import type { WorkspaceSession } from "./sessionWorkspaceRows";
import { reorderSidebarRows } from "./workspaceSidebarPreferences";

export type WorkspaceSessionNode = {
  session: WorkspaceSession;
  children: WorkspaceSessionNode[];
  /** Keep group membership stable when search hides a pinned descendant. */
  pinTime?: number | null;
};

export const sessionOrderGroup = (workspaceID: string, parentID: string | null = null) =>
  JSON.stringify(["sessions", workspaceID, parentID]);

export const sessionArrangementGroup = (
  workspaceID: string,
  parentID: string | null = null,
  pinned = false,
) => JSON.stringify(["session-arrangement", workspaceID, parentID, pinned]);

export const pinnedSessionGroup = (workspaceID: string) =>
  JSON.stringify(["pinned-sessions", workspaceID]);

export const manuallyMovedSessionGroup = (workspaceID: string, parentID: string | null = null) =>
  JSON.stringify(["session-moved", workspaceID, parentID]);

export const sessionOrderSnapshotGroup = (workspaceID: string, parentID: string | null = null) =>
  JSON.stringify(["session-order-snapshot", workspaceID, parentID]);

const time = (value: string | null | undefined) => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Keep pinned descendants with their parent rather than duplicating conversations. */
export function sessionPinTime(node: WorkspaceSessionNode): number | null {
  if (node.pinTime !== undefined) return node.pinTime;
  const pins = node.children.map(sessionPinTime).filter((pin) => pin !== null);
  if (node.session.pinned) pins.push(time(node.session.pinnedAt ?? node.session.createdAt));
  return pins.length ? Math.max(...pins) : null;
}

// A fresh pin has a new identity for ordering, even when the same session is repinned.
export const sessionArrangementID = (node: WorkspaceSessionNode) => {
  const pin = sessionPinTime(node);
  return pin === null ? node.session.id : JSON.stringify([node.session.id, pin]);
};

/** Save only the arranged prefix, leaving untouched recent sessions chronological. */
export function arrangeSessionRows(
  saved: readonly string[],
  all: readonly WorkspaceSessionNode[],
  visible: readonly WorkspaceSessionNode[],
  active: string,
  over: string,
): string[] {
  const ids = visible.map((node) => node.session.id);
  if (active === over || !ids.includes(active) || !ids.includes(over)) return [...saved];
  const reordered = reorderSidebarRows(
    all.map((node) => node.session.id),
    ids,
    active,
    over,
  );
  const byID = new Map(all.map((node) => [node.session.id, node]));
  const tokens = reordered.map((id) => sessionArrangementID(byID.get(id)!));
  const savedIDs = new Set(saved);
  const lastSaved = tokens.reduce((last, id, index) => (savedIDs.has(id) ? index : last), -1);
  const prefix = tokens.slice(0, Math.max(lastSaved, reordered.indexOf(active)) + 1);
  const known = new Set(all.map(sessionArrangementID));
  // Missing/filtered history keeps its saved slots without capturing every visible row.
  let index = 0;
  const merged = saved.flatMap((id) =>
    known.has(id) ? (index < prefix.length ? [prefix[index++]!] : []) : [id],
  );
  return [...merged, ...prefix.slice(index)];
}

