import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  BotIcon,
  ChevronRightIcon,
  GripVerticalIcon,
  MessageSquareIcon,
  PinIcon,
  SearchIcon,
} from "lucide-react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { ThreadId, type EnvironmentId } from "@cinderdeck/contracts";
import type { IntegrationView, ManagedSessionView } from "@cinderdeck/contracts/deckhand/rpc";
import { useArchivedThreadSnapshots } from "../lib/archivedThreadsState";
import { presentThreadShell, scopeProject } from "@cinderdeck/client-runtime/state/models";
import { useProjects, useServerConfigs, useThreadShells } from "../state/entities";
import { useEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../providerInstances";
import {
  ProviderInstanceIcon,
  providerTextColorClassName,
} from "../components/chat/ProviderInstanceIcon";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../components/ui/tooltip";
import { managedSessionsView, threadContextView } from "./state";
import { useSessionActions } from "./useSessionActions";
import { workspaceSessions, type WorkspaceSession } from "./sessionWorkspaceRows";
import {
  filterWorkspaceSessionTree,
  orderWorkspaceSessionTree,
  sessionTreeContains,
  reorderWorkspaceSessions,
  sessionPinTime,
  pinnedSessionGroup,
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
  const config = useServerConfigs().get(environmentId);
  const providers = useMemo(
    () =>
      new Map(
        (config
          ? applyProviderInstanceSettings(
              deriveProviderInstanceEntries(config.providers),
              config.settings,
            )
          : []
        ).map((provider) => [provider.instanceId as string, provider]),
      ),
    [config],
  );
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
  const tree = workspaceSessionTree(all);
  const orderedSessions = orderWorkspaceSessionTree(
    filterWorkspaceSessionTree(tree, { archived, query: "", selectedThreadId }),
    resource.workspaceID,
    sidebar.preferences.order,
    null,
    tree,
  );
  const sessions = filterWorkspaceSessionTree(orderedSessions, {
    archived,
    query,
    selectedThreadId,
  });
  const pinned = sessions.filter((node) => sessionPinTime(node) !== null);
  const recent = sessions.filter((node) => sessionPinTime(node) === null);
  const recentLimit = sidebarSessionLimit - (pinned.length ? 1 : 0);
  const visibleSessions = compact ? recent.slice(0, recentLimit) : recent;
  // An exact conversation link must remain visible even outside the newest groups.
  const selectedGroup = recent.find((node) => sessionTreeContains(node, selectedThreadId));
  if (compact && selectedGroup && !visibleSessions.includes(selectedGroup)) {
    visibleSessions.push(selectedGroup);
  }
  const pinnedKey = pinnedSessionGroup(resource.workspaceID);
  const pinnedOpen = sidebar.preferences.expanded[pinnedKey] ?? true;
  const pinnedListID = useId();
  const previousPins = useRef(new Map(tree.map((node) => [node.session.id, sessionPinTime(node)])));
  const previousSelection = useRef(selectedThreadId);
  useEffect(() => {
    const newlyPinned = tree.some(
      (node) =>
        sessionPinTime(node) !== null &&
        previousPins.current.has(node.session.id) &&
        previousPins.current.get(node.session.id) !== sessionPinTime(node),
    );
    const navigatedToPin =
      previousSelection.current !== selectedThreadId &&
      pinned.some((node) => sessionTreeContains(node, selectedThreadId));
    previousPins.current = new Map(tree.map((node) => [node.session.id, sessionPinTime(node)]));
    previousSelection.current = selectedThreadId;
    if (!pinnedOpen && (newlyPinned || navigatedToPin)) {
      sidebar.update((current) => ({
        ...current,
        expanded: { ...current.expanded, [pinnedKey]: true },
      }));
    }
  });
  const allNodes = new Map<string, WorkspaceSessionNode>();
  const snapshotNodes = new Map<string, WorkspaceSessionNode>();
  const remember = (
    nodes: readonly WorkspaceSessionNode[],
    target: Map<string, WorkspaceSessionNode>,
  ) => {
    for (const node of nodes) {
      target.set(node.session.id, node);
      remember(node.children, target);
    }
  };
  remember(orderedSessions, allNodes);
  remember(tree, snapshotNodes);
  const connected = environment?.connection.phase === "connected";
  const renderBranch = (node: WorkspaceSessionNode) => (
    <SessionBranch
      key={node.session.id}
      node={node}
      allNodes={allNodes}
      snapshotNodes={snapshotNodes}
      environmentId={environmentId}
      selectedThreadId={selectedThreadId}
      searching={!!query.trim()}
      compact={compact}
      connected={connected}
      onNavigate={onNavigate}
      showMenu={showMenu}
      workspaceID={resource.workspaceID}
      sidebar={sidebar}
      providers={providers}
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
  );
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
        {pinned.length ? (
          <div className={styles.pinned}>
            <button
              type="button"
              className={styles.pinnedHeading}
              aria-expanded={pinnedOpen || !!query.trim()}
              aria-controls={pinnedListID}
              disabled={!!query.trim()}
              onClick={() =>
                sidebar.update((current) => ({
                  ...current,
                  expanded: { ...current.expanded, [pinnedKey]: !pinnedOpen },
                }))
              }
            >
              <ChevronRightIcon size={12} aria-hidden />
              <PinIcon size={12} aria-hidden />
              Pinned <span className={styles.count}>{pinned.length}</span>
            </button>
            <ul
              id={pinnedListID}
              className={styles.list}
              hidden={!pinnedOpen && !query.trim()}
              aria-label="Pinned sessions"
            >
              <SessionSiblings
                nodes={pinned}
                allNodes={orderedSessions}
                snapshot={tree}
                workspaceID={resource.workspaceID}
                sidebar={sidebar}
              >
                {renderBranch}
              </SessionSiblings>
            </ul>
          </div>
        ) : null}
        <ul className={styles.list}>
          <SessionSiblings
            nodes={visibleSessions}
            allNodes={orderedSessions}
            snapshot={tree}
            workspaceID={resource.workspaceID}
            sidebar={sidebar}
          >
            {renderBranch}
          </SessionSiblings>
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
      {compact && (recent.length > recentLimit || page?.length === sessionPageSize) ? (
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

function SessionSiblings({
  nodes,
  allNodes,
  snapshot,
  workspaceID,
  parentID = null,
  sidebar,
  children,
}: {
  nodes: readonly WorkspaceSessionNode[];
  allNodes: readonly WorkspaceSessionNode[];
  snapshot: readonly WorkspaceSessionNode[];
  workspaceID: string;
  parentID?: string | null;
  sidebar: ReturnType<typeof useWorkspaceSidebarPreferences>;
  children: (node: WorkspaceSessionNode) => ReactNode;
}) {
  const sensors = useSensors(
    // This sensor is attached only to the dedicated grip. Activate immediately
    // so a short/coalesced drag does not spend its only movement on activation.
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = nodes.map((node) => node.session.id);
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={({ active, over }) => {
        if (!over || active.id === over.id) return;
        sidebar.update((current) => ({
          ...current,
          order: reorderWorkspaceSessions(
            current.order,
            workspaceID,
            parentID,
            allNodes,
            nodes,
            String(active.id),
            String(over.id),
            snapshot,
          ),
        }));
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {nodes.map(children)}
      </SortableContext>
    </DndContext>
  );
}

function SessionBranch(props: {
  node: WorkspaceSessionNode;
  allNodes: ReadonlyMap<string, WorkspaceSessionNode>;
  snapshotNodes: ReadonlyMap<string, WorkspaceSessionNode>;
  environmentId: EnvironmentId;
  selectedThreadId: string | undefined;
  searching: boolean;
  compact: boolean;
  connected: boolean;
  onNavigate: (() => void) | undefined;
  showMenu: ReturnType<typeof useSessionActions>["showMenu"];
  workspaceID: string;
  sidebar: ReturnType<typeof useWorkspaceSidebarPreferences>;
  providers: ReadonlyMap<string, ProviderInstanceEntry>;
  colors: Readonly<Record<string, string>>;
  onColorChange: (id: string, color: string | undefined) => void;
}) {
  const { node, selectedThreadId, searching } = props;
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: node.session.id });
  const childrenId = useId();
  const containsSelected = node.children.some((child) =>
    sessionTreeContains(child, selectedThreadId),
  );
  const [disclosure, setDisclosure] = useState({
    expanded: containsSelected,
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
  // A collapsed group can contain thousands of agents. Mount its sortable rows
  // on first expansion, then retain them to preserve nested disclosure state.
  const [childrenMounted, setChildrenMounted] = useState(open);
  if (open && !childrenMounted) setChildrenMounted(true);
  return (
    <li
      ref={setNodeRef}
      className={styles.branch}
      data-dragging={isDragging}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <SessionRow
        {...props}
        session={node.session}
        provider={props.providers.get(node.session.providerInstanceId)}
        selected={node.session.id === selectedThreadId}
        color={props.colors[node.session.id]}
        onColorChange={(color) => props.onColorChange(node.session.id, color)}
        dragHandle={
          <button
            type="button"
            className={styles.handle}
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${node.session.isSubagent ? "sub-agent" : "session"} ${node.session.title || "New session"}`}
          >
            <GripVerticalIcon size={12} aria-hidden />
          </button>
        }
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
          {childrenMounted ? (
            <SessionSiblings
              nodes={node.children}
              allNodes={props.allNodes.get(node.session.id)?.children ?? node.children}
              snapshot={props.snapshotNodes.get(node.session.id)?.children ?? node.children}
              workspaceID={props.workspaceID}
              parentID={node.session.id}
              sidebar={props.sidebar}
            >
              {(child) => <SessionBranch key={child.session.id} {...props} node={child} />}
            </SessionSiblings>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

function SessionRow({
  session,
  provider,
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
  dragHandle,
}: {
  session: WorkspaceSession;
  provider: ProviderInstanceEntry | undefined;
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
  dragHandle: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const providerLabel = provider?.displayName ?? session.providerInstanceId;
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
      {dragHandle}
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
        <Tooltip>
          <TooltipTrigger
            render={<span />}
            className={styles.provider}
            role="img"
            aria-label={`Provider: ${providerLabel}`}
          >
            {provider ? (
              <ProviderInstanceIcon
                driverKind={provider.driverKind}
                displayName={provider.displayName}
                accentColor={provider.accentColor}
                acpRegistryAgentId={provider.acpRegistryAgentId}
                acpRegistryIconUrl={provider.acpRegistryIconUrl}
                className={providerTextColorClassName(provider.driverKind) ?? ""}
                iconClassName="size-3.5"
              />
            ) : session.isSubagent ? (
              <BotIcon size={14} aria-hidden />
            ) : (
              <MessageSquareIcon size={14} aria-hidden />
            )}
          </TooltipTrigger>
          <TooltipPopup>{providerLabel}</TooltipPopup>
        </Tooltip>
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
