import { useEffect, useId, useRef, useState } from "react";
import { ProviderSessionId, type ScopedThreadRef } from "@cinderdeck/contracts";
import type { ThreadContextView } from "@cinderdeck/contracts/deckhand/rpc";
import type { ReviewerSourceStopResult } from "@cinderdeck/contracts/deckhand/reviewerRpc";
import { CircleStopIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useAtomCommand } from "../state/use-atom-command";
import { stopReviewerSource } from "./state";
import styles from "./managedSessionControl.module.css";

type Props = {
  threadRef: ScopedThreadRef;
  context: ThreadContextView;
  enabled: boolean;
};

/** The existing source-stop action confirms that the provider process stopped. */
export function ManagedSessionControl(props: Props) {
  if (props.context.session.role !== "writer") return null;
  const { context, threadRef } = props;
  return (
    <WriterSessionControl
      key={JSON.stringify([
        threadRef.environmentId,
        threadRef.threadId,
        context.workspace.environmentId,
        context.checkout.id,
        context.checkout.nativeGeneration,
        context.session.providerSessionId,
      ])}
      {...props}
    />
  );
}

function WriterSessionControl({ threadRef, context, enabled }: Props) {
  const id = useId();
  const stop = useAtomCommand(stopReviewerSource, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ReviewerSourceStopResult["state"] | null>(null);
  const [message, setMessage] = useState("");
  const [releaseSequence, setReleaseSequence] = useState<number | null>(null);
  const lifetime = useRef(true);
  useEffect(() => {
    lifetime.current = true;
    return () => {
      lifetime.current = false;
    };
  }, []);
  const ownThread =
    threadRef.threadId === context.session.threadId &&
    (context.requestedThreadId ?? threadRef.threadId) === context.session.threadId;
  const providerSessionId = context.session.providerSessionId;
  const exactNative =
    context.native?.available === true &&
    context.native.workspaceID === (context.checkout.laneId ?? context.workspace.ownerId) &&
    context.native.generation === context.checkout.nativeGeneration;
  const available =
    enabled &&
    ownThread &&
    exactNative &&
    context.nativeConnection === "connected" &&
    context.session.connection === "connected" &&
    context.session.desiredAccess === "write" &&
    context.checkout.state === "ready" &&
    Boolean(providerSessionId);
  // A saved provider-session ID can be reused by a newly resumed process.
  // A newer connected binding supersedes the previous confirmed release.
  const resumed =
    outcome === "released" &&
    releaseSequence !== null &&
    context.session.connection === "connected" &&
    context.session.lastSequence > releaseSequence;
  const currentOutcome = resumed ? null : outcome;
  const disabled =
    !available || busy || currentOutcome === "released" || currentOutcome === "unknown_outcome";
  const label = busy
    ? "Stopping agent…"
    : currentOutcome === "released"
      ? "Agent stopped"
      : "Stop agent";
  const stopAgent = async () => {
    if (disabled || !providerSessionId) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await stop({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          providerSessionId: ProviderSessionId.make(providerSessionId),
        },
      });
      if (!lifetime.current) return;
      if (result._tag === "Failure" || result.value.threadId !== threadRef.threadId) {
        setOutcome("unknown_outcome");
        setMessage(
          "The stop could not be confirmed. Check the agent’s current connection before taking another checkout action.",
        );
        return;
      }
      setOutcome(result.value.state);
      if (result.value.state === "released") setReleaseSequence(context.session.lastSequence);
      setMessage(
        result.value.state === "released"
          ? "Agent stopped. Your conversation and lane files are kept. Your next message can start another agent session."
          : result.value.state === "shared_session"
            ? "This agent process is shared with other conversations and was not stopped."
            : "The agent’s stop could not be confirmed.",
      );
    } catch {
      if (lifetime.current) {
        setOutcome("unknown_outcome");
        setMessage(
          "The stop response was lost. The agent stop is unconfirmed; no second stop was sent.",
        );
      }
    } finally {
      if (lifetime.current) setBusy(false);
    }
  };
  return (
    <div className={styles.control}>
      <Tooltip>
        <TooltipTrigger render={<span />}>
          <button
            type="button"
            className={styles.stop}
            disabled={disabled}
            onClick={() => void stopAgent()}
            aria-busy={busy}
            aria-describedby={message && !resumed ? `${id}-result` : undefined}
          >
            <CircleStopIcon aria-hidden size={14} />
            {label}
          </button>
        </TooltipTrigger>
        <TooltipPopup>
          {!ownThread
            ? "Stop the agent from its parent conversation."
            : "Stops this agent. Conversation and files are kept."}
        </TooltipPopup>
      </Tooltip>
      {message && !resumed ? (
        <details className={styles.result} open>
          <summary>{outcome === "released" ? "Agent stopped" : "Agent stop not confirmed"}</summary>
          <p id={`${id}-result`} role="status">
            {message}
          </p>
        </details>
      ) : null}
    </div>
  );
}
