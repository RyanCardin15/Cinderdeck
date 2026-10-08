import type * as AcpSchema from "effect-acp/compat";
import type { AcpToolCallState } from "../../provider/acp/AcpRuntimeModel.ts";
import type {
  AcpAdapterV2SubagentSessionUpdate,
  AcpAdapterV2SubagentUpdate,
} from "./AcpAdapterV2.ts";

// Cursor CLI (agent 2026.10) over ACP. A client that advertises the
// `subagents` capability receives each subagent as its own session:
// - the parent's `task` tool call: kind "other", rawInput { _toolName: "task",
//   prompt, description, subagentType }, rawOutput { durationMs, isBackground }
// - `subagent_spawned` on the parent session: { subagentSessionId, name, task,
//   _meta.cursor { toolCallId, agentId, model? } }
// - ordinary session updates on `subagentSessionId`
// - `subagent_state_update` on the parent session: { subagentSessionId,
//   state: "completed" | "failed" | "cancelled" | "disconnected" }
// Neither update is in the ACP schema, so they arrive raw or as `_t3_unknown`.

/** Opts the session into Cursor's subagent sessions. */
export const CURSOR_ACP_CLIENT_CAPABILITIES_META = { subagents: true } as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function cursorTaskOutputText(tool: AcpToolCallState): string | undefined {
  const content = tool.data.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((entry) => {
      const nested = record(record(entry)?.content);
      return typeof nested?.text === "string" ? [nested.text] : [];
    })
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

export function extractCursorSubagentUpdate(
  tool: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined {
  const input = record(tool.data.rawInput);
  if (input?._toolName !== "task") return undefined;
  const base = {
    nativeTaskId: tool.toolCallId,
    childSessionId: null,
    prompt: nonEmptyString(input.prompt) ?? nonEmptyString(input.description) ?? "Subagent task",
    title: nonEmptyString(input.description) ?? null,
    model: null,
  };
  const output = record(tool.data.rawOutput);
  if (tool.status === "failed") {
    return {
      ...base,
      status: "failed",
      result: nonEmptyString(output?.error) ?? cursorTaskOutputText(tool) ?? null,
    };
  }
  // A background launch returns immediately; `subagent_state_update` ends it.
  if (tool.status !== "completed" || output?.isBackground === true) {
    return { ...base, status: "running", result: null };
  }
  return { ...base, status: "completed", result: cursorTaskOutputText(tool) ?? null };
}

function customSessionUpdate(
  notification: AcpSchema.SessionNotification,
): { readonly type: string; readonly payload: Record<string, unknown> } | undefined {
  const update = record(notification.update);
  if (update === undefined) return undefined;
  if (update.sessionUpdate === "_t3_unknown") {
    const payload = record(update.raw);
    const type = nonEmptyString(update.originalSessionUpdate);
    return payload === undefined || type === undefined ? undefined : { type, payload };
  }
  const type = nonEmptyString(update.sessionUpdate);
  return type === undefined ? undefined : { type, payload: update };
}

export function extractCursorSubagentSessionUpdate(
  notification: AcpSchema.SessionNotification,
): AcpAdapterV2SubagentSessionUpdate | undefined {
  const custom = customSessionUpdate(notification);
  if (custom === undefined) return undefined;
  const childSessionId = nonEmptyString(custom.payload.subagentSessionId);
  if (childSessionId === undefined) return undefined;
  const cursorMeta = record(record(custom.payload._meta)?.cursor);
  if (custom.type === "subagent_spawned") {
    const task = nonEmptyString(custom.payload.task);
    return {
      kind: "spawned",
      update: {
        nativeTaskId: nonEmptyString(cursorMeta?.toolCallId) ?? childSessionId,
        childSessionId,
        prompt: task ?? nonEmptyString(custom.payload.name) ?? "Subagent task",
        title: null,
        model: nonEmptyString(cursorMeta?.model) ?? null,
        status: "running",
        result: null,
      },
    };
  }
  if (custom.type === "subagent_state_update") {
    switch (custom.payload.state) {
      case "completed":
        return { kind: "finished", childSessionId, status: "completed", result: null };
      case "failed":
        return { kind: "finished", childSessionId, status: "failed", result: null };
      case "cancelled":
        return { kind: "finished", childSessionId, status: "cancelled", result: null };
      // Cursor gave up waiting for the child after a cancel.
      case "disconnected":
        return { kind: "finished", childSessionId, status: "interrupted", result: null };
    }
  }
  return undefined;
}
