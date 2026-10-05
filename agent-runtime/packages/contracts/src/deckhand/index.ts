import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString, ThreadId } from "../baseSchemas.ts";

const identifier = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
export const EnvironmentId = identifier.pipe(Schema.brand("deckhand/EnvironmentId"));
export const WorkspaceBindingId = identifier.pipe(Schema.brand("deckhand/WorkspaceBindingId"));
export const CheckoutBindingId = identifier.pipe(Schema.brand("deckhand/CheckoutBindingId"));
export const FeatureId = identifier.pipe(Schema.brand("deckhand/FeatureId"));
export const SessionBindingId = identifier.pipe(Schema.brand("deckhand/SessionBindingId"));
export const BackendKind = Schema.Literals(["standalone", "cinderdeck"]);
export const ConnectionState = Schema.Literals([
  "connected",
  "reconnecting",
  "unavailable",
  "stale",
]);
export const ExecutionState = Schema.Literals([
  "queued",
  "starting",
  "working",
  "waiting_input",
  "waiting_approval",
  "idle",
  "finished_turn",
  "interrupted",
  "failed",
  "unknown",
]);
export const ProviderCapabilities = Schema.Struct({
  nativeResume: Schema.Boolean,
  interrupt: Schema.Boolean,
  steering: Schema.Boolean,
  approvals: Schema.Boolean,
  questions: Schema.Boolean,
  enforcedReadOnly: Schema.Boolean,
  imageInput: Schema.Boolean,
  videoInput: Schema.Boolean,
  managed: Schema.Boolean,
});
export const PhysicalCheckout = Schema.Struct({
  physicalId: identifier,
  repositoryPhysicalId: identifier,
  root: TrimmedNonEmptyString,
  commonDirectory: TrimmedNonEmptyString,
  gitDirectory: TrimmedNonEmptyString,
  branch: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(Schema.String),
  // All remotes are retained: origin may be a fork while upstream is the PR base.
  remotes: Schema.Array(Schema.Struct({ name: identifier, canonicalKey: identifier })),
});
export type PhysicalCheckout = typeof PhysicalCheckout.Type;
export const WorkspaceBinding = Schema.Struct({
  id: WorkspaceBindingId,
  environmentId: EnvironmentId,
  backend: BackendKind,
  ownerId: identifier,
  generation: PositiveInt,
  revision: PositiveInt,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  state: Schema.Literals(["active", "missing", "released"]),
});
export type WorkspaceBinding = typeof WorkspaceBinding.Type;
export const CheckoutBinding = Schema.Struct({
  id: CheckoutBindingId,
  workspaceId: WorkspaceBindingId,
  workspaceGeneration: PositiveInt,
  nativeGeneration: Schema.optionalKey(PositiveInt),
  environmentId: EnvironmentId,
  backend: BackendKind,
  kind: Schema.Literals(["primary", "lane"]),
  laneId: Schema.NullOr(identifier),
  state: Schema.Literals(["creating", "ready", "unavailable", "releasing", "released"]),
  repositories: Schema.Array(PhysicalCheckout),
  revision: PositiveInt,
});
export type CheckoutBinding = typeof CheckoutBinding.Type;
export const Feature = Schema.Struct({
  id: FeatureId,
  workspaceId: WorkspaceBindingId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  objective: Schema.Union([
    TrimmedNonEmptyString.check(Schema.isMaxLength(16000)),
    Schema.Literal(""),
  ]),
  status: Schema.Literals(["active", "completed", "archived"]),
  revision: PositiveInt,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Feature = typeof Feature.Type;
export const SessionBinding = Schema.Struct({
  id: SessionBindingId,
  threadId: ThreadId,
  providerSessionId: Schema.NullOr(identifier),
  providerInstanceId: identifier,
  featureId: FeatureId,
  checkoutId: CheckoutBindingId,
  // Absent on pre-v4 history. Such a session must be deliberately rebound
  // before launch; a multi-repository checkout never supplies an implicit cwd.
  repositoryScope: Schema.optionalKey(Schema.Array(identifier).check(Schema.isMaxLength(64))),
  role: Schema.Literals(["writer", "reviewer", "observer"]),
  desiredAccess: Schema.Literals(["write", "read_only", "isolated"]),
  execution: ExecutionState,
  connection: ConnectionState,
  capabilities: ProviderCapabilities,
  lastSequence: NonNegativeInt,
});
export type SessionBinding = typeof SessionBinding.Type;
