import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import type { VerificationContext } from "@t3tools/contracts/deckhand/verificationRpc";
import type {
  AttemptPreview,
  VerificationAttempt,
  AttemptAdvance,
  AttemptSummary,
} from "@t3tools/contracts/deckhand/verificationAttemptsRpc";
import { toAttemptSummary } from "@t3tools/contracts/deckhand/verificationAttemptsRpc";
import { useEffect, useRef, useState } from "react";
import * as Cause from "effect/Cause";
import { ShieldCheckIcon, GitCommitHorizontalIcon, RefreshCwIcon } from "lucide-react";
import { randomUUID } from "../lib/utils";
import { useAtomCommand } from "../state/use-atom-command";
import {
  previewAttempt,
  startAttempt,
  getAttempt,
  listAttempts,
  advanceAttempt,
} from "./verificationAttemptState";
import type { RecordingContext } from "@t3tools/contracts/deckhand/recordingsRpc";
import styles from "./verificationAttempt.module.css";
import { OwnedPreviewCaptureControl } from "./OwnedPreviewCaptureControl";
export function VerificationAttemptPanel({
  environmentId,
  reference,
  candidate,
  recordingID,
  onCaptureContext,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  candidate: VerificationContext | undefined;
  recordingID: string;
  onCaptureContext: (value: { context: RecordingContext; receiptID: string } | null) => void;
}) {
  const previewCommand = useAtomCommand(previewAttempt, { reportFailure: false });
  const startCommand = useAtomCommand(startAttempt, { reportFailure: false });
  const getCommand = useAtomCommand(getAttempt, { reportFailure: false });
  const listCommand = useAtomCommand(listAttempts, { reportFailure: false });
  const advanceCommand = useAtomCommand(advanceAttempt, { reportFailure: false });
  const [serviceID, setServiceID] = useState("");
  const [preview, setPreview] = useState<AttemptPreview | null>(null);
  const [attempt, setAttempt] = useState<VerificationAttempt | null>(null);
  const [history, setHistory] = useState<ReadonlyArray<AttemptSummary>>([]);
  const [ownedRecordingID, setOwnedRecordingID] = useState("");
  useEffect(() => {
    setOwnedRecordingID("");
  }, [attempt?.operationKey]);
  const [busy, setBusy] = useState(false);
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
          action === "start" ? (originalKey.current ??= randomUUID()) : selected?.operationKey;
        if (!key) return;
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
      if (version === epoch.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Verification is unavailable. Refresh the saved receipt before retrying.",
        );
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  };
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
    busy || !receipt || attempt?.phase === "unknown" || Boolean(attempt?.pendingAction) || terminal;
  return (
    <section className={styles.panel} aria-label="Pinned verification attempt">
      <header>
        <ShieldCheckIcon size={19} />
        <div>
          <h3>Verify this revision</h3>
          <p>Build and check the exact PR source, then capture the running result.</p>
        </div>
      </header>
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
                disabled={busy}
              />
            </label>
            <button
              disabled={busy || !candidate || !serviceID.trim()}
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
              <button disabled={busy} onClick={() => void run("start")}>
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
              Build and check receipts match pinned source. The video target is unverified.
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
              onRecording={setOwnedRecordingID}
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
