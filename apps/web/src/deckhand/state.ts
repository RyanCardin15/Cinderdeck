import { DECKHAND_METHODS } from "@t3tools/contracts/deckhand/rpc";
import {
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentRpcCommand,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const workspaceView = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "deckhand:workspaces",
  tag: DECKHAND_METHODS.subscribe,
  idleTtlMs: 0,
});
export const refreshWorkspaces = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:refresh",
  tag: DECKHAND_METHODS.refresh,
});
export const submitOperation = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:operation",
  tag: DECKHAND_METHODS.submit,
});
export const inspectOperation = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:reconcile",
  tag: DECKHAND_METHODS.operation,
});

export const recentOperations = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:recent-operations",
  tag: DECKHAND_METHODS.operations,
});
