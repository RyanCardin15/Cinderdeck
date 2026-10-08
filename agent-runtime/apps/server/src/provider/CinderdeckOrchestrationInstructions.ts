import { APP_MCP_SERVER_NAME } from "../mcp/McpProviderSession.ts";
import type { ProviderInteractionMode } from "@cinderdeck/contracts";

export const CINDERDECK_ORCHESTRATION_INSTRUCTIONS = `

## Cinderdeck orchestration

The \`${APP_MCP_SERVER_NAME}\` MCP server provides app-owned orchestration. Treat these concepts distinctly:

- A delegated task/subagent is child work owned by the current thread. Use \`orchestrator_capabilities\` to discover the current provider/model IDs from the same live catalog as the composer, including configured custom models. Do not treat a native tool's model list as the full list of available subagent models. Prefer native subagent tools for same-provider work only when they support the chosen model. Use \`delegate_task\` with that provider instance and model when native tools cannot, including for same-provider work. Also use \`delegate_task\` for cross-provider or explicitly Cinderdeck-owned child tasks. Retain each returned \`taskId\`, and use \`task_status\` or \`task_cancel\` to manage it. The returned \`childThreadId\` is backing storage for the subagent, not the target for starting another delegated review round.
- \`t3_thread_launch\` and \`create_threads\` create ordinary top-level Cinderdeck conversations. Use them only when the user explicitly asks for separate/new/top-level threads or conversations. Never use them merely because the user said "subagent" or requested parallel delegated work.
- For every Cinderdeck delegated review round, call \`delegate_task\` again. Include the original brief, prior findings, responses, and unresolved objections in each new task prompt. Track each round by its own \`taskId\`. Use a distinct \`clientRequestId\` per round, stable across retries of that round. Do not use \`t3_thread_send\` on \`childThreadId\` to continue a delegated review.
- \`schedule_task\` creates persistent recurring work in the app scheduler. Pass \`schedule\` as a structured object, never as JSON text: \`{"type":"interval","everyMs":3600000}\` for an interval, or \`{"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,2,3,4,5]}\` for a wall-clock schedule. By default runs return to the current thread; set \`bindToCurrentThread=false\` only when the user wants a fresh thread for every run. After scheduling, report the returned cadence and next run time.

### Lane names

When creating a Cinderdeck lane with \`t3_worktree_handoff\`, optionally pass \`name\` for a short, useful display name based on the task. In a multi-repository workspace, pass \`repositoryModes\` (IDs from \`t3_worktree_status\`) so only repositories you will change get worktrees and the rest stay references. Omitting it keeps the default branch name. On the first session in your own lane, you may call \`t3_worktree_status\` and, if \`laneName\` still matches the default branch name and the task gives useful context, call \`t3_worktree_rename\` with \`name\` and the observed \`expectedName\`. Keeping the default is fine. Preserve a custom or user-chosen name; never rename another lane. A lane name is separate from its Git branch.

### Choose the workspace before starting a new thread

For independent implementation or a PR stack in its own worktree, use \`t3_thread_launch\` with an explicit \`workspaceStrategy\`. It creates or selects the workspace, binds the new thread to it, and prepares it before the agent starts. Put the task in \`message\`, not \`prompt\`:

- New worktree: \`{"title":"UI cleanup","workspaceStrategy":{"type":"worktree","baseRef":"feature/base","branch":"feature/ui-cleanup","startFromOrigin":false},"message":"Implement the cleanup and open a PR against feature/base."}\`
- Existing worktree: \`{"title":"Continue cleanup","workspaceStrategy":{"type":"existing_worktree","worktreePath":"/absolute/path/to/worktree","branch":"feature/ui-cleanup"},"message":"Continue the cleanup."}\`
- Project's main checkout: \`workspaceStrategy:{"type":"root"}\`. Omitting workspaceStrategy also selects root; it does not inherit the caller's worktree.

For stacked work, set \`baseRef\` to the intended parent branch and \`startFromOrigin:false\` to use its local commits. Use \`startFromOrigin:true\` when you intend to fetch and start from origin. Uncommitted edits are not copied. Use \`t3_worktree_list\` to discover existing checkout paths. Project, model selection, and modes inherit unless supplied; launch requires a full-access/default caller.

\`t3_thread_launch\` is the single-thread launch tool. Use \`create_threads\` only for a batch of threads intentionally sharing the caller's checkout: it always inherits the caller's project, branch, and worktree and has no workspace override. Asking an agent to run \`git worktree add\` or \`cd\` in its prompt does not update Cinderdeck's thread binding. Select the workspace in the launch call instead. \`t3_worktree_handoff\` moves the calling thread, not another thread, and creates a native lane for a Cinderdeck primary-checkout conversation. Use adoptExisting with path and branch to adopt an existing worktree. It cannot move a conversation that is already in a lane. Shell Git commands do not transfer the conversation; always use the handoff tool and pass continuationPrompt to resume the task there.

\`t3_thread_launch\` has no idempotency key. Retain its returned threadId and inspect it with \`t3_thread_read\` / \`t3_thread_wait\`; preparation can still be running after acceptance. If a launch fails or its response is lost, inspect \`t3_thread_list\` before retrying, since a thread may already exist.

Tool names may include a harness-normalized MCP prefix, such as \`mcp__${APP_MCP_SERVER_NAME}__delegate_task\`; the semantics are the same. Some harnesses attach optional MCP servers lazily: if an initial tool-catalog scan does not show Cinderdeck tools, do not conclude that cross-provider delegation is unavailable. Make one bounded direct attempt using the known Cinderdeck tool name on the next tool step. In Codex code mode, for example, call \`tools.mcp__${APP_MCP_SERVER_NAME}__orchestrator_capabilities({})\` before reporting that the capability is absent. Keep polling/wait loops bounded, do not duplicate active work, and use stable \`clientRequestId\` values when retrying tools that accept them.

ACP fallback: some ACP agents accept the injected MCP server but fail to expose its tools. When the Cinderdeck tools are absent and \`T3_ACP_MCP_NODE\` is present, call the same tools through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset when Cinderdeck runs as a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`. This is the supported Cinderdeck transport fallback, not an ordinary shell-based substitute for delegation.
`;

export const CINDERDECK_BROWSER_TOOL_INSTRUCTIONS = `

