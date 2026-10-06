import { EXTERNAL_DEBUG_METHODS } from "@cinderdeck/contracts/deckhand/externalDebugRpc";
import { createEnvironmentRpcCommand } from "@cinderdeck/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const discoverDebugTargets = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "external-debug:discover",
  tag: EXTERNAL_DEBUG_METHODS.discover,
});
export const attachDebugTarget = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "external-debug:attach",
  tag: EXTERNAL_DEBUG_METHODS.attach,
});
export const listDebugSessions = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "external-debug:sessions",
  tag: EXTERNAL_DEBUG_METHODS.sessions,
});
export const listDebugConflicts = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "external-debug:conflicts",
  tag: EXTERNAL_DEBUG_METHODS.conflicts,
});
export const readDebugSession = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "external-debug:read",
  tag: EXTERNAL_DEBUG_METHODS.read,
});
export const runDebugCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "external-debug:command",
  tag: EXTERNAL_DEBUG_METHODS.command,
});
export const detachDebugSession = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "external-debug:detach",
  tag: EXTERNAL_DEBUG_METHODS.detach,
});

export const openDebugApp = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "external-debug:open",
  tag: EXTERNAL_DEBUG_METHODS.open,
});
export const excelProbe = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "external-debug:probe",
  tag: EXTERNAL_DEBUG_METHODS.probe,
});
export const excelBenchmark = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "external-debug:benchmark",
  tag: EXTERNAL_DEBUG_METHODS.benchmark,
});