/** Record the actual moved row separately from neighbors captured by a drop. */
export function reorderWorkspaceSessions(
  order: Record<string, string[]>,
  workspaceID: string,
  parentID: string | null,
  all: readonly WorkspaceSessionNode[],
  visible: readonly WorkspaceSessionNode[],
  active: string,
  over: string,
  snapshot: readonly WorkspaceSessionNode[] = all,
): Record<string, string[]> {
  const activeNode = visible.find((node) => node.session.id === active);
  const overNode = visible.find((node) => node.session.id === over);
  if (!activeNode || !overNode || active === over) return order;
  const pinned = sessionPinTime(activeNode) !== null;
  if (pinned !== (sessionPinTime(overNode) !== null)) return order;
  const siblings = all.filter((node) => (sessionPinTime(node) !== null) === pinned);
  const group = sessionArrangementGroup(workspaceID, parentID, pinned);
  const next = {
    ...order,
    [group]: arrangeSessionRows(
      order[group] ?? (pinned ? [] : (order[sessionOrderGroup(workspaceID, parentID)] ?? [])),
      siblings,
      visible.filter((node) => (sessionPinTime(node) !== null) === pinned),
      active,
      over,
    ),
  };
  if (!pinned) {
    const movedGroup = manuallyMovedSessionGroup(workspaceID, parentID);
    const snapshotGroup = sessionOrderSnapshotGroup(workspaceID, parentID);
    next[movedGroup] = [...new Set([...(order[movedGroup] ?? []), active])];
    // Persist the boundary, so archived/missing rows cannot change what counts as new.
    const newest = snapshot.reduce(
      (latest, node) => Math.max(latest, time(node.session.createdAt)),
      time(order[snapshotGroup]?.[0]),
    );
    const sameBoundary = time(order[snapshotGroup]?.[0]) === newest;
    next[snapshotGroup] = [
      new Date(newest).toISOString(),
      ...new Set([
        ...(sameBoundary ? (order[snapshotGroup]?.slice(1) ?? []) : []),
        ...snapshot.map((node) => node.session.id),
      ]),
    ];
  }
  return next;
}

/** Pinned groups, arranged positions, then deterministic newest-first sessions. */
export function orderWorkspaceSessionTree(
  nodes: readonly WorkspaceSessionNode[],
  workspaceID: string,
  order: Readonly<Record<string, readonly string[]>>,
  parentID: string | null = null,
  snapshot: readonly WorkspaceSessionNode[] = nodes,
): WorkspaceSessionNode[] {
  const annotated = nodes.map((node) => ({ ...node, pinTime: sessionPinTime(node) }));
  const snapshotByID = new Map(snapshot.map((node) => [node.session.id, node]));
  const groups = [true, false].flatMap((pinned) => {
    const siblings = annotated.filter((node) => (sessionPinTime(node) !== null) === pinned);
    const arrangement = order[sessionArrangementGroup(workspaceID, parentID, pinned)];
    const positions = new Map(
      (arrangement ?? (pinned ? [] : (order[sessionOrderGroup(workspaceID, parentID)] ?? []))).map(
        (id, index) => [id, index],
      ),
    );
    const key = (node: WorkspaceSessionNode) =>
      arrangement ? sessionArrangementID(node) : node.session.id;
    if (!pinned) {
      const saved = arrangement ?? order[sessionOrderGroup(workspaceID, parentID)] ?? [];
      const moved = new Set(order[manuallyMovedSessionGroup(workspaceID, parentID)] ?? []);
      const firstAutomatic = saved.findIndex((id) => !moved.has(id));
      const stickyCount = firstAutomatic === -1 ? saved.length : firstAutomatic;
      const savedSnapshot = order[sessionOrderSnapshotGroup(workspaceID, parentID)]?.[0];
      const knownAtSnapshot = new Set(
        order[sessionOrderSnapshotGroup(workspaceID, parentID)]?.slice(1) ?? [],
      );
      const newestSavedStart =
        savedSnapshot === undefined
          ? snapshot.reduce(
              (latest, node) =>
                positions.has(node.session.id)
                  ? Math.max(latest, time(node.session.createdAt))
                  : latest,
              0,
            )
          : time(savedSnapshot);
      const rank = (node: WorkspaceSessionNode) => {
        const position = positions.get(node.session.id);
        if (position !== undefined && position < stickyCount) return 0;
        const started = time(node.session.createdAt);
        if (
          position === undefined &&
          (started > newestSavedStart ||
            (started === newestSavedStart && !knownAtSnapshot.has(node.session.id)))
        )
          return 1;
        return position !== undefined ? 2 : 3;
      };
      return siblings.sort(
        (left, right) =>
          rank(left) - rank(right) ||
          (positions.get(left.session.id) ?? Infinity) -
            (positions.get(right.session.id) ?? Infinity) ||
          time(right.session.createdAt) - time(left.session.createdAt) ||
          left.session.id.localeCompare(right.session.id),
      );
    }
    // Newly pinned sessions always lead existing pins; old hidden pins retain their slots.
    const latestArrangedPin = (arrangement ?? []).reduce((latest, token) => {
      try {
        const value: unknown = JSON.parse(token);
        return Array.isArray(value) && typeof value[1] === "number"
          ? Math.max(latest, value[1])
          : latest;
      } catch {
        return latest;
      }
    }, -1);
    const position = (node: WorkspaceSessionNode) =>
      positions.get(key(node)) ??
      (pinned && (sessionPinTime(node) ?? 0) > latestArrangedPin ? -1 : Infinity);
    return siblings.sort(
      (left, right) =>
        position(left) - position(right) ||
        (pinned ? (sessionPinTime(right) ?? 0) - (sessionPinTime(left) ?? 0) : 0) ||
        time(right.session.createdAt) - time(left.session.createdAt) ||
        left.session.id.localeCompare(right.session.id),
    );
  });
  return groups.map((node) => ({
    ...node,
    children: orderWorkspaceSessionTree(
      node.children,
      workspaceID,
      order,
      node.session.id,
      snapshotByID.get(node.session.id)?.children ?? node.children,
    ),
  }));
}

