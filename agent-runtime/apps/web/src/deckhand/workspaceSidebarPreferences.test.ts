// @vitest-environment jsdom
import { afterEach, expect, it } from "vite-plus/test";
import {
  orderedSidebarRows,
  readSidebarPreferences,
  reorderSidebarRows,
  sidebarPreferenceKey,
} from "./workspaceSidebarPreferences";

afterEach(() => localStorage.clear());
const rows = ["alpha", "beta", "gamma"].map((workspaceID) => ({ workspaceID }));
const names = (row: { workspaceID: string }) => row.workspaceID;

it("keeps selection-first transport snapshots in the same stable sidebar order", () => {
  expect(orderedSidebarRows([rows[2]!, rows[0]!, rows[1]!], [], names)).toEqual(rows);
  expect(
    orderedSidebarRows([rows[1]!, rows[2]!, rows[0]!], ["gamma", "alpha", "beta"], names).map(
      names,
    ),
  ).toEqual(["gamma", "alpha", "beta"]);
});

it("moves both directions while preserving off-page IDs and appending new siblings", () => {
  expect(
    reorderSidebarRows(["alpha", "off-page", "beta"], ["alpha", "beta", "gamma"], "gamma", "alpha"),
  ).toEqual(["gamma", "off-page", "alpha", "beta"]);
  expect(reorderSidebarRows([], ["alpha", "beta", "gamma"], "alpha", "gamma")).toEqual([
    "beta",
    "gamma",
    "alpha",
  ]);
  expect(
    reorderSidebarRows(["alpha", "beta"], ["alpha", "beta"], "alpha", "another-workspace-lane"),
  ).toEqual(["alpha", "beta"]);
});

it("validates saved state and scopes it by execution computer and installation", () => {
  const key = sidebarPreferenceKey("computer", "install");
  localStorage.setItem(
    key,
    JSON.stringify({
      order: { workspaces: ["beta", "alpha", "beta", 4] },
      favorites: ["alpha", "alpha", false],
      expanded: { alpha: false, beta: "true" },
      colors: { alpha: "#579de5", "alpha/lane": "#ABCDEF", beta: "red", bad: 12 },
    }),
  );
  expect(readSidebarPreferences(key)).toEqual({
    order: { workspaces: ["beta", "alpha"] },
    favorites: ["alpha"],
    expanded: { alpha: false },
    colors: { alpha: "#579de5", "alpha/lane": "#ABCDEF" },
  });
  expect(readSidebarPreferences(sidebarPreferenceKey("another", "install")).favorites).toEqual([]);
  expect(readSidebarPreferences(sidebarPreferenceKey("computer", "replacement")).order).toEqual({});
  localStorage.setItem(key, "broken JSON");
  expect(readSidebarPreferences(key)).toEqual({
    order: {},
    favorites: [],
    expanded: {},
    colors: {},
  });
});

it("keeps older sidebar preferences while adding an empty color map", () => {
  const key = sidebarPreferenceKey("computer", "install");
  localStorage.setItem(key, JSON.stringify({ favorites: ["alpha"], expanded: { alpha: true } }));
  expect(readSidebarPreferences(key)).toEqual({
    order: {},
    favorites: ["alpha"],
    expanded: { alpha: true },
    colors: {},
  });
});
