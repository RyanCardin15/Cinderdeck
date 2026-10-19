import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@cinderdeck/client-runtime/state/models";
import type { IntegrationView, ManagedSessionView } from "@cinderdeck/contracts/deckhand/rpc";
import { normalizeProjectPathForComparison } from "@cinderdeck/shared/path";

export type SessionShell = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "projectId"
  | "id"
  | "title"
  | "lineage"
  | "providerInstanceId"
  | "createdAt"
  | "updatedAt"
  | "archivedAt"
  | "pinnedAt"
  | "deletedAt"
  | "runtime"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
>;
export type SessionProject = Pick<EnvironmentProject, "environmentId" | "id" | "workspaceRoot">;
type Resource = IntegrationView["resources"][number];
export type WorkspaceSession = {
  id: string;
  title: string;
  parentThreadId: string | null;
  isSubagent: boolean;
  providerInstanceId: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  pinned: boolean;
  pinnedAt?: string | null;
  status: "working" | "attention" | "failed" | "idle";
};
// Foundation and Node can return different spellings of macOS system symlinks.
// Workspace resources come from the native Mac host, including remote hosts.
const normalize = (path: string) =>
  normalizeProjectPathForComparison(path).replace(/^\/(tmp|var|etc)(?=\/|$)/, "/private/$1");

export function workspaceProjectIDs(
  environmentId: string,
  resource: Resource,
  resources: readonly Resource[],
  projects: readonly SessionProject[],
): Set<string> {
  const roots = new Set(
    [
      resource,
      ...resources.filter((row) => row.workspace?.lane?.sourceStackID === resource.workspaceID),
    ]
      .flatMap((row) => [
        row.workspace?.root,
        ...(row.workspace?.repos.map((repo) => repo.path) ?? []),
      ])
      .filter((path): path is string => !!path)
      .map(normalize),
  );
  return new Set(
    projects
      .filter(
        (project) =>
          project.environmentId === environmentId && roots.has(normalize(project.workspaceRoot)),
      )
      .map((project) => project.id),
  );
}

/** Ordinary project threads and saved checkout bindings share one workspace list. */
export function workspaceSessions(
  environmentId: string,
  resource: Resource,
  resources: readonly Resource[],
  projects: readonly SessionProject[],
  threads: readonly SessionShell[],
  saved: readonly ManagedSessionView[],
): WorkspaceSession[] {
  const projectIDs = workspaceProjectIDs(environmentId, resource, resources, projects);
  const savedByID = new Map(saved.map((session) => [session.binding.threadId, session]));
  const result = new Map<string, WorkspaceSession>();
  for (const session of saved) {
    const execution = session.binding.execution;
    result.set(session.binding.threadId, {
      id: session.binding.threadId,
      title: session.title,
      parentThreadId:
        session.lineage?.relationshipToParent === "subagent"
          ? session.lineage.parentThreadId
          : null,
      isSubagent: session.lineage?.relationshipToParent === "subagent",
      providerInstanceId: session.binding.providerInstanceId,
      createdAt: session.createdAt ?? "",
      updatedAt: "",
      archived: session.archived,
      pinned: false,
      status:
        execution === "failed"
          ? "failed"
          : ["waiting_input", "waiting_approval"].includes(execution)
            ? "attention"
            : ["queued", "starting", "working"].includes(execution)
              ? "working"
              : "idle",
    });
  }
  for (const thread of threads) {
    if (thread.environmentId !== environmentId) continue;
    if (thread.deletedAt) {
      result.delete(thread.id);
      continue;
    }
    if (!projectIDs.has(thread.projectId) && !savedByID.has(thread.id)) continue;
    result.set(thread.id, {
      id: thread.id,
      title: thread.title,
      parentThreadId:
        thread.lineage.relationshipToParent === "subagent" ? thread.lineage.parentThreadId : null,
      isSubagent: thread.lineage.relationshipToParent === "subagent",
      providerInstanceId: thread.runtime?.providerInstanceId ?? thread.providerInstanceId,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      archived: !!thread.archivedAt,
      pinned: !!thread.pinnedAt,
      pinnedAt: thread.pinnedAt,
      status:
        thread.runtime?.status === "failed"
          ? "failed"
          : thread.hasPendingApprovals ||
              thread.hasPendingUserInput ||
              thread.hasActionableProposedPlan ||
              thread.runtime?.status === "waiting"
            ? "attention"
            : ["queued", "preparing", "starting", "running"].includes(thread.runtime?.status ?? "")
              ? "working"
              : "idle",
    });
  }
  const started = (value: string) => {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : 0;
  };
  return [...result.values()].sort(
    (a, b) => started(b.createdAt) - started(a.createdAt) || a.id.localeCompare(b.id),
  );
}
