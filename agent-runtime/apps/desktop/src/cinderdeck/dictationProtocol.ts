import type { DictationCommand, DictationEvent } from "@cinderdeck/contracts";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isDictationCommand(value: unknown): value is DictationCommand {
  return (
    record(value) &&
    Object.keys(value).length === 2 &&
    typeof value.requestID === "string" &&
    uuid.test(value.requestID) &&
    typeof value.action === "string" &&
    ["start", "stop", "cancel"].includes(value.action)
  );
}
export function parseDictationEvent(value: unknown): DictationEvent | null {
  if (
    !record(value) ||
    value.type !== "dictation" ||
    !Object.keys(value).every((key) =>
      ["type", "requestID", "state", "text", "error"].includes(key),
    ) ||
    typeof value.requestID !== "string" ||
    !uuid.test(value.requestID) ||
    typeof value.state !== "string" ||
    !["idle", "preparing", "recording", "transcribing", "completed", "error"].includes(
      value.state,
    ) ||
    (value.text !== undefined && (typeof value.text !== "string" || value.text.length > 8000)) ||
    (value.error !== undefined && (typeof value.error !== "string" || value.error.length > 1000))
  )
    return null;
  return {
    requestID: value.requestID,
    state: value.state as DictationEvent["state"],
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}
