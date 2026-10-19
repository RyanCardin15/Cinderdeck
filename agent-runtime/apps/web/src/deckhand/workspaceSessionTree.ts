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

/** Pinned groups, arranged positions, then deterministic newest-first sessions. */
export function orderWorkspaceSessionTree(
  nodes: readonly WorkspaceSessionNode[],
  workspaceID: string,
  order: Readonly<Record<string, readonly string[]>>,
  parentID: string | null = null,
): WorkspaceSessionNode[] {
  const annotated = nodes.map((node) => ({ ...node, pinTime: sessionPinTime(node) }));
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
    children: orderWorkspaceSessionTree(node.children, workspaceID, order, node.session.id),
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
