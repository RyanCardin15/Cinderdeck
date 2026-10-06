import type { IntegrationView } from "@cinderdeck/contracts/deckhand/rpc";

/** Native warnings describe service/lane configuration; they do not invalidate chat folders. */
export function blockingWorkspaceIssue(issues: ReadonlyArray<string>): string | undefined {
  return issues.find((issue) => !issue.startsWith("warning: "));
}

export function workspaceChatUnavailableReason(
  resource: IntegrationView["resources"][number],
): string | null {
  if (!resource.available || !resource.workspace)
    return "This workspace is unavailable. Refresh workspaces to load its current folders.";
  const issue = blockingWorkspaceIssue(resource.workspace.issues);
  if (issue) return `Workspace settings need attention: ${issue.replace(/^error: /, "")}`;
  if (!resource.workspace.repos.length) return "Add a folder in Workspace settings to open a chat.";
  // definitionChanged compares running service settings with the current definition.
  // Chat uses the current folders and verifies the resource revision on the server.
  return null;
}
