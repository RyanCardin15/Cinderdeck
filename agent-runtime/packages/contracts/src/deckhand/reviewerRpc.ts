import * as Schema from "effect/Schema";
import { ThreadId, ProviderSessionId, PositiveInt, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ModelSelection } from "../modelSelection.ts";
import { RuntimeMode, ProviderInteractionMode } from "../providerPolicy.ts";
import { FeatureId, CheckoutBindingId } from "./index.ts";
const identifier = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
export const CODE_REVIEW_SKILL_PATH = ".cinderdeck/skills/code-review/SKILL.md";
export const DEFAULT_CODE_REVIEW_SKILL = `---
name: cinderdeck-code-review
description: Review committed changes in an isolated Cinderdeck lane.
---

Review the committed changes against the intended base branch in each repository with changes under review.
When creating a review lane, inspect which repositories changed first. If only one of four
repositories has changes, create a worktree only for that repository and select Reference
for the other three (MCP repositoryModes, CLI --repo-mode). Use their primary checkouts
as read-only context; do not edit them or run checks that modify their files.
Supply repositoryRefs only for repositories selected as worktrees.
Read repository instructions and the surrounding code before assessing a change.
Determine the base from the pull request or repository's default branch; if ambiguous, ask.
Find actionable correctness bugs, regressions, security issues, and missing tests.
Prioritize findings by impact and include exact file and line references, a concrete trigger,
and an explanation of the observed or expected failure. Avoid speculative style complaints.
Run focused checks when useful and distinguish verified behavior from untested assumptions.
Report findings first, followed by a brief assessment and validation limits. Say when none are found.
Keep source checkouts untouched. Do not publish a review, create a pull request, or merge.
`;
export const CodeReviewSkill = Schema.Struct({
  path: TrimmedNonEmptyString,
  content: TrimmedNonEmptyString.check(Schema.isMaxLength(6000)),
  configured: Schema.Boolean,
});
export const REVIEWER_METHODS = {
  preview: "deckhand.reviewer.preview",
  launch: "deckhand.reviewer.launch",
  schedule: "deckhand.reviewer.schedule",
  get: "deckhand.reviewer.get",
  cancel: "deckhand.reviewer.cancel",
  stopSource: "deckhand.reviewer.source.stop",
} as const;
export const ReviewerLaunchContext = Schema.Struct({
  featureId: FeatureId,
  sourceCheckoutId: CheckoutBindingId,
  sourceWorkspaceID: identifier,
  sourceGeneration: PositiveInt,
  sourceRevision: identifier,
  repositories: Schema.Array(
    Schema.Struct({
      repositoryID: identifier,
      sourcePhysicalId: identifier,
      repositoryPhysicalId: identifier,
      commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
export type ReviewerLaunchContext = typeof ReviewerLaunchContext.Type;
export const ReviewerLaunchPreview = Schema.Struct({
  installationID: identifier,
  workspaceID: identifier,
  generation: PositiveInt,
  revision: identifier,
  repositoryID: identifier,
  repositoryPath: Schema.optionalKey(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  reviewerContext: ReviewerLaunchContext,
  codeReviewSkill: Schema.optionalKey(CodeReviewSkill),
});
export type ReviewerLaunchPreview = typeof ReviewerLaunchPreview.Type;
export const ReviewerPreviewInput = Schema.Struct({ threadId: ThreadId });
export const ReviewerLaunchInput = Schema.Struct({
  operationKey: identifier,
  preview: ReviewerLaunchPreview,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(4000)),
});
export type ReviewerLaunchInput = typeof ReviewerLaunchInput.Type;

export const ReviewerQueueLookup = Schema.Struct({ operationKey: identifier });
export type ReviewerQueueLookup = typeof ReviewerQueueLookup.Type;
export const ReviewerQueueRecord = Schema.Struct({
  operationKey: identifier,
  state: Schema.Literals([
    "queued",
    "starting",
    "accepted",
    "needs_refresh",
    "failed",
    "unknown_outcome",
    "cancelled",
  ]),
  attempts: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  attemptKey: Schema.NullOr(identifier),
  preview: ReviewerLaunchPreview,
  creation: Schema.NullOr(
    Schema.Struct({
      operationKey: identifier,
      state: Schema.String,
      laneID: Schema.NullOr(identifier),
      threadID: Schema.NullOr(ThreadId),
      error: Schema.NullOr(Schema.String),
    }),
  ),
  detail: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ReviewerQueueRecord = typeof ReviewerQueueRecord.Type;

export const ReviewerSourceStopInput = Schema.Struct({
  threadId: ThreadId,
  providerSessionId: ProviderSessionId,
});
export type ReviewerSourceStopInput = typeof ReviewerSourceStopInput.Type;
export const ReviewerSourceStopResult = Schema.Struct({
  threadId: ThreadId,
  state: Schema.Literals(["released", "shared_session", "unknown_outcome"]),
  detail: Schema.String,
});
export type ReviewerSourceStopResult = typeof ReviewerSourceStopResult.Type;
