import { GITHUB_WORKSPACE_METHOD } from "@t3tools/contracts/deckhand/gitHubWorkspace";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const gitHubWorkspaceRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "GitHub pull requests",
  tag: GITHUB_WORKSPACE_METHOD,
});
