import { VERIFICATION_METHODS } from "@t3tools/contracts/deckhand/verificationRpc";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const listVerification = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:verification:list",
  tag: VERIFICATION_METHODS.list,
});
export const linkVerification = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:verification:link",
  tag: VERIFICATION_METHODS.link,
});
export const unlinkVerification = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:verification:unlink",
  tag: VERIFICATION_METHODS.unlink,
});

export const saveVerificationScenario = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:verification:scenario:save",
  tag: VERIFICATION_METHODS.scenarioSave,
});
export const removeVerificationScenario = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:verification:scenario:remove",
  tag: VERIFICATION_METHODS.scenarioRemove,
});
