import { squashAtomCommandFailure } from "@cinderdeck/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@cinderdeck/contracts";
import { useCallback, useMemo } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { usePrimaryEnvironmentId } from "../state/environments";
import { terminalEnvironment } from "../state/terminal";
import { useAtomCommand } from "../state/use-atom-command";
import { useCopyToClipboard } from "./useCopyToClipboard";

/**
 * Opens a thread's Claude Code or Codex session in the user's own terminal app,
 * or copies the command that does. A thread whose run is in flight is forked
 * (Claude) so the terminal does not write into the agent's live transcript.
 */
export function useThreadSessionTerminal() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const openThreadSession = useAtomCommand(terminalEnvironment.openThreadSession, {
    reportFailure: false,
  });
  const { copyToClipboard } = useCopyToClipboard<{ command: string }>({
    target: "resume command",
    onCopy: ({ command }) => {
      toastManager.add({ type: "success", title: "Resume command copied", description: command });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy resume command",
          description: error.message,
        }),
      );
    },
  });

  /** The terminal opens on the machine running the environment, so only the local one offers it. */
  const canOpen = useCallback(
    (threadRef: ScopedThreadRef) => threadRef.environmentId === primaryEnvironmentId,
    [primaryEnvironmentId],
  );

  const run = useCallback(
    async (threadRef: ScopedThreadRef, launch: boolean) => {
      const result = await openThreadSession({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, launch },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: launch ? "Could not open session in terminal" : "Could not build resume command",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }
      const { command, mode } = result.value;
      if (!launch) {
        copyToClipboard(command, { command });
        return;
      }
      toastManager.add({
        type: "success",
        title:
          mode === "fork" ? "Opened a fork of the running session" : "Opened session in terminal",
        description: command,
      });
    },
    [copyToClipboard, openThreadSession],
  );

  return useMemo(
    () => ({
      canOpen,
      openInTerminal: (threadRef: ScopedThreadRef) => run(threadRef, true),
      copyResumeCommand: (threadRef: ScopedThreadRef) => run(threadRef, false),
    }),
    [canOpen, run],
  );
}
