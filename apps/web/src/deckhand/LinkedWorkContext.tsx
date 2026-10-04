import { Tooltip, TooltipTrigger, TooltipPopup } from "../components/ui/tooltip";
import { isElectron } from "../env";
import { useEnvironments } from "../state/environments";
import { useEffect, useState } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ThreadContextView } from "@t3tools/contracts/deckhand/rpc";
import { linkedWorkNativeURL } from "@t3tools/contracts/deckhand/linkedWorkRpc";
import { useAtomCommand } from "../state/use-atom-command";
import { publishLinkedWork } from "./state";
/** A bounded heartbeat expires honestly in Cinderdeck if this client or native connection stops. */
export function LinkedWorkContext({
  threadRef,
  context,
  enabled,
}: {
  threadRef: ScopedThreadRef;
  context: ThreadContextView;
  enabled: boolean;
}) {
  const { environments } = useEnvironments();
  const localDesktop =
    isElectron &&
    environments.some(
      (entry) =>
        entry.environmentId === threadRef.environmentId &&
        entry.entry.target._tag === "PrimaryConnectionTarget",
    );
  const publish = useAtomCommand(publishLinkedWork, { reportFailure: false });
  const [status, setStatus] = useState("Not yet published");
  useEffect(() => {
    let active = true;
    let pending = false;
    const observe = async () => {
      if (!enabled || pending) return;
      pending = true;
      const result = await publish({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      pending = false;
      if (active)
        setStatus(
          result._tag === "Success"
            ? "Linked in Cinderdeck"
            : "Last native observation unavailable",
        );
    };
    void observe();
    const timer = setInterval(() => void observe(), 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [publish, threadRef.environmentId, threadRef.threadId, enabled]);
  const target = {
    installation: context.workspace.environmentId,
    workspace: context.checkout.laneId ?? context.workspace.ownerId,
    generation: context.checkout.nativeGeneration!,
  };
  if (!localDesktop || context.nativeChannel !== "release")
    return (
      <Tooltip>
        <TooltipTrigger render={<span tabIndex={0} />}>Cinderdeck</TooltipTrigger>
        <TooltipPopup>
          Open Workspaces on the Cinderdeck execution host and select Agents & linked work. The
          development app shares the release URL scheme.
        </TooltipPopup>
      </Tooltip>
    );
  return (
    <Tooltip>
      <TooltipTrigger render={<a href={linkedWorkNativeURL(target)} />}>
        Open in Cinderdeck
      </TooltipTrigger>
      <TooltipPopup>
        {enabled
          ? status
          : "Native connection unavailable; saved linked work may still be visible."}
      </TooltipPopup>
    </Tooltip>
  );
}
