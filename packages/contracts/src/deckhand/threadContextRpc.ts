import * as Schema from "effect/Schema";
import { ThreadId } from "../baseSchemas.ts";
import { CheckoutBinding, Feature, SessionBinding, WorkspaceBinding } from "./index.ts";
import { IntegrationSnapshot } from "./integration.ts";

export const THREAD_CONTEXT_METHOD = "deckhand.thread.context.subscribe";
export const ThreadContextInput = Schema.Struct({ threadId: ThreadId });
export type ThreadContextInput = typeof ThreadContextInput.Type;
export const ThreadContextView = Schema.Struct({
  workspace: WorkspaceBinding,
  checkout: CheckoutBinding,
  feature: Feature,
  session: SessionBinding,
  native: Schema.NullOr(IntegrationSnapshot.fields.resources.value),
  nativeConnection: Schema.String,
  nativeChannel: Schema.optionalKey(Schema.Literals(["development", "release"])),
  sessions: Schema.Array(
    Schema.Struct({
      binding: SessionBinding,
      title: Schema.String,
      source: Schema.Literals(["current", "unavailable"]),
      archived: Schema.Boolean,
    }),
  ),
});
export type ThreadContextView = typeof ThreadContextView.Type;
