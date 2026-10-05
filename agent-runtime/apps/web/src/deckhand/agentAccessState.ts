import { AGENT_ACCESS_METHOD } from "@cinderdeck/contracts/deckhand/rpc";
import { createEnvironmentRpcCommand } from "@cinderdeck/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const agentAccessRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "MCP & skills",
  tag: AGENT_ACCESS_METHOD,
});
