import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { MessageSquareIcon, PinIcon, SearchIcon } from "lucide-react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { ThreadId, type EnvironmentId } from "@cinderdeck/contracts";
import type { IntegrationView, ManagedSessionView } from "@cinderdeck/contracts/deckhand/rpc";
import { useArchivedThreadSnapshots } from "../lib/archivedThreadsState";
import { presentThreadShell, scopeProject } from "@cinderdeck/client-runtime/state/models";
import { useProjects, useThreadShells } from "../state/entities";
import { useEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { managedSessionsView, threadContextView } from "./state";
import { useSessionActions } from "./useSessionActions";
import { workspaceSessions, type WorkspaceSession } from "./sessionWorkspaceRows";
import { SidebarColorPicker } from "./SidebarColorPicker";
import { sidebarPreferenceKey } from "./workspaceSidebarPreferences";
import { useWorkspaceSidebarPreferences } from "./useWorkspaceSidebarPreferences";
import styles from "./WorkspaceSessions.module.css";

const sessionPageSize = 20;
const sidebarSessionLimit = 10;
type Resource = IntegrationView["resources"][number];
export function WorkspaceSessions(props: {
  environmentId: EnvironmentId;
  installationID: string;
  resource: Resource;
  resources: readonly Resource[];
  selectedThreadId?: string | undefined;
  onNavigate?: (() => void) | undefined;
  compact?: boolean;
}) {
  return (
    <SessionRows
      key={`${props.environmentId}:${props.installationID}:${props.resource.workspaceID}`}
      {...props}
    />
  );
}
function SessionRows({
  environmentId,
  installationID,
  resource,
  resources,
  selectedThreadId,
  onNavigate,
  compact = false,
}: Parameters<typeof WorkspaceSessions>[0]) {
  const currentProjects = useProjects();
  const currentThreads = useThreadShells();
  const environment = useEnvironment(environmentId);
  const { showMenu, renameDialog } = useSessionActions(environmentId);
  const sidebar = useWorkspaceSidebarPreferences(
    sidebarPreferenceKey(environmentId, installationID),
  );
  const [offset, setOffset] = useState(0);
  const [history, setHistory] = useState<readonly ManagedSessionView[]>([]);
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const archive = useArchivedThreadSnapshots(archived ? [environmentId] : []);
  const projects = [
    ...archive.snapshots.flatMap(({ environmentId: id, snapshot }) =>
      snapshot.projects.map((project) => scopeProject(id, project)),
    ),
    ...currentProjects,
  ];
  const threads = [
    ...new Map(
      [
        ...archive.snapshots.flatMap(({ environmentId: id, snapshot }) =>
          snapshot.threads.map((thread) => presentThreadShell(id, thread)),
        ),
        ...currentThreads,
      ].map((thread) => [`${thread.environmentId}:${thread.id}`, thread]),
    ).values(),
  ];
  const result = useAtomValue(
    managedSessionsView({
      environmentId,
      input: {
        installationID,
        workspaceID: resource.workspaceID,
        generation: resource.generation,
        scope: "workspace",
        offset,
        limit: sessionPageSize,
      },
    }),
  );
  const page = Option.getOrNull(AsyncResult.value(result));
  useEffect(() => {
    if (!page) return;
    setHistory((previous) => {
      const next = new Map(
        (offset ? previous : []).map((session) => [session.binding.threadId, session]),
      );
      for (const session of page) next.set(session.binding.threadId, session);
      return [...next.values()];
    });
  }, [page, offset]);
  const selected = useEnvironmentQuery(
    selectedThreadId
      ? threadContextView({ environmentId, input: { threadId: ThreadId.make(selectedThreadId) } })
      : null,
  ).data;
  const exact =
    selected &&
    selected.workspace.ownerId === resource.workspaceID &&
    selected.workspace.environmentId === installationID &&
    selected.session.threadId === selectedThreadId
      ? [
          {
            binding: selected.session,
            createdAt:
              page?.find((session) => session.binding.threadId === selectedThreadId)?.createdAt ??
              history.find((session) => session.binding.threadId === selectedThreadId)?.createdAt ??
              selected.feature.createdAt,
            title:
              threads.find(
                (thread) =>
                  thread.environmentId === environmentId && thread.id === selectedThreadId,
              )?.title ?? selected.feature.title,
            archived: false,
            source: "current" as const,
          },
        ]
      : [];
  const saved = [
    ...new Map(
      [...history, ...(page ?? []), ...exact].map((session) => [session.binding.threadId, session]),
    ).values(),
  ];
  const all = workspaceSessions(environmentId, resource, resources, projects, threads, saved);
  const sessions = all.filter(
    (session) =>
      (archived || !session.archived || session.id === selectedThreadId) &&
      (!query.trim() ||
        session.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())),
  );
  const visibleSessions = compact ? sessions.slice(0, sidebarSessionLimit) : sessions;
  const connected = environment?.connection.phase === "connected";
  return (
    <section
      className={`${styles.sessions} ${compact ? styles.compact : ""}`}
      aria-label={`Sessions in ${resource.workspace?.name ?? resource.workspaceID}`}
    >
      {renameDialog}
      {!compact ? (
        <div className={styles.filters}>
          <label className={styles.search}>
            <SearchIcon size={15} aria-hidden />
            <input
              type="search"
              aria-label="Search sessions"
              placeholder="Search sessions…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className={styles.archive}>
            <input
              type="checkbox"
              checked={archived}
              onChange={(event) => setArchived(event.target.checked)}
            />
            Include archived
          </label>
        </div>
      ) : null}
      <nav className={styles.list} aria-label="Workspace sessions">
        {visibleSessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            environmentId={environmentId}
            selected={session.id === selectedThreadId}
            compact={compact}
            connected={connected}
            onNavigate={onNavigate}
            showMenu={showMenu}
            color={sidebar.preferences.sessionColors[session.id]}
            onColorChange={(color) =>
              sidebar.update((current) => {
                const sessionColors = { ...current.sessionColors };
                if (color) sessionColors[session.id] = color;
                else delete sessionColors[session.id];
                return { ...current, sessionColors };
              })
            }
          />
        ))}
      </nav>
      {!sessions.length ? (
        <p className={styles.empty} role="status">
          {query
            ? "No matching sessions"
            : AsyncResult.isInitial(result) && !all.length
              ? "Loading sessions…"
              : "No sessions yet"}
        </p>
      ) : null}
      {archived && archive.error ? (
        <p className={styles.empty} role="status">
          {archive.error}
        </p>
      ) : null}
      {result._tag === "Failure" ? (
        <p className={styles.empty} role="status">
          Saved session history is unavailable.
        </p>
      ) : null}
      {!compact && page?.length === sessionPageSize ? (
        <button
          type="button"
          className={styles.more}
          onClick={() => setOffset(offset + sessionPageSize)}
        >
          Show older sessions
        </button>
      ) : null}
      {compact && (sessions.length > sidebarSessionLimit || page?.length === sessionPageSize) ? (
        <Link
          to="/workspaces"
          search={{
            environment: environmentId,
            expectedInstallationID: installationID,
            workspace: resource.workspaceID,
            context: resource.workspaceID,
            expectedGeneration: resource.generation,
            tab: "agents",
          }}
          className={styles.more}
          onClick={onNavigate}
        >
          Show more
        </Link>
      ) : null}
    </section>
  );
}