/** Only sub-agent edges nest sessions; forks remain independent conversations. */
export function workspaceSessionTree(
  sessions: readonly WorkspaceSession[],
): WorkspaceSessionNode[] {
  const nodes = new Map(
    sessions.map((session) => [session.id, { session, children: [] } as WorkspaceSessionNode]),
  );
  const parents = new Map<string, string>();
  for (const session of sessions) {
    if (
      session.isSubagent &&
      session.parentThreadId &&
      session.parentThreadId !== session.id &&
      nodes.has(session.parentThreadId)
    ) {
      parents.set(session.id, session.parentThreadId);
    }
  }
  // Keep malformed legacy relationships reachable and prevent recursive cycles.
  const checked = new Set<string>();
  for (const session of sessions) {
    const path = new Set<string>();
    let id: string | undefined = session.id;
    while (id && !checked.has(id)) {
      if (path.has(id)) {
        parents.delete(id);
        break;
      }
      path.add(id);
      id = parents.get(id);
    }
    for (const visited of path) checked.add(visited);
  }
  const roots: WorkspaceSessionNode[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(parents.get(node.session.id) ?? "");
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Retain ancestors for context when a descendant matches search or archive filters. */
export function filterWorkspaceSessionTree(
  nodes: readonly WorkspaceSessionNode[],
  options: { query: string; archived: boolean; selectedThreadId?: string | undefined },
): WorkspaceSessionNode[] {
  const query = options.query.trim().toLocaleLowerCase();
  const filter = (node: WorkspaceSessionNode, ancestorMatches: boolean): WorkspaceSessionNode[] => {
    const { session } = node;
    const eligible =
      options.archived || !session.archived || session.id === options.selectedThreadId;
    const matches = eligible && (!query || session.title.toLocaleLowerCase().includes(query));
    const children = node.children.flatMap((child) => filter(child, ancestorMatches || matches));
    return matches || (eligible && ancestorMatches) || children.length
      ? [{ ...node, children }]
      : [];
  };
  return nodes.flatMap((node) => filter(node, false));
}

export function sessionTreeContains(node: WorkspaceSessionNode, id: string | undefined): boolean {
  return (
    !!id &&
    (node.session.id === id || node.children.some((child) => sessionTreeContains(child, id)))
  );
}
