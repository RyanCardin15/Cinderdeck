import type * as AcpSchema from "effect-acp/compat";
import type { AcpToolCallState } from "../../provider/acp/AcpRuntimeModel.ts";
import type { AcpAdapterV2SubagentUpdate } from "./AcpAdapterV2.ts";

// GitHub Copilot CLI (1.0.9x) over plain ACP. Shapes from its native stream:
// - `task` spawns a subagent: kind "other", rawInput { agent_type, prompt,
//   description, name, mode: "sync" | "background", model? }. A sync spawn
//   completes with the subagent's reply; a background spawn completes at once
//   with "Agent started in background with agent_id: <uuid>".
// - Every frame a subagent produces arrives on the ROOT session. Its tool calls
//   carry `_meta["github.com/copilot"].agentId`; its message chunks carry
//   nothing, so the adapter attributes them (see `isCopilotSubagentWaitTool`).
// - `read_agent` { agent_id, wait?, timeout?, since_turn? } reports "status: running | idle |
//   completed | failed | cancelled" followed by "[Turn N]\n<reply>" blocks.

const COPILOT_META_KEY = "github.com/copilot";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function copilotAgentId(meta: unknown): string | undefined {
  return nonEmptyString(record(record(meta)?.[COPILOT_META_KEY])?.agentId);
}

/** Routes a subagent's frames to a child session named by its agent id. */
export function normalizeCopilotSessionUpdate(
  notification: AcpSchema.SessionNotification,
): AcpSchema.SessionNotification {
  const update = notification.update;
  const agentId = copilotAgentId("_meta" in update ? update._meta : undefined);
  return agentId === undefined ? notification : { ...notification, sessionId: agentId };
}

function copilotToolOutputText(tool: AcpToolCallState): string | undefined {
  const content = tool.data.content;
  if (Array.isArray(content)) {
    const text = content
      .flatMap((entry) => {
        const nested = record(record(entry)?.content);
        return typeof nested?.text === "string" ? [nested.text] : [];
      })
      .join("\n")
      .trim();
    if (text.length > 0) return text;
  }
  const rawOutput = record(tool.data.rawOutput);
  return nonEmptyString(rawOutput?.content) ?? nonEmptyString(tool.data.rawOutput);
}

interface CopilotSpawn {
  readonly prompt: string;
  readonly title: string | null;
  readonly model: string | null;
  readonly background: boolean;
}

function copilotSpawn(tool: AcpToolCallState): CopilotSpawn | undefined {
  const input = record(tool.data.rawInput);
  const prompt = nonEmptyString(input?.prompt);
  if (prompt === undefined || nonEmptyString(input?.agent_type) === undefined) return undefined;
  return {
    prompt,
    title: nonEmptyString(input?.description) ?? nonEmptyString(input?.name) ?? null,
    model: nonEmptyString(input?.model) ?? null,
    background: input?.mode === "background",
  };
}

const READ_AGENT_INPUT_KEYS = new Set(["agent_id", "wait", "timeout", "since_turn"]);

/** `read_agent` input; `write_agent` also names an agent but carries a message. */
function copilotReadAgentId(tool: AcpToolCallState): string | undefined {
  const input = record(tool.data.rawInput);
  const agentId = nonEmptyString(input?.agent_id);
  if (input === undefined || agentId === undefined) return undefined;
  return Object.keys(input).every((key) => READ_AGENT_INPUT_KEYS.has(key)) ? agentId : undefined;
}

const AGENT_ID_PATTERN =
  /agent_id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** The latest reply in a `read_agent` report: the text after its last "[Turn N]". */
function copilotLatestTurnText(output: string): string | null {
  const turns = output.split(/^\[Turn \d+\]\n/m);
  if (turns.length < 2) return null;
  return nonEmptyString(turns.at(-1)) ?? null;
}

function copilotReportedStatus(
  output: string,
): Exclude<AcpAdapterV2SubagentUpdate["status"], "pending" | "interrupted"> | undefined {
  const status = /\bstatus:\s*([a-z_-]+)/i.exec(output)?.[1]?.toLowerCase();
  switch (status) {
    case "running":
      return "running";
    // An idle agent finished its turn and waits for follow-ups; its task is done.
    case "idle":
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
  }
  if (/^Agent (?:completed|is idle|was retired)/.test(output)) return "completed";
  if (output.startsWith("Agent is still running")) return "running";
  return undefined;
}

export function extractCopilotSubagentUpdate(
  tool: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined {
  const spawn = copilotSpawn(tool);
  if (spawn !== undefined) {
    const output = copilotToolOutputText(tool);
    const base = {
      nativeTaskId: tool.toolCallId,
      prompt: spawn.prompt,
      title: spawn.title,
      model: spawn.model,
    };
    if (tool.status === "failed") {
      return { ...base, status: "failed", childSessionId: null, result: output ?? null };
    }
    if (tool.status !== "completed") {
      return { ...base, status: "running", childSessionId: null, result: null };
    }
    const backgroundAgentId = output === undefined ? undefined : AGENT_ID_PATTERN.exec(output)?.[1];
    if (spawn.background || backgroundAgentId !== undefined) {
      return {
        ...base,
        status: "running",
        childSessionId: backgroundAgentId ?? null,
        result: null,
      };
    }
    return { ...base, status: "completed", childSessionId: null, result: output ?? null };
  }

  const agentId = copilotReadAgentId(tool);
  if (agentId === undefined) return undefined;
  // Hydration of a known subagent: the adapter never opens one from this.
  const hydration = {
    nativeTaskId: agentId,
    childSessionId: agentId,
    prompt: "",
    title: null,
    model: null,
  };
  if (tool.status !== "completed") {
    return { ...hydration, status: "running", result: null };
  }
  const output = copilotToolOutputText(tool) ?? "";
  const status = copilotReportedStatus(output) ?? "running";
  return {
    ...hydration,
    status,
    result: status === "running" ? null : copilotLatestTurnText(output),
  };
}

/**
 * Tools the parent waits on while its subagents work: a sync `task` and a
 * blocking `read_agent`. The parent model cannot speak until they return.
 */
export function isCopilotSubagentWaitTool(tool: AcpToolCallState): boolean {
  const spawn = copilotSpawn(tool);
  if (spawn !== undefined) return !spawn.background;
  return copilotReadAgentId(tool) !== undefined && record(tool.data.rawInput)?.wait === true;
}
