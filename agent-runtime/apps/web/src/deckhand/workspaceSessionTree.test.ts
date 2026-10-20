import { expect, it } from "vite-plus/test";
import type { WorkspaceSession } from "./sessionWorkspaceRows";
import {
  filterWorkspaceSessionTree,
  orderWorkspaceSessionTree,
  sessionOrderGroup,
  sessionArrangementGroup,
  sessionArrangementID,
  arrangeSessionRows,
  reorderWorkspaceSessions,
  manuallyMovedSessionGroup,
  sessionOrderSnapshotGroup,
  sessionTreeContains,
  workspaceSessionTree,
  type WorkspaceSessionNode,
} from "./workspaceSessionTree";

const session = (id: string, parentThreadId: string | null = null): WorkspaceSession => ({
  id,
  title: id,
  parentThreadId,
  isSubagent: parentThreadId !== null,
  providerInstanceId: "codex",
  createdAt: "2026-10-14T12:00:00Z",
  updatedAt: "2026-10-14T12:00:00Z",
  archived: false,
  pinned: false,
  status: "idle",
});
const ids = (nodes: readonly WorkspaceSessionNode[]): unknown[] =>
  nodes.map((node) => [node.session.id, ids(node.children)]);

it("applies saved sibling order without changing parents or unsorted start order", () => {
  const tree = workspaceSessionTree([
    session("newest"),
    session("second"),
    session("main"),
    session("first-child", "main"),
    session("second-child", "main"),
    session("grandchild", "first-child"),
  ]);
  const order = {
    [sessionOrderGroup("app")]: ["missing", "main", "second"],
    [sessionOrderGroup("app", "main")]: ["second-child", "first-child"],
  };
  expect(ids(orderWorkspaceSessionTree(tree, "app", order))).toEqual([
    ["newest", []],
    [
      "main",
      [
        ["second-child", []],
        ["first-child", [["grandchild", []]]],
      ],
    ],
    ["second", []],
  ]);
  expect(orderWorkspaceSessionTree(tree, "other-workspace", order)).toEqual(
    orderWorkspaceSessionTree(tree, "app", {}),
  );
  expect(sessionOrderGroup("app", "main")).not.toBe(sessionOrderGroup("app:main"));
});

it("nests multiple generations under their immediate parents while preserving start order", () => {
  const tree = workspaceSessionTree([
    session("grandchild", "child"),
    session("child", "main"),
    session("sibling", "main"),
    session("newer-main"),
    session("main"),
  ]);
  expect(ids(tree)).toEqual([
    ["newer-main", []],
    [
      "main",
      [
        ["child", [["grandchild", []]]],
        ["sibling", []],
      ],
    ],
  ]);
  expect(sessionTreeContains(tree[1]!, "grandchild")).toBe(true);
  expect(sessionTreeContains(tree[0]!, "grandchild")).toBe(false);
});

it("puts new starts ahead of old snapshots while preserving their existing relative order", () => {
  const started = (id: string, day: number, parent: string | null = null) => ({
    ...session(id, parent),
    createdAt: new Date(Date.UTC(2026, 9, day)).toISOString(),
  });
  const tree = workspaceSessionTree([
    started("newest", 15),
    started("new", 14),
    started("recent", 13),
    started("main", 12),
    started("new-child", 15, "main"),
    started("recent-child", 13, "main"),
    started("older-child", 12, "main"),
    started("old-history", 1),
    { ...session("unknown-start"), createdAt: "invalid" },
  ]);
  const order = {
    [sessionOrderGroup("app")]: ["missing", "main", "recent"],
    [sessionOrderGroup("app", "main")]: ["older-child", "recent-child"],
  };
  const ordered = orderWorkspaceSessionTree(tree, "app", order);
  expect(ids(ordered)).toEqual([
    ["newest", []],
    ["new", []],
    [
      "main",
      [
        ["new-child", []],
        ["older-child", []],
        ["recent-child", []],
      ],
    ],
    ["recent", []],
    ["old-history", []],
    ["unknown-start", []],
  ]);
  expect(orderWorkspaceSessionTree(ordered, "app", order)).toEqual(ordered);
  expect(order[sessionOrderGroup("app")]).toEqual(["missing", "main", "recent"]);
});

