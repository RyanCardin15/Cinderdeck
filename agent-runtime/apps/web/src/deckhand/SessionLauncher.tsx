import { NewChatLauncher, type NewChatLauncherProps } from "./NewChatLauncher";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Contracts from "@t3tools/contracts/deckhand/rpc";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { runtime } from "../lib/runtime";
import { buildThreadRouteParams } from "../threadRoutes";
import { useAtomCommand } from "../state/use-atom-command";
import {
  launchSession,
  inspectSessionLaunch,
  sessionLaunchOptions,
  createSession,
  inspectSessionCreation,
  previewLaunchReview,
  confirmLaunchReview,
} from "./state";
import styles from "./workspace.module.css";
import sessionStyles from "./sessions.module.css";

type Resource = Contracts.IntegrationView["resources"][number];
type Choice = typeof Contracts.ManagedLaunchOption.Type;
const isDeckhandRpcError = Schema.is(Contracts.DeckhandRpcError);
const decodeLaunchInput = Schema.decodeUnknownSync(Contracts.ManagedLaunchInput);
const decodeDraft = Schema.decodeUnknownSync(Schema.fromJsonString(Contracts.ManagedLaunchInput));
const encodeDraft = Schema.encodeSync(Schema.fromJsonString(Contracts.ManagedLaunchInput));
const decodeCreationDraft = Schema.decodeUnknownSync(
  Schema.fromJsonString(Contracts.ManagedCreateInput),
);
const encodeCreationDraft = Schema.encodeSync(Schema.fromJsonString(Contracts.ManagedCreateInput));
const isCreationInput = Schema.is(Contracts.ManagedCreateInput);
const decodeCreationInput = Schema.decodeUnknownSync(Contracts.ManagedCreateInput);
type Record = Contracts.ManagedLaunchRecord | Contracts.ManagedCreateRecord;
const launchRecord = (record: Record) => ("launch" in record ? record.launch : record);
const failureReason = (cause: Cause.Cause<unknown>): string | undefined => {
  const error = Option.getOrNull(Cause.findErrorOption(cause));
  return isDeckhandRpcError(error) ? error.reason : undefined;
};
const reasonLabel = (reason: string | undefined) =>
  ({
    stale_context: "This context changed. Review the latest context before retrying this request.",
    not_retryable: "This request is not ready for launch recovery. Check its saved result first.",
    unavailable_provider:
      "This provider is unavailable or does not support the selected permissions.",
    unsupported_access:
      "This provider cannot enforce the selected purpose. Choose Codex for read-only analysis, or choose implementation.",
    launch_failed:
      "The launch was saved, but intake failed. Check the result or retry this launch.",
    wrong_actor:
      "This saved launch belongs to a different sign-in. Its owner can check the result.",
    key_conflict: "This launch key already belongs to a different request.",
    missing: "No saved launch was found. You can retry this same request.",
  })[reason ?? ""] ??
  "The launch result could not be confirmed. Check its result before starting another launch.";
export function SessionLauncher(
  props: NewChatLauncherProps & {
    creation?: {
      visible: boolean;
      onClose: () => void;
      onResume?: () => void;
      onLane: (id: string) => void;
      onPending: (pending: boolean) => void;
    };
  },
) {
  const [legacy, setLegacy] = useState(() => {
    try {
      const value = localStorage.getItem(
        `deckhand:launch:${props.environmentId}:${props.installationID}:${props.resource.workspaceID}:${props.resource.generation}`,
      );
      return value !== null && !decodeDraft(value).deferStart;
    } catch {
      return false;
    }
  });
  return props.creation || legacy ? (
    <SessionSetupLauncher {...props} onRecovered={() => setLegacy(false)} />
  ) : (
    <NewChatLauncher {...props} />
  );
}

