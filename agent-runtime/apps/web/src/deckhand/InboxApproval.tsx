import { useRef, useState } from "react";
import type { EnvironmentId, ProviderApprovalDecision } from "@cinderdeck/contracts";
import type { AttentionItem } from "@cinderdeck/contracts/deckhand/attentionRpc";
import { derivePendingThreadRequests } from "@cinderdeck/client-runtime/state/thread-requests";
import { useThreadProjection, useThreadStatus } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import { threadEnvironment } from "../state/threads";
import styles from "./inbox.module.css";

export function InboxApproval({
  item,
  environmentId,
  live,
  onResolved,
}: {
  item: AttentionItem;
  environmentId: EnvironmentId;
  live: boolean;
  onResolved: () => void;
}) {
  const ref =
    item.target.kind === "thread" ? { environmentId, threadId: item.target.threadId } : null;
  const thread = useThreadProjection(ref);
  const status = useThreadStatus(ref);
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const requestId = item.target.kind === "thread" ? item.target.requestId : undefined;
  const request = thread
    ? derivePendingThreadRequests(thread.projection).approvals.find(
        (approval) => approval.requestId === requestId,
      )
    : null;
  const canRespond =
    live &&
    item.state === "active" &&
    status === "live" &&
    request?.responseCapability === "live" &&
    !submitted;
  const options = request?.options ?? [
    { decision: "accept" as const, label: "Approve" },
    { decision: "decline" as const, label: "Decline" },
  ];
  const act = async (decision: ProviderApprovalDecision) => {
    if (!canRespond || !ref || !request || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = await respond({
        environmentId,
        input: { threadId: ref.threadId, requestId: request.requestId, decision },
      });
      if (result._tag === "Success") {
        setSubmitted(true);
        setMessage("Decision sent. Refreshing attention…");
        onResolved();
      } else
        setMessage(
          "Could not send this decision. Open the conversation to check the current request.",
        );
    } catch {
      setMessage("Could not send this decision. Try again or open the conversation.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <div className={styles.approval}>
      {request ? (
        <pre>
          {request.detail ??
            `Approve ${request.requestKind.replaceAll("_", " ")}? Open the conversation for full context.`}
        </pre>
      ) : (
        <p>
          {!requestId
            ? "Open the conversation to review this approval."
            : !thread
              ? "Loading approval details…"
              : "This approval is no longer actionable here. Open the conversation to check it."}
        </p>
      )}
      {request?.appName ? <p>Requested by {request.appName}</p> : null}
      {request ? (
        <div className={styles.decisions}>
          {options.map((option) => (
            <div key={option.decision}>
              <button
                type="button"
                data-primary={option.decision === "accept"}
                disabled={!canRespond || busy}
                onClick={() => void act(option.decision)}
              >
                {busy ? "Sending…" : option.label}
              </button>
              {option.warning ? <p>{option.warning}</p> : null}
            </div>
          ))}
        </div>
      ) : null}
      {request && !canRespond && !submitted ? (
        <p>Live approval is unavailable. Open the conversation to continue.</p>
      ) : null}
      {message ? <p role={submitted ? "status" : "alert"}>{message}</p> : null}
    </div>
  );
}
