import { useAtomValue } from "@effect/atom-react";
import { workspaceChatUnavailableReason } from "@cinderdeck/shared/workspaceChat";
import { Link } from "@tanstack/react-router";
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
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GripVerticalIcon,
  PlusIcon,
  StarIcon,
} from "lucide-react";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ContextMenuItem, EnvironmentId } from "@cinderdeck/contracts";
import type { IntegrationView } from "@cinderdeck/contracts/deckhand/rpc";
import { workspaceView } from "./state";
import { readLocalApi } from "../localApi";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../components/ui/tooltip";
import { useAgentObservation } from "./useAgentObservation";
import { WorkspaceSettingsButton } from "./WorkspaceSettingsButton";
import { SessionLauncher } from "./SessionLauncher";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogPanel,
  DialogTitle,
  DialogDescription,
} from "../components/ui/dialog";
import { type WorkspaceSearch } from "./workspaceNavigation";
import {
  orderedSidebarRows,
  isSidebarColor,
  reorderSidebarRows,
  sidebarPreferenceKey,
} from "./workspaceSidebarPreferences";
import styles from "./WorkspaceSidebar.module.css";
import { useWorkspaceSidebarPreferences } from "./useWorkspaceSidebarPreferences";
import { SidebarColorPicker } from "./SidebarColorPicker";
import { WorkspaceSessions } from "./WorkspaceSessions";
import { useParams } from "@tanstack/react-router";
import { useProjects, useThreadShells } from "../state/entities";
import { workspaceProjectIDs } from "./sessionWorkspaceRows";

type Resource = IntegrationView["resources"][number];
const workspaceGroup = "workspaces";
const name = (row: Resource) => row.workspace?.lane?.name ?? row.workspace?.name ?? row.workspaceID;
const canLaunch = (row: Resource) => workspaceChatUnavailableReason(row) === null;

type SidebarState = ReturnType<typeof useWorkspaceSidebarPreferences>;

function Siblings({
  rows,
  group,
  state,
  children,
}: {
  rows: Resource[];
  group: string;
  state: SidebarState;
  children: (row: Resource) => ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={({ active, over }) => {
        if (!over) return;
        state.update((current) => ({
          ...current,
          order: {
            ...current.order,
            [group]: reorderSidebarRows(
              current.order[group] ?? [],
              rows.map((row) => row.workspaceID),
              String(active.id),
              String(over.id),
            ),
          },
        }));
      }}
    >
      <SortableContext
        items={rows.map((row) => row.workspaceID)}
        strategy={verticalListSortingStrategy}
      >
        {rows.map(children)}
      </SortableContext>
    </DndContext>
  );
}

