import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "../baseSchemas.ts";

export const IntegrationHello = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  installationID: TrimmedNonEmptyString,
  executionHostID: TrimmedNonEmptyString,
  channel: Schema.Literals(["development", "release"]),
  runtimeEpoch: TrimmedNonEmptyString,
  capabilities: Schema.Array(TrimmedNonEmptyString),
  maximumFrameBytes: PositiveInt,
  maximumPageSize: PositiveInt,
  maximumWaitMs: NonNegativeInt,
});
export type IntegrationHello = typeof IntegrationHello.Type;
export const IntegrationService = Schema.Struct({
  name: Schema.String,
  phase: Schema.String,
  status: Schema.String,
  ready: Schema.Boolean,
  port: Schema.optionalKey(Schema.Number),
  url: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  sharedFrom: Schema.optionalKey(Schema.String),
  dependsOn: Schema.Array(Schema.String),
});
export const IntegrationRepository = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  branch: Schema.String,
  dirty: Schema.Boolean,
  changedFiles: NonNegativeInt,
  ahead: Schema.Int,
  behind: Schema.Int,
});
export const IntegrationWorkspace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  file: Schema.String,
  state: Schema.String,
  definitionChanged: Schema.Boolean,
  issues: Schema.Array(Schema.String),
  services: Schema.Array(IntegrationService),
  repos: Schema.Array(IntegrationRepository),
});
export const IntegrationSnapshot = Schema.Struct({
  installationID: TrimmedNonEmptyString,
  runtimeEpoch: TrimmedNonEmptyString,
  cursor: TrimmedNonEmptyString,
  resources: Schema.Array(
    Schema.Struct({
      workspaceID: TrimmedNonEmptyString,
      generation: PositiveInt,
      available: Schema.Boolean,
      revision: Schema.String,
      workspace: Schema.optionalKey(Schema.NullOr(IntegrationWorkspace)),
    }),
  ),
  total: NonNegativeInt,
  nextOffset: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
});
export type IntegrationSnapshot = typeof IntegrationSnapshot.Type;
export const IntegrationEvents = Schema.Struct({
  installationID: TrimmedNonEmptyString,
  runtimeEpoch: TrimmedNonEmptyString,
  events: Schema.Array(
    Schema.Struct({
      eventID: TrimmedNonEmptyString,
      sourceID: TrimmedNonEmptyString,
      revision: Schema.optionalKey(Schema.NullOr(Schema.String)),
      occurredAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
      observedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
      sequence: PositiveInt,
      workspaceID: TrimmedNonEmptyString,
      generation: PositiveInt,
      kind: Schema.Literals(["workspace.available", "workspace.updated", "workspace.unavailable"]),
    }),
  ),
  cursor: TrimmedNonEmptyString,
  resyncRequired: Schema.Boolean,
});
export type IntegrationEvents = typeof IntegrationEvents.Type;

export const IntegrationOperationInput = Schema.Struct({
  operationKey: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  installationID: TrimmedNonEmptyString,
  workspaceID: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  generation: PositiveInt,
  revision: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  method: Schema.Literals(["lane.create", "services.start", "services.stop", "services.restart"]),
  arguments: Schema.Record(Schema.String, Schema.Unknown),
});
export type IntegrationOperationInput = typeof IntegrationOperationInput.Type;
export const IntegrationOperationReceipt = Schema.Struct({
  id: TrimmedNonEmptyString,
  operationKey: TrimmedNonEmptyString,
  argumentHash: TrimmedNonEmptyString.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  workspaceID: TrimmedNonEmptyString,
  generation: PositiveInt,
  method: Schema.Literals(["lane.create", "services.start", "services.stop", "services.restart"]),
  state: Schema.Literals(["pending", "running", "succeeded", "failed", "unknown_outcome"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String })),
  ),
});
export type IntegrationOperationReceipt = typeof IntegrationOperationReceipt.Type;
