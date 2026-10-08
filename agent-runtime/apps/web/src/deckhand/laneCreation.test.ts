import type { IntegrationView } from "@cinderdeck/contracts/deckhand/rpc";
import { expect, it } from "vite-plus/test";
import {
  branchPresence,
  defaultLaneBranch,
  defaultLaneName,
  laneBranchSlug,
  laneCreationBlockedReason,
} from "./laneCreation";

type Resource = IntegrationView["resources"][number];
const source = (workspace: Partial<NonNullable<Resource["workspace"]>> = {}): Resource => ({
  workspaceID: "source",
  generation: 1,
  revision: "revision",
  available: true,
  workspace: {
    id: "source",
    name: "Project",
    file: "/fixture/project.toml",
    state: "ready",
    definitionChanged: false,
    issues: [],
    services: [],
    repos: [],
    ...workspace,
  },
});
const capabilities = ["operations.lane.create"];

it("names a lane with the smallest unused number, ignoring case", () => {
  expect(defaultLaneName([])).toBe("Lane 1");
  expect(defaultLaneName(["lane 1", "LANE 3", "Review"])).toBe("Lane 2");
  expect(defaultLaneName(["Lane 1", "Lane 2"])).toBe("Lane 3");
});

it("slugs lane names and suffixes branches that already exist", () => {
  expect(laneBranchSlug("Payment Retry!")).toBe("payment-retry");
  expect(laneBranchSlug("--Ünïcode__ & stuff--")).toBe("n-code-stuff");
  expect(laneBranchSlug("!!!")).toBe("lane");
  expect(laneBranchSlug(`${"a".repeat(39)} tail`)).toBe("a".repeat(39));
  const taken = new Set(["lane/lane-1", "lane/lane-1-2"]);
  expect(defaultLaneBranch("lane/", "Lane 1", (name) => taken.has(name))).toBe("lane/lane-1-3");
  expect(defaultLaneBranch("feat/", "Lane 2", (name) => taken.has(name))).toBe("feat/lane-2");
});

it("distinguishes local and remote-only existing branches", () => {
  const ref = (name: string, remoteName?: string) => ({
    name,
    current: false,
    isDefault: false,
    worktreePath: null,
    ...(remoteName ? { isRemote: true, remoteName } : {}),
  });
  expect(branchPresence([ref("main"), ref("origin/main", "origin")], "main")).toBe("local");
  expect(branchPresence([ref("origin/fix", "origin")], "fix")).toBe("remote");
  expect(branchPresence([ref("origin/fix-2", "origin"), ref("fix-2")], "fix")).toBeNull();
});

it("blocks lane creation only for connection, availability, lanes, errors, capability or pending work", () => {
  const allowed = { fresh: true, resource: source(), capabilities };
  expect(laneCreationBlockedReason(allowed)).toBeNull();
  // Warnings and services running an older definition never block.
  expect(
    laneCreationBlockedReason({
      ...allowed,
      resource: source({ issues: ["warning: port 3000 in use"], definitionChanged: true }),
    }),
  ).toBeNull();
  expect(laneCreationBlockedReason({ ...allowed, fresh: false })).toContain("Refresh");
  expect(
    laneCreationBlockedReason({ ...allowed, resource: { ...source(), available: false } }),
  ).toContain("unavailable");
  expect(laneCreationBlockedReason({ ...allowed, resource: undefined })).toContain("unavailable");
  expect(
    laneCreationBlockedReason({
      ...allowed,
      resource: source({
        lane: {
          sourceStackID: "primary",
          name: "Lane 1",
          createdAt: "2026-10-04T00:00:00Z",
          directory: "/fixture/lane",
          ports: {},
        },
      }),
    }),
  ).toContain("original workspace");
  expect(
    laneCreationBlockedReason({
      ...allowed,
      resource: source({ issues: ["error: Repository app is missing"] }),
    }),
  ).toBe("Workspace settings need attention: Repository app is missing");
  expect(laneCreationBlockedReason({ ...allowed, capabilities: [] })).toContain("cannot create");
  expect(laneCreationBlockedReason({ ...allowed, pending: true })).toContain("already");
});
