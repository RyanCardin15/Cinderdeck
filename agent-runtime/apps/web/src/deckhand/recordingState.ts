import { RECORDING_METHODS } from "@cinderdeck/contracts/deckhand/recordingsRpc";
import { createEnvironmentRpcCommand } from "@cinderdeck/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const listRecordings = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:recording-list",
  tag: RECORDING_METHODS.list,
});
export const getRecording = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:recording-get",
  tag: RECORDING_METHODS.get,
});
export const recordingWindows = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:recording-windows",
  tag: RECORDING_METHODS.windows,
});
export const startRecording = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:recording-start",
  tag: RECORDING_METHODS.start,
});
export const controlRecording = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:recording-control",
  tag: RECORDING_METHODS.control,
});
export const recordingLogs = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:recording-logs",
  tag: RECORDING_METHODS.logs,
});
export const markRecording = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:recording-mark",
  tag: RECORDING_METHODS.mark,
});
export const recordingMedia = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:recording-media",
  tag: RECORDING_METHODS.media,
});

export const recordingOverview = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:recording-overview",
  tag: RECORDING_METHODS.overview,
});

export const beginPreviewImport = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:preview-begin",
  tag: RECORDING_METHODS.importBegin,
});
export const inspectPreviewImport = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:preview-inspect",
  tag: RECORDING_METHODS.importGet,
});
export const previewImportEvent = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:preview-event",
  tag: RECORDING_METHODS.importEvent,
});
export const uploadPreviewChunk = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:preview-upload",
  tag: RECORDING_METHODS.importChunk,
});
export const finishPreviewImport = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:preview-finish",
  tag: RECORDING_METHODS.importFinish,
});

export const prepareEvidence = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:evidence-prepare",
  tag: RECORDING_METHODS.prepareEvidence,
});
export const getEvidence = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:evidence-get",
  tag: RECORDING_METHODS.evidenceGet,
});
export const evidenceResource = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:evidence-resource",
  tag: RECORDING_METHODS.evidenceResource,
});

export const recordingThumbnail = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:recording-thumbnail",
  tag: RECORDING_METHODS.thumbnail,
});
