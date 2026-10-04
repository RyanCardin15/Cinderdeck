import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { EnvironmentAuthorizationError } from "../auth.ts";
import { PullRequestRef } from "../pullRequest.ts";
import { TrimmedNonEmptyString } from "../baseSchemas.ts";
import { Recording, RecordingIdentity, RecordingContext } from "./recordingsRpc.ts";
import { Feature, CheckoutBinding, SessionBinding } from "./index.ts";
const identifier = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
export const VERIFICATION_METHODS = {
  list: "deckhand.verification.list",
  link: "deckhand.verification.link",
  unlink: "deckhand.verification.unlink",
  scenarioSave: "deckhand.verification.scenario.save",
  scenarioRemove: "deckhand.verification.scenario.remove",
} as const;
export const VerificationInput = Schema.Struct({ reference: PullRequestRef });
export type VerificationInput = typeof VerificationInput.Type;
export const VerificationLink = Schema.Struct({
  ...VerificationInput.fields,
  featureID: identifier,
  checkoutID: identifier,
  recording: RecordingIdentity,
});
export type VerificationLink = typeof VerificationLink.Type;
export const VerificationUnlink = Schema.Struct({
  ...VerificationInput.fields,
  featureID: identifier,
  checkoutID: identifier,
  artifactID: identifier,
});
export type VerificationUnlink = typeof VerificationUnlink.Type;
export const VerificationScenarioSave = Schema.Struct({
  ...VerificationInput.fields,
  scenarioID: identifier,
  featureID: identifier,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  baselineArtifactID: identifier,
  followupArtifactID: identifier,
});
export type VerificationScenarioSave = typeof VerificationScenarioSave.Type;
export const VerificationScenarioRemove = Schema.Struct({
  ...VerificationInput.fields,
  scenarioID: identifier,
});
export type VerificationScenarioRemove = typeof VerificationScenarioRemove.Type;
export const VerificationScenario = Schema.Struct({
  id: identifier,
  title: Schema.String,
  featureID: identifier,
  baselineArtifactID: identifier,
  followupArtifactID: identifier,
  baselineManifestHash: Schema.String,
  followupManifestHash: Schema.String,
  createdAt: Schema.String,
});
export type VerificationScenario = typeof VerificationScenario.Type;
export const VerificationContext = Schema.Struct({
  feature: Feature,
  checkout: CheckoutBinding,
  recordingContext: Schema.NullOr(RecordingContext),
});
export type VerificationContext = typeof VerificationContext.Type;
export const Evidence = Schema.Struct({
  artifactID: identifier,
  featureID: identifier,
  checkoutID: identifier,
  context: RecordingIdentity,
  recording: Recording,
  manifestHash: Schema.String,
  linkedAtHead: Schema.NullOr(Schema.String),
  sourceState: Schema.Literals(["source_match", "stale", "dirty", "unknown", "unrelated"]),
  buildState: Schema.Literals(["unknown"]),
  reason: Schema.String,
});
export type Evidence = typeof Evidence.Type;
export const VerificationOverview = Schema.Struct({
  head: Schema.NullOr(Schema.String),
  repositoryKeys: Schema.Array(Schema.String),
  observedAt: Schema.String,
  contexts: Schema.Array(VerificationContext),
  evidence: Schema.Array(Evidence),
  sessions: Schema.Array(SessionBinding),
  scenarios: Schema.optionalKey(Schema.Array(VerificationScenario)),
});
export type VerificationOverview = typeof VerificationOverview.Type;
export class VerificationError extends Schema.TaggedError<VerificationError>()(
  "VerificationError",
  { reason: Schema.String },
) {
  override get message() {
    return `Verification ${this.reason}.`;
  }
}
const errors = Schema.Union([VerificationError, EnvironmentAuthorizationError]);
export const VerificationRpcGroup = RpcGroup.make(
  Rpc.make(VERIFICATION_METHODS.scenarioSave, {
    payload: VerificationScenarioSave,
    success: VerificationOverview,
    error: errors,
  }),
  Rpc.make(VERIFICATION_METHODS.scenarioRemove, {
    payload: VerificationScenarioRemove,
    success: VerificationOverview,
    error: errors,
  }),
  Rpc.make(VERIFICATION_METHODS.list, {
    payload: VerificationInput,
    success: VerificationOverview,
    error: errors,
  }),
  Rpc.make(VERIFICATION_METHODS.link, {
    payload: VerificationLink,
    success: VerificationOverview,
    error: errors,
  }),
  Rpc.make(VERIFICATION_METHODS.unlink, {
    payload: VerificationUnlink,
    success: VerificationOverview,
    error: errors,
  }),
);
