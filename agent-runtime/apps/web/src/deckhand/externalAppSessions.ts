import { scopedThreadKey } from "@cinderdeck/client-runtime/environment";
import type { ScopedThreadRef } from "@cinderdeck/contracts";
import type { DebugSession } from "@cinderdeck/contracts/deckhand/externalDebugRpc";
import { create } from "zustand";
import { useCallback } from "react";
import { useAtomCommand } from "../state/use-atom-command";
import { detachDebugSession } from "./externalDebugState";

export type ExternalAppBinding = {
  threadRef: ScopedThreadRef;
  profileId: string;
  sessions: readonly DebugSession[];
};
export const externalAppBindingKey = (ref: ScopedThreadRef, profileId: string) =>
  `${scopedThreadKey(ref)}:external-app:${profileId}`;
// Native session IDs are transient; only panel descriptors survive a restart.
export const useExternalAppSessions = create<{
  bindings: Record<string, ExternalAppBinding>;
  bind: (binding: ExternalAppBinding) => void;
  remove: (key: string) => void;
}>((set) => ({
  bindings: {},
  bind: (binding) =>
    set((state) => ({
      bindings: {
        ...state.bindings,
        [externalAppBindingKey(binding.threadRef, binding.profileId)]: binding,
      },
    })),
  remove: (key) =>
    set((state) => {
      const { [key]: _removed, ...bindings } = state.bindings;
      return { bindings };
    }),
}));

export function useDisconnectExternalApps() {
  const detach = useAtomCommand(detachDebugSession, { reportFailure: false });
  return useCallback(
    async (select: (binding: ExternalAppBinding) => boolean) => {
      const store = useExternalAppSessions.getState();
      const bindings = Object.entries(store.bindings).filter(([, binding]) => select(binding));
      for (const [key] of bindings) store.remove(key);
      return Promise.all(
        bindings.flatMap(([, binding]) =>
          binding.sessions.map((session) =>
            detach({
              environmentId: binding.threadRef.environmentId,
              input: { threadId: binding.threadRef.threadId, sessionId: session.sessionId },
            }),
          ),
        ),
      );
    },
    [detach],
  );
}
