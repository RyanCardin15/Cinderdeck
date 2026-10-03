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
const ReservationIdentity = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
const ReservationToken = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const IntegrationReservationControl = Schema.Struct({
  id: ReservationIdentity,
  token: ReservationToken,
  installationID: ReservationIdentity,
});
export type IntegrationReservationControl = typeof IntegrationReservationControl.Type;
export const IntegrationCheckoutLookupInput = Schema.Struct({
  installationID: ReservationIdentity,
  physicalID: ReservationToken,
  repositoryPhysicalID: ReservationToken,
  physicalIDs: Schema.Array(ReservationToken).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  sharedRefs: Schema.Boolean,
});
export type IntegrationCheckoutLookupInput = typeof IntegrationCheckoutLookupInput.Type;
export const IntegrationCheckoutContext = Schema.Struct({
  workspaceID: ReservationIdentity,
  generation: PositiveInt,
  revision: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  available: Schema.Boolean,
  repos: Schema.Array(ReservationIdentity).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  physicalIDs: Schema.Array(ReservationToken).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
export type IntegrationCheckoutContext = typeof IntegrationCheckoutContext.Type;
export const IntegrationCheckoutLookup = Schema.Struct({
  installationID: ReservationIdentity,
  runtimeEpoch: ReservationIdentity,
  contexts: Schema.Array(IntegrationCheckoutContext).check(Schema.isMaxLength(64)),
});
export type IntegrationCheckoutLookup = typeof IntegrationCheckoutLookup.Type;
export const IntegrationWriterReservationInput = Schema.Struct({
  ...IntegrationReservationControl.fields,
  ownerID: ReservationIdentity,
  workspaceID: ReservationIdentity,
  generation: PositiveInt,
  revision: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  repos: Schema.Array(ReservationIdentity).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
export type IntegrationWriterReservationInput = typeof IntegrationWriterReservationInput.Type;
export const IntegrationCheckoutReservation = Schema.Struct({
  id: ReservationIdentity,
  ownerID: ReservationIdentity,
  workspaceID: ReservationIdentity,
  generation: Schema.optionalKey(Schema.NullOr(PositiveInt)),
  kind: Schema.Literals(["writer", "run", "git", "lifecycle"]),
  state: Schema.Literals(["held", "uncertain", "released"]),
  physicalIDs: Schema.Array(ReservationToken).check(Schema.isMaxLength(64)),
  createdAt: Schema.String,
});
export type IntegrationCheckoutReservation = typeof IntegrationCheckoutReservation.Type;
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
  physicalID: Schema.optionalKey(Schema.NullOr(ReservationToken)),
  repositoryPhysicalID: Schema.optionalKey(Schema.NullOr(ReservationToken)),
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
  lane: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        sourceStackID: Schema.String,
        name: Schema.String,
        createdAt: Schema.String,
        directory: Schema.String,
        ports: Schema.Record(Schema.String, Schema.Int),
        from: Schema.optionalKey(Schema.NullOr(Schema.String)),
        pinned: Schema.optionalKey(Schema.Boolean),
        adopted: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
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
  result: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        workspace: Schema.optionalKey(IntegrationWorkspace),
        createdWorkspaceID: Schema.optionalKey(Schema.String),
        creationReady: Schema.optionalKey(Schema.Boolean),
        reconciliation: Schema.optionalKey(Schema.String),
        setup: Schema.optionalKey(
          Schema.NullOr(
            Schema.Struct({
              status: Schema.String,
              reference: Schema.optionalKey(Schema.NullOr(Schema.String)),
              runID: Schema.optionalKey(Schema.NullOr(Schema.String)),
              detail: Schema.optionalKey(Schema.NullOr(Schema.String)),
              updatedAt: Schema.String,
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
