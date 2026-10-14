import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { BotIcon, ChevronRightIcon, MessageSquareIcon, PinIcon, SearchIcon } from "lucide-react";
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
import {
  filterWorkspaceSessionTree,
  sessionTreeContains,
  workspaceSessionTree,
  type WorkspaceSessionNode,
} from "./workspaceSessionTree";
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
  const currentIDs = new Set(
    currentThreads
      .filter((thread) => thread.environmentId === environmentId)
      .map((thread) => thread.id),
  );
  const missingParent = (lineage: ManagedSessionView["lineage"]) =>
    lineage?.relationshipToParent === "subagent" &&
    lineage.parentThreadId !== null &&
    !currentIDs.has(lineage.parentThreadId);
  // Load archive metadata lazily for an active child's parent or an exact archived link.
  const needsAncestors =
    currentThreads.some(
      (thread) => thread.environmentId === environmentId && missingParent(thread.lineage),
    ) ||
    [...history, ...(page ?? [])].some(
      (session) =>
        (!session.archived || session.binding.threadId === selectedThreadId) &&
        missingParent(session.lineage),
    ) ||
    (!!selectedThreadId && !currentIDs.has(ThreadId.make(selectedThreadId)));
  const archive = useArchivedThreadSnapshots(archived || needsAncestors ? [environmentId] : []);
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
  const selectedSaved =
    page?.find((session) => session.binding.threadId === selectedThreadId) ??
    history.find((session) => session.binding.threadId === selectedThreadId);
  const exact =
    selected &&
    selected.workspace.ownerId === resource.workspaceID &&
    selected.workspace.environmentId === installationID &&
    selected.session.threadId === selectedThreadId
      ? [
          {
            ...selectedSaved,
            binding: selected.session,
            createdAt: selectedSaved?.createdAt ?? selected.feature.createdAt,
            title:
              threads.find(
                (thread) =>
                  thread.environmentId === environmentId && thread.id === selectedThreadId,
              )?.title ?? selected.feature.title,
            archived: selectedSaved?.archived ?? false,
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
  const sessions = filterWorkspaceSessionTree(workspaceSessionTree(all), {
    archived,
    query,
    selectedThreadId,
  });
  const visibleSessions = compact ? sessions.slice(0, sidebarSessionLimit) : sessions;
  // An exact conversation link must remain visible even outside the newest groups.
  const selectedGroup = sessions.find((node) => sessionTreeContains(node, selectedThreadId));
  if (compact && selectedGroup && !visibleSessions.includes(selectedGroup)) {
    visibleSessions.push(selectedGroup);
  }
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
      <nav aria-label="Workspace sessions">
        <ul className={styles.list}>
          {visibleSessions.map((node) => (
            <SessionBranch
              key={node.session.id}
              node={node}
              environmentId={environmentId}
              selectedThreadId={selectedThreadId}
              searching={!!query.trim()}
              compact={compact}
              connected={connected}
              onNavigate={onNavigate}
              showMenu={showMenu}
              colors={sidebar.preferences.sessionColors}
              onColorChange={(id, color) =>
                sidebar.update((current) => {
                  const sessionColors = { ...current.sessionColors };
                  if (color) sessionColors[id] = color;
                  else delete sessionColors[id];
                  return { ...current, sessionColors };
                })
              }
            />
          ))}
        </ul>
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

function SessionBranch(props: {
  node: WorkspaceSessionNode;
  environmentId: EnvironmentId;
  selectedThreadId: string | undefined;
  searching: boolean;
  compact: boolean;
  connected: boolean;
  onNavigate: (() => void) | undefined;
  showMenu: ReturnType<typeof useSessionActions>["showMenu"];
  colors: Readonly<Record<string, string>>;
  onColorChange: (id: string, color: string | undefined) => void;
}) {
  const { node, selectedThreadId, searching } = props;
  const childrenId = useId();
  const containsSelected = node.children.some((child) =>
    sessionTreeContains(child, selectedThreadId),
  );
  const [disclosure, setDisclosure] = useState({
    expanded: true,
    selectedThreadId,
    containsSelected,
  });
  if (
    disclosure.selectedThreadId !== selectedThreadId ||
    disclosure.containsSelected !== containsSelected
  ) {
    setDisclosure({
      expanded: containsSelected || disclosure.expanded,
      selectedThreadId,
      containsSelected,
    });
  }
  const open = searching || disclosure.expanded;
  return (
    <li className={styles.branch}>
      <SessionRow
        {...props}
        session={node.session}
        selected={node.session.id === selectedThreadId}
        color={props.colors[node.session.id]}
        onColorChange={(color) => props.onColorChange(node.session.id, color)}
        disclosure={
          node.children.length ? (
            <button
              type="button"
              className={styles.disclosure}
              aria-label={`${open ? "Collapse" : "Expand"} sub-agents for ${node.session.title || "New session"}`}
              aria-expanded={open}
              aria-controls={childrenId}
              disabled={searching}
              onClick={(event) => {
                event.stopPropagation();
                setDisclosure({ ...disclosure, expanded: !open });
              }}
            >
              <ChevronRightIcon size={12} aria-hidden />
            </button>
          ) : (
            <span className={styles.disclosureSpace} aria-hidden />
          )
        }
        childCount={node.children.length}
      />
      {node.children.length ? (
        <ul id={childrenId} className={`${styles.list} ${styles.children}`} hidden={!open}>
          {node.children.map((child) => (
            <SessionBranch key={child.session.id} {...props} node={child} />
          ))}
        </ul>
      ) : null}
    </li>
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
  disclosure,
  childCount,
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
  disclosure: React.ReactNode;
  childCount: number;
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
      {disclosure}
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
        {session.isSubagent ? (
          <BotIcon size={14} aria-hidden />
        ) : (
          <MessageSquareIcon size={14} aria-hidden />
        )}
        <span className={styles.identity}>
          <span className={styles.title}>{session.title || "New session"}</span>
          {!compact && session.createdAt ? (
            <span className={styles.age}>
              Started {formatRelativeTimeLabel(session.createdAt)}
              {session.archived ? " · Archived" : ""}
            </span>
          ) : null}
        </span>
        {session.isSubagent ? <span className={styles.kind}>Sub-agent</span> : null}
        {childCount ? (
          <span className={styles.count} aria-label={`${childCount} sub-agents`}>
            {childCount}
          </span>
        ) : null}
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
