import * as Schema from "effect/Schema";
import { PositiveInt, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ConnectionState, ExecutionState } from "./index.ts";
const identifier = TrimmedNonEmptyString.check(
  Schema.isMaxLength(160),
  Schema.makeFilter((value: string) =>
    Array.from(value).every(
      (character) =>
        character.codePointAt(0)! >= 32 &&
        (character.codePointAt(0)! < 127 || character.codePointAt(0)! > 159),
    ),
  ),
);
export const LINKED_WORK_METHODS = {
  publish: "deckhand.linked-work.publish",
  resolve: "deckhand.linked-work.resolve",
} as const;
export const LinkedWorkTarget = Schema.Struct({
  installation: identifier,
  workspace: identifier,
  generation: PositiveInt,
  session: identifier,
  thread: ThreadId,
  environment: identifier,
});
export type LinkedWorkTarget = typeof LinkedWorkTarget.Type;
export const LinkedWorkPublishInput = Schema.Struct({ threadId: ThreadId });
export type LinkedWorkPublishInput = typeof LinkedWorkPublishInput.Type;
export const LinkedWorkResolution = Schema.Struct({
  target: LinkedWorkTarget,
  nativeAvailable: Schema.Boolean,
});
export type LinkedWorkResolution = typeof LinkedWorkResolution.Type;
export const LinkedWorkPublication = Schema.Struct({
  installationID: identifier,
  executionHostID: identifier,
  environmentID: identifier,
  workspaceID: identifier,
  generation: PositiveInt,
  sessionID: identifier,
  featureID: identifier,
  checkoutID: identifier,
  threadID: ThreadId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  provider: identifier,
  role: Schema.Literals(["writer", "reviewer", "observer"]),
  execution: ExecutionState,
  connection: ConnectionState,
  sourceSequence: NonNegativeInt,
  repositories: Schema.Array(
    Schema.Struct({
      repositoryID: identifier,
      head: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/))),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  pullRequests: Schema.Array(
    Schema.Struct({
      url: Schema.String.check(Schema.isMaxLength(1024)),
      host: identifier,
      repository: Schema.String.check(Schema.isMaxLength(320)),
      number: PositiveInt,
    }),
  ).check(Schema.isMaxLength(50)),
  recordingIDs: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/i))).check(
    Schema.isMaxLength(50),
  ),
});
export type LinkedWorkPublication = typeof LinkedWorkPublication.Type;
export const LinkedWorkRecord = Schema.Struct({
  publication: LinkedWorkPublication,
  actorKey: Schema.String,
  observedAt: Schema.String,
  runtimeEpoch: identifier,
});
export type LinkedWorkRecord = typeof LinkedWorkRecord.Type;
export class LinkedWorkError extends Schema.TaggedError<LinkedWorkError>()("LinkedWorkError", {
  reason: Schema.Literals([
    "missing",
    "wrong_context",
    "wrong_actor",
    "unavailable",
    "storage",
    "invalid_response",
  ]),
}) {
  override get message() {
    return this.reason === "missing"
      ? "This linked conversation is no longer available."
      : this.reason === "wrong_context"
        ? "This link belongs to another environment or installation."
        : "Linked work could not be refreshed. Saved history remains available.";
  }
}
const isLinkedWorkTarget = Schema.is(LinkedWorkTarget);
const targetKeys = [
  "installation",
  "workspace",
  "generation",
  "session",
  "thread",
  "environment",
] as const;
/** Navigation-only links carry opaque IDs. They never carry a path or a command. */
export function parseLinkedWorkURL(value: string, development: boolean): LinkedWorkTarget | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== (development ? "deckhand-dev:" : "deckhand:") ||
      url.host !== "app" ||
      url.pathname !== "/linked-work" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    )
      return null;
    const keys = [...url.searchParams.keys()];
    if (
      keys.length !== targetKeys.length ||
      new Set(keys).size !== targetKeys.length ||
      keys.some((key) => !targetKeys.includes(key as (typeof targetKeys)[number]))
    )
      return null;
    const generation = url.searchParams.get("generation")!;
    if (!/^[1-9][0-9]{0,8}$/.test(generation)) return null;
    const target = Object.fromEntries(
      targetKeys.map((key) => [
        key,
        key === "generation" ? Number(generation) : url.searchParams.get(key),
      ]),
    );
    return isLinkedWorkTarget(target) ? target : null;
  } catch {
    return null;
  }
}
export function linkedWorkDesktopURL(target: LinkedWorkTarget, development: boolean): string {
  const url = new URL(`${development ? "deckhand-dev" : "deckhand"}://app/linked-work`);
  for (const key of targetKeys) url.searchParams.set(key, String(target[key]));
  return url.href;
}