## Cinderdeck collaborative browser

You are running inside Cinderdeck. The \`${APP_MCP_SERVER_NAME}\` MCP server is the product-native collaborative browser shared with the user. When it exposes \`preview_*\` tools, prefer those tools for browser navigation, inspection, interaction, screenshots, and recordings.

For browser work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` before concluding that the browser is unavailable. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Use an alternative browser system only when the Cinderdeck preview tools are absent, the user explicitly requests another browser, or \`preview_open\` returns an explicit unsupported/unavailable error. A failed Cinderdeck preview tool call should be inspected and retried with corrected arguments when the error is actionable.
`;

const CINDERDECK_ACP_DEFAULT_MODE_INSTRUCTIONS = `## Cinderdeck interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until Cinderdeck supplies a different interaction-mode instruction.`;

const CINDERDECK_ACP_PLAN_MODE_INSTRUCTIONS = `## Cinderdeck interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until Cinderdeck supplies a different interaction-mode instruction.`;

export interface CinderdeckAcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
}

/**
 * ACP has no system/developer prompt field, so send Cinderdeck-owned context in the
 * first user prompt and whenever the available tools or interaction mode change.
 */
export function cinderdeckAcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: CinderdeckAcpInstructionState;
  readonly previousState?: CinderdeckAcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasT3Mcp === input.state.hasT3Mcp
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? CINDERDECK_ACP_PLAN_MODE_INSTRUCTIONS
      : CINDERDECK_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasT3Mcp
      ? [CINDERDECK_BROWSER_TOOL_INSTRUCTIONS.trim(), CINDERDECK_ORCHESTRATION_INSTRUCTIONS.trim()]
      : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

/**
 * Providers without a system/developer-instruction channel receive this
 * context in the first prompt. Keep the wrapper explicit so it cannot be
 * mistaken for text authored by the user.
 */
function prependCinderdeckOrchestrationInstructions(prompt: string): string {
  return `<t3_code_orchestration_instructions>${CINDERDECK_ORCHESTRATION_INSTRUCTIONS.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

export function cinderdeckOrchestrationPromptForFirstRun(input: {
  readonly prompt: string;
  readonly runOrdinal: number;
  readonly hasT3Mcp: boolean;
}): string {
  return input.runOrdinal === 1 && input.hasT3Mcp
    ? prependCinderdeckOrchestrationInstructions(input.prompt)
    : input.prompt;
}

export function cinderdeckOrchestrationSystemPrompt(hasT3Mcp: boolean): string | undefined {
  return hasT3Mcp ? CINDERDECK_ORCHESTRATION_INSTRUCTIONS : undefined;
}
