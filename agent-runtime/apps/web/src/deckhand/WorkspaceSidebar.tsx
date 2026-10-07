import { useAtomValue } from "@effect/atom-react";
import { workspaceChatUnavailableReason } from "@cinderdeck/shared/workspaceChat";
import { Link, useNavigate } from "@tanstack/react-router";
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
  PlayIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GripVerticalIcon,
  PlusIcon,
  StarIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { EnvironmentId } from "@cinderdeck/contracts";
import type { AgentActivityCounts, IntegrationView } from "@cinderdeck/contracts/deckhand/rpc";
import { managedContextsView, workspaceView } from "./state";
import { readLocalApi } from "../localApi";
import { LaneLifecycleControls } from "./LaneLifecycleControls";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../components/ui/tooltip";
import { useAgentObservation } from "./useAgentObservation";
import { WorkspaceCreateLaneButton, WorkspaceSettingsButton } from "./WorkspaceSettingsButton";
import { SessionLauncher } from "./SessionLauncher";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogPanel,
  DialogTitle,
  DialogDescription,
} from "../components/ui/dialog";
import {
  overviewResources,
  overviewWorkspaceContexts,
  type WorkspaceSearch,
} from "./workspaceNavigation";
import {
  orderedSidebarRows,
  readSidebarPreferences,
  reorderSidebarRows,
  sidebarPreferenceKey,
  type WorkspaceSidebarPreferences,
} from "./workspaceSidebarPreferences";
import styles from "./WorkspaceSidebar.module.css";
import { isReviewerLane } from "./reviewerLane";
import reviewerStyles from "./reviewerLane.module.css";

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
  activity,
  reviewer = false,
  onNavigate,
  onNewSession,
  launchEnabled,
  settingsEnabled,
  onDeleteLane,
  deletionEnabled = false,
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
  activity?: AgentActivityCounts | undefined;
  reviewer?: boolean;
  onNavigate?: (() => void) | undefined;
  onNewSession: (resource: Resource) => void;
  launchEnabled: boolean;
  settingsEnabled: boolean;
  onDeleteLane?: (resource: Resource) => void;
  deletionEnabled?: boolean;
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
        className={`${styles.row} ${reviewer ? reviewerStyles.reviewer : ""}`}
        data-reviewer={reviewer}
        data-current={selected || workspaceActive}
        data-dragging={isDragging}
        onContextMenu={
          onDeleteLane
            ? (event) => {
                const api = readLocalApi();
                if (!api) return;
                event.preventDefault();
                event.stopPropagation();
                void api.contextMenu
                  .show(
                    [
                      {
                        id: "delete-lane",
                        label: "Delete lane…",
                        destructive: true,
                        icon: "trash",
                        disabled: !deletionEnabled,
                      },
                    ],
                    { x: event.clientX, y: event.clientY },
                  )
                  .then((action) => {
                    if (action === "delete-lane" && deletionEnabled) onDeleteLane(resource);
                  })
                  .catch(() => {});
              }
            : undefined
        }
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
            tab: resource.workspace?.lane ? (search.tab ?? "agents") : "agents",
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
          {reviewer ? <span className={reviewerStyles.badge}>Reviewer</span> : null}
          <AgentBadges activity={activity} label={label} />
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

