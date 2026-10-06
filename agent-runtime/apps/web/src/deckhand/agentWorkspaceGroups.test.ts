import { expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
} from "@cinderdeck/contracts";
import { presentThreadShell, scopeProject } from "@cinderdeck/client-runtime/state/models";
import * as DateTime from "effect/DateTime";
import { groupWorkspaceAgents, type AgentResource } from "./agentWorkspaceGroups";
const environment = EnvironmentId.make("computer");
const now = DateTime.makeUnsafe("2026-10-06T00:00:00Z");
const id = ThreadId.make("agent");
const provider = ProviderInstanceId.make("codex");
const v2Project: OrchestrationProjectShell = {
  id: ProjectId.make("project"),
  title: "Project",
  workspaceRoot: "/fixture/project",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-06T00:00:00Z",
  updatedAt: "2026-10-06T00:00:00Z",
};
const v2ThreadShell: OrchestrationV2ThreadShell = {
  id,
  projectId: v2Project.id,
  title: "Agent",
  providerInstanceId: provider,
  modelSelection: { instanceId: provider, model: "model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
};
const resource = (
  id: string,
  root: string,
  lane?: { sourceStackID: string; name: string; directory: string },
) =>
  ({
    workspaceID: id,
    generation: 1,
    available: true,
    revision: "v1",
    workspace: {
      id,
      name: id,
      root,
      file: "/fixture/workspace.toml",
      state: "stopped",
      repos: [],
      services: [],
      issues: [],
      definitionChanged: false,
      ...(lane ? { lane: { ...lane, createdAt: "2026-10-06T00:00:00Z", ports: {} } } : {}),
    },
  }) satisfies AgentResource;
it("groups lane agents under their workspace, preserves empty workspaces and unlinked conversations", () => {
  const project = scopeProject(environment, v2Project);
  const lane = presentThreadShell(environment, {
    ...v2ThreadShell,
    id: ThreadId.make("lane-agent"),
    worktreePath: "/fixture/lane",
  });
  const unlinked = presentThreadShell(environment, {
    ...v2ThreadShell,
    id: ThreadId.make("unlinked"),
    projectId: ProjectId.make("missing"),
  });
  const deleted = { ...unlinked, id: ThreadId.make("deleted"), deletedAt: "2026-10-06T00:00:00Z" };
  const groups = groupWorkspaceAgents(
    [
      resource("base", project.workspaceRoot),
      resource("lane", "/fixture/lane", {
        sourceStackID: "base",
        name: "Feature",
        directory: "/fixture/lane",
      }),
      resource("empty", "/fixture/empty"),
    ],
    [project],
    [lane, unlinked, deleted],
  );
  expect(groups.find((group) => group.id === "base")?.threads.map((thread) => thread.id)).toEqual([
    "lane-agent",
  ]);
  expect(groups.find((group) => group.id === "empty")?.threads).toEqual([]);
  expect(
    groups.find((group) => group.id === "unassigned")?.threads.map((thread) => thread.id),
  ).toEqual(["unlinked"]);
  expect(groups.flatMap((group) => group.threads)).toHaveLength(2);
});
it("keeps project conversations and empty runtime projects when native integration is unavailable", () => {
  const project = scopeProject(environment, v2Project);
  const empty = { ...project, id: ProjectId.make("empty"), title: "Empty" };
  const groups = groupWorkspaceAgents(
    [],
    [project, empty],
    [presentThreadShell(environment, v2ThreadShell)],
  );
  expect(groups.find((group) => group.id === `project:${project.id}`)?.threads).toHaveLength(1);
  expect(groups.find((group) => group.id === "project:empty")?.threads).toHaveLength(0);
});
it.each(["tmp", "var"])(
  "merges macOS /private/%s aliases without duplicate workspace cards",
  (directory) => {
    const project = scopeProject(environment, {
      ...v2Project,
      workspaceRoot: `/private/${directory}/fixture/project/`,
    });
    const groups = groupWorkspaceAgents(
      [resource("base", `/${directory}/fixture/project`)],
      [project],
      [presentThreadShell(environment, v2ThreadShell)],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe("base");
    expect(groups[0]?.threads).toHaveLength(1);
  },
);
