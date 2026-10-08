import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { CodexAppServerReplayEntry, normalizeReplayFrame, stableStringify } from "./replay.ts";

const InitializeFrame = Schema.Struct({
  id: Schema.Number,
  method: Schema.Literal("initialize"),
  params: Schema.Struct({
    capabilities: Schema.Record(Schema.String, Schema.Unknown),
    clientInfo: Schema.Struct({
      name: Schema.String,
      title: Schema.String,
      version: Schema.String,
    }),
  }),
});
const readRecording = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const transcript = yield* fs.readFileString(
    path.join(
      import.meta.dirname,
      "../../../apps/server/src/orchestration-v2/testkit/fixtures/proposed_plan/codex_transcript.ndjson",
    ),
  );
  const entries = transcript
    .split("\n")
    .filter(Boolean)
    .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(line));
  const initialize = entries
    .filter(Schema.is(CodexAppServerReplayEntry))
    .find((entry) => entry.type === "expect_outbound" && entry.label === "initialize");
  if (!initialize || initialize.type !== "expect_outbound")
    throw new Error("Missing recorded initialize frame");
  return yield* Schema.decodeUnknownEffect(InitializeFrame)(initialize.frame);
});
const comparable = (frame: unknown) => stableStringify(normalizeReplayFrame(frame));
const ownedFrame = (recorded: typeof InitializeFrame.Type) => ({
  ...recorded,
  params: {
    ...recorded.params,
    clientInfo: { name: "Cinderdeck", title: "Cinderdeck", version: "0.1.0-alpha.1" },
  },
});

it.layer(NodeServices.layer)("original recording client identity compatibility", (it) => {
  it.effect("accepts the owned client while preserving the original recording", () =>
    Effect.gen(function* () {
      const recorded = yield* readRecording;
      const original = stableStringify(recorded);
      assert.equal(comparable(recorded), comparable(ownedFrame(recorded)));
      assert.equal(stableStringify(recorded), original);
    }),
  );
  it.effect("still rejects other clients, titles, capabilities, and request IDs", () =>
    Effect.gen(function* () {
      const recorded = yield* readRecording;
      const owned = ownedFrame(recorded);
      for (const frame of [
        { ...owned, id: 999 },
        { ...owned, params: { ...owned.params, capabilities: { experimentalApi: false } } },
        {
          ...owned,
          params: {
            ...owned.params,
            clientInfo: { ...owned.params.clientInfo, name: "Other client" },
          },
        },
        {
          ...owned,
          params: {
            ...owned.params,
            clientInfo: { ...owned.params.clientInfo, title: "Other title" },
          },
        },
      ])
        assert.notEqual(comparable(frame), comparable(recorded));
    }),
  );
  it.effect("leaves client metadata on non-initialize requests untouched", () =>
    Effect.gen(function* () {
      const recorded = yield* readRecording;
      const frame = { ...recorded, method: "thread/start" };
      assert.deepEqual(normalizeReplayFrame(frame), frame);
    }),
  );
});
