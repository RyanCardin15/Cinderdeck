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
  CircleDotIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GripVerticalIcon,
  PlusIcon,
  StarIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { EnvironmentId } from "@cinderdeck/contracts";
import type { IntegrationView } from "@cinderdeck/contracts/deckhand/rpc";
import { workspaceView } from "./state";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../components/ui/tooltip";
import { WorkspaceSettingsButton } from "./WorkspaceSettingsButton";
import { SessionLauncher } from "./SessionLauncher";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../components/ui/dialog";
import { overviewWorkspaceContexts, type WorkspaceSearch } from "./workspaceNavigation";
import {
  orderedSidebarRows,
  readSidebarPreferences,
  reorderSidebarRows,
  sidebarPreferenceKey,
  type WorkspaceSidebarPreferences,
} from "./workspaceSidebarPreferences";
import styles from "./WorkspaceSidebar.module.css";

type Resource = IntegrationView["resources"][number];
const workspaceGroup = "workspaces";
const laneGroup = (id: string) => `lanes:${id}`;
const name = (row: Resource) => row.workspace?.lane?.name ?? row.workspace?.name ?? row.workspaceID;
const canLaunch = (row: Resource) => workspaceChatUnavailableReason(row) === null;

function useSidebarPreferences(key: string) {
  const [preferences, setPreferences] = useState(() => readSidebarPreferences(key));
  useEffect(() => {
    const refresh = () => setPreferences(readSidebarPreferences(key));
    window.addEventListener("storage", refresh);
    window.addEventListener("cinderdeck-sidebar-preferences", refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("cinderdeck-sidebar-preferences", refresh);
    };
  }, [key]);
  const update = (change: (value: WorkspaceSidebarPreferences) => WorkspaceSidebarPreferences) => {
    const next = change(preferences);
    setPreferences(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      window.dispatchEvent(new Event("cinderdeck-sidebar-preferences"));
    } catch {
      /* Session state still works when storage is unavailable. */
    }
  };
  return { preferences, update };
}
type SidebarState = ReturnType<typeof useSidebarPreferences>;

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
  attention,
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
  attention?: boolean;
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
  return (
    <div
      ref={setNodeRef}
      className={styles.group}
      data-workspace-id={resource.workspaceID}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <div
        className={styles.row}
        data-current={selected || workspaceActive}
        data-dragging={isDragging}
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
            aria-label={`${expanded ? "Collapse" : "Expand"} lanes for ${label}`}
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
            tab: search.tab ?? "services",
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
          <span>{label}</span>
          {attention ? <CircleDotIcon size={10} aria-label="Needs attention" /> : null}
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
      {children}
    </div>
  );
}

function WorkspaceLanes({
  baseID,
  environmentId,
  installationID,
  resources,
  state,
  search,
  needsAttention,
  onNavigate,
  onNewSession,
}: {
  baseID: string;
  environmentId: EnvironmentId;
  installationID: string;
  resources: readonly Resource[];
  state: SidebarState;
  search: WorkspaceSearch;
  needsAttention?: ((row: Resource) => boolean) | undefined;
  onNavigate?: (() => void) | undefined;
  onNewSession: (resource: Resource) => void;
}) {
  const [offset, setOffset] = useState(0);
  const result = useAtomValue(
    workspaceView({
      environmentId,
      input: {
        offset: 0,
        limit: 1,
        selectedWorkspaceID: baseID,
        workspacePage: { offset, limit: 50 },
      },
    }),
  );
  const observed = Option.getOrNull(AsyncResult.value(result));
  const view = observed?.hello?.installationID === installationID ? observed : null;
  const fresh = result._tag !== "Failure" && view?.state === "connected";
  const page = view?.workspaceContexts?.workspaceID === baseID ? view.workspaceContexts : null;
  const scoped = overviewWorkspaceContexts(view, baseID);
  // Preserve an off-page selected lane, without mixing in other catalog pages.
  const pinned = resources.filter((row) => row.workspaceID === search.context);
  const candidates = page ? [...scoped, ...pinned] : [...scoped, ...resources];
  const seen = new Set<string>();
  const lanes = orderedSidebarRows(
    candidates.filter((row) => {
      if (row.workspace?.lane?.sourceStackID !== baseID || seen.has(row.workspaceID)) return false;
      seen.add(row.workspaceID);
      return true;
    }),
    state.preferences.order[laneGroup(baseID)] ?? [],
    name,
  );
  return (
    <div className={styles.lanes}>
      {view && !fresh && lanes.length > 0 ? (
        <p className={styles.notice} role="status">
          Last observed lanes
        </p>
      ) : null}
      <Siblings rows={lanes} group={laneGroup(baseID)} state={state}>
        {(row) => (
          <SidebarRow
            key={row.workspaceID}
            resource={row}
            baseID={baseID}
            state={state}
            search={search}
            selected={search.context === row.workspaceID}
            attention={needsAttention?.(row) ?? false}
            onNavigate={onNavigate}
            onNewSession={onNewSession}
            launchEnabled={fresh && canLaunch(row)}
            settingsEnabled={fresh}
          />
        )}
      </Siblings>
      {!lanes.length ? (
        <p className={styles.notice} role="status">
          {fresh
            ? "No lanes"
            : AsyncResult.isInitial(result)
              ? "Loading lanes…"
              : "Lane list unavailable"}
        </p>
      ) : null}
      {page && (offset > 0 || page.nextOffset !== null) ? (
        <div className={styles.pages}>
          <button
            type="button"
            disabled={offset === 0}
            aria-label={`Previous lanes for ${baseID}`}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            Previous
          </button>
          <button
            type="button"
            disabled={page.nextOffset === null}
            aria-label={`Next lanes for ${baseID}`}
            onClick={() => setOffset(page.nextOffset ?? offset)}
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}

type SidebarProps = {
  environmentId: EnvironmentId;
  installationID: string;
  resources: readonly Resource[];
  search: WorkspaceSearch;
  needsAttention?: (row: Resource) => boolean;
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
  needsAttention,
  onNavigate,
}: SidebarProps) {
  const state = useSidebarPreferences(sidebarPreferenceKey(environmentId, installationID));
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
  const catalogFresh = catalogResult._tag !== "Failure" && catalog?.state === "connected";
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
  return (
    <>
      <div className={styles.heading}>Workspaces</div>
      <nav className={styles.tree} aria-label="Workspaces and lanes">
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
                  search.workspace === base.workspaceID &&
                  (!search.context || search.context === base.workspaceID)
                }
                workspaceActive={search.workspace === base.workspaceID}
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
                  <WorkspaceLanes
                    baseID={base.workspaceID}
                    environmentId={environmentId}
                    installationID={installationID}
                    resources={resources}
                    state={state}
                    search={navigationSearch}
                    needsAttention={needsAttention}
                    onNavigate={onNavigate}
                    onNewSession={setLaunchTarget}
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
            <DialogTitle>New session in {name(launchTarget)}</DialogTitle>
            <DialogDescription>
              {launchTarget.workspace?.lane ? "Lane folders" : "Workspace folders"} · opens with
              your chat defaults.
            </DialogDescription>
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
          </DialogPopup>
        </Dialog>
      ) : null}
    </>
  );
}
