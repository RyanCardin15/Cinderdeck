import { assert, describe, it } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@cinderdeck/contracts";
import { materializeReplayTranscriptCodexThreadOptions } from "./ReplayTranscriptNdjson.ts";

const transcript = (frame: unknown): ProviderReplayTranscript => ({
  provider: "codex",
  protocol: "codex.app-server",
  version: "test",
  scenario: "thread-options",
  entries: [{ type: "expect_outbound", label: "request", frame }],
});

const frame = (value: ProviderReplayTranscript): unknown => {
  const entry = value.entries[0];
  if (entry?.type !== "expect_outbound") throw new Error("Missing expected request");
  return entry.frame;
};

describe("recorded Codex thread options", () => {
  it("adds explicitly selected options without mutating recordings or hiding conflicting fields", () => {
    const original = transcript({
      id: 2,
      method: "thread/fork",
      params: { threadId: "source", lastTurnId: "first", config: { custom: true } },
    });
    const selected = materializeReplayTranscriptCodexThreadOptions(original, {
      cwd: "/synthetic",
      model: "fixture-model",
      readOnly: true,
    });
    assert.deepEqual(frame(selected), {
      id: 2,
      method: "thread/fork",
      params: {
        threadId: "source",
        lastTurnId: "first",
        config: { custom: true },
        cwd: "/synthetic",
        model: "fixture-model",
        sandbox: "read-only",
        approvalPolicy: "never",
      },
    });
    assert.deepEqual(frame(original), {
      id: 2,
      method: "thread/fork",
      params: { threadId: "source", lastTurnId: "first", config: { custom: true } },
    });
    const conflicting = transcript({
      method: "thread/start",
      params: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    });
    assert.deepEqual(
      frame(materializeReplayTranscriptCodexThreadOptions(conflicting, { readOnly: true })),
      frame(conflicting),
    );
  });

  it("preserves unsupported networking and custom plan instructions so replay still rejects differences", () => {
    const custom = transcript({
      method: "turn/start",
      params: {
        sandboxPolicy: { type: "readOnly", networkAccess: true },
        collaborationMode: {
          mode: "plan",
          settings: { developer_instructions: "Custom instructions" },
        },
      },
    });
    assert.deepEqual(
      frame(materializeReplayTranscriptCodexThreadOptions(custom, { readOnly: true })),
      frame(custom),
    );
    const historical = transcript({
      method: "turn/start",
      params: { sandboxPolicy: { type: "readOnly", networkAccess: false } },
    });
    assert.deepEqual(
      frame(materializeReplayTranscriptCodexThreadOptions(historical, { readOnly: true })),
      {
        method: "turn/start",
        params: { sandboxPolicy: { type: "readOnly" } },
      },
    );
  });
});
