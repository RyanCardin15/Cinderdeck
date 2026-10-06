import { Run } from "./runsRpc.ts";
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
const ContextIdentity = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
const PhysicalIdentity = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const IntegrationCheckoutLookupInput = Schema.Struct({
  installationID: ContextIdentity,
  physicalID: PhysicalIdentity,
  repositoryPhysicalID: PhysicalIdentity,
  physicalIDs: Schema.Array(PhysicalIdentity).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  sharedRefs: Schema.Boolean,
});
export type IntegrationCheckoutLookupInput = typeof IntegrationCheckoutLookupInput.Type;
export const IntegrationCheckoutContext = Schema.Struct({
  workspaceID: ContextIdentity,
  generation: PositiveInt,
  revision: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  available: Schema.Boolean,
  repos: Schema.Array(ContextIdentity).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  physicalIDs: Schema.Array(PhysicalIdentity).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
export type IntegrationCheckoutContext = typeof IntegrationCheckoutContext.Type;
export const IntegrationCheckoutLookup = Schema.Struct({
  installationID: ContextIdentity,
  runtimeEpoch: ContextIdentity,
  contexts: Schema.Array(IntegrationCheckoutContext).check(Schema.isMaxLength(64)),
});
export type IntegrationCheckoutLookup = typeof IntegrationCheckoutLookup.Type;
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
  // A shared alias may have a different name than its owner's actual service.
  sharedServiceID: Schema.optionalKey(Schema.String),
  dependsOn: Schema.Array(Schema.String),
});
export const IntegrationRepository = Schema.Struct({
  physicalID: Schema.optionalKey(Schema.NullOr(PhysicalIdentity)),
  repositoryPhysicalID: Schema.optionalKey(Schema.NullOr(PhysicalIdentity)),
  id: Schema.String,
  path: Schema.String,
  branch: Schema.String,
  dirty: Schema.Boolean,
  changedFiles: NonNegativeInt,
  ahead: Schema.Int,
  behind: Schema.Int,
});
export const IntegrationRepositoryStartRefs = Schema.Record(
  Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(160)),
  Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(200),
    Schema.isPattern(/^(?!-)(?![\s\S]*[\0\n\r])[\s\S]+$/),
  ),
).check(Schema.isMaxProperties(64));
export type IntegrationRepositoryStartRefs = typeof IntegrationRepositoryStartRefs.Type;
export const IntegrationWorkspace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  file: Schema.String,
  state: Schema.String,
  lane: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        sourceStackID: Schema.String,
        name: Schema.String,
        createdAt: Schema.String,
        directory: Schema.String,
        ports: Schema.Record(Schema.String, Schema.Int),
        from: Schema.optionalKey(Schema.NullOr(Schema.String)),
        repositoryRefs: Schema.optionalKey(IntegrationRepositoryStartRefs),
        pinned: Schema.optionalKey(Schema.Boolean),
        adopted: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
  definitionChanged: Schema.Boolean,
  issues: Schema.Array(Schema.String),
  services: Schema.Array(IntegrationService),
  repos: Schema.Array(IntegrationRepository),
  root: Schema.optionalKey(Schema.String),
  files: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(128))),
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

export const IntegrationOperationMethod = Schema.Literals([
  "lane.create",
  "lane.adopt",
  "lane.update",
  "lane.setup",
  "lane.release",
  "lane.remove",
  "services.start",
  "services.stop",
  "services.restart",
  "runs.start",
  "runs.cancel",
  "runs.rerun",
  "definition.apply",
]);
export type IntegrationOperationMethod = typeof IntegrationOperationMethod.Type;

export const IntegrationOperationInput = Schema.Struct({
  operationKey: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  installationID: TrimmedNonEmptyString,
  workspaceID: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  generation: PositiveInt,
  revision: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  method: IntegrationOperationMethod,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
});
export type IntegrationOperationInput = typeof IntegrationOperationInput.Type;
export const IntegrationOperationReceipt = Schema.Struct({
  id: TrimmedNonEmptyString,
  operationKey: TrimmedNonEmptyString,
  argumentHash: TrimmedNonEmptyString.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  workspaceID: TrimmedNonEmptyString,
  generation: PositiveInt,
  method: IntegrationOperationMethod,
  state: Schema.Literals(["pending", "running", "succeeded", "failed", "unknown_outcome"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  result: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        run: Schema.optionalKey(Run),
        saved: Schema.optionalKey(Schema.Boolean),
        workspaceID: Schema.optionalKey(Schema.String),
        sourceHash: Schema.optionalKey(Schema.String),
        workspace: Schema.optionalKey(IntegrationWorkspace),
        createdWorkspaceID: Schema.optionalKey(Schema.String),
        creationReady: Schema.optionalKey(Schema.Boolean),
        removed: Schema.optionalKey(Schema.String),
        released: Schema.optionalKey(Schema.String),
        resourceAvailable: Schema.optionalKey(Schema.Boolean),
        report: Schema.optionalKey(
          Schema.Struct({
            removedWorktrees: Schema.Array(Schema.String),
            keptWorktrees: Schema.Array(Schema.String),
            unpushed: Schema.Record(Schema.String, Schema.Number),
            ignored: Schema.Array(
              Schema.Struct({
                path: Schema.String,
                bytes: Schema.optionalKey(Schema.NullOr(Schema.Number)),
                note: Schema.optionalKey(Schema.NullOr(Schema.String)),
              }),
            ),
          }),
        ),
        reconciliation: Schema.optionalKey(Schema.String),
        setup: Schema.optionalKey(
          Schema.NullOr(
            Schema.Struct({
              status: Schema.String,
              reference: Schema.optionalKey(Schema.NullOr(Schema.String)),
              runID: Schema.optionalKey(Schema.NullOr(Schema.String)),
              detail: Schema.optionalKey(Schema.NullOr(Schema.String)),
              updatedAt: Schema.String,
              integrationOperationID: Schema.optionalKey(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
      }),
    ),
  ),
  error: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String })),
  ),
});
export type IntegrationOperationReceipt = typeof IntegrationOperationReceipt.Type;
