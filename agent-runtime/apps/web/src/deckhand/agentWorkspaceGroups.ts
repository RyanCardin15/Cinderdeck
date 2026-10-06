import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@cinderdeck/client-runtime/state/shell";
import type { IntegrationView } from "@cinderdeck/contracts/deckhand/rpc";

export type AgentResource = IntegrationView["resources"][number];
export type AgentWorkspaceGroup = {
  id: string;
  label: string;
  resources: AgentResource[];
  threads: EnvironmentThreadShell[];
};
export function agentNeedsAttention(thread: EnvironmentThreadShell) {
  return (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.hasActionableProposedPlan ||
    thread.runtime?.status === "failed" ||
    Boolean(thread.runtime?.lastError)
  );
}
export function agentStatus(thread: EnvironmentThreadShell) {
  if (thread.hasPendingApprovals) return "Approval needed";
  if (thread.hasPendingUserInput) return "Input needed";
  if (thread.hasActionableProposedPlan) return "Review plan";
  if (thread.runtime?.status === "failed" || thread.runtime?.lastError) return "Failed";
  if (["preparing", "queued", "starting", "running"].includes(thread.runtime?.status ?? ""))
    return "Working";
  if (thread.runtime?.status === "waiting") return "Waiting";
  if (thread.archivedAt) return "Archived";
  return thread.latestRun?.status === "completed" ? "Turn complete" : "Idle";
}
// macOS exposes these directories through both their public and /private paths.
// Native workspace discovery resolves the aliases; runtime projects may retain them.
function workspacePath(path: string | undefined) {
  return path?.replace(/^\/private\/(tmp|var)(?=\/|$)/, "/$1").replace(/\/+$/, "");
}
function resourcePaths(resource: AgentResource) {
  return [
    resource.workspace?.root,
    resource.workspace?.lane?.directory,
    ...(resource.workspace?.repos.map((repo) => repo.path) ?? []),
  ];
}
/** Paths organize presentation only. Mutations and navigation retain native identity pins. */
export function groupWorkspaceAgents(
  resources: readonly AgentResource[],
  projects: readonly EnvironmentProject[],
  threads: readonly EnvironmentThreadShell[],
): AgentWorkspaceGroup[] {
  const groups = new Map<string, AgentWorkspaceGroup>();
  for (const resource of resources) {
    const id = resource.workspace?.lane?.sourceStackID ?? resource.workspaceID;
    const base = resources.find((candidate) => candidate.workspaceID === id);
    const group = groups.get(id) ?? {
      id,
      label: base?.workspace?.name ?? resource.workspace?.name ?? id,
      resources: [],
      threads: [],
    };
    group.resources.push(resource);
    groups.set(id, group);
  }
  for (const thread of threads) {
    if (thread.deletedAt) continue;
    const project = projects.find((candidate) => candidate.id === thread.projectId);
    const path = thread.worktreePath ?? project?.workspaceRoot;
    const resource = path
      ? resources.find((candidate) =>
          resourcePaths(candidate).some((root) => workspacePath(root) === workspacePath(path)),
        )
      : undefined;
    const id = resource
      ? (resource.workspace?.lane?.sourceStackID ?? resource.workspaceID)
      : project
        ? `project:${project.id}`
        : "unassigned";
    const group = groups.get(id) ?? {
      id,
      label: project?.title ?? "Other conversations",
      resources: [],
      threads: [],
    };
    group.threads.push(thread);
    groups.set(id, group);
  }
  // Empty runtime projects belong in the catalog too.
  for (const project of projects) {
    if (
      resources.some((resource) =>
        resourcePaths(resource).some(
          (root) => workspacePath(root) === workspacePath(project.workspaceRoot),
        ),
      )
    )
      continue;
    const id = `project:${project.id}`;
    if (!groups.has(id)) groups.set(id, { id, label: project.title, resources: [], threads: [] });
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}
