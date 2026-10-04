import { ATTEMPT_METHODS } from "@t3tools/contracts/deckhand/verificationAttemptsRpc";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const previewAttempt = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:verificationAttempt:preview",
  tag: ATTEMPT_METHODS.preview,
});
export const startAttempt = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:verificationAttempt:start",
  tag: ATTEMPT_METHODS.start,
});
export const getAttempt = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:verificationAttempt:get",
  tag: ATTEMPT_METHODS.get,
});
export const listAttempts = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:verificationAttempt:list",
  tag: ATTEMPT_METHODS.list,
});
export const advanceAttempt = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:verificationAttempt:advance",
  tag: ATTEMPT_METHODS.advance,
});
