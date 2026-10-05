import { useEffect } from "react";
import type { ScopedThreadRef } from "@cinderdeck/contracts";
import { useAtomCommand } from "../state/use-atom-command";
import { publishLinkedWork } from "./state";
/** A bounded heartbeat expires honestly in Cinderdeck if this client or native connection stops. */
export function LinkedWorkContext({
  threadRef,
  enabled,
}: {
  threadRef: ScopedThreadRef;
  enabled: boolean;
}) {
  const publish = useAtomCommand(publishLinkedWork, { reportFailure: false });
  useEffect(() => {
    let pending = false;
    const observe = async () => {
      if (!enabled || pending) return;
      pending = true;
      await publish({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      pending = false;
    };
    void observe();
    const timer = setInterval(() => void observe(), 30_000);
    return () => {
      clearInterval(timer);
    };
  }, [publish, threadRef.environmentId, threadRef.threadId, enabled]);
  // The conversation is already inside Cinderdeck; publishing needs no navigation control.
  return null;
}
