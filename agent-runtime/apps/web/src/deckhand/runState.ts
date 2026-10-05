import { RUN_METHODS } from "@cinderdeck/contracts/deckhand/runsRpc";
import { createEnvironmentRpcCommand } from "@cinderdeck/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const listRuns = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:runs:list",
  tag: RUN_METHODS.list,
});

export const runLogs = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:runs:logs",
  tag: RUN_METHODS.logs,
});
export const runDefinition = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:runs:definition",
  tag: RUN_METHODS.definition,
});
export const validateRunDefinition = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:runs:validate",
  tag: RUN_METHODS.validate,
});

export const getRun = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:runs:get",
  tag: RUN_METHODS.get,
});
