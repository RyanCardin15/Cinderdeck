import { assert, describe, it } from "@effect/vitest";
import * as Bindings from "@t3tools/contracts/deckhand";
import * as C from "@t3tools/contracts/deckhand/recordingsRpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Relationships from "./Relationships.ts";
import * as Transport from "./RecordingTransport.ts";
import * as PreviewCapture from "./PreviewCapture.ts";
const session = Schema.decodeUnknownSync(Bindings.SessionBinding)({
  id: "session",
  threadId: "thread",
  providerSessionId: null,
  providerInstanceId: "codex",
  featureId: "feature",
  checkoutId: "checkout",
  role: "writer",
  desiredAccess: "write",
  execution: "idle",
  connection: "connected",
  lastSequence: 1,
  capabilities: {
    nativeResume: true,
    interrupt: true,
    steering: true,
    approvals: true,
    questions: true,
    enforcedReadOnly: false,
    imageInput: true,
    videoInput: false,
    managed: true,
  },
});
const checkout = Schema.decodeUnknownSync(Bindings.CheckoutBinding)({
  id: "checkout",
  workspaceId: "workspace",
  workspaceGeneration: 1,
  nativeGeneration: 2,
  environmentId: "install",
  backend: "cinderdeck",
  kind: "lane",
  laneId: "lane",
  state: "ready",
  repositories: [],
  revision: 1,
});
const workspace = Schema.decodeUnknownSync(Bindings.WorkspaceBinding)({
  id: "workspace",
  environmentId: "install",
  backend: "cinderdeck",
  ownerId: "primary",
  generation: 1,
  revision: 1,
  name: "Test workspace",
  state: "active",
});
const feature = Schema.decodeUnknownSync(Bindings.Feature)({
  id: "feature",
  workspaceId: "workspace",
  title: "Preview verification",
  objective: "Verify",
  status: "active",
  revision: 1,
  createdAt: "now",
  updatedAt: "now",
});
const input: C.PreviewImportBegin = {
  installationID: "install",
  workspaceID: "lane",
  generation: 2,
  operationKey: "durable-key",
  sessionID: "session",
  tabID: "tab",
  title: "Preview verification",
  targetURL: "http://localhost:4000",
  clientMonotonicMs: 200,
  capturedWorkspaceIDs: [],
};
const receipt: C.PreviewImportReceipt = {
  operationKey: "durable-key",
  recordingID: "recording",
  token: "token",
  state: "capturing",
  receivedBytes: 0,
  hostStartedAt: "2026-10-03T20:00:00Z",
  clockQuality: "unknown",
  detail: null,
  sha256: null,
  duration: null,
};
const layer = (request: Transport.RecordingTransport["Service"]["request"]) =>
  PreviewCapture.layer.pipe(
    Layer.provide(Layer.mock(Transport.RecordingTransport)({ request })),
    Layer.provide(
      Layer.mock(Relationships.Relationships)({
        session: () => Effect.succeed(session),
        checkout: () => Effect.succeed(checkout),
        workspace: () => Effect.succeed(workspace),
        feature: () => Effect.succeed(feature),
      }),
    ),
  );
describe("preview capture binding and receipt authority", () => {
  it.effect(
    "uses stored session feature and checkout while preserving exact source identity and logs-off scope",
    () => {
      const calls: unknown[] = [];
      return Effect.gen(function* () {
        const service = yield* PreviewCapture.PreviewCapture;
        assert.deepEqual(yield* service.begin("actor", input), receipt);
        assert.deepEqual(calls, [
          {
            actor: "actor",
            method: "integration.recording.import.begin",
            params: { ...input, featureID: "feature", checkoutID: "checkout" },
          },
        ]);
      }).pipe(
        Effect.provide(
          layer((actor, method, params) =>
            Effect.sync(() => {
              calls.push({ actor, method, params });
              return receipt;
            }),
          ),
        ),
      );
    },
  );
  it.effect(
    "refuses changed installation, workspace and native generation before native capture",
    () => {
      let calls = 0;
      return Effect.gen(function* () {
        const service = yield* PreviewCapture.PreviewCapture;
        for (const changed of [
          { ...input, installationID: "another" },
          { ...input, workspaceID: "primary" },
          { ...input, generation: 3 },
        ]) {
          const error = yield* service.begin("actor", changed).pipe(Effect.flip);
          assert.equal(error.reason, "stale_context");
        }
        assert.equal(calls, 0);
      }).pipe(
        Effect.provide(
          layer(() =>
            Effect.sync(() => {
              calls++;
              return receipt;
            }),
          ),
        ),
      );
    },
  );
  it.effect("rejects malformed success receipts instead of manufacturing ready video", () =>
    Effect.gen(function* () {
      const service = yield* PreviewCapture.PreviewCapture;
      const error = yield* service
        .finish("actor", {
          installationID: "install",
          workspaceID: "lane",
          generation: 2,
          operationKey: "durable-key",
          token: "token",
        })
        .pipe(Effect.flip);
      assert.equal(error.reason, "invalid_response");
    }).pipe(Effect.provide(layer(() => Effect.succeed({ state: "ready" })))),
  );
});
