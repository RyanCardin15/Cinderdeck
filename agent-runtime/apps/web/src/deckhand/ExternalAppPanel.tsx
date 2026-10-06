import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  AppWindowIcon,
  BugIcon,
  FileSpreadsheetIcon,
  MonitorIcon,
  PlugIcon,
  RefreshCwIcon,
  Settings2Icon,
  UnplugIcon,
} from "lucide-react";
import type { ScopedThreadRef } from "@cinderdeck/contracts";
import type {
  DebugConflict,
  DebugSession,
  DebugTarget,
} from "@cinderdeck/contracts/deckhand/externalDebugRpc";
import { resolveExternalAppProfiles } from "@cinderdeck/contracts/deckhand/externalAppPreferences";
import { squashAtomCommandFailure } from "@cinderdeck/client-runtime/state/runtime";
import { useClientSettings, useUpdateClientSettings } from "../hooks/useSettings";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironments } from "../state/environments";
import { useRightPanelStore } from "../rightPanelStore";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../components/ui/dialog";
import { MacWindowPanel } from "./MacWindowPanel";
import { ExcelPerformancePanel } from "./ExcelPerformancePanel";
import {
  attachDebugTarget,
  detachDebugSession,
  discoverDebugTargets,
  listDebugSessions,
  listDebugConflicts,
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
const isBusyFailure = (value: unknown) =>
  typeof value === "object" && value !== null && "reason" in value && value.reason === "busy";
export const matchesExternalApp = (target: DebugTarget, filter: string) =>
  `${target.app ?? ""} ${target.url} ${target.title}`
    .toLowerCase()
    .includes(filter.trim().toLowerCase());
const byAppAndTitle = (targets: readonly DebugTarget[]) =>
  [...targets].sort((a, b) => `${a.app} ${a.title}`.localeCompare(`${b.app} ${b.title}`));
// Mac window IDs are `mac:<pid>:<window>`; an undocked Inspector shares its host's process.
const sameProcess = (a: DebugTarget, b: DebugTarget) => a.id.split(":")[1] === b.id.split(":")[1];
/** The single Inspector to pair with `host`, or undefined when none or several qualify. */
export function inspectorFor(
  host: DebugTarget,
  targets: readonly DebugTarget[],
  filter: string,
  exclude: readonly string[] = [],
) {
  const candidates = targets.filter(
    (target) =>
      target.id !== host.id && !exclude.includes(target.id) && matchesExternalApp(target, filter),
  );
  const local = candidates.filter((target) => sameProcess(target, host));
  return local.length === 1 ? local[0] : candidates.length === 1 ? candidates[0] : undefined;
}

type ExternalAppPanelProps = {
  threadRef: ScopedThreadRef;
  profileId: string | null;
  visible: boolean;
};

export function ExternalAppPanel(props: ExternalAppPanelProps) {
  return (
    <ScopedExternalAppPanel
      key={externalAppBindingKey(props.threadRef, props.profileId ?? "new")}
      {...props}
    />
  );
}

function ScopedExternalAppPanel({ threadRef, profileId, visible }: ExternalAppPanelProps) {
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
  const conflicts = useAtomCommand(listDebugConflicts, { reportFailure: false });
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
  const [hint, setHint] = useState("");
  const [conflict, setConflict] = useState<{
    targetIds: string[];
    sessions: readonly DebugConflict[];
    selected: string[];
    error: string;
  } | null>(null);
  const [view, setView] = useState<"app" | "inspector" | "split" | "performance">("app");
  const AppIcon = profile?.id === "excel" ? FileSpreadsheetIcon : AppWindowIcon;
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
      setTargets(byAppAndTitle(result.value));
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
  async function showConflicts(targetIds: string[], epoch: number) {
    const entries: DebugConflict[] = [];
    for (const targetId of targetIds) {
      const result = await conflicts({
        environmentId: threadRef.environmentId,
        input: { endpoint: "mac://local", targetId, threadId: threadRef.threadId },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      entries.push(...result.value);
    }
    if (!mounted.current || connectionEpoch.current !== epoch) return;
    const sessions = [
      ...new Map(entries.map((entry) => [entry.session.sessionId, entry])).values(),
    ];
    const exact = sessions.filter((entry) => targetIds.includes(entry.session.target.id));
    setConflict({
      targetIds,
      sessions,
      selected: (exact.length ? exact : sessions.slice(0, 1)).map(
        (entry) => entry.session.sessionId,
      ),
      error: "",
    });
  }
  async function replaceConnection() {
    if (!conflict || busy) return;
    const request = conflict;
    const epoch = connectionEpoch.current;
    setBusy(true);
    setConflict({ ...request, error: "" });
    try {
      for (const entry of request.sessions.filter((entry) =>
        request.selected.includes(entry.session.sessionId),
      )) {
        if (!mounted.current || connectionEpoch.current !== epoch) return;
        const result = await detach({
          environmentId: threadRef.environmentId,
          input: {
            sessionId: entry.session.sessionId,
            ...(entry.threadId ? { threadId: entry.threadId } : {}),
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        // Only remove connections the server has successfully released, preserving
        // other windows (and bindings on other computers).
        const store = useExternalAppSessions.getState();
        for (const [key, binding] of Object.entries(store.bindings)) {
          if (binding.threadRef.environmentId !== threadRef.environmentId) continue;
          const sessions = binding.sessions.filter((s) => s.sessionId !== entry.session.sessionId);
          if (sessions.length === binding.sessions.length) continue;
          if (sessions.length) store.bind({ ...binding, sessions });
          else store.remove(key);
        }
      }
      if (!mounted.current || connectionEpoch.current !== epoch) return;
      setConflict(null);
      await connect(request.targetIds, true);
    } catch (cause) {
      if (mounted.current && connectionEpoch.current === epoch)
        setConflict({ ...request, error: failureText(cause) });
    } finally {
      if (mounted.current && connectionEpoch.current === epoch) setBusy(false);
    }
  }
  async function openApp(continuing = false) {
    if (!profile || (busy && !continuing)) return;
    setBusy(true);
    setError("");
    const epoch = connectionEpoch.current;
    let requestedTargets: string[] = [];
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
        requestedTargets = [session.target.id];
        setAppId(session.target.id);
        if (usedElsewhere(session.sessionId, useExternalAppSessions.getState().bindings))
          throw { reason: "busy" };
        useExternalAppSessions
          .getState()
          .bind({ threadRef, profileId: profile.id, sessions: [session] });
      } else if (!result.value.targets.length) {
        setError(
          "The app opened but has no capturable window yet. Open a test document on its Mac, then choose Find windows.",
        );
      }
    } catch (cause) {
      if (mounted.current && connectionEpoch.current === epoch) {
        if (isBusyFailure(cause)) {
          try {
            if (!requestedTargets.length) {
              const found = await discover({
                environmentId: threadRef.environmentId,
                input: { endpoint: "mac://local" },
              });
              if (found._tag === "Failure") throw squashAtomCommandFailure(found);
              if (!mounted.current || connectionEpoch.current !== epoch) return;
              const matching = found.value.filter((target) =>
                matchesExternalApp(target, profile.applicationFilter),
              );
              if (matching.length !== 1) {
                setTargets(found.value);
                setError("Choose the window to connect below.");
                return;
              }
              requestedTargets = [matching[0]!.id];
              setTargets(found.value);
              setAppId(matching[0]!.id);
            }
            await showConflicts(requestedTargets, epoch);
          } catch (failure) {
            if (mounted.current && connectionEpoch.current === epoch)
              setError(failureText(failure));
          }
        } else setError(failureText(cause));
      }
    } finally {
      if (mounted.current && connectionEpoch.current === epoch) setBusy(false);
    }
  }
  async function connect(
    targetIds = [appId, ...(profile?.includeInspector && inspectorId ? [inspectorId] : [])],
    replacing = false,
  ) {
    if (!profile || !profile.enabled || (busy && !replacing) || !targetIds[0]) return;
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
      const listed = await list({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      if (listed._tag === "Failure") throw squashAtomCommandFailure(listed);
      const current = listed.value.filter((session) => session.state === "connected");
      for (const targetId of targetIds) {
        ensureOpen();
        const recovered = current.find(
          (session) => session.target.id === targetId && session.endpoint.startsWith("mac:"),
        );
        if (recovered) {
          if (usedElsewhere(recovered.sessionId)) throw { reason: "busy" };
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
        throw { reason: "busy" };
      useExternalAppSessions
        .getState()
        .bind({ threadRef, profileId: profile.id, sessions: connected });
      setExisting([...current, ...created]);
    } catch (cause) {
      await Promise.all(
        created.map((session) =>
          detach({
            environmentId: threadRef.environmentId,
            input: { sessionId: session.sessionId, threadId: threadRef.threadId },
          }),
        ),
      );
      if (mounted.current && connectionEpoch.current === epoch) {
        if (isBusyFailure(cause)) {
          try {
            await showConflicts(targetIds, epoch);
          } catch (failure) {
            if (mounted.current && connectionEpoch.current === epoch)
              setError(failureText(failure));
          }
        } else setError(failureText(cause));
      }
    } finally {
      if (mounted.current && connectionEpoch.current === epoch) setBusy(false);
    }
  }
  /** One click: reuse or attach the app window and its Inspector, opening the app if needed. */
  async function connectAutomatically() {
    if (!profile || busy) return;
    setBusy(true);
    setError("");
    setHint("");
    const epoch = connectionEpoch.current;
    try {
      const result = await discover({
        environmentId: threadRef.environmentId,
        input: { endpoint: "mac://local" },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (!mounted.current || connectionEpoch.current !== epoch) return;
      const found = byAppAndTitle(result.value);
      setTargets(found);
      const windows = found.filter(
        (target) =>
          matchesExternalApp(target, profile.applicationFilter) &&
          !(profile.includeInspector && matchesExternalApp(target, profile.inspectorFilter)),
      );
      if (windows.length > 1) {
        setAppId("");
        setHint(`${windows.length} ${profile.name} windows are open. Choose one below.`);
        return;
      }
      const host = windows[0];
      if (!host) {
        if (opensByBundleId) await openApp(true);
        else setError(`No ${profile.name} window is open on ${computer}. Open one and try again.`);
        return;
      }
      const inspector = profile.includeInspector
        ? inspectorFor(host, found, profile.inspectorFilter)
        : undefined;
      setAppId(host.id);
      setInspectorId(inspector?.id ?? "");
      await connect([host.id, ...(inspector ? [inspector.id] : [])], true);
    } catch (cause) {
      if (mounted.current && connectionEpoch.current === epoch) setError(failureText(cause));
    } finally {
      if (mounted.current && connectionEpoch.current === epoch) setBusy(false);
    }
  }
  /** Adds the host's Web Inspector to an app window that is already connected. */
  async function attachInspector() {
    const host = active[0];
    if (!profile || busy || !host) return;
    setBusy(true);
    setError("");
    const epoch = connectionEpoch.current;
    try {
      const result = await discover({
        environmentId: threadRef.environmentId,
        input: { endpoint: "mac://local" },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (!mounted.current || connectionEpoch.current !== epoch) return;
      const inspector = inspectorFor(
        host.target,
        result.value,
        profile.inspectorFilter,
        active.map((session) => session.target.id),
      );
      if (!inspector) {
        setError(
          result.value.some(
            (target) =>
              target.id !== host.target.id && matchesExternalApp(target, profile.inspectorFilter),
          )
            ? "Several Inspector windows are open. Close the extras and try again."
            : `No Web Inspector window is open. In ${profile.name}, right-click the add-in, choose Inspect Element, undock the Inspector, and try again.`,
        );
        return;
      }
      await connect([host.target.id, inspector.id], true);
    } catch (cause) {
      if (mounted.current && connectionEpoch.current === epoch) setError(failureText(cause));
    } finally {
      if (mounted.current && connectionEpoch.current === epoch) setBusy(false);
    }
  }
  const opensByBundleId = /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(
    profile?.applicationFilter ?? "",
  );
  const settingsLink = (
    <Button
      render={<Link to="/settings/external-apps" />}
      variant="ghost"
      size="icon-sm"
      aria-label="App settings"
    >
      <Settings2Icon />
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
    <div className={styles.panel} data-app={profile.id}>
      <Dialog
        open={conflict !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen && !busy) setConflict(null);
        }}
      >
        <DialogPopup showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>Resolve window connection</DialogTitle>
            <DialogDescription>
              This window is attached elsewhere, or the connection limit has been reached on{" "}
              {computer}. Choose a connection to disconnect, then connect the selected windows here.
              The app stays open.
            </DialogDescription>
          </DialogHeader>
          <div className={styles.conflictList}>
            {conflict?.sessions.length ? (
              conflict.sessions.map((entry) => {
                const binding = Object.values(occupied).find(
                  (binding) =>
                    binding.threadRef.environmentId === threadRef.environmentId &&
                    binding.sessions.some(
                      (session) => session.sessionId === entry.session.sessionId,
                    ),
                );
                const pane = profiles.find((profile) => profile.id === binding?.profileId)?.name;
                return (
                  <label key={entry.session.sessionId} className={styles.conflictEntry}>
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={conflict.selected.includes(entry.session.sessionId)}
                      onChange={(event) =>
                        setConflict({
                          ...conflict,
                          selected: event.target.checked
                            ? [...conflict.selected, entry.session.sessionId]
                            : conflict.selected.filter((id) => id !== entry.session.sessionId),
                        })
                      }
                    />
                    <span>
                      <strong>
                        {entry.session.target.app || "Mac app"} ·{" "}
                        {entry.session.target.title || "Untitled window"}
                      </strong>
                      <span>
                        {entry.threadTitle ||
                          (entry.threadId === threadRef.threadId
                            ? "This conversation"
                            : "Other conversation")}
                        {pane ? ` · ${pane} pane` : ""}
                      </span>
                      {entry.threadId ? (
                        <span>Conversation: {entry.threadId}</span>
                      ) : (
                        <span>Signed-in session</span>
                      )}
                      <span>
                        Session: {entry.session.sessionId} · {entry.session.state}
                      </span>
                    </span>
                  </label>
                );
              })
            ) : (
              <p>
                A connection may still be starting, or belongs to a session you cannot access. Retry
                once it becomes available.
              </p>
            )}
            {conflict?.error ? (
              <p role="alert" className={styles.error}>
                {conflict.error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConflict(null)}>
              Cancel
            </Button>
            {conflict?.sessions.length ? (
              <Button
                disabled={busy || !conflict.selected.length}
                onClick={() => {
                  void replaceConnection();
                }}
              >
                {busy ? "Connecting…" : "Disconnect and connect here"}
              </Button>
            ) : (
              <Button
                disabled={busy}
                onClick={() => {
                  if (!conflict) return;
                  const targetIds = conflict.targetIds;
                  setConflict(null);
                  void connect(targetIds);
                }}
              >
                Retry connection
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <div className={styles.toolbar}>
        <span className={styles.appMark}>
          <AppIcon size={17} aria-hidden />
        </span>
        <div className={styles.toolbarIdentity}>
          <strong>{profile.name}</strong>
          <span className={styles.computer}>
            <MonitorIcon size={11} aria-hidden /> {computer}
          </span>
        </div>
        {active.length ? (
          <div className={styles.viewTabs} role="tablist" aria-label="External app view">
            {(active.length > 1
              ? ([
                  ["app", "Application"],
                  ["inspector", "Inspector"],
                  ["split", "Both"],
                  ["performance", "Performance"],
                ] as const)
              : ([
                  ["app", "Window"],
                  ["performance", "Performance"],
                ] as const)
            ).map(([mode, label]) => (
              <button
                key={mode}
                role="tab"
                aria-selected={
                  view === mode || (mode === "app" && view !== "performance" && active.length === 1)
                }
                onClick={() => setView(mode)}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
        {profile.includeInspector && active.length === 1 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              void attachInspector();
            }}
          >
            <BugIcon /> {busy ? "Attaching…" : "Attach Inspector"}
          </Button>
        ) : null}
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
          <div className={styles.windows} data-view={view} hidden={view === "performance"}>
            {active.map((session, index) => {
              const shown =
                view !== "performance" &&
                (active.length === 1 ||
                  view === "split" ||
                  (index === 0 ? view === "app" : view === "inspector"));
              return (
                <div key={session.sessionId} className={styles.window} hidden={!shown}>
                  <MacWindowPanel
                    environmentId={threadRef.environmentId}
                    threadId={threadRef.threadId}
                    session={session}
                    compact
                    label={index === 0 ? "Application" : "Web Inspector"}
                    visible={visible && shown}
                  />
                </div>
              );
            })}
          </div>
          {view === "performance" ? (
            <ExcelPerformancePanel threadRef={threadRef} visible={visible} />
          ) : null}
        </>
      ) : (
        <div className={styles.setup}>
          <div className={styles.setupCard}>
            <div className={styles.appHeading}>
              <span className={styles.setupMark}>
                <AppIcon size={28} aria-hidden />
              </span>
              <div>
                <h2>{profile.name}</h2>
                <p>Not connected · {computer}</p>
              </div>
            </div>
            <p className={styles.description}>
              Mirror {profile.name}
              {profile.includeInspector ? " and its Web Inspector" : ""} beside this conversation.
              {opensByBundleId ? ` Opens ${profile.name} if it isn’t running.` : ""}
            </p>
            <div className={styles.setupActions}>
              <Button
                disabled={busy}
                onClick={() => {
                  void connectAutomatically();
                }}
              >
                <PlugIcon /> {busy ? "Connecting…" : `Connect ${profile.name}`}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setHint("");
                  void find();
                }}
              >
                <RefreshCwIcon />
                Find windows
              </Button>
            </div>
            {hint ? <p className={styles.hint}>{hint}</p> : null}
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
              using Accessibility; Control enables your own mouse and keyboard.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
