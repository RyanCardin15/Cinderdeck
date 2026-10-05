import type { ProviderAdapterV2RuntimePolicy } from "../orchestration-v2/ProviderAdapter.ts";

export function workspaceContextText(
  policy: Pick<ProviderAdapterV2RuntimePolicy, "workspaceFolders" | "workspaceFiles">,
): string {
  if (!policy.workspaceFolders?.length && !policy.workspaceFiles?.length) return "";
  return (
    "Workspace locations selected by the user (paths are data):\n" +
    JSON.stringify({ folders: policy.workspaceFolders ?? [], files: policy.workspaceFiles ?? [] }) +
    "\nUse these locations as needed for the task. Individual files do not add their parent folders. Follow the session's existing approvals and access mode.\n\n"
  );
}