it("repeated drops preserve the displayed order while new unarranged sessions remain recent", () => {
  const nodes = workspaceSessionTree(
    Array.from({ length: 15 }, (_, index) => ({
      ...session(`session-${index}`),
      createdAt: new Date(Date.UTC(2026, 9, index + 1)).toISOString(),
    })),
  );
  const group = sessionArrangementGroup("app");
  const before = orderWorkspaceSessionTree(nodes, "app", {});
  const firstOrder = reorderWorkspaceSessions(
    {},
    "app",
    null,
    before,
    before.slice(0, 10),
    "session-5",
    "session-14",
  );
  const first = firstOrder[group];
  expect(first).toEqual(["session-5"]);
  const withNew = [
    ...nodes,
    { session: { ...session("new"), createdAt: "2026-10-19T00:00:00Z" }, children: [] },
  ];
  const next = orderWorkspaceSessionTree(withNew, "app", firstOrder);
  expect(next.slice(0, 4).map((node) => node.session.id)).toEqual([
    "session-5",
    "new",
    "session-14",
    "session-13",
  ]);
  const secondOrder = reorderWorkspaceSessions(
    firstOrder,
    "app",
    null,
    next,
    next.slice(0, 10),
    "session-13",
    "new",
  );
  const second = secondOrder[group];
  expect(second).toEqual(["session-5", "session-13"]);
  const after = orderWorkspaceSessionTree(withNew.toReversed(), "app", secondOrder);
  expect(after.map((node) => node.session.id)).toEqual([
    "session-5",
    "session-13",
    "new",
    "session-14",
    ...Array.from({ length: 13 }, (_, i) => `session-${12 - i}`).filter((id) => id !== "session-5"),
  ]);
});

it("does not let untouched neighbors captured by a downward drag outrank new threads", () => {
  const node = (id: string, day: number): WorkspaceSessionNode => ({
    session: { ...session(id), createdAt: new Date(Date.UTC(2026, 9, day)).toISOString() },
    children: [],
  });
  const original = [node("a", 4), node("b", 3), node("c", 2), node("d", 1)];
  const down = reorderWorkspaceSessions({}, "app", null, original, original, "a", "c");
  expect(down[sessionArrangementGroup("app")]).toEqual(["b", "c", "a"]);
  expect(down[manuallyMovedSessionGroup("app")]).toEqual(["a"]);
  const nextNodes = [node("e", 5), ...original];
  const next = orderWorkspaceSessionTree(nextNodes, "app", down);
  expect(next.map((row) => row.session.id)).toEqual(["e", "b", "c", "a", "d"]);
  const up = reorderWorkspaceSessions(down, "app", null, next, next, "a", "e");
  expect(up[manuallyMovedSessionGroup("app")]).toEqual(["a"]);
  const newest = orderWorkspaceSessionTree([node("f", 6), ...nextNodes], "app", up);
  expect(newest.map((row) => row.session.id)).toEqual(["a", "f", "e", "b", "c", "d"]);
});

it("keeps the new-thread boundary stable when a saved row disappears or older history arrives late", () => {
  const node = (id: string, day: number): WorkspaceSessionNode => ({
    session: { ...session(id), createdAt: new Date(Date.UTC(2026, 9, day)).toISOString() },
    children: [],
  });
  const rows = [node("latest", 15), node("older", 10), node("oldest", 1)];
  const order = reorderWorkspaceSessions({}, "app", null, rows, rows, "latest", "older");
  expect(order[sessionOrderSnapshotGroup("app")]).toEqual([
    "2026-10-15T00:00:00.000Z",
    "latest",
    "older",
    "oldest",
  ]);
  const partial = [node("fresh", 16), node("late-history", 12), rows[1]!, rows[2]!];
  expect(orderWorkspaceSessionTree(partial, "app", order).map((row) => row.session.id)).toEqual([
    "fresh",
    "older",
    "late-history",
    "oldest",
  ]);
  expect(
    orderWorkspaceSessionTree([...partial, rows[0]!], "app", order).map((row) => row.session.id),
  ).toEqual(["fresh", "older", "latest", "late-history", "oldest"]);
  expect(
    orderWorkspaceSessionTree(partial.toReversed(), "app", order).map((row) => row.session.id),
  ).toEqual(["fresh", "older", "late-history", "oldest"]);
});

