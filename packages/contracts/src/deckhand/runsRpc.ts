import { BuildAdapter, BuildObservation } from "./buildEvidence.ts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { EnvironmentAuthorizationError } from "../auth.ts";
import { SourceFingerprint } from "./sourceFingerprint.ts";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "../baseSchemas.ts";
export const RUN_METHODS = {
  list: "deckhand.runs.list",
  get: "deckhand.runs.get",
  failures: "deckhand.runs.failures",
  logs: "deckhand.runs.logs",
  definition: "deckhand.runs.definition",
  validate: "deckhand.runs.definition.validate",
} as const;
const identifier = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
export const RunContext = Schema.Struct({
  installationID: identifier,
  workspaceID: identifier,
  generation: PositiveInt,
});
export type RunContext = typeof RunContext.Type;
export const RunStatus = Schema.Literals([
  "queued",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "skipped",
]);
export const RunRepositorySnapshot = Schema.Struct({
  repositoryID: identifier,
  canonicalRepositoryKeys: Schema.Array(Schema.String.check(Schema.isMaxLength(512))).check(
    Schema.isMaxLength(32),
  ),
  checkoutPhysicalID: Schema.NullOr(Schema.String),
  repositoryPhysicalID: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Schema.String),
  capturedAt: Schema.String,
  fingerprint: Schema.NullOr(SourceFingerprint),
  complete: Schema.Boolean,
});
export type RunRepositorySnapshot = typeof RunRepositorySnapshot.Type;
const snapshots = Schema.Array(RunRepositorySnapshot).check(Schema.isMaxLength(16));
export const RunSourceProvenance = Schema.Struct({
  schemaVersion: PositiveInt,
  definitionHash: Schema.String,
  workflowHash: Schema.String,
  state: Schema.Literals(["preparing", "complete", "changed", "unknown"]),
  capturedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  repositoriesAtStart: snapshots,
  repositoriesAtEnd: snapshots,
  detail: Schema.NullOr(Schema.String),
  buildState: Schema.Literal("unknown"),
});
export type RunSourceProvenance = typeof RunSourceProvenance.Type;
export const Run = Schema.Struct({
  id: identifier,
  workspaceID: identifier,
  name: Schema.String,
  definitionID: identifier,
  kind: Schema.Literals(["task", "workflow"]),
  status: RunStatus,
  actor: Schema.String,
  createdAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  duration: Schema.Number,
  detail: Schema.NullOr(Schema.String),
  cancelAllowed: Schema.Boolean,
  buildReceiptID: Schema.optionalKey(identifier),
  buildObservations: Schema.optionalKey(
    Schema.Array(BuildObservation).check(Schema.isMaxLength(2)),
  ),
  sourceProvenance: Schema.optionalKey(RunSourceProvenance),
  rerunOfID: Schema.optionalKey(identifier),
  integrationAuthority: Schema.optionalKey(RunContext),
  outcomeHash: Schema.optionalKey(Schema.String),
  steps: Schema.Array(
    Schema.Struct({
      id: identifier,
      reference: Schema.String,
      title: Schema.String,
      status: RunStatus,
      command: Schema.NullOr(Schema.String),
      directory: Schema.NullOr(Schema.String),
      exitCode: Schema.NullOr(Schema.Int),
      detail: Schema.NullOr(Schema.String),
      definitionHash: Schema.optionalKey(Schema.String),
      startedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
      finishedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
      environmentKeys: Schema.optionalKey(
        Schema.Array(Schema.String).check(Schema.isMaxLength(512)),
      ),
      executionProcess: Schema.optionalKey(
        Schema.Struct({ pid: PositiveInt, pgid: PositiveInt, startTime: Schema.Number }),
      ),
      sourceScopeComplete: Schema.optionalKey(Schema.Boolean),
      repositoriesAtStart: Schema.optionalKey(snapshots),
      repositoriesAtEnd: Schema.optionalKey(snapshots),
    }),
  ).check(Schema.isMaxLength(256)),
});
export type Run = typeof Run.Type;
export const Service = Schema.Struct({
  buildAdapter: Schema.optionalKey(BuildAdapter),
  id: identifier,
  phase: Schema.String,
  status: Schema.String,
  ready: Schema.Boolean,
  detail: Schema.NullOr(Schema.String),
  port: Schema.NullOr(PositiveInt),
  command: Schema.NullOr(Schema.String),
  directory: Schema.NullOr(Schema.String),
  dependencies: Schema.Array(Schema.String),
  sharedFrom: Schema.NullOr(Schema.String),
});
export type Service = typeof Service.Type;
export const RunsOverview = Schema.Struct({
  revision: identifier,
  storageError: Schema.NullOr(Schema.String),
  retainedRunCount: Schema.optionalKey(NonNegativeInt),
  runsTruncated: Schema.optionalKey(Schema.Boolean),
  detailAvailable: Schema.optionalKey(Schema.Boolean),
  services: Schema.Array(Service).check(Schema.isMaxLength(128)),
  tasks: Schema.Array(
    Schema.Struct({
      id: identifier,
      name: Schema.String,
      command: Schema.String,
      directory: Schema.String,
      requiresServices: Schema.Array(Schema.String),
      timeout: Schema.Number,
    }),
  ).check(Schema.isMaxLength(128)),
  workflows: Schema.Array(
    Schema.Struct({
      id: identifier,
      name: Schema.String,
      steps: Schema.Array(Schema.String),
      cleanupServices: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(128)),
  runs: Schema.Array(Run).check(Schema.isMaxLength(100)),
});
export type RunsOverview = typeof RunsOverview.Type;
export const RunGetInput = Schema.Struct({
  ...RunContext.fields,
  runID: identifier,
  stepOffset: NonNegativeInt,
  stepLimit: PositiveInt.check(Schema.isLessThanOrEqualTo(16)),
});
export type RunGetInput = typeof RunGetInput.Type;
export const RunDetail = Schema.Struct({
  run: Run,
  totalSteps: NonNegativeInt,
  nextStepOffset: Schema.NullOr(NonNegativeInt),
});
export type RunDetail = typeof RunDetail.Type;
export const RunFailuresInput = Schema.Struct({
  ...RunContext.fields,
  runIDs: Schema.optionalKey(Schema.Array(identifier).check(Schema.isMaxLength(100))),
});
export type RunFailuresInput = typeof RunFailuresInput.Type;
export const RunFailures = Schema.Struct({
  revision: identifier,
  storageError: Schema.NullOr(Schema.String),
  retainedRunCount: NonNegativeInt,
  runsTruncated: Schema.Boolean,
  runs: Schema.Array(
    Schema.Struct({
      id: identifier,
      name: Schema.String,
      status: Schema.Literals(["failed", "interrupted"]),
      finishedAt: Schema.NullOr(Schema.String),
      detail: Schema.NullOr(Schema.String),
      causeVersion: Schema.String,
    }),
  ).check(Schema.isMaxLength(100)),
  resolutions: Schema.Array(
    Schema.Struct({
      runID: identifier,
      causeVersion: Schema.String,
      resolvedByRunID: identifier,
      observedAt: Schema.String,
    }),
  ).check(Schema.isMaxLength(100)),
});
export type RunFailures = typeof RunFailures.Type;
export const RunLogInput = Schema.Struct({
  ...RunContext.fields,
  runID: identifier,
  stepID: Schema.optionalKey(identifier),
});
export type RunLogInput = typeof RunLogInput.Type;
export const RunLogs = Schema.Array(
  Schema.Struct({
    source: Schema.String,
    text: Schema.String.check(Schema.isMaxLength(4000)),
    time: Schema.String,
  }),
).check(Schema.isMaxLength(300));
export type RunLogs = typeof RunLogs.Type;
export const RunDefinition = Schema.Struct({
  source: Schema.String.check(Schema.isMaxLength(30000)),
  sourceHash: Schema.String.check(Schema.isLengthBetween(64, 64)),
  editable: Schema.Boolean,
});
export type RunDefinition = typeof RunDefinition.Type;
export const ValidateDefinition = Schema.Struct({
  ...RunContext.fields,
  source: Schema.String.check(Schema.isMaxLength(30000)),
});
export type ValidateDefinition = typeof ValidateDefinition.Type;
export const DefinitionValidation = Schema.Struct({
  valid: Schema.Boolean,
  issues: Schema.Array(Schema.String),
});
export type DefinitionValidation = typeof DefinitionValidation.Type;
export class RunsError extends Schema.TaggedError<RunsError>()("RunsError", {
  reason: Schema.String,
  code: Schema.optionalKey(Schema.String),
}) {
  override get message() {
    return `Runs ${this.reason}${this.code ? ` (${this.code})` : ""}.`;
  }
}
const errors = Schema.Union([RunsError, EnvironmentAuthorizationError]);
export const RunsRpcGroup = RpcGroup.make(
  Rpc.make(RUN_METHODS.list, { payload: RunContext, success: RunsOverview, error: errors }),
  Rpc.make(RUN_METHODS.get, { payload: RunGetInput, success: RunDetail, error: errors }),
  Rpc.make(RUN_METHODS.failures, {
    payload: RunFailuresInput,
    success: RunFailures,
    error: errors,
  }),
  Rpc.make(RUN_METHODS.logs, { payload: RunLogInput, success: RunLogs, error: errors }),
  Rpc.make(RUN_METHODS.definition, { payload: RunContext, success: RunDefinition, error: errors }),
  Rpc.make(RUN_METHODS.validate, {
    payload: ValidateDefinition,
    success: DefinitionValidation,
    error: errors,
  }),
);