function SidebarRow({
  resource,
  baseID,
  state,
  search,
  selected,
  workspaceActive,
  expanded,
  onExpand,
  onNavigate,
  onNewSession,
  launchEnabled,
  settingsEnabled,
  children,
}: {
  resource: Resource;
  baseID: string;
  state: SidebarState;
  search: WorkspaceSearch;
  selected: boolean;
  workspaceActive?: boolean;
  expanded?: boolean;
  onExpand?: () => void;
  onNavigate?: (() => void) | undefined;
  onNewSession: (resource: Resource) => void;
  launchEnabled: boolean;
  settingsEnabled: boolean;
  children?: ReactNode;
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: resource.workspaceID });
  const favorite = state.preferences.favorites.includes(resource.workspaceID);
  const label = name(resource);
  const rowRef = useRef<HTMLDivElement>(null);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const savedColor = state.preferences.colors[resource.workspaceID];
  const color = isSidebarColor(savedColor) ? savedColor : undefined;
  const changeColor = (value: string | undefined) =>
    state.update((current) => {
      if (value) {
        return { ...current, colors: { ...current.colors, [resource.workspaceID]: value } };
      }
      const colors = { ...current.colors };
      delete colors[resource.workspaceID];
      return { ...current, colors };
    });
  const showMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const items: ContextMenuItem[] = [
      { id: "highlight-color", label: "Highlight color…", icon: "palette" },
    ];
    try {
      const action = await api.contextMenu.show(items, position);
      if (action === "highlight-color") setColorPickerOpen(true);
    } catch {
      /* Dismissing an unavailable menu leaves the row unchanged. */
    }
  };
  return (
    <div
      ref={setNodeRef}
      className={styles.group}
      data-workspace-id={resource.workspaceID}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <div
        ref={rowRef}
        className={styles.row}
        style={color ? ({ "--sidebar-accent": color } as CSSProperties) : undefined}
        data-highlighted={!!color}
        data-current={selected || workspaceActive}
        data-dragging={isDragging}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void showMenu({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          void showMenu({ x: bounds.left, y: bounds.bottom });
        }}
      >
        <button
          type="button"
          className={`${styles.control} ${styles.handle}`}
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${label}`}
        >
          <GripVerticalIcon size={13} />
        </button>
        {onExpand ? (
          <button
            type="button"
            className={styles.control}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} sessions for ${label}`}
            onClick={onExpand}
          >
            {expanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
          </button>
        ) : null}
        <Link
          className={styles.select}
          to="/workspaces"
          search={{
            ...(search.environment ? { environment: search.environment } : {}),
            tab: "agents",
            workspace: baseID,
            context: resource.workspaceID,
            ...(search.expectedInstallationID
              ? { expectedInstallationID: search.expectedInstallationID }
              : {}),
            expectedGeneration: resource.generation,
          }}
          aria-current={selected ? "page" : undefined}
          title={label}
          onClick={onNavigate}
        >
          {onExpand ? <FolderGit2Icon size={15} /> : <GitBranchIcon size={14} />}
          <span className={styles.label}>{label}</span>
        </Link>
        <Tooltip>
          <TooltipTrigger
            type="button"
            render={<button className={styles.control} disabled={!launchEnabled} />}
            aria-label={`New session in ${label}`}
            disabled={!launchEnabled}
            onClick={() => onNewSession(resource)}
          >
            <PlusIcon size={15} aria-hidden />
          </TooltipTrigger>
          <TooltipPopup>
            {launchEnabled
              ? `New session in ${label}`
              : "Reconnect an available checkout to open a session"}
          </TooltipPopup>
        </Tooltip>
        <WorkspaceSettingsButton
          environmentId={search.environment!}
          workspaceID={baseID}
          label={
            resource.workspace?.lane
              ? `Source workspace settings for ${label}`
              : `Workspace settings for ${label}`
          }
          enabled={settingsEnabled}
          compact
        />
        <Tooltip>
          <TooltipTrigger
            type="button"
            render={<button className={styles.control} />}
            aria-pressed={favorite}
            aria-label={`${favorite ? "Unfavorite" : "Favorite"} ${label}`}
            onClick={() =>
              state.update((current) => ({
                ...current,
                favorites: favorite
                  ? current.favorites.filter((id) => id !== resource.workspaceID)
                  : [...current.favorites, resource.workspaceID],
              }))
            }
          >
            <StarIcon size={14} fill={favorite ? "currentColor" : "none"} />
          </TooltipTrigger>
          <TooltipPopup>{`${favorite ? "Unfavorite" : "Favorite"} ${label}`}</TooltipPopup>
        </Tooltip>
      </div>
      <SidebarColorPicker
        open={colorPickerOpen}
        onOpenChange={setColorPickerOpen}
        anchor={rowRef}
        label={label}
        color={color}
        onChange={changeColor}
      />
      {children}
    </div>
  );
}

