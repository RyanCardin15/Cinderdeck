import { describe, expect, it } from "vite-plus/test";
import { isDictationCommand, parseDictationEvent } from "./dictationProtocol.ts";
const requestID = "12345678-1234-1234-1234-123456789012";
describe("native dictation protocol", () => {
  it("accepts only scoped start, stop and cancel commands", () => {
    for (const action of ["start", "stop", "cancel"])
      expect(isDictationCommand({ action, requestID })).toBe(true);
    for (const value of [
      { action: "start", requestID: "not-a-uuid" },
      { action: "upload", requestID },
      { action: "start", requestID, url: "https://attacker.test" },
      null,
    ])
      expect(isDictationCommand(value)).toBe(false);
  });
  it("validates events and strips their transport discriminator", () => {
    expect(
      parseDictationEvent({ type: "dictation", requestID, state: "completed", text: "Hello" }),
    ).toEqual({ requestID, state: "completed", text: "Hello" });
    for (const value of [
      { type: "dictation", requestID, state: "unknown" },
      { type: "dictation", requestID, state: "completed", text: "x".repeat(8001) },
      { type: "dictation", requestID, state: "error", key: "secret" },
    ])
      expect(parseDictationEvent(value)).toBeNull();
  });
});
