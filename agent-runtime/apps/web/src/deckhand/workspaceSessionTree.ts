import type { WorkspaceSession } from "./sessionWorkspaceRows";

export type WorkspaceSessionNode = {
  session: WorkspaceSession;
  children: WorkspaceSessionNode[];
};

export const sessionOrderGroup = (workspaceID: string, parentID: string | null = null) =>
  JSON.stringify(["sessions", workspaceID, parentID]);

/** Saved positions apply only to siblings; unsorted sessions keep their start order. */
export function orderWorkspaceSessionTree(
  nodes: readonly WorkspaceSessionNode[],
  workspaceID: string,
  order: Readonly<Record<string, readonly string[]>>,
  parentID: string | null = null,
): WorkspaceSessionNode[] {
  const positions = new Map(
    (order[sessionOrderGroup(workspaceID, parentID)] ?? []).map((id, index) => [id, index]),
  );
  return [...nodes]
    .sort(
      (left, right) =>
        (positions.get(left.session.id) ?? Infinity) -
          (positions.get(right.session.id) ?? Infinity) || 0,
    )
    .map((node) => ({
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
      ? [{ session, children }]
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
