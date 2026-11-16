// Formats the native helper's accessibility nodes as compact indexed text, and
// diffs successive reads. Indexes are stable for unchanged elements, so a diff
// lists only what was added, changed, or removed.

export interface ComputerNode {
  readonly id: number;
  readonly parent: number;
  readonly depth: number;
  readonly role: string;
  readonly subrole?: string;
  readonly title?: string;
  readonly value?: string;
  readonly description?: string;
  readonly help?: string;
  readonly placeholder?: string;
  readonly identifier?: string;
  readonly url?: string;
  readonly disabled?: boolean;
  readonly focused?: boolean;
  readonly selected?: boolean;
  readonly expanded?: boolean;
  readonly actions?: ReadonlyArray<string>;
}

const roleNames: Record<string, string> = {
  AXStaticText: "text",
  AXWebArea: "web area",
  AXTextField: "text field",
  AXTextArea: "text area",
  AXPopUpButton: "pop up button",
  AXMenuBarItem: "menu bar item",
  AXUnknown: "element",
};
const quietSubroles = new Set(["AXStandardWindow", "AXUnknown", "AXTextAttachment"]);

const humanize = (axName: string) =>
  roleNames[axName] ??
  axName
    .replace(/^AX/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();

// Generated identifiers (UUIDs, AppKit "_NS:123") carry no meaning for the model.
const meaningfulIdentifier = (identifier: string) =>
  !/^[0-9a-f-]{16,}$/i.test(identifier) &&
  !identifier.startsWith("_") &&
  !identifier.includes("_NS:");

export function formatNode(node: ComputerNode): string {
  let line = `${node.id} ${humanize(node.role)}`;
  if (node.subrole && !quietSubroles.has(node.subrole)) line += ` (${humanize(node.subrole)})`;
  const details: string[] = [];
  if (node.title) line += ` ${JSON.stringify(node.title)}`;
  if (node.description) {
    if (node.title) details.push(`Description: ${JSON.stringify(node.description)}`);
    else line += ` ${JSON.stringify(node.description)}`;
  }
  if (node.value !== undefined && node.value !== node.title)
    details.push(`Value: ${JSON.stringify(node.value)}`);
  if (node.placeholder) details.push(`Placeholder: ${JSON.stringify(node.placeholder)}`);
  if (node.help) details.push(`Help: ${JSON.stringify(node.help)}`);
  if (node.identifier && meaningfulIdentifier(node.identifier))
    details.push(`ID: ${node.identifier}`);
  if (node.url) details.push(`URL: ${node.url}`);
  if (node.focused) details.push("focused");
  if (node.selected) details.push("selected");
  if (node.disabled) details.push("disabled");
  if (node.expanded !== undefined) details.push(node.expanded ? "expanded" : "collapsed");
  if (node.actions && node.actions.length > 0)
    details.push(`Secondary Actions: ${node.actions.join(", ")}`);
  return details.length > 0 ? `${line}, ${details.join(", ")}` : line;
}

export function formatTree(nodes: ReadonlyArray<ComputerNode>): string {
  return nodes
    .map((node) => `${"  ".repeat(Math.min(node.depth, 30))}${formatNode(node)}`)
    .join("\n");
}

/** Lines keyed by stable element index, kept to diff the next read against. */
export type TreeSnapshot = ReadonlyMap<number, string>;

export function snapshotTree(nodes: ReadonlyArray<ComputerNode>): TreeSnapshot {
  return new Map(nodes.map((node) => [node.id, formatNode(node)]));
}

export interface TreeDiff {
  readonly text: string;
  readonly changes: number;
}

/**
 * Diffs against the previous snapshot. Returns null when a full tree is the
 * better answer: no previous read, or so much changed that the diff is noise.
 */
export function diffTree(
  previous: TreeSnapshot | undefined,
  nodes: ReadonlyArray<ComputerNode>,
): TreeDiff | null {
  if (!previous || previous.size === 0 || nodes.length === 0) return null;
  const added: string[] = [];
  const changed: string[] = [];
  const seen = new Set<number>();
  for (const node of nodes) {
    seen.add(node.id);
    const line = formatNode(node);
    const before = previous.get(node.id);
    if (before === undefined) added.push(`+ ${line}`);
    else if (before !== line) changed.push(`~ ${line}`);
  }
  const removed: string[] = [];
  for (const [id, line] of previous) if (!seen.has(id)) removed.push(`- ${line}`);
  const changes = added.length + changed.length + removed.length;
  if (changes > Math.max(40, nodes.length * 0.5)) return null;
  if (changes === 0) {
    return { text: "No changes since the previous state.", changes };
  }
  const unchanged = nodes.length - added.length - changed.length;
  return {
    text: [
      "Changes since the previous state (unchanged elements keep their indexes):",
      ...changed,
      ...added,
      ...removed,
      `(${unchanged} elements unchanged)`,
    ].join("\n"),
    changes,
  };
}
