import * as Schema from "effect/Schema";
import { PositiveInt, NonNegativeInt, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { RunContext, RunRepositorySnapshot, RunStatus } from "./runsRpc.ts";
const id = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
const sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export { BuildAdapter } from "./buildEvidence.ts";
import { BuildAdapter } from "./buildEvidence.ts";
export const BuildExpectedRepository = Schema.Struct({
  repositoryID: id,
  checkoutPhysicalID: sha,
  repositoryPhysicalID: sha,
  canonicalRepositoryKeys: Schema.Array(Schema.String.check(Schema.isMaxLength(512))).check(
    Schema.isMaxLength(32),
  ),
  head: Schema.String.check(Schema.isMaxLength(128)),
});
export const BuildDescribeInput = Schema.Struct({ ...RunContext.fields, serviceID: id });
export type BuildDescribeInput = typeof BuildDescribeInput.Type;
export const BuildDescriptor = Schema.Struct({
  adapter: BuildAdapter,
  definitionHash: sha,
  workflowHash: sha,
  repositories: Schema.Array(RunRepositorySnapshot).check(Schema.isMaxLength(16)),
  detail: Schema.NullOr(Schema.String),
});
export type BuildDescriptor = typeof BuildDescriptor.Type;
export const BuildPrepareInput = Schema.Struct({
  ...RunContext.fields,
  operationKey: id,
  serviceID: id,
  expectedDefinitionHash: sha,
  expectedWorkflowHash: sha,
  expectedRepositories: Schema.Array(BuildExpectedRepository).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
  requiredTaskIDs: Schema.Array(id).check(Schema.isMaxLength(32)),
});
export type BuildPrepareInput = typeof BuildPrepareInput.Type;
export const BuildGetInput = Schema.Struct({
  ...RunContext.fields,
  receiptID: Schema.optionalKey(id),
  operationKey: Schema.optionalKey(id),
});
export type BuildGetInput = typeof BuildGetInput.Type;
export const BuildActionInput = Schema.Struct({
  ...RunContext.fields,
  receiptID: id,
  operationKey: id,
});
export type BuildActionInput = typeof BuildActionInput.Type;
export const BuildObserveInput = Schema.Struct({
  ...RunContext.fields,
  receiptID: id,
  phase: Schema.Literals(["start", "end", "check"]),
});
export type BuildObserveInput = typeof BuildObserveInput.Type;
export const BuildFinishInput = Schema.Struct({
  ...BuildActionInput.fields,
  cancel: Schema.Boolean,
});
export type BuildFinishInput = typeof BuildFinishInput.Type;
export { BuildObservation } from "./buildEvidence.ts";
import { BuildObservation } from "./buildEvidence.ts";
export const BuildReceipt = Schema.Struct({
  id: id,
  request: BuildPrepareInput,
  adapter: BuildAdapter,
  state: Schema.Literals([
    "preparing",
    "ready",
    "launching",
    "running",
    "checking",
    "failed",
    "unknown",
    "finalized",
    "cancelled",
  ]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  detail: Schema.NullOr(Schema.String),
  buildRunID: Schema.NullOr(id),
  definitionHash: sha,
  workflowHash: sha,
  repositoriesAtStart: Schema.Array(RunRepositorySnapshot).check(Schema.isMaxLength(16)),
  repositoriesAtEnd: Schema.Array(RunRepositorySnapshot).check(Schema.isMaxLength(16)),
  artifact: Schema.NullOr(Schema.Struct({ name: id, sha256: sha, size: NonNegativeInt })),
  launch: Schema.NullOr(
    Schema.Struct({
      process: Schema.Struct({ pid: PositiveInt, pgid: PositiveInt, startTime: Schema.Number }),
      nonceHash: sha,
      startedAt: Schema.String,
    }),
  ),
  checks: Schema.Array(
    Schema.Struct({
      taskID: id,
      runID: id,
      status: RunStatus,
      finishedAt: Schema.NullOr(Schema.String),
      outcomeHash: Schema.NullOr(sha),
      buildMatched: Schema.optional(Schema.Boolean),
    }),
  ).check(Schema.isMaxLength(32)),
  observations: Schema.Array(BuildObservation).check(Schema.isMaxLength(64)),
  operations: Schema.Array(
    Schema.Struct({
      operationKey: id,
      action: Schema.Literals(["prepare", "launch", "checks", "finish"]),
      state: Schema.Literals(["pending", "accepted", "failed", "unknown"]),
    }),
  ).check(Schema.isMaxLength(8)),
});
export type BuildReceipt = typeof BuildReceipt.Type;
export class BuildError extends Schema.TaggedError<BuildError>()("BuildError", {
  reason: Schema.String,
  code: Schema.optionalKey(Schema.String),
}) {
  override get message() {
    return `Declared build ${this.reason}${this.code ? ` (${this.code})` : ""}.`;
  }
}
