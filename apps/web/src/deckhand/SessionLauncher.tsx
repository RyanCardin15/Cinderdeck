import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
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
    launch_failed:
      "The launch was saved, but intake failed. Check the result or retry this launch.",
    wrong_actor:
      "This saved launch belongs to a different sign-in. Its owner can check the result.",
    key_conflict: "This launch key already belongs to a different request.",
    missing: "No saved launch was found. You can retry this same request.",
  })[reason ?? ""] ??
  "The launch result could not be confirmed. Check its result before starting another launch.";
export function SessionLauncher({
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
  creation?: {
    visible: boolean;
    onClose: () => void;
    onLane: (id: string) => void;
    onPending: (pending: boolean) => void;
  };
}) {
  const navigate = useNavigate();
  const isCreation = creation !== undefined;
  const id = useId();
  const branchInput = useRef<HTMLInputElement>(null);
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
  const formVisible = !isCreation || creation.visible || saved !== null;
  useEffect(() => {
    if (isCreation && creation.visible) branchInput.current?.focus();
  }, [isCreation, creation?.visible]);
  const loadOptions = useCallback(() => {
    const generation = ++optionsGeneration.current;
    void options({ environmentId, input: {} }).then((result) => {
      if (generation !== optionsGeneration.current) return;
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
    if (busy || !enabled || initial.error || review !== null) return;
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
  return (
    <section
      className={`${styles["dh-launcher"]} ${isCreation ? styles["dh-feature-create"] : ""}`}
      aria-label={isCreation ? "Create a feature" : "Launch an agent"}
    >
      <h3>{isCreation ? "New feature" : "Agent session"}</h3>
      <p>
        {isCreation
          ? `Create a lane in ${resource.workspace?.name ?? resource.workspaceID}, then start its agent in the selected repository. Each repository gets an independent checkout.`
          : "Start a writer in this context’s existing source tree. Choose the repository it may own."}
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
        <p>Waiting for configured providers. Configure and sign in to a provider in Settings.</p>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={busy || saved !== null || !enabled || initial.error}>
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
                  Leave blank to use each repository’s workspace default. Enter a branch, tag or
                  commit to override it.
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
                {resource.workspace?.services.length ?? 0} configured services will use this lane’s
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
          <label htmlFor={`${id}-provider`}>Provider account</label>
          <select
            id={`${id}-provider`}
            required
            value={instanceId}
            onChange={(event) => {
              setInstanceId(event.target.value);
              setModel("");
            }}
          >
            <option value="">Choose a provider</option>
            {choices.map((choice) => (
              <option key={choice.instanceId} value={choice.instanceId}>
                {choice.label}
              </option>
            ))}
          </select>
          <label htmlFor={`${id}-model`}>Model</label>
          <select
            id={`${id}-model`}
            required
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="">Choose a model</option>
            {provider?.models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
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
            <option value="approval-required">Ask for approval</option>
            <option value="full-access">Full access</option>
          </select>
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
                (!saved && (!provider || !model || !title.trim() || !objective.trim()))
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
                    : "Launch agent"}
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
