import * as Schema from "effect/Schema";
import { PositiveInt, NonNegativeInt } from "../baseSchemas.ts";
export const SourceFingerprint = Schema.Struct({
  schemaVersion: PositiveInt,
  hash: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  state: Schema.Literals(["complete", "truncated", "unknown"]),
  trackedCount: NonNegativeInt,
  untrackedCount: NonNegativeInt,
  omittedCount: NonNegativeInt,
  detail: Schema.NullOr(Schema.String),
});
export type SourceFingerprint = typeof SourceFingerprint.Type;