function SessionRow({
  session,
  environmentId,
  selected,
  compact,
  connected,
  onNavigate,
  showMenu,
  color,
  onColorChange,
}: {
  session: WorkspaceSession;
  environmentId: EnvironmentId;
  selected: boolean;
  compact: boolean;
  connected: boolean;
  onNavigate: (() => void) | undefined;
  showMenu: ReturnType<typeof useSessionActions>["showMenu"];
  color: string | undefined;
  onColorChange: (color: string | undefined) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const openMenu = (position: { x: number; y: number }) =>
    showMenu(
      { binding: { threadId: session.id }, title: session.title, archived: session.archived },
      position,
      connected,
      { onHighlight: () => setColorPickerOpen(true) },
    );
  return (
    <div ref={rowRef} className={styles.row} data-session-id={session.id}>
      <Link
        to="/$environmentId/$threadId"
        params={buildThreadRouteParams({ environmentId, threadId: ThreadId.make(session.id) })}
        className={styles.session}
        style={color ? ({ "--session-accent": color } as CSSProperties) : undefined}
        data-highlighted={!!color}
        aria-current={selected ? "page" : undefined}
        onClick={onNavigate}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void openMenu({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          void openMenu({ x: rect.left, y: rect.bottom });
        }}
      >
        <MessageSquareIcon size={14} aria-hidden />
        <span className={styles.identity}>
          <span className={styles.title}>{session.title || "New session"}</span>
          {!compact && session.createdAt ? (
            <span className={styles.age}>
              Started {formatRelativeTimeLabel(session.createdAt)}
              {session.archived ? " · Archived" : ""}
            </span>
          ) : null}
        </span>
        {session.pinned ? <PinIcon size={11} aria-label="Pinned" /> : null}
        {connected && session.status !== "idle" ? (
          <i
            className={styles.status}
            data-status={session.status}
            role="img"
            aria-label={
              session.status === "working"
                ? "Working"
                : session.status === "failed"
                  ? "Failed"
                  : "Needs attention"
            }
          />
        ) : null}
      </Link>
      <SidebarColorPicker
        open={colorPickerOpen}
        onOpenChange={setColorPickerOpen}
        anchor={rowRef}
        label={session.title || "New session"}
        color={color}
        onChange={onColorChange}
      />
    </div>
  );
}
