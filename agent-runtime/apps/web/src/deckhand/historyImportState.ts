import { HISTORY_IMPORT_METHODS } from "@t3tools/contracts/deckhand/historyImportRpc";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const importHistory = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:history-import",
  tag: HISTORY_IMPORT_METHODS.import,
});
export const historyImportGet = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:history-get",
  tag: HISTORY_IMPORT_METHODS.get,
});
export const historyImportsList = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:history-list",
  tag: HISTORY_IMPORT_METHODS.list,
});
export const historyThreads = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:history-threads",
  tag: HISTORY_IMPORT_METHODS.threads,
});
export const historyMessages = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:history-messages",
  tag: HISTORY_IMPORT_METHODS.messages,
});
export const historyMessageText = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:history-message-text",
  tag: HISTORY_IMPORT_METHODS.messageText,
});
export const historyImportRemove = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:history-remove",
  tag: HISTORY_IMPORT_METHODS.remove,
});
