import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as C from "@t3tools/contracts/deckhand/builds";
import * as Recording from "@t3tools/contracts/deckhand/recordingsRpc";
import * as Builds from "./Builds.ts";
import * as RecordingTransport from "./RecordingTransport.ts";
const sha = "a".repeat(64);
const context = { installationID: "installation", workspaceID: "lane", generation: 3 };
const input: C.BuildPrepareInput = {
  ...context,
  operationKey: "immutable-prepare",
  serviceID: "web",
  expectedDefinitionHash: sha,
  expectedWorkflowHash: sha,
  expectedRepositories: [
    {
      repositoryID: "app",
      checkoutPhysicalID: sha,
      repositoryPhysicalID: sha,
      canonicalRepositoryKeys: ["github.com/fixture/app"],
      head: "head",
    },
  ],
  requiredTaskIDs: ["verify"],
};
const receipt: C.BuildReceipt = {
  id: "saved-receipt",
  request: input,
  adapter: {
    serviceID: "web",
    buildTaskID: "build",
    requiredTaskIDs: ["verify"],
    artifactName: "web.js",
    stampPath: "/stamp",
    servedArtifactPath: "/artifact",
  },
  state: "unknown",
  createdAt: "2026-10-04T00:00:00Z",
  updatedAt: "2026-10-04T00:00:00Z",
  detail: "Inspect before cancel; launch outcome unknown",
  buildRunID: "real-build-run",
  definitionHash: sha,
  workflowHash: sha,
  repositoriesAtStart: [],
  repositoriesAtEnd: [],
  artifact: { name: "web.js", sha256: sha, size: 42 },
  launch: null,
  checks: [
    {
      taskID: "verify",
      runID: "actual-check",
      status: "succeeded",
      finishedAt: "2026-10-04T00:00:00Z",
      outcomeHash: sha,
      buildMatched: false,
    },
  ],
  observations: [],
  operations: [
    { operationKey: "immutable-prepare", action: "prepare", state: "accepted" },
    { operationKey: "original-launch", action: "launch", state: "unknown" },
  ],
  reservationState: "uncertain",
};
const provide = (request: RecordingTransport.RecordingTransport["Service"]["request"]) =>
  Builds.layer.pipe(
    Layer.provide(
      Layer.succeed(
        RecordingTransport.RecordingTransport,
        RecordingTransport.RecordingTransport.of({ request }),
      ),
    ),
  );
describe("Declared build receipts", () => {
  it.effect("forwards actor and immutable request without turning admission into success", () => {
    const app = Effect.gen(function* () {
      const service = yield* Builds.Builds;
      const value = yield* service.prepare("owner", input);
      assert.strictEqual(value.state, "unknown");
      assert.strictEqual(value.reservationState, "uncertain");
      assert.strictEqual(value.checks[0]!.buildMatched, false);
      assert.strictEqual(value.operations[1]!.state, "unknown");
    });
    return app.pipe(
      Effect.provide(
        provide((actor, method, params) => {
          assert.strictEqual(actor, "owner");
          assert.strictEqual(method, "integration.build.prepare");
          assert.deepStrictEqual(params, input);
          return Effect.succeed(receipt);
        }),
      ),
    );
  });
  it.effect(
    "recovers lost prepare replies by the original key and retains unknown outcomes",
    () => {
      const app = Effect.gen(function* () {
        const service = yield* Builds.Builds;
        const value = yield* service.get("owner", {
          ...context,
          operationKey: "immutable-prepare",
        });
        assert.strictEqual(value.id, receipt.id);
        assert.isNull(value.launch);
        assert.strictEqual(value.operations[1]!.operationKey, "original-launch");
      });
      return app.pipe(
        Effect.provide(
          provide((_actor, method, params) => {
            assert.strictEqual(method, "integration.build.get");
            assert.deepStrictEqual(params, { ...context, operationKey: "immutable-prepare" });
            return Effect.succeed(receipt);
          }),
        ),
      );
    },
  );
  it.effect("rejects malformed process proof rather than manufacturing a launch", () => {
    const app = Effect.gen(function* () {
      const service = yield* Builds.Builds;
      const error = yield* service
        .get("owner", { ...context, receiptID: receipt.id })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "invalid_response");
    });
    return app.pipe(
      Effect.provide(
        provide(() =>
          Effect.succeed({
            ...receipt,
            launch: {
              process: { pid: -1, pgid: 12, startTime: 1 },
              nonceHash: sha,
              startedAt: "now",
            },
          }),
        ),
      ),
    );
  });
  it.effect("preserves native capability refusal without replaying a launch", () => {
    const app = Effect.gen(function* () {
      const service = yield* Builds.Builds;
      const error = yield* service
        .launch("owner", { ...context, receiptID: receipt.id, operationKey: "original-launch" })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "refused");
      assert.strictEqual(error.code, "unsupported_capability");
    });
    return app.pipe(
      Effect.provide(
        provide(() =>
          Effect.fail(
            new Recording.RecordingError({ reason: "refused", code: "unsupported_capability" }),
          ),
        ),
      ),
    );
  });
});
