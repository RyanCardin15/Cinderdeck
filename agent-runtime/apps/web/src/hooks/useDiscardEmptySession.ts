import { useEffect } from "react";
import { scopedThreadKey } from "@cinderdeck/client-runtime/environment";
import type { ScopedThreadRef } from "@cinderdeck/contracts";

import { composerDraftHasUserContent, useComposerDraftStore } from "../composerDraftStore";
import { readThreadShell, readEnvironmentSupportsEmptyThreadDiscard } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { threadShellHasStarted } from "../components/ChatView.logic";

const visits = new Map<string, { owners: number; used: boolean }>();

/** Latch send intent before uploads/settings awaits and before the composer clears. */
export function preserveSessionOnSubmission(ref: ScopedThreadRef): void {
  const visit = visits.get(scopedThreadKey(ref));
  if (visit) visit.used = true;
}

export function useDiscardEmptySession(ref: ScopedThreadRef | null): void {
  const discard = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const environmentId = ref?.environmentId;
  const threadId = ref?.threadId;
  useEffect(() => {
    if (environmentId === undefined || threadId === undefined) return;
    const target = { environmentId, threadId };
    const key = scopedThreadKey(target);
    const visit = visits.get(key) ?? { owners: 0, used: false };
    visits.set(key, visit);
    visit.owners++;
    return () => {
      visit.owners--;
      // StrictMode and same-thread route promotion remount within this turn.
      // Waiting one microtask also lets the composer finish its unmount save.
      queueMicrotask(() => {
        if (visit.owners > 0) return;
        visits.delete(key);
        if (visit.used || !readEnvironmentSupportsEmptyThreadDiscard(environmentId)) return;
        const store = useComposerDraftStore.getState();
        const draftId = store.getDraftIdByRef(target);
        if (
          store.backgroundSubmissionThreadKeys[key] ||
          composerDraftHasUserContent(store.getComposerDraft(draftId ?? target)) ||
          threadShellHasStarted(readThreadShell(target))
        )
          return;
        // No navigation or delete confirmation: the user already left an
        // unused conversation. The server makes the final atomic decision.
        void discard({ environmentId, input: { threadId, onlyIfUnused: true } });
      });
    };
  }, [environmentId, threadId, discard]);
}
