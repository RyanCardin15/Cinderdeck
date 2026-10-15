import { expect, it } from "vite-plus/test";
import type { WorkspaceSession } from "./sessionWorkspaceRows";
import {
  filterWorkspaceSessionTree,
  orderWorkspaceSessionTree,
  sessionOrderGroup,
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
    [
      "main",
      [
        ["second-child", []],
        ["first-child", [["grandchild", []]]],
      ],
    ],
    ["second", []],
    ["newest", []],
  ]);
  expect(orderWorkspaceSessionTree(tree, "other-workspace", order)).toEqual(tree);
  expect(orderWorkspaceSessionTree(tree, "app", {})).toEqual(tree);
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
