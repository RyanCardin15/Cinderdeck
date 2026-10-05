import { useEffect } from "react";
import type { ScopedThreadRef } from "@cinderdeck/contracts";
import type { DebugSession } from "@cinderdeck/contracts/deckhand/externalDebugRpc";
import {
  resolveExternalAppProfiles,
  type ExternalAppProfile,
} from "@cinderdeck/contracts/deckhand/externalAppPreferences";
import { useClientSettings } from "../hooks/useSettings";
import { useAtomCommand } from "../state/use-atom-command";
import { useRightPanelStore } from "../rightPanelStore";
import { listDebugSessions } from "./externalDebugState";
import {
  externalAppBindingKey,
  useExternalAppSessions,
  type ExternalAppBinding,
} from "./externalAppSessions";

const matches = (session: DebugSession, filter: string) =>
  `${session.target.app ?? ""} ${session.target.url} ${session.target.title}`
    .toLowerCase()
    .includes(filter.trim().toLowerCase());

// UI and MCP own the same thread-scoped backend sessions. Presentation never
// creates another capture connection or grants input permission.
export function agentAppBindings(
  threadRef: ScopedThreadRef,
  sessions: readonly DebugSession[],
  profiles: readonly ExternalAppProfile[],
): ExternalAppBinding[] {
  const connected = sessions.filter(
    (session) => session.state === "connected" && session.target.type === "mac-window",
  );
  const groups = new Map<string, DebugSession[]>();
  const ordered = [...connected].sort(
    (a, b) =>
      Number(
        profiles.some((entry) => entry.includeInspector && matches(a, entry.inspectorFilter)),
      ) -
      Number(profiles.some((entry) => entry.includeInspector && matches(b, entry.inspectorFilter))),
  );
  for (const session of ordered) {
    const profile = profiles.find(
      (entry) => entry.applicationFilter.trim() && matches(session, entry.applicationFilter),
    );
    if (profile && !profile.enabled) continue;
    const profileId = profile?.id ?? `session-${session.sessionId}`;
    const group = groups.get(profileId) ?? [];
    // Each workbook keeps its own tab. An Inspector joins only an unambiguous
    // app from the same process, never a different workbook chosen by guesswork.
    if (!group.length) groups.set(profileId, [session]);
    else groups.set(`session-${session.sessionId}`, [session]);
  }
  for (const profile of profiles.filter((entry) => entry.enabled && entry.includeInspector)) {
    const group = groups.get(profile.id);
    if (!group || group.length !== 1) continue;
    const app = group[0]!;
    if (matches(app, profile.inspectorFilter)) continue;
    const sameProcess = connected.filter(
      (entry) =>
        entry.sessionId !== app.sessionId &&
        entry.target.id.split(":")[1] === app.target.id.split(":")[1],
    );
    const inspectors = sameProcess.filter((entry) => matches(entry, profile.inspectorFilter));
    const workbooks = sameProcess.filter((entry) => !matches(entry, profile.inspectorFilter));
    if (inspectors.length === 1 && workbooks.length === 0) {
      const inspector = inspectors[0]!;
      group.push(inspector);
      for (const [id, entries] of groups) {
        if (id !== profile.id && entries.some((entry) => entry.sessionId === inspector.sessionId))
          groups.delete(id);
      }
    }
  }
  return [...groups].map(([profileId, entries]) => ({ threadRef, profileId, sessions: entries }));
}

export function useAgentExternalApps(threadRef: ScopedThreadRef | null) {
  const profiles = useClientSettings((settings) => settings.externalAppProfiles);
  const list = useAtomCommand(listDebugSessions, { reportFailure: false });
  useEffect(() => {
    if (!threadRef) return;
    const ref = threadRef;
    let disposed = false,
      pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const seen = new Set<string>();
    async function poll() {
      if (disposed || pending || document.visibilityState !== "visible") return;
      pending = true;
      const panelRevision = useRightPanelStore.getState().getUserActionRevision(ref);
      const show = (profileId: string, title: string) =>
        useRightPanelStore
          .getState()
          .openProactive(
            ref,
            { id: `external-app:${profileId}`, kind: "external-app", profileId, title },
            panelRevision,
          );
      try {
        const result = await list({
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId },
        });
        if (disposed || result._tag !== "Success") return;
        for (const binding of agentAppBindings(
          ref,
          result.value,
          resolveExternalAppProfiles(profiles),
        )) {
          const store = useExternalAppSessions.getState();
          const owned = Object.values(store.bindings).filter(
            (entry) =>
              entry.threadRef.environmentId === ref.environmentId &&
              entry.threadRef.threadId === ref.threadId,
          );
          const assigned = new Set(
            owned.flatMap((entry) => entry.sessions.map((session) => session.sessionId)),
          );
          const fresh = binding.sessions.filter(
            (session) => !seen.has(session.sessionId) && !assigned.has(session.sessionId),
          );
          for (const session of binding.sessions) seen.add(session.sessionId);
          if (!fresh.length) continue;
          const key = externalAppBindingKey(ref, binding.profileId);
          const existing = store.bindings[key];
          if (
            existing &&
            existing.sessions.some(
              (session) => !binding.sessions.some((entry) => entry.sessionId === session.sessionId),
            )
          ) {
            // A user-selected workbook owns this preset tab; give a new workbook
            // its own transient tab instead of replacing that selection.
            for (const session of fresh) {
              const profileId = `session-${session.sessionId}`;
              store.bind({ threadRef: ref, profileId, sessions: [session] });
              show(profileId, session.target.app || "Mac app");
            }
          } else {
            const sessions = binding.sessions.filter(
              (session) =>
                !assigned.has(session.sessionId) ||
                existing?.sessions.some((entry) => entry.sessionId === session.sessionId),
            );
            store.bind({ ...binding, sessions });
            const name =
              profiles.find((profile) => profile.id === binding.profileId)?.name ??
              sessions[0]?.target.app ??
              "Mac app";
            show(binding.profileId, name);
          }
        }
      } catch {
        // A transient connection failure leaves current views intact; retry below.
      } finally {
        pending = false;
        if (!disposed && document.visibilityState === "visible")
          timer = setTimeout(() => {
            void poll();
          }, 1500);
      }
    }
    function visibility() {
      if (timer) clearTimeout(timer);
      if (document.visibilityState === "visible") void poll();
    }
    document.addEventListener("visibilitychange", visibility);
    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [threadRef?.environmentId, threadRef?.threadId, profiles, list]);
}