function AgentBadges({
  activity,
  label,
}: {
  activity?: AgentActivityCounts | undefined;
  label: string;
}) {
  if (!activity || activity.unavailable) return null;
  return (
    <span className={styles.badges}>
      {activity.running > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={<span />}
            className={`${styles.badge} ${styles.running}`}
            aria-label={`${label}: ${activity.running} ${activity.running === 1 ? "agent" : "agents"} running`}
          >
            <PlayIcon size={9} fill="currentColor" aria-hidden />
            {activity.running}
          </TooltipTrigger>
          <TooltipPopup>{`${activity.running} ${activity.running === 1 ? "agent" : "agents"} running`}</TooltipPopup>
        </Tooltip>
      ) : null}
      {activity.review > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={<span />}
            className={`${styles.badge} ${styles.review}`}
            aria-label={`${label}: ${activity.review} ${activity.review === 1 ? "agent needs" : "agents need"} review`}
          >
            <CircleDotIcon size={10} aria-hidden />
            {activity.review}
          </TooltipTrigger>
          <TooltipPopup>{`${activity.review} ${activity.review === 1 ? "agent needs" : "agents need"} review`}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}

function useSidebarAgentActivity(
  environmentId: EnvironmentId,
  installationID: string,
  rows: readonly Resource[],
) {
  const contexts = rows
    .map((row) => ({ workspaceID: row.workspaceID, generation: row.generation }))
    .sort((a, b) => a.workspaceID.localeCompare(b.workspaceID));
  const scope = JSON.stringify([installationID, contexts]);
  const result = useAtomValue(
    managedContextsView({ environmentId, input: { installationID, contexts } }),
  );
  const summaries = Option.getOrNull(AsyncResult.value(result));
  const observation = useAgentObservation(environmentId, scope, summaries);
  return result._tag === "Failure" || observation.stale ? null : summaries;
}

function WorkspaceLanes({
  baseID,
  environmentId,
  installationID,
  resources,
  state,
  search,
  onNavigate,
  onNewSession,
  onDeleteLane,
}: {
  baseID: string;
  environmentId: EnvironmentId;
  installationID: string;
  resources: readonly Resource[];
  state: SidebarState;
  search: WorkspaceSearch;
  onNavigate?: (() => void) | undefined;
  onNewSession: (resource: Resource) => void;
  onDeleteLane: (resource: Resource) => void;
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
  const observation = useAgentObservation(
    environmentId,
    JSON.stringify([baseID, offset]),
    observed,
  );
  const fresh = result._tag !== "Failure" && !observation.stale && view?.state === "connected";
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
  const summaries = useSidebarAgentActivity(environmentId, installationID, lanes);
  return (
    <div className={styles.lanes}>
      <div className={styles.laneHeading}>
        <span>{fresh && lanes.length === 0 ? "No lanes" : "Lanes"}</span>
        <WorkspaceCreateLaneButton
          environmentId={environmentId}
          workspaceID={baseID}
          label={`Create lane in ${view?.resources.find((row) => row.workspaceID === baseID)?.workspace?.name ?? baseID}`}
          compact
          enabled={fresh && view?.hello?.capabilities.includes("operations.lane.create") === true}
        />
      </div>
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
            activity={
              fresh
                ? summaries?.find(
                    (item) =>
                      item.workspaceID === row.workspaceID && item.generation === row.generation,
                  )?.agentActivity
                : undefined
            }
            reviewer={isReviewerLane(
              row,
              summaries?.find(
                (item) =>
                  item.workspaceID === row.workspaceID && item.generation === row.generation,
              ),
            )}
            onNavigate={onNavigate}
            onNewSession={onNewSession}
            launchEnabled={fresh && canLaunch(row)}
            settingsEnabled={fresh}
            onDeleteLane={onDeleteLane}
            deletionEnabled={
              fresh &&
              row.available &&
              !row.workspace?.definitionChanged &&
              !row.workspace?.issues.length &&
              view?.hello?.capabilities.includes("operations.receipts") === true &&
              ["operations.lane.release", "operations.lane.remove"].some((capability) =>
                view?.hello?.capabilities.includes(capability),
              )
            }
          />
        )}
      </Siblings>
      {!lanes.length && !fresh ? (
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
  const navigate = useNavigate();
  const state = useSidebarPreferences(sidebarPreferenceKey(environmentId, installationID));
  const navigationSearch = {
    ...search,
    environment: environmentId,
    expectedInstallationID: installationID,
  };
  const [offset, setOffset] = useState(0);
  const [launchTarget, setLaunchTarget] = useState<Resource | null>(null);
  const [removalTarget, setRemovalTarget] = useState<Resource | null>(null);
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
  const summaries = useSidebarAgentActivity(environmentId, installationID, bases);
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
                activity={
                  catalogFresh
                    ? summaries?.find(
                        (item) =>
                          item.workspaceID === base.workspaceID &&
                          item.generation === base.generation,
                      )?.workspaceAgentActivity
                    : undefined
                }
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
                    onNavigate={onNavigate}
                    onNewSession={setLaunchTarget}
                    onDeleteLane={setRemovalTarget}
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
      {removalTarget ? (
        <SidebarLaneRemoval
          environmentId={environmentId}
          installationID={installationID}
          target={removalTarget}
          onClose={() => setRemovalTarget(null)}
          onRemoved={() => {
            setRemovalTarget(null);
            state.update((current) => ({
              ...current,
              favorites: current.favorites.filter((id) => id !== removalTarget.workspaceID),
              order: Object.fromEntries(
                Object.entries(current.order).map(([group, ids]) => [
                  group,
                  ids.filter((id) => id !== removalTarget.workspaceID),
                ]),
              ),
            }));
            if (search.context === removalTarget.workspaceID) {
              const baseID = removalTarget.workspace!.lane!.sourceStackID;
              const base = bases.find((row) => row.workspaceID === baseID);
              void navigate({
                to: "/workspaces",
                search: {
                  environment: environmentId,
                  expectedInstallationID: installationID,
                  workspace: baseID,
                  context: baseID,
                  ...(search.tab ? { tab: search.tab } : {}),
                  ...(base ? { expectedGeneration: base.generation } : {}),
                },
              });
            }
          }}
        />
      ) : null}
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
                {launchTarget.workspace?.lane ? "Lane folders" : "Workspace folders"} · opens with
                your chat defaults.
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

function SidebarLaneRemoval({
  environmentId,
  installationID,
  target,
  onClose,
  onRemoved,
}: {
  environmentId: EnvironmentId;
  installationID: string;
  target: Resource;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [working, setWorking] = useState(false);
  const result = useAtomValue(
    workspaceView({
      environmentId,
      input: {
        offset: 0,
        limit: 1,
        selectedWorkspaceID: target.workspace!.lane!.sourceStackID,
        selectedContextID: target.workspaceID,
        workspacePage: { offset: 0, limit: 1 },
      },
    }),
  );
  const observed = Option.getOrNull(AsyncResult.value(result));
  const view = observed?.hello?.installationID === installationID ? observed : null;
  const observation = useAgentObservation(environmentId, target.workspaceID, observed);
  const current = overviewResources(view).find((row) => row.workspaceID === target.workspaceID);
  const sameLane =
    current?.generation === target.generation &&
    current?.workspace?.lane?.sourceStackID === target.workspace?.lane?.sourceStackID;
  const enabled =
    result._tag !== "Failure" && !observation.stale && view?.state === "connected" && sameLane;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !working) onClose();
      }}
    >
      <DialogPopup showCloseButton={!working}>
        <LaneLifecycleControls
          environmentId={environmentId}
          installationID={installationID}
          resource={sameLane ? current! : target}
          capabilities={view?.hello?.capabilities ?? []}
          enabled={enabled}
          mode="remove"
          onCancel={onClose}
          onRemoved={onRemoved}
          onWorking={setWorking}
        />
      </DialogPopup>
    </Dialog>
  );
}
