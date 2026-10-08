import {
  WorktreeMcpFailure,
  OrchestratorMcpFailure,
  VcsListRefsInput,
  VcsListRefsResult,
  WorktreeMcpHandoffInput,
  WorktreeMcpHandoffResult,
  WorktreeMcpStatusResult,
} from "@cinderdeck/contracts";
import * as Schema from "effect/Schema";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorktreeMcpService from "../../WorktreeMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  WorktreeMcpService.WorktreeMcpService,
];

const WorktreeHandoffTool = Tool.make("t3_worktree_handoff", {
  description:
    "Move this conversation into a new git worktree. Optionally pass name for a concise lane display name; otherwise it defaults to branch. In a Cinderdeck workspace, create a native lane and atomically transfer this conversation and its lane controls; the primary checkout is eligible even when it has a saved working directory. With several repositories, pass repositoryModes to choose which get worktrees (edited on the lane branch) and which stay references (read-only context); call t3_worktree_status for repository IDs and defaults. Running services or unapplied workspace settings never block a lane. Use adoptExisting with path and its exact branch to adopt an existing worktree. Use this tool instead of shell git worktree add or cd to move a conversation. To launch a separate agent already bound to a new or existing worktree, use t3_thread_launch with workspaceStrategy instead. Creates the worktree branch (optionally from origin), re-points the thread at the worktree, and by default runs the project's setup script there. Changing the workspace detaches the live provider session, so the current turn ends shortly after the handoff is recorded; call this as the last action of the turn. To keep working after the handoff, pass continuationPrompt with the remaining work: it is queued as the thread's next message and starts a new turn inside the worktree with the conversation preserved. Without it the thread stays idle until the next message. The worktree is not removed automatically when the thread is deleted. Fails if the Cinderdeck conversation is already in a lane, or a standalone thread is already attached to a worktree. Existing uncommitted files remain in the original checkout; existing terminal processes and historical recordings retain their original context.",
  parameters: WorktreeMcpHandoffInput,
  success: WorktreeMcpHandoffResult,
  failure: WorktreeMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Hand off thread to a git worktree")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const WorktreeRenameTool = Tool.make("t3_worktree_rename", {
  description:
    "Rename this conversation's own Cinderdeck lane without changing Git branches, folders, ports or services. Call t3_worktree_status for laneName and pass it as expectedName to avoid overwriting a name changed by the user. Only writable parent conversations in native lanes may rename. During the first session you may choose a concise task name if the lane still has its default branch name; keeping the default is fine.",
  parameters: Schema.Struct({
    name: Schema.String.check(
      Schema.isTrimmed(),
      Schema.isNonEmpty(),
      Schema.isMaxLength(100),
      Schema.isPattern(/^[^\x00-\x1f\x7f-\x9f]+$/),
    ),
    expectedName: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
  }),
  success: Schema.Struct({ name: Schema.String }),
  failure: WorktreeMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Rename current worktree lane")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const WorktreeStatusTool = Tool.make("t3_worktree_status", {
  description:
    "Report this agent thread's worktree binding and current Cinderdeck laneName (when available): whether it is attached to a git worktree, the worktree path and branch, the project's main workspace root, and the server default for t3_worktree_handoff's startFromOrigin. Call this before t3_worktree_handoff to check whether a handoff is possible or has already happened.",
  // No `parameters`: Tool.make defaults to Tool.EmptyParams, which serializes
  // to a top-level `type: "object"` JSON Schema. An explicit empty
  // Schema.Struct({}) serializes to `anyOf: [object, array]`, which is not a
  // valid MCP tool input schema and makes clients reject the whole server.
  success: WorktreeMcpStatusResult,
  failure: WorktreeMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get thread worktree status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const WorktreeListTool = Tool.make("t3_worktree_list", {
  description:
    "List branch refs and their associated checkout paths for this thread's workspace using the app's ref inventory. Detached worktrees without a branch are not included. Use t3_worktree_status for the thread binding and t3_worktree_handoff to create a new worktree.",
  parameters: Schema.Struct({
    query: VcsListRefsInput.fields.query,
    cursor: VcsListRefsInput.fields.cursor,
    limit: VcsListRefsInput.fields.limit,
    refKind: VcsListRefsInput.fields.refKind,
    includeMatchingRemoteRefs: VcsListRefsInput.fields.includeMatchingRemoteRefs,
  }),
  success: VcsListRefsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    GitWorkflowService.GitWorkflowService,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const WorktreeToolkit = Toolkit.make(
  WorktreeHandoffTool,
  WorktreeStatusTool,
  WorktreeRenameTool,
  WorktreeListTool,
);
