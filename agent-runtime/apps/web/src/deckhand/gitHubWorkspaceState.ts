import { GITHUB_WORKSPACE_METHOD } from "@cinderdeck/contracts/deckhand/gitHubWorkspace";
import { createEnvironmentRpcCommand } from "@cinderdeck/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const gitHubWorkspaceRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "GitHub pull requests",
  tag: GITHUB_WORKSPACE_METHOD,
});