it("puts a newly created thread first even when its creation timestamp matches the last snapshot", () => {
  const rows = workspaceSessionTree([session("latest"), session("older"), session("untouched")]);
  const order = reorderWorkspaceSessions({}, "app", null, rows, rows, "latest", "older");
  const created = workspaceSessionTree([session("new"), ...rows.map((node) => node.session)]);
  expect(orderWorkspaceSessionTree(created, "app", order).map((row) => row.session.id)).toEqual([
    "new",
    "older",
    "latest",
    "untouched",
  ]);
});

it("keeps hidden sessions in place when arranging a filtered subset", () => {
  const all = workspaceSessionTree([session("a"), session("hidden"), session("b"), session("c")]);
  const saved = ["a", "missing", "hidden", "b"];
  const visible = all.filter((node) => node.session.id !== "hidden");
  const next = arrangeSessionRows(saved, all, visible, "c", "a");
  expect(next).toEqual(["c", "missing", "hidden", "a", "b"]);
  expect(arrangeSessionRows(saved, all, visible, "a", "other-workspace")).toEqual(saved);
});

it("new pins and repins lead arranged pins, and unpinning restores the regular arrangement", () => {
  const a = {
    session: { ...session("a"), pinned: true, pinnedAt: "2026-10-17T00:00:00Z" },
    children: [],
  };
  const b = {
    session: { ...session("b"), pinned: true, pinnedAt: "2026-10-18T00:00:00Z" },
    children: [],
  };
  const order = {
    [sessionArrangementGroup("app", null, true)]: [
      sessionArrangementID(a),
      sessionArrangementID(b),
    ],
    [sessionArrangementGroup("app")]: ["a"],
    [manuallyMovedSessionGroup("app")]: ["a"],
  };
  const list = (nodes: WorkspaceSessionNode[]) =>
    orderWorkspaceSessionTree(nodes, "app", order).map((node) => node.session.id);
  expect(list([b, a])).toEqual(["a", "b"]);
  const repinned = { ...b, session: { ...b.session, pinnedAt: "2026-10-19T00:00:00Z" } };
  expect(list([a, repinned])).toEqual(["b", "a"]);
  expect(
    list([
      b,
      { ...a, session: { ...a.session, pinned: false, pinnedAt: null } },
      { session: session("new"), children: [] },
    ]),
  ).toEqual(["b", "a", "new"]);
});

it("keeps missing, deleted and cyclic parent relationships reachable without duplicate sessions", () => {
  const tree = workspaceSessionTree([
    session("missing-parent", "missing"),
    session("self", "self"),
    session("a", "b"),
    session("b", "a"),
    session("c", "b"),
  ]);
  expect(ids(tree)).toEqual([
    ["missing-parent", []],
    ["self", []],
    ["a", [["b", [["c", []]]]]],
  ]);
});

it("keeps a matching descendant's ancestors and shows the whole group when its parent matches", () => {
  const tree = workspaceSessionTree([
    session("target", "child"),
    session("child", "main"),
    session("sibling", "main"),
    session("other"),
    session("main"),
  ]);
  expect(ids(filterWorkspaceSessionTree(tree, { query: " TARGET ", archived: false }))).toEqual([
    ["main", [["child", [["target", []]]]]],
  ]);
  expect(ids(filterWorkspaceSessionTree(tree, { query: "main", archived: false }))).toEqual([
    [
      "main",
      [
        ["child", [["target", []]]],
        ["sibling", []],
      ],
    ],
  ]);
  expect(filterWorkspaceSessionTree(tree, { query: "absent", archived: false })).toEqual([]);
});

it("retains archived ancestors of active or selected children without revealing unrelated archives", () => {
  const tree = workspaceSessionTree([
    { ...session("old-main"), archived: true },
    session("active-child", "old-main"),
    { ...session("archived-child", "old-main"), archived: true },
    { ...session("unrelated"), archived: true },
  ]);
  expect(ids(filterWorkspaceSessionTree(tree, { query: "", archived: false }))).toEqual([
    ["old-main", [["active-child", []]]],
  ]);
  expect(
    ids(
      filterWorkspaceSessionTree(tree, {
        query: "",
        archived: false,
        selectedThreadId: "archived-child",
      }),
    ),
  ).toEqual([
    [
      "old-main",
      [
        ["active-child", []],
        ["archived-child", []],
      ],
    ],
  ]);
  expect(ids(filterWorkspaceSessionTree(tree, { query: "", archived: true }))).toEqual([
    [
      "old-main",
      [
        ["active-child", []],
        ["archived-child", []],
      ],
    ],
    ["unrelated", []],
  ]);
});
