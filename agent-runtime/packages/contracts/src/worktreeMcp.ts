import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { IntegrationRepositoryModes } from "./deckhand/integration.ts";

/**
 * Input for the `t3_worktree_handoff` MCP tool.
 *
 * Creates a git worktree for the calling agent thread and re-points the
 * thread at it. Changing the thread's workspace detaches the live provider
 * session, so the current turn ends shortly after the handoff is recorded;
 * the conversation continues inside the worktree on the thread's next run.
 */
export const WorktreeMcpHandoffInput = Schema.Struct({
  name: Schema.optionalKey(
    TrimmedNonEmptyString.check(
      Schema.isMaxLength(100),
      Schema.isPattern(/^[^\x00-\x1f\x7f-\x9f]+$/),
    ),
  ).annotate({
    description: "Optional title for the session after moving it. Independent of its Git branch.",
  }),
  adoptExisting: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Move this session to the existing worktree at path. Requires path and its exact branch; omit baseRef and startFromOrigin.",
    }),
  ),
  branch: TrimmedNonEmptyString.annotate({
    description: "Branch name to create for the worktree (e.g. 'feature/my-change').",
  }),
  baseRef: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Branch or ref the worktree branch starts from. Defaults to the branch currently checked out in the project workspace.",
    }),
  ),
  startFromOrigin: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Fetch origin and start the worktree branch from the remote-tracking commit of baseRef instead of the local ref. Defaults to the server's 'new worktrees start from origin' setting.",
    }),
  ),
  path: Schema.optional(
    TrimmedNonEmptyString.check(
      // Absolute POSIX (/...), Windows drive (C:\ or C:/), or UNC (\\host).
      Schema.isPattern(/^(?:[A-Za-z]:[\\/]|[\\/])/),
    ).annotate({
      description:
        "Absolute filesystem path for the new worktree, or an existing checkout when adoptExisting is true.",
    }),
  ),
  repositoryModes: Schema.optional(
    IntegrationRepositoryModes.annotate({
      description:
        "Legacy compatibility field. Per-repository lane modes are retired; omit this field. A handoff moves only the session's project repository.",
    }),
  ),
  runSetupScript: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Run the project's configured setup script in the new worktree after handoff. Defaults to true.",
    }),
  ),
  continuationPrompt: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)).annotate({
      description:
        "Brief of the remaining work queued as the session's next turn after it moves. The current provider detaches. Omit to wait for the next user message. Include the goal, findings and constraints; do not repeat the already handled request to create a session or worktree.",
    }),
  ),
});
export type WorktreeMcpHandoffInput = typeof WorktreeMcpHandoffInput.Type;

export const WorktreeMcpSetupScriptStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("completed") }),
  Schema.Struct({
    status: Schema.Literal("started"),
    scriptName: TrimmedNonEmptyString,
    terminalId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("no-script"),
  }),
  Schema.Struct({
    status: Schema.Literal("skipped"),
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    detail: Schema.String,
  }),
]);
export type WorktreeMcpSetupScriptStatus = typeof WorktreeMcpSetupScriptStatus.Type;

export const WorktreeMcpContinuationStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("scheduled"),
    delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
  }),
  Schema.Struct({
    status: Schema.Literal("skipped"),
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    detail: Schema.String,
  }),
]);
export type WorktreeMcpContinuationStatus = typeof WorktreeMcpContinuationStatus.Type;

export const WorktreeMcpHandoffResult = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  baseRef: TrimmedNonEmptyString,
  startedFromOrigin: Schema.Boolean,
  setupScript: WorktreeMcpSetupScriptStatus,
  continuation: WorktreeMcpContinuationStatus,
  note: Schema.String,
});
export type WorktreeMcpHandoffResult = typeof WorktreeMcpHandoffResult.Type;

export const WorktreeMcpStatusResult = Schema.Struct({
  laneName: Schema.optionalKey(Schema.String),
  attached: Schema.Boolean.annotate({
    description: "True when this thread is already attached to a git worktree.",
  }),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  projectWorkspaceRoot: TrimmedNonEmptyString.annotate({
    description: "Root of the project's main workspace checkout.",
  }),
  defaultStartFromOrigin: Schema.Boolean.annotate({
    description: "Server default used by t3_worktree_handoff when startFromOrigin is omitted.",
  }),
  repositories: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        path: Schema.String,
        branch: Schema.String,
        laneDefault: Schema.optionalKey(Schema.Literals(["worktree", "reference"])),
        current: Schema.Boolean,
      }),
    ).annotate({
      description:
        "Saved native workspace repository context. current marks this session's repository, which is the only repository moved by t3_worktree_handoff. laneDefault is retained compatibility metadata and does not control session worktrees; omit repositoryModes.",
    }),
  ),
});
export type WorktreeMcpStatusResult = typeof WorktreeMcpStatusResult.Type;

export class WorktreeMcpFailure extends Schema.TaggedError<WorktreeMcpFailure>()(
  "WorktreeMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "thread_not_found",
      "project_not_found",
      "already_in_worktree",
      "handoff_in_progress",
      "invalid_request",
      "operation_failed",
    ]),
    message: Schema.String,
  },
) {}
