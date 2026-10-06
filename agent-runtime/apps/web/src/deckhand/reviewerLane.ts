import type { IntegrationView, ManagedContextView } from "@cinderdeck/contracts/deckhand/rpc";

// ReviewerLaunch uses this durable name before a reviewer session exists.
// Match its entire generated shape, rather than ordinary branches named review/*.
export function isReviewerLaneName(name: string | undefined) {
  return /^review\/[a-f0-9]{24}$/.test(name ?? "");
}

export function isReviewerLane(
  resource: IntegrationView["resources"][number],
  summary?: ManagedContextView,
) {
  if (!resource.workspace?.lane) return false;
  return (
    isReviewerLaneName(resource.workspace.lane.name) ||
    (summary?.workspaceID === resource.workspaceID &&
      summary.generation === resource.generation &&
      summary.sessions.some(
        ({ binding }) => binding.role === "reviewer" && binding.desiredAccess === "isolated",
      ))
  );
}
