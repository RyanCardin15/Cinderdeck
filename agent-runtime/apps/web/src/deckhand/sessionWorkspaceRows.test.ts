import { expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@cinderdeck/contracts";
import type { IntegrationView, ManagedSessionView } from "@cinderdeck/contracts/deckhand/rpc";
import { workspaceSessions, type SessionShell } from "./sessionWorkspaceRows";

const environmentId = EnvironmentId.make("local");
const resource: IntegrationView["resources"][number] = {
  workspaceID: "app",
  generation: 1,
  revision: "one",
  available: true,
  workspace: {
    id: "app",
    name: "App",
    file: "/fixture/app.toml",
    root: "/fixture/app",
    state: "ready",
    definitionChanged: false,
    issues: [],
    services: [],
    repos: [],
  },
};
const project = { environmentId, id: ProjectId.make("project"), workspaceRoot: "/fixture/app/" };
const thread = (id: string, updatedAt = "2026-10-12T12:00:00Z"): SessionShell => ({
  id: ThreadId.make(id),
  projectId: project.id,
  environmentId,
  title: id,
  providerInstanceId: ProviderInstanceId.make("codex"),
  createdAt: updatedAt,
  updatedAt,
  archivedAt: null,
  pinnedAt: null,
  deletedAt: null,
  runtime: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});
const saved = {
  binding: { threadId: "saved", providerInstanceId: "codex", execution: "idle" },
  title: "Saved checkout chat",
  archived: false,
} as ManagedSessionView;

it("includes ordinary threads and saved sessions from removed checkouts without duplicates", () => {
  const rows = workspaceSessions(
    environmentId,
    resource,
    [],
    [project],
    [thread("ordinary"), thread("saved")],
    [saved],
  );
  expect(rows.map((row) => row.id)).toEqual(["ordinary", "saved"]);
  expect(workspaceSessions(environmentId, resource, [], [], [], [saved])[0]?.title).toBe(
    "Saved checkout chat",
  );
});
it("keeps projects and computers separate and removes deleted sessions even from retained history", () => {
  const rows = workspaceSessions(
    environmentId,
    resource,
    [],
    [project],
    [
      thread("ordinary"),
      { ...thread("remote"), environmentId: EnvironmentId.make("remote") },
      { ...thread("other"), projectId: ProjectId.make("other") },
      { ...thread("saved"), deletedAt: "2026-10-12T13:00:00Z" },
    ],
    [saved],
  );
  expect(rows.map((row) => row.id)).toEqual(["ordinary"]);
});
it("orders by session start regardless of activity or pins, and retains archived history", () => {
  const rows = workspaceSessions(
    environmentId,
    resource,
    [],
    [project],
    [
      { ...thread("pin", "2026-10-01T00:00:00Z"), pinnedAt: "2026-10-02T00:00:00Z" },
      { ...thread("recent"), updatedAt: "2026-10-12T12:00:00Z" },
      {
        ...thread("archive", "2026-10-11T12:00:00Z"),
        updatedAt: "2026-10-14T12:00:00Z",
        archivedAt: "2026-10-12T13:00:00Z",
      },
    ],
    [],
  );
  expect(rows.map((row) => row.id)).toEqual(["recent", "archive", "pin"]);
  expect(rows[1]?.archived).toBe(true);
});
it("reflects approvals and review needs from canonical ordinary thread state", () => {
  const rows = workspaceSessions(
    environmentId,
    resource,
    [],
    [project],
    [
      { ...thread("approval"), hasPendingApprovals: true },
      { ...thread("plan"), hasActionableProposedPlan: true },
    ],
    [],
  );
  expect(rows.every((row) => row.status === "attention")).toBe(true);
});
it.each(["tmp", "var", "etc"])(
  "matches macOS /%s aliases in either direction without matching sibling folders",
  (folder) => {
    for (const [nativeRoot, projectRoot] of [
      [`/${folder}/app`, `/private/${folder}/app/`],
      [`/private/${folder}/app`, `/${folder}/app`],
    ] as const) {
      const aliasedResource = {
        ...resource,
        workspace: { ...resource.workspace!, root: nativeRoot },
      };
      const rows = workspaceSessions(
        environmentId,
        aliasedResource,
        [],
        [{ ...project, workspaceRoot: projectRoot! }],
        [thread("ordinary")],
        [],
      );
      expect(rows.map((row) => row.id)).toEqual(["ordinary"]);
      expect(
        workspaceSessions(
          environmentId,
          aliasedResource,
          [],
          [{ ...project, workspaceRoot: `${projectRoot}-other` }],
          [thread("other")],
          [],
        ),
      ).toEqual([]);
    }
  },
);

it("merges saved session start times and uses stable ties even when transport order changes", () => {
  const history = [
    { ...saved, createdAt: "2026-10-13T12:00:00Z" },
    { ...saved, binding: { ...saved.binding, threadId: ThreadId.make("unknown") } },
  ];
  const threads = [thread("b"), thread("a")];
  for (const input of [threads, threads.toReversed()]) {
    expect(
      workspaceSessions(environmentId, resource, [], [project], input, history).map(
        (row) => row.id,
      ),
    ).toEqual(["saved", "a", "b", "unknown"]);
  }
});
