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

export const launchSession = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:launch-session",
  tag: DECKHAND_METHODS.launch,
});
export const inspectSessionLaunch = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:inspect-session-launch",
  tag: DECKHAND_METHODS.launchGet,
});
export const sessionLaunchOptions = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:session-launch-options",
  tag: DECKHAND_METHODS.launchOptions,
});

export const managedSessionsView = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "deckhand:managed-sessions",
    tag: DECKHAND_METHODS.sessions,
    idleTtlMs: 0,
  },
);

export const createSession = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:create-session",
  tag: DECKHAND_METHODS.create,
});
export const inspectSessionCreation = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:inspect-session-creation",
  tag: DECKHAND_METHODS.createGet,
});
export const previewLaunchReview = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:preview-launch-review",
  tag: DECKHAND_METHODS.reviewPreview,
});
export const confirmLaunchReview = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:confirm-launch-review",
  tag: DECKHAND_METHODS.reviewConfirm,
});
