import { describe, expect, it } from "vite-plus/test";
import { computerStateMcpResult, computerScriptMcpResult } from "./tools.ts";

const screenshot = { data: "aW1n", mimeType: "image/jpeg", width: 800, height: 500 };
describe("computer use MCP presentation", () => {
  it("returns one image block without duplicating base64 in structured state", () => {
    const result = computerStateMcpResult({
      app: "test.fixture",
      name: "Fixture",
      text: "1 text field",
      diff: false,
      screenshot,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ screenshot: { width: 800, height: 500 } });
    expect(JSON.stringify(result.structuredContent)).not.toContain("aW1n");
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toMatchObject({ type: "text", text: "1 text field" });
    expect(result.content[1]).toMatchObject({
      type: "image",
      mimeType: "image/jpeg",
      data: new Uint8Array([105, 109, 103]),
    });
  });

  it("retains screenshot evidence on failed scripts and surfaces recoverable errors", () => {
    const result = computerScriptMcpResult({
      ok: false,
      output: "element_missing: Read fresh state",
      screenshots: [screenshot],
    });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(2);
    const failure = computerStateMcpResult({
      code: "invalid_request",
      message: "Read the app state again",
    });
    expect(failure.isError).toBe(true);
    expect(failure.content[0]).toMatchObject({ type: "text", text: "Read the app state again" });
  });
});