function SessionSetupLauncher({
  onRecovered,
  environmentId,
  installationID,
  resource,
  enabled,
  creation,
}: {
  environmentId: EnvironmentId;
  installationID: string;
  resource: Resource;
  enabled: boolean;
  onRecovered?: () => void;
  creation?: {
    visible: boolean;
    onClose: () => void;
    onResume?: () => void;
    onLane: (id: string) => void;
    onPending: (pending: boolean) => void;
  };
}) {
  const navigate = useNavigate();
  const isCreation = creation !== undefined;
  const id = useId();
  const branchInput = useRef<HTMLInputElement>(null);
  const launcher = useRef<HTMLElement>(null);
  const launchButton = useRef<HTMLButtonElement>(null);
  const focusRequest = useRef<"open" | "close" | null>(null);
  // Creation recovery survives a native generation change. Always replay the saved scope.
  const storageKey = isCreation
    ? `deckhand:create:${environmentId}:${installationID}:${resource.workspaceID}`
    : `deckhand:launch:${environmentId}:${installationID}:${resource.workspaceID}:${resource.generation}`;
  const [initial] = useState(() => {
    try {
      const value = localStorage.getItem(storageKey);
      return {
        request: value ? (isCreation ? decodeCreationDraft(value) : decodeDraft(value)) : null,
        error: false,
      };
    } catch {
      return { request: null, error: true };
    }
  });
  const [saved, setSaved] = useState<
    Contracts.ManagedLaunchInput | Contracts.ManagedCreateInput | null
  >(initial.request);
  const initialCreation = isCreationInput(initial.request) ? initial.request : null;
  const [branch, setBranch] = useState(initialCreation?.branch ?? "");
  const [repositoryRefs, setRepositoryRefs] = useState<Readonly<{ [id: string]: string }>>(
    initialCreation?.repositoryRefs ?? {},
  );
  const [setup, setSetup] = useState(initialCreation?.setup ?? true);
  const [start, setStart] = useState(initialCreation?.start ?? false);
  const [choices, setChoices] = useState<ReadonlyArray<Choice>>([]);
  const [optionsError, setOptionsError] = useState(false);
  const [optionsLoaded, setOptionsLoaded] = useState(false);
  const [formOpen, setFormOpen] = useState(initial.request !== null || initial.error);
  const optionsGeneration = useRef(0);
  const [repositoryID, setRepositoryID] = useState(
    saved?.repositoryID ?? resource.workspace?.repos[0]?.id ?? "",
  );
  const [instanceId, setInstanceId] = useState<string>(saved?.modelSelection.instanceId ?? "");
  const [model, setModel] = useState(saved?.modelSelection.model ?? "");
  const [title, setTitle] = useState(saved?.title ?? "");
  const [objective, setObjective] = useState(saved?.objective ?? "");
  const [runtimeMode, setRuntimeMode] = useState<Contracts.ManagedLaunchInput["runtimeMode"]>(
    saved?.runtimeMode ?? "approval-required",
  );
  const [access, setAccess] = useState<"read_only" | "write">(saved?.access ?? "write");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(
    saved ? "A launch request is saved. Check its result or retry the same request." : null,
  );
  const [confirmedRefusal, setConfirmedRefusal] = useState(false);
  const [review, setReview] = useState<Contracts.ManagedLaunchReview | null>(null);
  const [record, setRecord] = useState<Record | null>(null);
  const launch = useAtomCommand(launchSession, { reportFailure: false });
  const inspect = useAtomCommand(inspectSessionLaunch, { reportFailure: false });
  const create = useAtomCommand(createSession, { reportFailure: false });
  const inspectCreation = useAtomCommand(inspectSessionCreation, { reportFailure: false });
  const previewReview = useAtomCommand(previewLaunchReview, { reportFailure: false });
  const confirmReview = useAtomCommand(confirmLaunchReview, { reportFailure: false });
  const options = useAtomCommand(sessionLaunchOptions, { reportFailure: false });
  const formVisible = isCreation
    ? creation.visible || saved !== null || initial.error
    : formOpen || saved !== null;
  useEffect(() => {
    if (isCreation && creation.visible) branchInput.current?.focus();
  }, [isCreation, creation?.visible]);
  useEffect(() => {
    if (isCreation) return;
    if (formVisible && focusRequest.current === "open") {
      focusRequest.current = null;
      launcher.current?.focus({ preventScroll: true });
      launcher.current?.scrollIntoView({ block: "start", behavior: "instant" });
    } else if (!formVisible && focusRequest.current === "close") {
      focusRequest.current = null;
      launchButton.current?.focus();
    }
  }, [formVisible, isCreation]);
  const loadOptions = useCallback(() => {
    const generation = ++optionsGeneration.current;
    setOptionsLoaded(false);
    void options({ environmentId, input: {} }).then((result) => {
      if (generation !== optionsGeneration.current) return;
      setOptionsLoaded(true);
      if (result._tag !== "Success") {
        setOptionsError(true);
        return;
      }
      setChoices(result.value);
      setOptionsError(false);
    });
  }, [environmentId, options]);
  useEffect(() => {
    if (!formVisible) return;
    loadOptions();
    return () => {
      optionsGeneration.current++;
    };
  }, [loadOptions, formVisible]);
  const onPending = creation?.onPending;
  useEffect(() => {
    onPending?.(busy || (saved !== null && !["accepted", "failed"].includes(record?.state ?? "")));
    return () => onPending?.(false);
  }, [onPending, busy, saved, record?.state]);
  const provider = choices.find((choice) => choice.instanceId === instanceId);
  const open = (value: Contracts.ManagedLaunchRecord) => {
    if (!isCreation) onRecovered?.();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({ environmentId, threadId: value.threadId }),
    });
  };
  const handleRecord = (value: Record) => {
    setConfirmedRefusal(false);
    setRecord(value);
    setMessage(
      value.state === "accepted"
        ? "Launch accepted. Open the conversation to see the agent’s progress."
        : "laneID" in value
          ? value.state === "ready"
            ? "The lane is ready. Continue this request to start the agent."
            : value.state === "failed"
              ? value.laneID
                ? "The lane was kept, but setup or agent intake needs attention. Review it before retrying."
                : "Creation failed. The saved result is available for review."
              : value.state === "unknown_outcome"
                ? "The result is uncertain. Check this saved request before creating another feature."
                : "Creation is in progress. Check the result or continue this same request."
          : value.state === "failed"
            ? "The feature and session were saved, but launch intake failed. You can retry this request."
            : "The request was saved. Its intake result still needs to be checked.",
    );
    if (value.state === "accepted") {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        /* The saved key remains safe to inspect. */
      }
    }
  };
  const check = async () => {
    if (!saved || busy) return;
    setBusy(true);
    try {
      const result = isCreation
        ? await inspectCreation({ environmentId, input: { operationKey: saved.operationKey } })
        : await inspect({ environmentId, input: { operationKey: saved.operationKey } });
      if (result._tag === "Success") handleRecord(result.value);
      else
        setMessage(
          reasonLabel(result._tag === "Failure" ? failureReason(result.cause) : undefined),
        );
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (
      busy ||
      !enabled ||
      initial.error ||
      review !== null ||
      (!saved && (optionsError || !optionsLoaded))
    )
      return;
    setBusy(true);
    try {
      const request =
        saved ??
        (isCreation ? decodeCreationInput : decodeLaunchInput)({
          operationKey: await runtime.runPromise(
            Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
          ),
          installationID,
          workspaceID: resource.workspaceID,
          generation: resource.generation,
          revision: resource.revision,
          repositoryID,
          title,
          objective,
          modelSelection: { instanceId, model },
          runtimeMode,
          access,
          ...(isCreation
            ? {
                branch: branch.trim(),
                repositoryRefs: Object.fromEntries(
                  Object.entries(repositoryRefs)
                    .filter(([, ref]) => ref.trim())
                    .map(([repo, ref]) => [repo, ref.trim()]),
                ),
                setup,
                start,
              }
            : {}),
        });
      // Save before transport dispatch. A dropped connection keeps the same operation key,
      // immutable scope and objective available for inspection or a retry after reload.
      localStorage.setItem(
        storageKey,
        isCreation ? encodeCreationDraft(decodeCreationInput(request)) : encodeDraft(request),
      );
      setSaved(request);
      const result = isCreation
        ? await create({ environmentId, input: decodeCreationInput(request) })
        : await launch({ environmentId, input: request });
      if (result._tag === "Success") {
        handleRecord(result.value);
        const accepted = launchRecord(result.value);
        if (result.value.state === "accepted" && accepted) open(accepted);
      } else {
        const reason = result._tag === "Failure" ? failureReason(result.cause) : undefined;
        const refused = reason === "stale_context" || reason === "unavailable_provider";
        // Creation can report stale context after native effects. Confirm that no intent
        // exists before allowing edits that would discard the original operation key.
        if (isCreation && refused) {
          const checked = await inspectCreation({
            environmentId,
            input: { operationKey: request.operationKey },
          });
          if (checked._tag === "Success") handleRecord(checked.value);
          setConfirmedRefusal(
            checked._tag === "Failure" && failureReason(checked.cause) === "missing",
          );
        } else setConfirmedRefusal(refused);
        setMessage(reasonLabel(reason));
      }
    } catch {
      setMessage(
        "The request could not be saved or sent. Check its result if a launch key was already saved.",
      );
    } finally {
      setBusy(false);
    }
  };
  const inspectLatest = async () => {
    if (!saved || busy) return;
    setBusy(true);
    try {
      const result = await previewReview({
        environmentId,
        input: { operationKey: saved.operationKey, kind: isCreation ? "creation" : "launch" },
      });
      if (result._tag === "Success") setReview(result.value);
      else
        setMessage(
          reasonLabel(result._tag === "Failure" ? failureReason(result.cause) : undefined),
        );
    } finally {
      setBusy(false);
    }
  };
  const approveLatest = async () => {
    if (!review || busy || !enabled) return;
    setBusy(true);
    try {
      const result = await confirmReview({ environmentId, input: review });
      if (result._tag === "Success") {
        setReview(null);
        setMessage(
          "The reviewed context was saved. Continue the original request to retry its launch.",
        );
      } else {
        setReview(null);
        setMessage(
          reasonLabel(result._tag === "Failure" ? failureReason(result.cause) : undefined),
        );
      }
    } finally {
      setBusy(false);
    }
  };
  const clearSaved = () => {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      setMessage("The saved request could not be cleared. Check its result before continuing.");
      return false;
    }
    setSaved(null);
    setRecord(null);
    setReview(null);
    setConfirmedRefusal(false);
    return true;
  };
  if (isCreation && !creation.visible && !saved && !initial.error) return null;
  const accepted = record ? launchRecord(record) : null;
  const contextLabel = resource.workspace?.lane?.name ?? "Primary checkout";
  if (isCreation && !creation.visible) {
    if (record?.state === "accepted") return null;
    return (
      <section className={sessionStyles.launchPrompt} aria-label="Saved feature request">
        <div>
          <h3>{saved?.title ?? "Saved feature request"}</h3>
          <p>
            {initial.error
              ? "The saved request could not be read. Restore storage before creating another feature."
              : "A feature request is saved. Review its result before starting another."}
          </p>
          {message ? <p role="status">{message}</p> : null}
        </div>
        <div className={styles["dh-inspector-actions"]}>
          {saved ? (
            <button
              type="button"
              className={sessionStyles.quiet}
              disabled={busy}
              onClick={() => {
                void check();
              }}
            >
              {busy ? "Checking…" : "Check result"}
            </button>
          ) : null}
          <button
            type="button"
            className={sessionStyles.primary}
            disabled={busy}
            onClick={creation.onResume}
          >
            Review saved feature
          </button>
        </div>
      </section>
    );
  }
  if (!isCreation && !formVisible)
    return (
      <section className={sessionStyles.launchPrompt} aria-label="New session">
        <div>
          <h3>Start a new session</h3>
          <p>{contextLabel} · choose a configured provider and repository.</p>
        </div>
        <button
          ref={launchButton}
          type="button"
          className={sessionStyles.primary}
          disabled={!enabled}
          onClick={() => {
            focusRequest.current = "open";
            setFormOpen(true);
          }}
        >
          ＋ New session
        </button>
        {!enabled ? (
          <p className={sessionStyles.scopeNote}>
            A fresh, available checkout is needed to start a session.
          </p>
        ) : null}
      </section>
    );
  return (
    <section
      ref={launcher}
      tabIndex={-1}
      className={`${styles["dh-launcher"]} ${sessionStyles.launcher} ${isCreation ? styles["dh-feature-create"] : ""}`}
      aria-labelledby={`${id}-heading`}
    >
      <header className={sessionStyles.formHeading}>
        <div>
          <h3 id={`${id}-heading`}>{isCreation ? "New feature" : "New session"}</h3>
          {!isCreation ? <p>{contextLabel}</p> : null}
        </div>
        {isCreation || !saved ? (
          <button
            type="button"
            className={sessionStyles.quiet}
            disabled={busy}
            onClick={() => {
              if (isCreation) creation.onClose();
              else {
                focusRequest.current = "close";
                setFormOpen(false);
              }
            }}
          >
            Close
          </button>
        ) : null}
      </header>
      <p className={sessionStyles.scopeNote}>
        {isCreation
          ? `Create a lane in ${resource.workspace?.name ?? resource.workspaceID}, then start its agent in the selected repository. Repository and service sharing follow the workspace definition.`
          : "Choose a provider and purpose. Keep analysis alongside your feature sessions, or give one session permission to implement changes."}
      </p>
      {initial.error ? (
        <p role="alert">
          The saved request could not be read. Restore browser storage before submitting; an earlier
          creation may still exist.
        </p>
      ) : null}
      {optionsError ? (
        <div>
          <p role="alert">Provider choices could not be loaded.</p>
          <button type="button" className={styles["dh-button"]} onClick={loadOptions}>
            Reload providers
          </button>
        </div>
      ) : null}
      {!choices.length && !optionsError ? (
        <p role="status">
          {optionsLoaded
            ? "No configured provider is ready. Configure and sign in to a provider in Settings."
            : "Loading configured providers…"}
        </p>
      ) : null}
      {saved && !provider ? (
        <p role="status" className={sessionStyles.notice}>
          The saved provider instance is not currently available. Its original selection is retained
          for recovery.
        </p>
      ) : null}
      <form
        className={sessionStyles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset
          disabled={
            busy || saved !== null || !enabled || initial.error || optionsError || !optionsLoaded
          }
        >
          {isCreation ? (
            <>
              <label htmlFor={`${id}-branch`}>New lane branch</label>
              <input
                ref={branchInput}
                id={`${id}-branch`}
                required
                maxLength={200}
                placeholder="fix/payment-retry"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
              />
              <details className={styles["dh-revision-fields"]}>
                <summary>Repository start revisions</summary>
                <p>
                  A workspace can include several repositories and regular folders. Leave blank to
                  use each repository’s workspace default. Enter a branch, tag or commit to override
                  it.
                </p>
                {resource.workspace?.repos.map((repo) => (
                  <div key={repo.id}>
                    <label htmlFor={`${id}-ref-${repo.id}`}>{repo.id}</label>
                    <input
                      id={`${id}-ref-${repo.id}`}
                      maxLength={200}
                      placeholder="Workspace default"
                      value={repositoryRefs[repo.id] ?? ""}
                      onChange={(event) =>
                        setRepositoryRefs((current) => ({
                          ...current,
                          [repo.id]: event.target.value,
                        }))
                      }
                    />
                  </div>
                ))}
              </details>
              <label className={styles["dh-check-field"]}>
                <input
                  type="checkbox"
                  checked={setup}
                  onChange={(event) => setSetup(event.target.checked)}
                />
                Run workspace setup
              </label>
              <label className={styles["dh-check-field"]}>
                <input
                  type="checkbox"
                  checked={start}
                  onChange={(event) => setStart(event.target.checked)}
                />
                Start services after creation
              </label>
              <p>
                Shared services keep their workspace owners. Isolated services receive this lane’s
                own ports.
              </p>
            </>
          ) : null}
          <label htmlFor={`${id}-repo`}>Repository</label>
          <select
            id={`${id}-repo`}
            value={repositoryID}
            onChange={(event) => setRepositoryID(event.target.value)}
          >
            {resource.workspace?.repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.id}
              </option>
            ))}
          </select>
          <span id={`${id}-provider-label`}>Provider account</span>
          <div
            className={sessionStyles.providerChoices}
            role="group"
            aria-labelledby={`${id}-provider-label`}
          >
            {choices.map((choice) => (
              <button
                key={choice.instanceId}
                type="button"
                className={sessionStyles.providerChoice}
                aria-pressed={instanceId === choice.instanceId}
                aria-label={`${choice.label} · ${choice.instanceId}`}
                disabled={
                  choice.readiness === "unavailable" || choice.readiness === "sign_in_required"
                }
                onClick={() => {
                  setInstanceId(choice.instanceId);
                  setModel(choice.models.length === 1 ? choice.models[0]!.id : "");
                  setAccess(
                    choice.supportsReadOnly && !resource.workspace?.lane && !isCreation
                      ? "read_only"
                      : "write",
                  );
                }}
              >
                <strong>{choice.label}</strong>
                <span>
                  {choice.readiness === "sign_in_required"
                    ? "Sign in required"
                    : choice.readiness === "unavailable"
                      ? "Unavailable"
                      : choice.readiness === "unknown"
                        ? "Sign-in not verified"
                        : "Ready"}
                  {choice.models.length === 1 && choice.models[0]?.id === "default"
                    ? " · CLI default model"
                    : choice.models.length > 0
                      ? ` · ${choice.models.length} models`
                      : ""}
                </span>
              </button>
            ))}
            {saved && !provider ? (
              <div className={sessionStyles.savedProvider}>
                <strong>{saved.modelSelection.instanceId}</strong>
                <span>Saved instance · unavailable</span>
              </div>
            ) : null}
          </div>
          {choices.some(
            (choice) =>
              choice.readiness === "sign_in_required" || choice.readiness === "unavailable",
          ) ? (
            <p className={sessionStyles.scopeNote}>
              Set up accounts in{" "}
              <Link to="/settings/providers" search={{ machine: environmentId }}>
                Provider settings
              </Link>
              .
            </p>
          ) : null}
          <label htmlFor={`${id}-model`}>Model</label>
          <select
            id={`${id}-model`}
            required
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="">Choose a model</option>
            {model && !provider?.models.some((item) => item.id === model) ? (
              <option value={model}>{model} · saved selection</option>
            ) : null}
            {provider?.models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <label htmlFor={`${id}-purpose`}>Purpose</label>
          <select
            id={`${id}-purpose`}
            value={access}
            onChange={(event) =>
              setAccess(event.target.value === "read_only" ? "read_only" : "write")
            }
          >
            <option value="read_only" disabled={!provider?.supportsReadOnly}>
              Analyze · read only
            </option>
            <option value="write">Implement · can change files</option>
          </select>
          <p className={sessionStyles.scopeNote}>
            {access === "read_only"
              ? "The agent can inspect this checkout. File changes, commands that write, and Cinderdeck changes are blocked. Other sessions can keep working."
              : provider?.supportsReadOnly
                ? "Implementation uses this checkout’s writer slot. Choose Analyze when you only need investigation or planning."
                : "This provider supports implementation sessions. Enforced analysis is currently available with Codex."}
          </p>
          {access === "write" ? (
            <>
              <label htmlFor={`${id}-access`}>Permissions</label>
              <select
                id={`${id}-access`}
                value={runtimeMode}
                onChange={(event) =>
                  setRuntimeMode(
                    event.target.value === "full-access" ? "full-access" : "approval-required",
                  )
                }
              >
                <option value="approval-required">
                  Ask for approval
                  {provider?.runtimeModeAdjustments?.some(
                    (entry) => entry.mode === "approval-required",
                  )
                    ? ` (${provider.runtimeModeAdjustments.find((entry) => entry.mode === "approval-required")?.source === "provider" ? "provider" : "organization"} policy)`
                    : ""}
                </option>
                <option value="full-access">
                  Full access
                  {provider?.runtimeModeAdjustments?.some((entry) => entry.mode === "full-access")
                    ? ` (${provider.runtimeModeAdjustments.find((entry) => entry.mode === "full-access")?.source === "provider" ? "provider" : "organization"} policy)`
                    : ""}
                </option>
              </select>
              {provider?.runtimeModeAdjustments?.find((entry) => entry.mode === runtimeMode)
                ?.description ? (
                <p>
                  {
                    provider.runtimeModeAdjustments.find((entry) => entry.mode === runtimeMode)
                      ?.description
                  }
                </p>
              ) : null}
            </>
          ) : null}
          <label htmlFor={`${id}-title`}>{isCreation ? "Feature title" : "Agent task"}</label>
          <input
            id={`${id}-title`}
            required
            maxLength={200}
            placeholder={isCreation ? "Payment retries" : "Investigate payment retries"}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <label htmlFor={`${id}-objective`}>{isCreation ? "Objective" : "Instructions"}</label>
          <textarea
            id={`${id}-objective`}
            required
            maxLength={16000}
            rows={4}
            placeholder={
              isCreation
                ? "Describe the feature and what success looks like."
                : "Describe what this agent should do in the selected checkout."
            }
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
          />
        </fieldset>
        <div className={styles["dh-inspector-actions"]}>
          {record?.state === "accepted" && accepted ? (
            <button type="button" className={styles["dh-button"]} onClick={() => open(accepted)}>
              Open conversation
            </button>
          ) : (
            <button
              type="submit"
              className={`${styles["dh-button"]} ${styles["dh-accent"]}`}
              disabled={
                busy ||
                !enabled ||
                initial.error ||
                review !== null ||
                (isCreation &&
                  record?.state === "failed" &&
                  "launch" in record &&
                  !record.launch &&
                  ["succeeded", "failed"].includes(record.receipt?.state ?? "")) ||
                (isCreation && !saved && !branch.trim()) ||
                (!saved &&
                  (optionsError ||
                    !optionsLoaded ||
                    !provider ||
                    provider.readiness === "unavailable" ||
                    provider.readiness === "sign_in_required" ||
                    (access === "read_only" && !provider.supportsReadOnly) ||
                    !model ||
                    !title.trim() ||
                    !objective.trim()))
              }
            >
              {busy
                ? isCreation
                  ? "Creating feature…"
                  : "Checking launch…"
                : saved
                  ? isCreation
                    ? "Continue saved request"
                    : "Retry saved launch"
                  : isCreation
                    ? "Create lane and launch agent"
                    : "Start session"}
            </button>
          )}
          {saved && record?.state !== "accepted" ? (
            <button
              type="button"
              className={styles["dh-button"]}
              disabled={busy}
              onClick={() => {
                void inspectLatest();
              }}
            >
              Review latest context
            </button>
          ) : null}
          {saved ? (
            <button
              type="button"
              className={styles["dh-button"]}
              disabled={busy}
              onClick={() => {
                void check();
              }}
            >
              Check result
            </button>
          ) : null}
          {!isCreation && record?.state === "accepted" ? (
            <button
              type="button"
              className={styles["dh-button"]}
              disabled={busy || !enabled}
              onClick={() => {
                if (!clearSaved()) return;
                onRecovered?.();
                setInstanceId("");
                setModel("");
                setTitle("");
                setObjective("");
                setMessage(null);
                setFormOpen(true);
              }}
            >
              New session
            </button>
          ) : null}
          {isCreation && record && "laneID" in record && record.laneID ? (
            <button
              type="button"
              className={styles["dh-button"]}
              onClick={() => creation.onLane(record.laneID!)}
            >
              Review created lane
            </button>
          ) : null}
          {isCreation && !saved ? (
            <button type="button" className={styles["dh-button"]} onClick={creation.onClose}>
              Cancel
            </button>
          ) : null}
          {isCreation &&
          record &&
          (record.state === "accepted" ||
            (record.state === "failed" &&
              ["succeeded", "failed"].includes(
                "receipt" in record ? (record.receipt?.state ?? "") : "",
              ))) ? (
            <button
              type="button"
              className={styles["dh-button"]}
              disabled={busy}
              onClick={() => {
                if (!clearSaved()) return;
                setBranch("");
                setTitle("");
                setObjective("");
                setMessage(
                  "The previous result remains in workspace history. Enter a new branch and objective for another feature.",
                );
              }}
            >
              Start another feature
            </button>
          ) : null}
          {confirmedRefusal || (!isCreation && record?.state === "failed") ? (
            <button
              type="button"
              className={styles["dh-button"]}
              disabled={busy}
              onClick={() => {
                if (!clearSaved()) return;
                setMessage(
                  "Edit the request before launching again. Any previously saved session remains in its context history.",
                );
              }}
            >
              {isCreation ? "Edit refused request" : "Edit launch request"}
            </button>
          ) : null}
        </div>
      </form>
      {review ? (
        <section className={styles["dh-launch-review"]} aria-label="Review latest launch context">
          <h4>Latest launch context</h4>
          <p>
            Review these repositories before retrying the original request. Confirming keeps the
            same feature and conversation; the agent starts only when you continue.
          </p>
          {review.repositories.map((repo) => (
            <div key={repo.repositoryID}>
              <strong>{repo.repositoryID}</strong>
              <code>{repo.checkout.root}</code>
              <span>
                {repo.checkout.branch ?? "Detached HEAD"} ·{" "}
                {repo.checkout.commit?.slice(0, 12) ?? "Commit unavailable"}
              </span>
            </div>
          ))}
          <button
            type="button"
            className={styles["dh-button"]}
            disabled={busy || !enabled}
            onClick={() => {
              void approveLatest();
            }}
          >
            Confirm reviewed context
          </button>
          <button
            type="button"
            className={styles["dh-button"]}
            disabled={busy}
            onClick={() => setReview(null)}
          >
            Cancel review
          </button>
        </section>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {isCreation &&
      record &&
      "receipt" in record &&
      (record.receipt?.error?.message || record.error) ? (
        <p role="alert">{record.receipt?.error?.message ?? record.error}</p>
      ) : null}
    </section>
  );
}
