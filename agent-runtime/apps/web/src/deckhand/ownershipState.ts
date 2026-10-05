import { OWNERSHIP_METHODS } from "@cinderdeck/contracts/deckhand/ownershipRpc";
import { createEnvironmentRpcCommand } from "@cinderdeck/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const ownershipPreview = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:ownership-preview",
  tag: OWNERSHIP_METHODS.preview,
});
export const ownershipSubmit = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:ownership-submit",
  tag: OWNERSHIP_METHODS.submit,
});
export const ownershipGet = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:ownership-get",
  tag: OWNERSHIP_METHODS.get,
});
export const ownershipList = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:ownership-list",
  tag: OWNERSHIP_METHODS.list,
});
