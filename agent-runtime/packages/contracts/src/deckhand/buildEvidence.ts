import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "../baseSchemas.ts";
const id = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
const sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const BuildAdapter = Schema.Struct({
  serviceID: id,
  buildTaskID: id,
  requiredTaskIDs: Schema.Array(id).check(Schema.isMaxLength(32)),
  artifactName: id,
  stampPath: Schema.String.check(Schema.isMaxLength(512)),
  servedArtifactPath: Schema.String.check(Schema.isMaxLength(512)),
});
export type BuildAdapter = typeof BuildAdapter.Type;
export const BuildObservation = Schema.Struct({
  serviceURL: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
  receiptID: id,
  workspaceID: id,
  serviceID: id,
  phase: Schema.Literals(["start", "end", "check"]),
  state: Schema.Literals(["matched", "unknown", "changed"]),
  observedAt: Schema.String,
  artifactSHA256: Schema.NullOr(sha),
  servedArtifactSHA256: Schema.NullOr(sha),
  sourceUnchanged: Schema.Boolean,
  processMatched: Schema.Boolean,
  stampMatched: Schema.Boolean,
  detail: Schema.NullOr(Schema.String),
});
export type BuildObservation = typeof BuildObservation.Type;
export const BuildCaptureProof = Schema.Struct({
  receiptID: id,
  artifactSHA256: sha,
  launchNonceHash: sha,
  start: BuildObservation,
  end: Schema.NullOr(BuildObservation),
});
export type BuildCaptureProof = typeof BuildCaptureProof.Type;
