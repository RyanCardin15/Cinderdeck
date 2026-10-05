import { ATTENTION_METHODS } from "@t3tools/contracts/deckhand/attentionRpc";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const attentionList = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:attention-list",
  tag: ATTENTION_METHODS.list,
});
export const attentionChange = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:attention-change",
  tag: ATTENTION_METHODS.change,
});
