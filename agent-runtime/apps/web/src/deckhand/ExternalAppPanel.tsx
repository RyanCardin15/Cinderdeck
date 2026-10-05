import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AppWindowIcon, RefreshCwIcon, Settings2Icon, UnplugIcon } from "lucide-react";
import type { ScopedThreadRef } from "@cinderdeck/contracts";
import type { DebugSession, DebugTarget } from "@cinderdeck/contracts/deckhand/externalDebugRpc";
import { resolveExternalAppProfiles } from "@cinderdeck/contracts/deckhand/externalAppPreferences";
import { squashAtomCommandFailure } from "@cinderdeck/client-runtime/state/runtime";
import { useClientSettings, useUpdateClientSettings } from "../hooks/useSettings";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironments } from "../state/environments";
import { useRightPanelStore } from "../rightPanelStore";
import { Button } from "../components/ui/button";
import { MacWindowPanel } from "./MacWindowPanel";
import { ExcelPerformancePanel } from "./ExcelPerformancePanel";
import {
  attachDebugTarget,
  detachDebugSession,
  discoverDebugTargets,
  listDebugSessions,
  openDebugApp,
} from "./externalDebugState";
import {
  externalAppBindingKey,
  useDisconnectExternalApps,
  useExternalAppSessions,
} from "./externalAppSessions";
import styles from "./externalAppPanel.module.css";

const empty: readonly DebugSession[] = [];
const failureText = (value: unknown) =>
  typeof value === "object" && value !== null && "message" in value
    ? String(value.message)
    : "Couldn’t connect to the selected Mac window. Try again.";
export const matchesExternalApp = (target: DebugTarget, filter: string) =>
  `${target.app ?? ""} ${target.url} ${target.title}`
    .toLowerCase()
    .includes(filter.trim().toLowerCase());

