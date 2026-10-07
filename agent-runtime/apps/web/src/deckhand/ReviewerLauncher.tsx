import { useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  type ModelSelection,
  type RuntimeMode,
  type ProviderInteractionMode,
  type ScopedThreadRef,
} from "@cinderdeck/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { environmentServerConfigsAtom } from "../state/server";
import { readProjects } from "../state/entities";
import { resolveProjectSettings } from "@cinderdeck/shared/projectSettings";
import { resolveDefaultProviderModelSelection } from "../providerInstances";
import { useComposerDraftStore } from "../composerDraftStore";
import { resolveChatModes } from "./chatDefaults";
import { TraitsPicker } from "../components/chat/TraitsPicker";
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogTitle,
  DialogDescription,
} from "../components/ui/dialog";
import * as Rpc from "@cinderdeck/contracts/deckhand/rpc";
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { runtime } from "../lib/runtime";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  previewReviewer,
  scheduleReviewer,
  inspectReviewerQueue,
  cancelReviewerQueue,
  sessionLaunchOptions,
  inspectSessionCreation,
} from "./state";
import styles from "./laneSession.module.css";
const isRpcError = Schema.is(Rpc.DeckhandRpcError);
const decodeSaved = Schema.decodeUnknownSync(Schema.fromJsonString(Rpc.ReviewerLaunchInput));
const encodeSaved = Schema.encodeSync(Schema.fromJsonString(Rpc.ReviewerLaunchInput));
const decodeInput = Schema.decodeUnknownSync(Rpc.ReviewerLaunchInput);
function errorMessage(cause: Cause.Cause<unknown>, saved = false) {
  const error = Cause.squash(cause);
  const reason = isRpcError(error) ? error.reason : "unknown";
  return reason === "dirty_source"
    ? "Commit or discard source changes before reviewing this revision."
    : reason === "stale_context"
      ? saved
        ? "The source changed. Check the saved result before inspecting its current revision."
        : "The current committed revision could not be inspected. Refresh the workspace connection and try again."
      : reason === "invalid_feature"
        ? "The session or code review skill is unavailable. Check the workspace settings and try again."
        : "The review result could not be confirmed. Check the saved request before retrying.";
}
export function ReviewerLauncher({
  threadRef,
  enabled,
}: {
  threadRef: ScopedThreadRef;
  enabled: boolean;
  providerSessionId?: string | null;
}) {
  const id = useId();
  const navigate = useNavigate();
  const settings = useEnvironmentSettings(threadRef.environmentId);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const key = `deckhand:reviewer:${threadRef.environmentId}:${threadRef.threadId}`;
  const [initial] = useState(() => {
    try {
      const value = localStorage.getItem(key);
      return {
        saved: value ? decodeSaved(value) : null,
        error: false,
        queueMode: localStorage.getItem(`${key}:mode`) === "queue",
      };
    } catch {
      return { saved: null, error: true, queueMode: false };
    }
  });
  const [queueMode, setQueueMode] = useState(initial.queueMode);
  const [queue, setQueue] = useState<Rpc.ReviewerQueueRecord | null>(null);
  const [saved, setSaved] = useState(initial.saved);
  const [preview, setPreview] = useState<Rpc.ReviewerLaunchPreview | null>(
    initial.saved?.preview ?? null,
  );
  const [choices, setChoices] = useState<ReadonlyArray<typeof Rpc.ManagedLaunchOption.Type>>([]);
  const [instance, setInstance] = useState<string>(initial.saved?.modelSelection.instanceId ?? "");
  const [model, setModel] = useState(initial.saved?.modelSelection.model ?? "");
  const [modelOptions, setModelOptions] = useState<ModelSelection["options"]>(
    initial.saved?.modelSelection.options,
  );
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(
    initial.saved?.runtimeMode ?? "approval-required",
  );
  const [interactionMode, setInteractionMode] = useState<ProviderInteractionMode>(
    initial.saved?.interactionMode ?? "default",
  );
  const [objective, setObjective] = useState(
    initial.saved?.objective ?? "Review these committed changes and report actionable findings.",
  );
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const openSubmittedReview = useRef(false);
  const [message, setMessage] = useState(
    initial.error
      ? "Saved review request could not be read. Restore browser storage before starting another review."
      : "",
  );
  const [record, setRecord] = useState<Rpc.ManagedCreateRecord | null>(null);
  const [missing, setMissing] = useState(false);
  const inspectSource = useAtomCommand(previewReviewer, { reportFailure: false });
  const launch = useAtomCommand(scheduleReviewer, { reportFailure: false });
  const inspectQueue = useAtomCommand(inspectReviewerQueue, { reportFailure: false });
  const cancelQueue = useAtomCommand(cancelReviewerQueue, { reportFailure: false });
  const options = useAtomCommand(sessionLaunchOptions, { reportFailure: false });
  const inspect = useAtomCommand(inspectSessionCreation, { reportFailure: false });
  useEffect(() => {
    let active = true;
    void options({ environmentId: threadRef.environmentId, input: {} }).then((result) => {
      if (!active) return;
      if (result._tag === "Success") {
        setChoices(
          result.value.filter(
            (choice) =>
              choice.readiness !== "unavailable" &&
              choice.readiness !== "sign_in_required" &&
              choice.models.length > 0,
          ),
        );
      }
    });
    return () => {
      active = false;
    };
  }, [options, threadRef.environmentId]);
  const check = async () => {
    if (!saved) return;
    setBusy(true);
    if (queueMode) {
      const result = await inspectQueue({
        environmentId: threadRef.environmentId,
        input: { operationKey: saved.operationKey },
      });
      if (result._tag === "Success" && result.value === null) {
        const legacy = await inspect({
          environmentId: threadRef.environmentId,
          input: { operationKey: saved.operationKey },
        });
        if (legacy._tag === "Success") {
          setRecord(legacy.value);
          setMessage(`Saved direct review: ${legacy.value.state.replaceAll("_", " ")}`);
        } else {
          const error = Cause.squash(legacy.cause);
          setMissing(isRpcError(error) && error.reason === "missing");
          setMessage(
            isRpcError(error) && error.reason === "missing"
              ? "No queued or direct creation exists for this saved request. You can inspect a new revision."
              : errorMessage(legacy.cause),
          );
        }
        setBusy(false);
        return;
      }
      setBusy(false);
      if (result._tag === "Success") {
        setQueue(result.value);
        setMessage(
          result.value?.detail ??
            result.value?.state.replaceAll("_", " ") ??
            "This saved request has not entered the queue. Continue the saved review to schedule it.",
        );
      } else setMessage(errorMessage(result.cause));
      return;
    }
    const result = await inspect({
      environmentId: threadRef.environmentId,
      input: { operationKey: saved.operationKey },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setRecord(result.value);
      setMessage(`Saved review: ${result.value.state.replaceAll("_", " ")}`);
    } else {
      const error = Cause.squash(result.cause);
      setMissing(isRpcError(error) && error.reason === "missing");
      setMessage(errorMessage(result.cause));
    }
  };
  const prepare = async () => {
    setBusy(true);
    const [result, optionResult] = await Promise.all([
      inspectSource({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      }),
      options({ environmentId: threadRef.environmentId, input: {} }),
    ]);
    setBusy(false);
    if (result._tag === "Success") {
      setPreview(result.value);
      if (optionResult._tag !== "Success") {
        setMessage(
          "Provider choices could not be loaded. Refresh the committed revision to try again.",
        );
        return;
      }
      const available = optionResult.value.filter(
        (choice) =>
          choice.readiness !== "unavailable" &&
          choice.readiness !== "sign_in_required" &&
          choice.models.length > 0,
      );
      setChoices(available);
      if (!available.length) {
        setInstance("");
        setModel("");
        setModelOptions(undefined);
        setMessage("Set up and sign in to a provider in Settings to open a review chat.");
        return;
      }
      if (!preview || !available.some((choice) => choice.instanceId === instance)) {
        const project = readProjects().find(
          (candidate) =>
            candidate.environmentId === threadRef.environmentId &&
            candidate.workspaceRoot === result.value.repositoryPath,
        );
        const defaults = resolveProjectSettings(settings, project?.id ?? null, project).settings;
        const composer = useComposerDraftStore.getState();
        const remembered = composer.stickyActiveProvider
          ? composer.stickyModelSelectionByProvider[composer.stickyActiveProvider]
          : null;
        const preferred = defaults.defaultModelSelection ?? remembered;
        const providers =
          configs
            .get(threadRef.environmentId)
            ?.providers.filter((provider) =>
              available.some((choice) => choice.instanceId === provider.instanceId),
            ) ?? [];
        const selection =
          resolveDefaultProviderModelSelection(providers, preferred) ??
          (preferred &&
          available.some(
            (choice) =>
              choice.instanceId === preferred.instanceId &&
              choice.models.some((model) => model.id === preferred.model),
          )
            ? preferred
            : null);
        setInstance(selection?.instanceId ?? available[0]?.instanceId ?? "");
        setModel(selection?.model ?? available[0]?.models[0]?.id ?? "");
        setModelOptions(selection?.options);
        const modes = resolveChatModes(
          threadRef.environmentId,
          defaults.defaultRuntimeMode,
          settings.planModeEnabled,
        );
        setRuntimeMode(modes.runtimeMode);
        setInteractionMode(
          providers.find((provider) => provider.instanceId === selection?.instanceId)
            ?.showInteractionModeToggle === false
            ? "default"
            : modes.interactionMode,
        );
      }
      setMessage(
        "Choose the reviewer’s provider and model, then open its isolated chat at these commits.",
      );
    } else setMessage(errorMessage(result.cause));
  };
  const submit = async () => {
    if (!preview || submitting.current || (saved && !queueMode)) return;
    submitting.current = true;
    setBusy(true);
    try {
      const request =
        saved ??
        decodeInput({
          operationKey: await runtime.runPromise(
            Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
          ),
          preview,
          modelSelection: {
            instanceId: instance,
            model,
            ...(modelOptions ? { options: modelOptions } : {}),
          },
          runtimeMode,
          interactionMode,
          objective,
        });
      localStorage.setItem(key, encodeSaved(request));
      localStorage.setItem(`${key}:mode`, "queue");
      setQueueMode(true);
      setSaved(request);
      setMissing(false);
      openSubmittedReview.current = true;
      const result = await launch({ environmentId: threadRef.environmentId, input: request });
      if (result._tag === "Success") {
        setQueue(result.value);
        setMessage(result.value.detail ?? `Review ${result.value.state.replaceAll("_", " ")}.`);
      } else setMessage(errorMessage(result.cause, true));
    } catch {
      setMessage("This request could not be saved or validated. No new review was sent.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!openSubmittedReview.current || queue?.state !== "accepted" || !queue.creation?.threadID)
      return;
    openSubmittedReview.current = false;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({
        environmentId: threadRef.environmentId,
        threadId: queue.creation.threadID,
      }),
    });
  }, [navigate, queue, threadRef.environmentId]);
  const reset = () => {
    if (
      !missing &&
      record?.state !== "accepted" &&
      record?.state !== "failed" &&
      !["accepted", "cancelled", "needs_refresh"].includes(queue?.state ?? "")
    )
      return;
    try {
      localStorage.removeItem(key);
      localStorage.removeItem(`${key}:mode`);
      setQueue(null);
      setQueueMode(false);
      setSaved(null);
      setPreview(null);
      setRecord(null);
      setMissing(false);
      setMessage("");
      openSubmittedReview.current = false;
    } catch {
      setMessage("Saved review request could not be cleared.");
    }
  };
  useEffect(() => {
    if (!saved || !queueMode || !enabled) return;
    let active = true;
    const refresh = async () => {
      const result = await inspectQueue({
        environmentId: threadRef.environmentId,
        input: { operationKey: saved.operationKey },
      });
      if (active && result._tag === "Success" && result.value !== null) {
        setQueue(result.value);
        setMessage(
          result.value?.detail ??
            result.value?.state.replaceAll("_", " ") ??
            "This saved request has not entered the queue. Continue the saved review to schedule it.",
        );
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [saved, queueMode, enabled, inspectQueue, threadRef.environmentId]);
  const cancel = async () => {
    if (!saved) return;
    setBusy(true);
    const result = await cancelQueue({
      environmentId: threadRef.environmentId,
      input: { operationKey: saved.operationKey },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setQueue(result.value);
      setMessage(result.value.detail ?? "Review cancelled.");
    } else setMessage(errorMessage(result.cause));
  };
  const activeProvider = configs
    .get(threadRef.environmentId)
    ?.providers.find((provider) => provider.instanceId === instance);
  return (
    <Dialog>
      <DialogTrigger render={<button type="button" className={styles.reviewerTrigger} />}>
        Schedule isolated review
      </DialogTrigger>
      <DialogPopup
        className="w-[min(520px,calc(100vw-32px))] max-w-[min(520px,calc(100vw-32px))] overflow-hidden"
        showCloseButton={!busy}
      >
        <div className={styles.reviewerForm}>
          <DialogTitle>Review this feature</DialogTitle>
          <DialogDescription>
            Open a new review chat in a separate lane at every repository’s committed head.
            Uncommitted files stay in the source checkout.
          </DialogDescription>
          {saved && !queueMode ? (
            <p role="status">
              This saved request uses direct creation. Check its result before starting another
              review; it will not be resubmitted as a new queued request.
            </p>
          ) : null}
          {message ? <p role="status">{message}</p> : null}
          {!preview ? (
            <button
              type="button"
              onClick={() => void prepare()}
              disabled={!enabled || busy || initial.error}
            >
              Inspect committed revision
            </button>
          ) : null}
          {preview && !saved ? (
            <button type="button" disabled={busy || !enabled} onClick={() => void prepare()}>
              Refresh committed revision
            </button>
          ) : null}
          {preview ? (
            <>
              <ul>
                {preview.reviewerContext.repositories.map((repo) => (
                  <li key={repo.repositoryID}>
                    <strong>{repo.repositoryID}</strong>
                    <code>{repo.commit}</code>
                  </li>
                ))}
              </ul>
              <label htmlFor={`${id}-provider`}>Reviewer provider</label>
              {!saved ? (
                <Link
                  to="/settings/general"
                  search={{ machine: threadRef.environmentId }}
                  hash="project-defaults"
                >
                  Chat defaults
                </Link>
              ) : null}
              <select
                id={`${id}-provider`}
                disabled={Boolean(saved) || busy}
                value={instance}
                onChange={(event) => {
                  setInstance(event.target.value);
                  setModelOptions(undefined);
                  setModel(
                    choices.find((choice) => choice.instanceId === event.target.value)?.models[0]
                      ?.id ?? "",
                  );
                }}
              >
                {choices.map((choice) => (
                  <option value={choice.instanceId} key={choice.instanceId}>
                    {choice.label}
                  </option>
                ))}
              </select>
              {activeProvider && !saved && !busy ? (
                <TraitsPicker
                  provider={activeProvider.driver}
                  models={activeProvider.models}
                  model={model}
                  prompt=""
                  onPromptChange={() => {}}
                  modelOptions={modelOptions}
                  allowPromptInjectedEffort={false}
                  planModeEnabled={settings.planModeEnabled}
                  onModelOptionsChange={setModelOptions}
                />
              ) : null}
              <label htmlFor={`${id}-model`}>Model</label>
              <select
                id={`${id}-model`}
                disabled={Boolean(saved) || busy}
                value={model}
                onChange={(event) => {
                  setModel(event.target.value);
                  setModelOptions(undefined);
                }}
              >
                {choices
                  .find((choice) => choice.instanceId === instance)
                  ?.models.map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.label}
                    </option>
                  ))}
              </select>
              <label htmlFor={`${id}-permissions`}>Permissions</label>
              <select
                id={`${id}-permissions`}
                value={runtimeMode}
                disabled={Boolean(saved) || busy}
                onChange={(event) => setRuntimeMode(event.target.value as RuntimeMode)}
              >
                <option value="approval-required">Ask for approval</option>
                <option
                  value="auto-accept-edits"
                  disabled={
                    activeProvider?.supportedRuntimeModes !== undefined &&
                    !activeProvider.supportedRuntimeModes.includes("auto-accept-edits")
                  }
                >
                  Accept edits
                </option>
                <option
                  value="auto"
                  disabled={
                    activeProvider?.supportedRuntimeModes !== undefined &&
                    !activeProvider.supportedRuntimeModes.includes("auto")
                  }
                >
                  Automatic
                </option>
                <option
                  value="full-access"
                  disabled={
                    activeProvider?.supportedRuntimeModes !== undefined &&
                    !activeProvider.supportedRuntimeModes.includes("full-access")
                  }
                >
                  Full access
                </option>
              </select>
              {settings.planModeEnabled && activeProvider?.showInteractionModeToggle !== false ? (
                <>
                  <label htmlFor={`${id}-mode`}>Chat mode</label>
                  <select
                    id={`${id}-mode`}
                    value={interactionMode}
                    disabled={Boolean(saved) || busy}
                    onChange={(event) =>
                      setInteractionMode(event.target.value as ProviderInteractionMode)
                    }
                  >
                    <option value="default">Agent</option>
                    <option value="plan">Plan</option>
                  </select>
                </>
              ) : null}
              {preview.codeReviewSkill ? (
                <details>
                  <summary>
                    Code Review Skill ·{" "}
                    {preview.codeReviewSkill.configured ? "Workspace" : "Default"}
                  </summary>
                  <p>
                    <code>{preview.codeReviewSkill.path}</code>
                  </p>
                  <pre>{preview.codeReviewSkill.content}</pre>
                  {!saved ? (
                    <Link
                      to="/workspaces"
                      search={{
                        environment: threadRef.environmentId,
                        context: preview.workspaceID,
                        tab: "agents",
                        editReviewSkill: true,
                      }}
                    >
                      Open in session
                    </Link>
                  ) : null}
                </details>
              ) : null}
              <label htmlFor={`${id}-objective`}>Review instructions</label>
              <textarea
                id={`${id}-objective`}
                disabled={Boolean(saved) || busy}
                value={objective}
                maxLength={4000}
                rows={3}
                onChange={(event) => setObjective(event.target.value)}
              />
              <button
                type="button"
                disabled={
                  busy ||
                  !enabled ||
                  !instance ||
                  !model ||
                  !objective.trim() ||
                  initial.error ||
                  record?.state === "accepted" ||
                  (Boolean(saved) && !queueMode) ||
                  ["accepted", "cancelled", "needs_refresh", "failed"].includes(queue?.state ?? "")
                }
                onClick={() => void submit()}
              >
                {saved ? "Continue saved review" : "Schedule reviewer"}
              </button>
            </>
          ) : null}
          {saved ? (
            <button type="button" disabled={busy} onClick={() => void check()}>
              Check saved result
            </button>
          ) : null}
          {queue && ["queued", "needs_refresh"].includes(queue.state) ? (
            <button type="button" disabled={busy || !enabled} onClick={() => void cancel()}>
              Cancel scheduled review
            </button>
          ) : null}
          {queue?.state === "accepted" && queue.creation?.threadID ? (
            <Link
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams({
                environmentId: threadRef.environmentId,
                threadId: queue.creation.threadID,
              })}
            >
              Open reviewer conversation
            </Link>
          ) : null}
          {record?.launch && record.state === "accepted" ? (
            <Link
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams({
                environmentId: threadRef.environmentId,
                threadId: record.launch.threadId,
              })}
            >
              Open reviewer conversation
            </Link>
          ) : null}
          {saved &&
          (missing ||
            record?.state === "accepted" ||
            record?.state === "failed" ||
            ["accepted", "cancelled", "needs_refresh"].includes(queue?.state ?? "")) ? (
            <button type="button" disabled={busy} onClick={reset}>
              Start another review
            </button>
          ) : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
