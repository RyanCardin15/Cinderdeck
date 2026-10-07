export type WorkspaceSidebarPreferences = {
  order: Record<string, string[]>;
  favorites: string[];
  expanded: Record<string, boolean>;
  colors: Record<string, string>;
};

const emptySidebarPreferences = (): WorkspaceSidebarPreferences => ({
  order: {},
  favorites: [],
  expanded: {},
  colors: {},
});

export const isSidebarColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

export function sidebarPreferenceKey(environment: string, installation: string) {
  return `cinderdeck.workspace-sidebar.v1:${JSON.stringify([environment, installation])}`;
}

export function readSidebarPreferences(key: string): WorkspaceSidebarPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
    if (!value || typeof value !== "object") return emptySidebarPreferences();
    const raw = value as Record<string, unknown>;
    const strings = (input: unknown): string[] =>
      Array.isArray(input)
        ? [...new Set(input.filter((id): id is string => typeof id === "string"))]
        : [];
    return {
      favorites: strings(raw.favorites),
      order: Object.fromEntries(
        Object.entries(raw.order && typeof raw.order === "object" ? raw.order : {}).map(
          ([group, ids]) => [group, strings(ids)],
        ),
      ),
      expanded: Object.fromEntries(
        Object.entries(raw.expanded && typeof raw.expanded === "object" ? raw.expanded : {}).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
        ),
      ),
      colors: Object.fromEntries(
        Object.entries(raw.colors && typeof raw.colors === "object" ? raw.colors : {}).filter(
          (entry): entry is [string, string] => isSidebarColor(entry[1]),
        ),
      ),
    };
  } catch {
    return emptySidebarPreferences();
  }
}

// A selected resource may arrive before the catalog. Its position must never
// depend on that transport ordering. New rows follow saved rows alphabetically.
export function orderedSidebarRows<T extends { workspaceID: string }>(
  rows: readonly T[],
  order: readonly string[],
  name: (row: T) => string,
): T[] {
  const positions = new Map(order.map((id, index) => [id, index]));
  return [...rows].sort(
    (left, right) =>
      (positions.get(left.workspaceID) ?? Infinity) -
        (positions.get(right.workspaceID) ?? Infinity) ||
      name(left).localeCompare(name(right)) ||
      left.workspaceID.localeCompare(right.workspaceID),
  );
}

// Only move within the rendered sibling group. Keep off-page IDs in their saved
// slots so paging or a temporarily missing resource cannot erase its order.
export function reorderSidebarRows(
  saved: readonly string[],
  visible: readonly string[],
  active: string,
  over: string,
): string[] {
  if (active === over || !visible.includes(active) || !visible.includes(over)) return [...saved];
  const reordered = [...visible];
  reordered.splice(reordered.indexOf(active), 1);
  reordered.splice(visible.indexOf(over), 0, active);
  const visibleIDs = new Set(visible);
  let index = 0;
  const result = saved.map((id) => (visibleIDs.has(id) ? reordered[index++]! : id));
  return [...result, ...reordered.slice(index)];
}