export function ExternalAppPanel({
  threadRef,
  profileId,
  visible,
}: {
  threadRef: ScopedThreadRef;
  profileId: string | null;
  visible: boolean;
}) {
  const settings = useClientSettings();
  const profiles = resolveExternalAppProfiles(settings.externalAppProfiles);
  const update = useUpdateClientSettings();
  const bindingKey = externalAppBindingKey(threadRef, profileId ?? "new");
  const active = useExternalAppSessions((state) => state.bindings[bindingKey]?.sessions ?? empty);
  const profile =
    profiles.find((entry) => entry.id === profileId) ??
    (profileId?.startsWith("session-") && active[0]
      ? {
          id: profileId,
          name: active[0].target.app || "Mac app",
          enabled: true,
          applicationFilter: active[0].target.url,
          includeInspector: false,
          inspectorFilter: "Web Inspector",
        }
      : undefined);
  const { environments } = useEnvironments();
  const computer =
    environments.find((entry) => entry.environmentId === threadRef.environmentId)?.label ??
    "Session Mac";
  const discover = useAtomCommand(discoverDebugTargets, { reportFailure: false });
  const attach = useAtomCommand(attachDebugTarget, { reportFailure: false });
  const detach = useAtomCommand(detachDebugSession, { reportFailure: false });
  const list = useAtomCommand(listDebugSessions, { reportFailure: false });
  const open = useAtomCommand(openDebugApp, { reportFailure: false });
  const disconnect = useDisconnectExternalApps();
  const occupied = useExternalAppSessions((state) => state.bindings);
  const usedElsewhere = (sessionId: string, bindings = occupied) =>
    Object.values(bindings).some(
      (binding) =>
        binding.profileId !== profileId &&
        binding.threadRef.environmentId === threadRef.environmentId &&
        binding.threadRef.threadId === threadRef.threadId &&
        binding.sessions.some((session) => session.sessionId === sessionId),
    );
  const [targets, setTargets] = useState<readonly DebugTarget[]>([]);
  const [existing, setExisting] = useState<readonly DebugSession[]>([]);
  const [appId, setAppId] = useState("");
  const [inspectorId, setInspectorId] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<"app" | "inspector" | "split">("app");
  const mounted = useRef(true);
  const connectionEpoch = useRef(0);
  useEffect(() => {
    if (!profile?.enabled) {
      connectionEpoch.current += 1;
      void disconnect(
        (binding) => externalAppBindingKey(binding.threadRef, binding.profileId) === bindingKey,
      );
    }
  }, [profile?.enabled, bindingKey, disconnect]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    if (profile?.enabled && visible)
      void list({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      }).then((result) => {
        if (!disposed && result._tag === "Success")
          setExisting(
            result.value.filter(
              (session) => session.state === "connected" && session.target.type === "mac-window",
            ),
          );
      });
    return () => {
      disposed = true;
    };
  }, [list, threadRef.environmentId, threadRef.threadId, profile?.enabled, visible]);
  async function find() {
    setBusy(true);
    setError("");
    try {
      const result = await discover({
        environmentId: threadRef.environmentId,
        input: { endpoint: "mac://local" },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (!mounted.current) return;
      setTargets(
        [...result.value].sort((a, b) =>
          `${a.app} ${a.title}`.localeCompare(`${b.app} ${b.title}`),
        ),
      );
      setAppId((previous) =>
        result.value.some((target) => target.id === previous) ? previous : "",
      );
      setInspectorId((previous) =>
        result.value.some((target) => target.id === previous) ? previous : "",
      );
    } catch (cause) {
      if (mounted.current) setError(failureText(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function openApp() {
    if (!profile || busy) return;
    setBusy(true);
    setError("");
    const epoch = connectionEpoch.current;
    try {
      const result = await open({
        environmentId: threadRef.environmentId,
        input: { bundleId: profile.applicationFilter, threadId: threadRef.threadId },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (!mounted.current || connectionEpoch.current !== epoch) {
        if (result.value.session)
          await detach({
            environmentId: threadRef.environmentId,
            input: { sessionId: result.value.session.sessionId, threadId: threadRef.threadId },
          });
        return;
      }
      setTargets(result.value.targets);
      if (result.value.session) {
        const session = result.value.session;
        if (usedElsewhere(session.sessionId, useExternalAppSessions.getState().bindings))
          throw new Error("This window is open in another external app tab.");
        useExternalAppSessions
          .getState()
          .bind({ threadRef, profileId: profile.id, sessions: [session] });
      } else if (!result.value.targets.length) {
        setError(
          "The app opened but has no capturable window yet. Open a test document on its Mac, then choose Find windows.",
        );
      }
    } catch (cause) {
      if (mounted.current) setError(failureText(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function connect() {
    if (!profile || !profile.enabled || busy || !appId) return;
    setBusy(true);
    setError("");
    const epoch = connectionEpoch.current;
    const ensureOpen = () => {
      if (!mounted.current || connectionEpoch.current !== epoch)
        throw new Error("The app was disabled or its session panel was closed.");
    };
    const created: DebugSession[] = [],
      connected: DebugSession[] = [];
    try {
      for (const targetId of [
        appId,
        ...(profile.includeInspector && inspectorId ? [inspectorId] : []),
      ]) {
        ensureOpen();
        const recovered = existing.find((session) => session.target.id === targetId);
        if (recovered) {
          if (usedElsewhere(recovered.sessionId))
            throw new Error(
              "This window is open in another external app tab. Disconnect it there first.",
            );
          connected.push(recovered);
          continue;
        }
        const result = await attach({
          environmentId: threadRef.environmentId,
          input: {
            endpoint: "mac://local",
            targetId,
            threadId: threadRef.threadId,
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        created.push(result.value);
        connected.push(result.value);
      }
      ensureOpen();
      if (
        connected.some((session) =>
          usedElsewhere(session.sessionId, useExternalAppSessions.getState().bindings),
        )
      )
        throw new Error(
          "This window was opened in another external app tab. Disconnect it there first.",
        );
      useExternalAppSessions
        .getState()
        .bind({ threadRef, profileId: profile.id, sessions: connected });
      setExisting((previous) => [...previous, ...created]);
    } catch (cause) {
      await Promise.all(
        created.map((session) =>
          detach({
            environmentId: threadRef.environmentId,
            input: { sessionId: session.sessionId, threadId: threadRef.threadId },
          }),
        ),
      );
      if (mounted.current) setError(failureText(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const settingsLink = (
    <Button render={<Link to="/settings/external-apps" />} variant="ghost" size="sm">
      <Settings2Icon /> App settings
    </Button>
  );
  if (!profile)
    return (
      <div className={styles.launcher}>
        <AppWindowIcon className="size-7 text-muted-foreground" />
        <h2>External apps</h2>
        <p>Open a Mac app alongside this conversation.</p>
        <div className={styles.appList}>
          {profiles.map((entry) => (
            <button
              key={entry.id}
              onClick={() => {
                if (!entry.enabled)
                  update({
                    externalAppProfiles: profiles.map((profile) =>
                      profile.id === entry.id ? { ...profile, enabled: true } : profile,
                    ),
                  });
                useRightPanelStore.getState().openExternalApp(threadRef, entry.id, entry.name);
              }}
            >
              <AppWindowIcon size={18} />
              <span>{entry.name || "Mac app"}</span>
              <span>{entry.enabled ? "Open →" : "Enable & open →"}</span>
            </button>
          ))}
        </div>
        {!profiles.some((entry) => entry.enabled) ? (
          <p>Enable Excel or add a Mac app in Settings to get started.</p>
        ) : null}
        {settingsLink}
      </div>
    );
  if (!profile.enabled)
    return (
      <div className={styles.launcher}>
        <AppWindowIcon className="size-7 text-muted-foreground" />
        <h2>{profile.name} is disabled</h2>
        <p>Enable it in External apps settings to use it beside this session.</p>
        {settingsLink}
      </div>
    );
  const apps = targets.filter(
    (target) =>
      target.id === appId || showAll || matchesExternalApp(target, profile.applicationFilter),
  );
  const inspectors = targets.filter(
    (target) =>
      target.id !== appId &&
      (target.id === inspectorId || matchesExternalApp(target, profile.inspectorFilter)),
  );
  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <span className={styles.computer}>{computer}</span>
        {settingsLink}
        {active.length ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Disconnect ${profile.name}`}
            onClick={() => {
              void disconnect(
                (binding) =>
                  externalAppBindingKey(binding.threadRef, binding.profileId) === bindingKey,
              ).then(() => setExisting([]));
            }}
          >
            <UnplugIcon />
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {active.length ? (
        <>
          {active.length > 1 ? (
            <div className={styles.viewTabs} role="tablist" aria-label="External app view">
              {(
                [
                  ["app", "Application"],
                  ["inspector", "Inspector"],
                  ["split", "Both"],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  role="tab"
                  aria-selected={view === mode}
                  onClick={() => setView(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
          <div className={styles.windows} data-view={view}>
            {active.map((session, index) => (
              <div
                key={session.sessionId}
                className={styles.window}
                hidden={
                  active.length > 1 &&
                  view !== "split" &&
                  (index === 0 ? view !== "app" : view !== "inspector")
                }
              >
                <MacWindowPanel
                  environmentId={threadRef.environmentId}
                  threadId={threadRef.threadId}
                  session={session}
                  compact
                  label={index === 0 ? "Application" : "Web Inspector"}
                  visible={
                    visible &&
                    (active.length === 1 ||
                      view === "split" ||
                      (index === 0 ? view === "app" : view === "inspector"))
                  }
                />
              </div>
            ))}
          </div>
          <ExcelPerformancePanel
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            visible={visible}
          />
          <p className={styles.footnote}>
            Controls activate the selected window on its Mac. Closing this tab disconnects capture;
            the app stays open.
          </p>
        </>
      ) : (
        <div className={styles.setup}>
          <div className={styles.appHeading}>
            <AppWindowIcon size={26} />
            <div>
              <h2>Connect {profile.name}</h2>
              <p>Choose its windows on {computer}.</p>
            </div>
          </div>
          <p className={styles.description}>
            Open the app here or ask your agent to open it. You and the agent share the selected
            window, screenshots, controls, and action history.
          </p>
          {/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(profile.applicationFilter) ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                void openApp();
              }}
            >
              <AppWindowIcon /> Open {profile.name} on {computer}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              void find();
            }}
          >
            <RefreshCwIcon />
            {busy ? "Connecting…" : "Find windows"}
          </Button>
          {targets.length ? (
            <div className={styles.selectors}>
              <label>
                Application window
                <select
                  aria-label="Application window"
                  value={appId}
                  disabled={busy}
                  onChange={(event) => {
                    setAppId(event.target.value);
                    if (event.target.value === inspectorId) setInspectorId("");
                  }}
                >
                  <option value="">Choose a window</option>
                  {apps.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.app} · {target.title || "Untitled window"}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.showAll}>
                <input
                  type="checkbox"
                  checked={showAll}
                  onChange={(event) => setShowAll(event.target.checked)}
                />{" "}
                Show all Mac windows
              </label>
              {profile.includeInspector ? (
                <label>
                  Web Inspector window
                  <select
                    aria-label="Web Inspector window"
                    value={inspectorId}
                    disabled={busy}
                    onChange={(event) => setInspectorId(event.target.value)}
                  >
                    <option value="">Choose Inspector (optional)</option>
                    {inspectors.map((target) => (
                      <option key={target.id} value={target.id}>
                        {target.app} · {target.title || "Untitled window"}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <Button
                disabled={!appId || busy}
                onClick={() => {
                  void connect();
                }}
              >
                Connect selected windows
              </Button>
              {!apps.length && !showAll ? (
                <p className={styles.description}>
                  No windows match the application filter. Open {profile.name} or show all Mac
                  windows.
                </p>
              ) : null}
            </div>
          ) : null}
          {existing.filter(
            (session) =>
              !usedElsewhere(session.sessionId) &&
              matchesExternalApp(session.target, profile.applicationFilter),
          ).length ? (
            <div className={styles.recovery}>
              <h3>Already attached in this session</h3>
              {existing
                .filter(
                  (session) =>
                    !usedElsewhere(session.sessionId) &&
                    matchesExternalApp(session.target, profile.applicationFilter),
                )
                .map((session) => (
                  <Button
                    key={session.sessionId}
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const candidates = profile.includeInspector
                        ? existing.filter(
                            (other) =>
                              other.sessionId !== session.sessionId &&
                              !usedElsewhere(other.sessionId) &&
                              other.target.id.split(":")[1] === session.target.id.split(":")[1] &&
                              matchesExternalApp(other.target, profile.inspectorFilter),
                          )
                        : [];
                      const inspector = candidates.length === 1 ? candidates[0] : undefined;
                      useExternalAppSessions.getState().bind({
                        threadRef,
                        profileId: profile.id,
                        sessions: [session, ...(inspector ? [inspector] : [])],
                      });
                    }}
                  >
                    View {session.target.title}
                  </Button>
                ))}
            </div>
          ) : null}
          <p className={styles.footnote}>
            Viewing requires Screen Recording on {computer}. Your agent can control this window
            using Accessibility; Control window enables your own mouse and keyboard.
          </p>
        </div>
      )}
    </div>
  );
}
