import { expect, it } from "vite-plus/test";
import { externalDebugMcpResult } from "./ExternalDebugMcpResult.ts";

it("delivers a visible JPEG image without base64 in text or structured metadata", () => {
  const result = externalDebugMcpResult({
    session: {
      sessionId: "test",
      endpoint: "mac://local/",
      target: { id: "mac:1:2", title: "Fixture", url: "fixture", type: "mac-window" },
      state: "connected",
      paused: false,
    },
    events: [],
    nextSequence: 0,
    dropped: 0,
    image: "/9j/2Q==",
    imageSequence: 1,
    imageUnavailable: false,
    callFrames: [],
  });
  expect(result.isError).toBe(false);
  expect(result.content).toHaveLength(2);
  expect(result.content[1]).toMatchObject({
    type: "image",
    mimeType: "image/jpeg",
    data: new Uint8Array([255, 216, 255, 217]),
  });
  expect(JSON.stringify(result.structuredContent)).not.toContain("/9j/2Q==");
  expect(result.content[0]).toMatchObject({ type: "text" });
  expect(JSON.stringify(result.content[0])).not.toContain("/9j/2Q==");
});
it("preserves a tool failure as an error without inventing an image", () => {
  const result = externalDebugMcpResult({ _tag: "OrchestratorMcpFailure", message: "No access" });
  expect(result.isError).toBe(true);
  expect(result.content).toHaveLength(1);
});