type SidebarProps = {
  environmentId: EnvironmentId;
  installationID: string;
  resources: readonly Resource[];
  search: WorkspaceSearch;
  onNavigate?: () => void;
};
export function WorkspaceSidebar(props: SidebarProps) {
  // The identity key resets preferences when switching computers/installations.
  return (
    <WorkspaceSidebarTree
      key={sidebarPreferenceKey(props.environmentId, props.installationID)}
      {...props}
    />
  );
}
function WorkspaceSidebarTree({
  environmentId,
  installationID,
  resources,
  search,
  onNavigate,
}: SidebarProps) {
  const params = useParams({ strict: false });
  const projects = useProjects();
  const threads = useThreadShells();
  const selectedThread = threads.find(
    (thread) =>
      thread.environmentId === environmentId &&
      "threadId" in params &&
      thread.id === params.threadId,
  );
  const state = useWorkspaceSidebarPreferences(sidebarPreferenceKey(environmentId, installationID));
  const navigationSearch = {
    ...search,
    environment: environmentId,
    expectedInstallationID: installationID,
  };
  const [offset, setOffset] = useState(0);
  const [launchTarget, setLaunchTarget] = useState<Resource | null>(null);
  const catalogResult = useAtomValue(
    workspaceView({ environmentId, input: { offset, limit: 50 } }),
  );
  const observed = Option.getOrNull(AsyncResult.value(catalogResult));
  const catalog = observed?.hello?.installationID === installationID ? observed : null;
  const observation = useAgentObservation(
    environmentId,
    `sidebar:${installationID}:${offset}`,
    observed,
  );
  const catalogFresh =
    catalogResult._tag !== "Failure" && !observation.stale && catalog?.state === "connected";
  const candidates = catalog
    ? [...catalog.resources, ...resources.filter((row) => row.workspaceID === search.workspace)]
    : resources;
  const seen = new Set<string>();
  const bases = orderedSidebarRows(
    candidates.filter((row) => {
      if (!row.workspace || row.workspace.lane || seen.has(row.workspaceID)) return false;
      seen.add(row.workspaceID);
      return true;
    }),
    state.preferences.order[workspaceGroup] ?? [],
    name,
  );
  const activeWorkspaceID =
    search.workspace ??
    (selectedThread
      ? bases.find((base) =>
          workspaceProjectIDs(environmentId, base, candidates, projects).has(
            selectedThread.projectId,
          ),
        )?.workspaceID
      : undefined);
  return (
    <>
      <div className={styles.heading}>Workspaces</div>
      <nav className={styles.tree} aria-label="Workspaces and sessions">
        <Siblings rows={bases} group={workspaceGroup} state={state}>
          {(base) => {
            const expanded = state.preferences.expanded[base.workspaceID] ?? false;
            return (
              <SidebarRow
                key={base.workspaceID}
                resource={base}
                baseID={base.workspaceID}
                state={state}
                search={navigationSearch}
                selected={
                  activeWorkspaceID === base.workspaceID &&
                  (!search.context || search.context === base.workspaceID)
                }
                workspaceActive={activeWorkspaceID === base.workspaceID}
                expanded={expanded}
                onNavigate={onNavigate}
                onNewSession={setLaunchTarget}
                launchEnabled={catalogFresh && canLaunch(base)}
                settingsEnabled={catalogFresh}
                onExpand={() =>
                  state.update((current) => ({
                    ...current,
                    expanded: { ...current.expanded, [base.workspaceID]: !expanded },
                  }))
                }
              >
                {expanded ? (
                  <WorkspaceSessions
                    environmentId={environmentId}
                    installationID={installationID}
                    resource={base}
                    resources={candidates}
                    selectedThreadId={"threadId" in params ? params.threadId : undefined}
                    onNavigate={onNavigate}
                    compact
                  />
                ) : null}
              </SidebarRow>
            );
          }}
        </Siblings>
        {!bases.length ? (
          <p className={styles.notice} role="status">
            {catalog?.state === "connected"
              ? "No workspaces yet"
              : AsyncResult.isInitial(catalogResult)
                ? "Loading workspaces…"
                : "Workspace list unavailable"}
          </p>
        ) : null}
        {catalog && (offset > 0 || catalog.nextOffset !== null) ? (
          <div className={styles.pages}>
            <button
              type="button"
              disabled={!offset}
              aria-label="Previous workspace page"
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              Previous
            </button>
            <button
              type="button"
              disabled={catalog.nextOffset === null}
              aria-label="Next workspace page"
              onClick={() => setOffset(catalog.nextOffset ?? offset)}
            >
              Next
            </button>
          </div>
        ) : null}
      </nav>
      {launchTarget ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setLaunchTarget(null);
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>New session in {name(launchTarget)}</DialogTitle>
              <DialogDescription>
                Workspace folders · opens with your chat defaults.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <SessionLauncher
                key={`${environmentId}:${installationID}:${launchTarget.workspaceID}:${launchTarget.generation}`}
                environmentId={environmentId}
                installationID={installationID}
                resource={launchTarget}
                enabled={catalogFresh && canLaunch(launchTarget)}
                compact
                autoOpen
                onOpened={() => {
                  setLaunchTarget(null);
                  onNavigate?.();
                }}
              />
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      ) : null}
    </>
  );
}
