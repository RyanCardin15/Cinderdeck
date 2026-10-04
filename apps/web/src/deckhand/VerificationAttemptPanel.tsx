import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import type { VerificationContext } from "@t3tools/contracts/deckhand/verificationRpc";
import type {
  AttemptPreview,
  VerificationAttempt,
  AttemptAdvance,
  AttemptSummary,
} from "@t3tools/contracts/deckhand/verificationAttemptsRpc";
import {
  AttemptError,
  toAttemptSummary,
} from "@t3tools/contracts/deckhand/verificationAttemptsRpc";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { ShieldCheckIcon, GitCommitHorizontalIcon, RefreshCwIcon } from "lucide-react";
import { randomUUID } from "../lib/utils";
import { useAtomCommand } from "../state/use-atom-command";
import {
  previewAttempt,
  startAttempt,
  getAttempt,
  listAttempts,
  advanceAttempt,
  pendingAttemptView,
  needsAttemptObservation,
} from "./verificationAttemptState";
import type { RecordingContext } from "@t3tools/contracts/deckhand/recordingsRpc";
import styles from "./verificationAttempt.module.css";
import { OwnedPreviewCaptureControl } from "./OwnedPreviewCaptureControl";
const isAttemptError = Schema.is(AttemptError);
type VerificationAttemptPanelProps = {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  candidate: VerificationContext | undefined;
  recordingID: string;
  onCaptureContext: (value: { context: RecordingContext; receiptID: string } | null) => void;
};
export function VerificationAttemptPanel(props: VerificationAttemptPanelProps) {
  return (
    <ScopedVerificationAttemptPanel
      key={JSON.stringify([
        props.environmentId,
        props.reference.projectId,
        props.reference.host,
        props.reference.expectedAccountId,
        props.reference.allowStale,
        props.reference.repository,
        props.reference.number,
      ])}
      {...props}
    />
  );
}
function ScopedVerificationAttemptPanel({
  environmentId,
  reference: incomingReference,
  candidate,
  recordingID,
  onCaptureContext,
}: VerificationAttemptPanelProps) {
  // The keyed parent fixes this reference for the lifetime of this scope.
  // Equivalent parent renders must not invalidate an in-flight action.
  const [reference] = useState(incomingReference);
  const previewCommand = useAtomCommand(previewAttempt, { reportFailure: false });
  const startCommand = useAtomCommand(startAttempt, { reportFailure: false });
  const getCommand = useAtomCommand(getAttempt, { reportFailure: false });
  const listCommand = useAtomCommand(listAttempts, { reportFailure: false });
  const advanceCommand = useAtomCommand(advanceAttempt, { reportFailure: false });
  const [serviceID, setServiceID] = useState("");
  const [preview, setPreview] = useState<AttemptPreview | null>(null);
  const [attempt, setAttempt] = useState<VerificationAttempt | null>(null);
  const [history, setHistory] = useState<ReadonlyArray<AttemptSummary>>([]);
  const [ownedRecording, setOwnedRecording] = useState<{
    operationKey: string;
    recordingID: string;
  } | null>(null);
  const attemptKey = attempt?.operationKey;
  const ownedRecordingID =
    ownedRecording && ownedRecording.operationKey === attemptKey ? ownedRecording.recordingID : "";
  const saveOwnedRecording = useCallback(
    (recordingID: string) => {
      if (attemptKey) setOwnedRecording({ operationKey: attemptKey, recordingID });
    },
    [attemptKey],
  );
  const [busy, setBusy] = useState(false);
  // A failed command may have persisted its intent even before its response
  // arrives. Recover that exact key; never start another action automatically.
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const originalKey = useRef<string | null>(null);
  const cancellationKey = useRef<string | null>(null);
  useEffect(() => {
    const version = ++epoch.current;
    void listCommand({ environmentId, input: { reference } }).then((result) => {
      if (version === epoch.current && result._tag === "Success") setHistory(result.value);
    });
    return () => {
      epoch.current++;
    };
  }, [environmentId, reference, listCommand]);
  const run = async (
    action: "preview" | "start" | "refresh" | AttemptAdvance["action"],
    selected: Pick<VerificationAttempt, "operationKey"> | null = attempt,
  ) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const version = epoch.current;
    try {
      if (action === "preview") {
        if (!candidate) return;
        const result = await previewCommand({
          environmentId,
          input: {
            reference,
            featureID: candidate.feature.id,
            checkoutID: candidate.checkout.id,
            serviceID: serviceID.trim(),
          },
        });
        if (result._tag === "Failure") throw Cause.squash(result.cause);
        if (version === epoch.current) {
          setPreview(result.value);
          originalKey.current = null;
        }
      } else {
        const key =
          action === "start"
            ? (originalKey.current ??= randomUUID())
            : (selected?.operationKey ?? recoveryKey);
        if (!key) return;
        if (action !== "refresh") setRecoveryKey(key);
        const result =
          action === "start" && preview
            ? await startCommand({ environmentId, input: { operationKey: key, preview } })
            : action === "refresh"
              ? await getCommand({ environmentId, input: { operationKey: key } })
              : await advanceCommand({
                  environmentId,
                  input: {
                    operationKey: key,
                    action: action as AttemptAdvance["action"],
                    ...(action === "cancel" &&
                    (attempt?.pendingAction === "cancel" ||
                      attempt?.pendingAction === "finalize" ||
                      attempt?.receipt?.operations.some(
                        (operation) =>
                          operation.action === "finish" &&
                          (operation.state === "failed" || operation.state === "unknown"),
                      ))
                      ? { cancellationKey: (cancellationKey.current ??= randomUUID()) }
                      : {}),
                    ...(ownedRecordingID || recordingID
                      ? { recordingID: ownedRecordingID || recordingID }
                      : {}),
                  },
                });
        if (result._tag === "Failure") throw Cause.squash(result.cause);
        if (version === epoch.current) {
          setAttempt(result.value);
          setRecoveryKey(needsAttemptObservation(result.value) ? key : null);
          cancellationKey.current = null;
          setHistory((items) =>
            [
              toAttemptSummary(result.value),
              ...items.filter((item) => item.operationKey !== key),
            ].slice(0, 30),
          );
        }
      }
    } catch (cause) {
      if (version === epoch.current) {
        // The server rejects this named refusal before persisting an attempt
        // or starting its build. A transport failure cannot establish that.
        if (action === "start" && isAttemptError(cause) && cause.reason === "stale_preview") {
          setRecoveryKey(null);
          setPreview(null);
        }
        setError(
          cause instanceof Error
            ? cause.message
            : "Verification is unavailable. Refresh the saved receipt before retrying.",
        );
      }
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  };
  const observe = useCallback(
    (value: VerificationAttempt) => {
      const expectedKey = recoveryKey ?? attempt?.operationKey;
      if (
        value.operationKey !== expectedKey ||
        (attempt?.operationKey === value.operationKey && value.updatedAt < attempt.updatedAt)
      )
        return;
      setAttempt(value);
      setRecoveryKey(needsAttemptObservation(value) ? value.operationKey : null);
      if (!needsAttemptObservation(value)) setError(null);
      setHistory((items) =>
        [
          toAttemptSummary(value),
          ...items.filter((item) => item.operationKey !== value.operationKey),
        ].slice(0, 30),
      );
    },
    [recoveryKey, attempt],
  );
  const observedKey =
    recoveryKey ?? (attempt && needsAttemptObservation(attempt) ? attempt.operationKey : null);
  const recovering = Boolean(observedKey);
  const receipt = attempt?.receipt;
  useEffect(() => {
    onCaptureContext(
      attempt && receipt?.launch && !["completed", "cancelled"].includes(attempt.phase)
        ? { context: attempt.preview.context, receiptID: receipt.id }
        : null,
    );
  }, [attempt, receipt, onCaptureContext]);
  const mayStartAnother =
    attempt?.phase === "cancelled" ||
    attempt?.phase === "completed" ||
    (attempt?.phase === "failed" &&
      receipt?.reservationState === "released" &&
      !attempt.pendingAction);
  const terminal = attempt?.phase === "completed" || attempt?.phase === "cancelled";
  const blocked =
    busy ||
    recovering ||
    !receipt ||
    attempt?.phase === "unknown" ||
    Boolean(attempt?.pendingAction) ||
    terminal;
  return (
    <section className={styles.panel} aria-label="Pinned verification attempt">
      <header>
        <ShieldCheckIcon size={19} />
        <div>
          <h3>Verify this revision</h3>
          <p>Build and check the exact PR source, then capture the running result.</p>
        </div>
      </header>
      {!busy && observedKey ? (
        <PendingAttemptObservation
          key={`${environmentId}:${observedKey}`}
          environmentId={environmentId}
          operationKey={observedKey}
          minimumUpdatedAt={attempt?.updatedAt ?? ""}
          onObserved={observe}
        />
      ) : null}
      {!attempt && recoveryKey ? (
        <button disabled={busy} onClick={() => void run("refresh")}>
          <RefreshCwIcon size={13} />
          Refresh saved attempt
        </button>
      ) : null}
      {!attempt ? (
        <>
          <div className={styles.form}>
            <label>
              Service to verify
              <input
                value={serviceID}
                onChange={(event) => {
                  setServiceID(event.target.value);
                  setPreview(null);
                }}
                placeholder="Configured service name, for example web"
                disabled={busy || recovering}
              />
            </label>
            <button
              disabled={busy || recovering || !candidate || !serviceID.trim()}
              onClick={() => void run("preview")}
            >
              Pin current PR head
            </button>
          </div>
          <p className={styles.hint}>
            Select a clean feature checkout above. Its configured build and required checks run
            under a reservation until you finish or cancel.
          </p>
          {preview ? (
            <div className={styles.preview}>
              <GitCommitHorizontalIcon size={14} />
              <code>{preview.head.slice(0, 12)}</code>
              <span>
                {preview.repositories.length} repositories ·{" "}
                {preview.descriptor.adapter.requiredTaskIDs.length} required checks
              </span>
              <button disabled={busy || recovering} onClick={() => void run("start")}>
                Build pinned revision
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className={styles.summary}>
            <span data-state={attempt.verdict}>
              {attempt.verdict === "matches"
                ? "Verification matches this commit"
                : attempt.verdict === "earlier_revision"
                  ? "Earlier PR revision"
                  : attempt.verdict === "checks_failed"
                    ? "Required checks failed"
                    : "Verification incomplete"}
            </span>
            <code>{attempt.preview.head.slice(0, 12)}</code>
            <span>{attempt.phase}</span>
            <button disabled={busy} onClick={() => void run("refresh")}>
              <RefreshCwIcon size={13} />
              Refresh receipt
            </button>
            {mayStartAnother ? (
              <button
                disabled={busy}
                onClick={() => {
                  setAttempt(null);
                  setRecoveryKey(null);
                  setPreview(null);
                  originalKey.current = null;
                  onCaptureContext(null);
                }}
              >
                Start another attempt
              </button>
            ) : null}
          </div>
          <p>{attempt.detail}</p>
          {attempt.buildAndChecksMatch ? (
            <p className={styles.hint}>
              {attempt.verdict === "matches"
                ? "Pinned source, required checks, served artifact and the owned browser video match."
                : attempt.verdict === "earlier_revision"
                  ? "Build and check receipts match the pinned source. This evidence belongs to an earlier PR revision."
                  : "Build and check receipts match pinned source. Full video verification remains incomplete."}
            </p>
          ) : null}
          {receipt ? (
            <dl className={styles.facts}>
              <div>
                <dt>Build run</dt>
                <dd>{receipt.buildRunID ?? "Not started"}</dd>
              </div>
              <div>
                <dt>Artifact</dt>
                <dd>{receipt.artifact?.sha256.slice(0, 16) ?? "No captured artifact"}</dd>
              </div>
              <div>
                <dt>Checkout reservation</dt>
                <dd>{receipt.reservationState}</dd>
              </div>
              {receipt.checks.map((check) => (
                <div key={check.taskID}>
                  <dt>{check.taskID}</dt>
                  <dd>
                    {check.status} · {check.runID}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          <div className={styles.actions}>
            <button
              disabled={blocked || receipt?.state !== "ready"}
              onClick={() => void run("launch")}
            >
              Launch built service
            </button>
            <button
              disabled={blocked || !["ready", "running"].includes(receipt?.state ?? "")}
              onClick={() => void run("checks")}
            >
              Run required checks
            </button>
            <button
              disabled={blocked || !(ownedRecordingID || recordingID)}
              onClick={() => void run("finalize")}
            >
              Finish with selected recording
            </button>
            <button disabled={busy || terminal || !receipt} onClick={() => void run("cancel")}>
              {attempt.pendingAction === "cancel" || attempt.pendingAction === "finalize"
                ? "Retry cancellation after stopping owned processes"
                : "Cancel and release"}
            </button>
          </div>
          {receipt ? (
            <OwnedPreviewCaptureControl
              environmentId={environmentId}
              attemptOperationKey={attempt.operationKey}
              enabled={
                !blocked && receipt.state === "running" && receipt.reservationState === "held"
              }
              onRecording={saveOwnedRecording}
            />
          ) : null}
          <p className={styles.hint}>
            Record the launched service below. A useful recording remains incomplete until it
            carries matching build proof and every required check passes.
          </p>
        </>
      )}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {history.length ? (
        <details>
          <summary>Saved attempts · {history.length}</summary>
          <div className={styles.history}>
            {history.map((item) => (
              <button
                key={item.operationKey}
                disabled={busy}
                onClick={() => {
                  void run("refresh", item);
                }}
              >
                <code>{item.preview.head.slice(0, 12)}</code>
                <span>{item.preview.serviceID}</span>
                <span>{item.phase}</span>
              </button>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function PendingAttemptObservation({
  environmentId,
  operationKey,
  minimumUpdatedAt,
  onObserved,
}: {
  environmentId: EnvironmentId;
  operationKey: string;
  minimumUpdatedAt: string;
  onObserved: (value: VerificationAttempt) => void;
}) {
  const result = useAtomValue(
    pendingAttemptView({
      environmentId,
      input: { operationKey },
    }),
  );
  useEffect(() => {
    if (
      result._tag === "Success" &&
      !result.waiting &&
      result.value.operationKey === operationKey &&
      result.value.updatedAt >= minimumUpdatedAt
    ) {
      onObserved(result.value);
    }
  }, [result, operationKey, minimumUpdatedAt, onObserved]);
  return result._tag === "Failure" ? (
    <p role="alert" className={styles.error}>
      Status is unavailable. The last receipt is retained; automatic reads will retry. You can also
      refresh the saved attempt manually.
    </p>
  ) : (
    <p role="status" className={styles.hint}>
      Watching the saved action for a definitive receipt…
    </p>
  );
}
