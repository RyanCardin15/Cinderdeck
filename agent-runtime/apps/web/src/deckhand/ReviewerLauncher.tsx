import { useEffect, useId, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ProviderSessionId, type ScopedThreadRef } from "@cinderdeck/contracts";
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
  stopReviewerSource,
  sessionLaunchOptions,
  inspectSessionCreation,
} from "./state";
import styles from "./laneSession.module.css";
const isRpcError = Schema.is(Rpc.DeckhandRpcError);
const decodeSaved = Schema.decodeUnknownSync(Schema.fromJsonString(Rpc.ReviewerLaunchInput));
const encodeSaved = Schema.encodeSync(Schema.fromJsonString(Rpc.ReviewerLaunchInput));
const decodeInput = Schema.decodeUnknownSync(Rpc.ReviewerLaunchInput);
function errorMessage(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause);
  const reason = isRpcError(error) ? error.reason : "unknown";
  return reason === "dirty_source"
    ? "Commit or discard source changes before reviewing this revision."
    : reason === "stale_context"
      ? "The source changed. Inspect the saved request before starting a new review."
      : "The review result could not be confirmed. Check the saved request before retrying.";
}
export function ReviewerLauncher({
  threadRef,
  enabled,
  providerSessionId,
}: {
  threadRef: ScopedThreadRef;
  enabled: boolean;
  providerSessionId?: string | null;
}) {
  const id = useId();
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
  const [objective, setObjective] = useState(
    initial.saved?.objective ??
      "Find correctness gaps, regressions, and missing tests. Report actionable findings with file references.",
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(
    initial.error
      ? "Saved review request could not be read. Restore browser storage before starting another review."
      : "",
  );
  const [record, setRecord] = useState<Rpc.ManagedCreateRecord | null>(null);
  const [missing, setMissing] = useState(false);
  const refusedBeforeEffects =
    record?.state === "failed" &&
    record.laneID === null &&
    record.launch === null &&
    record.receipt?.state === "failed" &&
    record.receipt.result == null &&
    record.receipt.error?.code === "checkout_reserved";
  const inspectSource = useAtomCommand(previewReviewer, { reportFailure: false });
  const launch = useAtomCommand(scheduleReviewer, { reportFailure: false });
  const inspectQueue = useAtomCommand(inspectReviewerQueue, { reportFailure: false });
  const cancelQueue = useAtomCommand(cancelReviewerQueue, { reportFailure: false });
  const stopWriter = useAtomCommand(stopReviewerSource, { reportFailure: false });
  const options = useAtomCommand(sessionLaunchOptions, { reportFailure: false });
  const inspect = useAtomCommand(inspectSessionCreation, { reportFailure: false });
  useEffect(() => {
    let active = true;
    void options({ environmentId: threadRef.environmentId, input: {} }).then((result) => {
      if (!active) return;
      if (result._tag === "Success") {
        setChoices(result.value);
        if (!initial.saved) {
          setInstance(result.value[0]?.instanceId ?? "");
          setModel(result.value[0]?.models[0]?.id ?? "");
        }
      }
    });
    return () => {
      active = false;
    };
  }, [initial.saved, options, threadRef.environmentId]);
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
      setMessage(
        result.value.state === "failed" && result.value.receipt?.error?.code === "checkout_reserved"
          ? "Review scheduling is blocked while the writer reserves the repository. Finish or release the writer, then inspect the latest committed revision and start a new review."
          : `Saved review: ${result.value.state.replaceAll("_", " ")}`,
      );
    } else {
      const error = Cause.squash(result.cause);
      setMissing(isRpcError(error) && error.reason === "missing");
      setMessage(errorMessage(result.cause));
    }
  };
  const prepare = async () => {
    setBusy(true);
    const result = await inspectSource({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setPreview(result.value);
      setMessage(
        "Review these committed heads before scheduling. A separate lane will preserve the writer’s checkout.",
      );
    } else setMessage(errorMessage(result.cause));
  };
  const submit = async () => {
    if (!preview || (saved && !queueMode)) return;
    setBusy(true);
    try {
      const request =
        saved ??
        decodeInput({
          operationKey: await runtime.runPromise(
            Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
          ),
          preview,
          modelSelection: { instanceId: instance, model },
          runtimeMode: "approval-required",
          objective,
        });
      localStorage.setItem(key, encodeSaved(request));
      localStorage.setItem(`${key}:mode`, "queue");
      setQueueMode(true);
      setSaved(request);
      setMissing(false);
      const result = await launch({ environmentId: threadRef.environmentId, input: request });
      if (result._tag === "Success") {
        setQueue(result.value);
        setMessage(result.value.detail ?? `Review ${result.value.state.replaceAll("_", " ")}.`);
      } else setMessage(errorMessage(result.cause));
    } catch {
      setMessage("This request could not be saved or validated. No new review was sent.");
    } finally {
      setBusy(false);
    }
  };
  const reset = () => {
    if (
      !missing &&
      record?.state !== "accepted" &&
      !refusedBeforeEffects &&
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
  const stop = async () => {
    if (!providerSessionId) return;
    setBusy(true);
    const result = await stopWriter({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        providerSessionId: ProviderSessionId.make(providerSessionId),
      },
    });
    setBusy(false);
    if (result._tag === "Success") setMessage(result.value.detail);
    else setMessage(errorMessage(result.cause));
  };
  return (
    <details className={styles.reviewer}>
      <summary>Schedule isolated review</summary>
      <div className={styles.reviewerForm}>
        <h2>Review this feature</h2>
        <p>
          The reviewer gets a separate lane pinned to every repository’s committed head. Scheduling
          waits for the writer’s process to release its repository reservation, even after a turn
          finishes. Stop the writer below to release it while preserving its lane and transcript.
          Uncommitted source changes must be resolved first.
        </p>
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
            <select
              id={`${id}-provider`}
              disabled={Boolean(saved) || busy}
              value={instance}
              onChange={(event) => {
                setInstance(event.target.value);
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
            <label htmlFor={`${id}-model`}>Model</label>
            <select
              id={`${id}-model`}
              disabled={Boolean(saved) || busy}
              value={model}
              onChange={(event) => setModel(event.target.value)}
            >
              {choices
                .find((choice) => choice.instanceId === instance)
                ?.models.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
            </select>
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
                refusedBeforeEffects ||
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
        {queue?.state === "waiting_writer" && providerSessionId ? (
          <button type="button" disabled={busy || !enabled} onClick={() => void stop()}>
            Stop writer and release review
          </button>
        ) : null}
        {queue && ["queued", "waiting_writer", "needs_refresh"].includes(queue.state) ? (
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
          refusedBeforeEffects ||
          ["accepted", "cancelled", "needs_refresh"].includes(queue?.state ?? "")) ? (
          <button type="button" disabled={busy} onClick={reset}>
            Start another review
          </button>
        ) : null}
      </div>
    </details>
  );
}
