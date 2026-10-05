import * as Schema from "effect/Schema";

/** Settings → Integrations → MCP & skills. Cinderdeck on the execution computer performs every step. */
export const AGENT_ACCESS_METHOD = "deckhand.agentAccess";

export const AgentAccessClientId = Schema.Literals(["claude", "codex", "cursor", "copilot"]);
export type AgentAccessClientId = typeof AgentAccessClientId.Type;

export const AgentAccessInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("status") }),
  Schema.Struct({ action: Schema.Literal("cli") }),
  Schema.Struct({
    action: Schema.Literal("mcp"),
    agent: AgentAccessClientId,
    /** Also write Cinderdeck usage notes into ~/.codex/AGENTS.md or ~/.claude/CLAUDE.md. */
    instructions: Schema.Boolean,
  }),
  Schema.Struct({ action: Schema.Literal("skills"), agent: AgentAccessClientId }),
  Schema.Struct({ action: Schema.Literal("mod") }),
]);
export type AgentAccessInput = typeof AgentAccessInput.Type;

const Text = Schema.String.check(Schema.isMaxLength(2000));

export const AgentAccessInstall = Schema.Struct({
  state: Schema.Literals(["missing", "partial", "outdated", "current", "yours"]),
  detail: Text,
});
export type AgentAccessInstall = typeof AgentAccessInstall.Type;

export const AgentAccessStatus = Schema.Struct({
  cli: Schema.Struct({ installed: Schema.Boolean, path: Text }),
  clients: Schema.Array(
    Schema.Struct({
      id: AgentAccessClientId,
      name: Text,
      mcpConfigured: Schema.Boolean,
      mcpLocation: Text,
      skills: AgentAccessInstall,
    }),
  ).check(Schema.isMaxLength(16)),
  skills: Schema.Array(Schema.Struct({ name: Text, summary: Text })).check(Schema.isMaxLength(64)),
  /** Absent when the installed Cinderdeck ships no Claude Code mod. */
  claudeMod: Schema.optional(AgentAccessInstall),
});
export type AgentAccessStatus = typeof AgentAccessStatus.Type;

export const AgentAccessResult = Schema.Struct({
  ok: Schema.Boolean,
  detail: Text,
  status: AgentAccessStatus,
});
export type AgentAccessResult = typeof AgentAccessResult.Type;
