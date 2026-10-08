import type { VcsRef } from "@cinderdeck/contracts";
import type { IntegrationView } from "@cinderdeck/contracts/deckhand/rpc";
import { blockingWorkspaceIssue } from "@cinderdeck/shared/workspaceChat";

/** Shared lane-creation rules; the native lane sheet applies the same ones. */
type Resource = IntegrationView["resources"][number];
type Repository = NonNullable<Resource["workspace"]>["repos"][number];
export type LaneCheckoutMode = "worktree" | "reference";

export const LANE_CHECKOUT_MODES: ReadonlyArray<{
  readonly mode: LaneCheckoutMode;
  readonly label: string;
  readonly description: string;
}> = [
  { mode: "worktree", label: "Worktree", description: "Isolated checkout on the lane branch" },
  { mode: "reference", label: "Reference", description: "Original checkout, read-only context" },
];

export const DEFAULT_LANE_BRANCH_PREFIX = "lane/";

/** "Lane N" with the smallest N not already used by a lane of the source workspace. */
export function defaultLaneName(existingNames: Iterable<string>): string {
  const taken = new Set([...existingNames].map((name) => name.trim().toLowerCase()));
  let index = 1;
  while (taken.has(`lane ${index}`)) index += 1;
  return `Lane ${index}`;
}

export function laneBranchSlug(name: string): string {
  const trim = (value: string) => value.replace(/^-+|-+$/g, "");
  const slug = trim(trim(name.toLowerCase().replace(/[^a-z0-9]+/g, "-")).slice(0, 40));
  return slug || "lane";
}

export function laneBranchPrefix(resource: Resource): string {
  return resource.workspace?.laneBranchPrefix ?? DEFAULT_LANE_BRANCH_PREFIX;
}

/** prefix + slug(name), suffixed -2, -3, … while the branch exists in a worktree repository. */
export function defaultLaneBranch(
  prefix: string,
  name: string,
  exists: (branch: string) => boolean,
): string {
  const base = `${prefix}${laneBranchSlug(name)}`;
  if (!exists(base)) return base;
  let suffix = 2;
  while (exists(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/** Local branches win over remote-tracking ones; null means the branch is new. */
export function branchPresence(
  refs: ReadonlyArray<VcsRef>,
  branch: string,
): "local" | "remote" | null {
  if (!branch) return null;
  if (refs.some((ref) => !ref.isRemote && ref.name === branch)) return "local";
  return refs.some(
    (ref) =>
      ref.isRemote &&
      (ref.remoteName
        ? ref.name === `${ref.remoteName}/${branch}`
        : ref.name.endsWith(`/${branch}`)),
  )
    ? "remote"
    : null;
}

/** Repository defaults, with the session's repository always isolated. */
export function initialRepositoryModes(
  repos: ReadonlyArray<Repository>,
  forcedWorktreeID: string,
): { [id: string]: LaneCheckoutMode } {
  return Object.fromEntries(
    repos.map((repo) => [
      repo.id,
      repo.id === forcedWorktreeID ? "worktree" : (repo.laneDefault ?? "worktree"),
    ]),
  );
}

/**
 * Why a lane cannot be created from this workspace, or null. Warnings and services
 * running an older definition never block; only connection, availability, lane
 * nesting, blocking issues, capability and an in-flight creation do.
 */
export function laneCreationBlockedReason({
  fresh,
  resource,
  capabilities,
  pending = false,
}: {
  fresh: boolean;
  resource: Resource | null | undefined;
  capabilities: ReadonlyArray<string> | null | undefined;
  pending?: boolean;
}): string | null {
  if (!fresh) return "Refresh the workspace connection to create a lane.";
  if (!resource?.available || !resource.workspace)
    return "This workspace is unavailable. Refresh workspaces to load it.";
  if (resource.workspace.lane) return "Lanes are created from the original workspace.";
  const issue = blockingWorkspaceIssue(resource.workspace.issues);
  if (issue) return `Workspace settings need attention: ${issue.replace(/^error: /, "")}`;
  if (!capabilities?.includes("operations.lane.create"))
    return "This Cinderdeck version cannot create lanes from here.";
  if (pending) return "A lane is already being created.";
  return null;
}
