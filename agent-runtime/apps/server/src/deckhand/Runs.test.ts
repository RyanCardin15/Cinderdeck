import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Recording from "@cinderdeck/contracts/deckhand/recordingsRpc";
import * as C from "@cinderdeck/contracts/deckhand/runsRpc";
import * as RecordingTransport from "./RecordingTransport.ts";
import * as Runs from "./Runs.ts";
const context: C.RunContext = {
  installationID: "fixture-installation",
  workspaceID: "fixture-lane",
  generation: 3,
};
const overview: C.RunsOverview = {
  revision: "r1",
  storageError: null,
  retainedRunCount: 1,
  runsTruncated: false,
  services: [
    {
      id: "api",
      phase: "starting",
      status: "Waiting for readiness",
      ready: false,
      detail: null,
      port: 43000,
      command: "node api.js",
      directory: "/fixture/api",
      dependencies: ["db"],
      sharedFrom: null,
    },
  ],
  tasks: [],
  workflows: [],
  runs: [
    {
      id: "failed-run",
      workspaceID: context.workspaceID,
      name: "Verify",
      definitionID: "verify",
      kind: "task",
      status: "failed",
      actor: "Cinderdeck",
      createdAt: "2026-10-04T00:00:00Z",
      finishedAt: "2026-10-04T00:00:01Z",
      duration: 1,
      detail: "Command exited 17",
      cancelAllowed: false,
      steps: [
        {
          id: "step",
          reference: "task:verify",
          title: "Verify",
          status: "failed",
          command: "node verify.js",
          directory: "/fixture/api",
          exitCode: 17,
          detail: "Command exited 17",
        },
      ],
    },
  ],
};
const provide = (request: RecordingTransport.RecordingTransport["Service"]["request"]) =>
  Runs.layer.pipe(
    Layer.provide(
      Layer.succeed(
        RecordingTransport.RecordingTransport,
        RecordingTransport.RecordingTransport.of({ request }),
      ),
    ),
  );
describe("Services and Runs owner projection", () => {
  it.effect(
    "preserves native readiness and failed finite exit status without turning submission into completion",
    () =>
      Effect.gen(function* () {
        const runs = yield* Runs.Runs;
        const value = yield* runs.list("actor", context);
        assert.isFalse(value.services[0]!.ready);
        assert.strictEqual(value.services[0]!.phase, "starting");
        assert.strictEqual(value.runs[0]!.status, "failed");
        assert.strictEqual(value.runs[0]!.steps[0]!.exitCode, 17);
      }).pipe(Effect.provide(provide(() => Effect.succeed(overview)))),
  );
  it.effect(
    "rejects invalid or oversized native run summaries rather than publishing invented states",
    () =>
      Effect.gen(function* () {
        const runs = yield* Runs.Runs;
        const error = yield* runs.list("actor", context).pipe(Effect.flip);
        assert.strictEqual(error.reason, "invalid_response");
      }).pipe(
        Effect.provide(
          provide(() =>
            Effect.succeed({ ...overview, runs: [{ ...overview.runs[0], status: "completed" }] }),
          ),
        ),
      ),
  );
  it.effect(
    "preserves a scoped refusal on log retrieval and exposes validated definition issues",
    () =>
      Effect.gen(function* () {
        const runs = yield* Runs.Runs;
        const error = yield* runs
          .logs("actor", { ...context, runID: "other-workspace-run" })
          .pipe(Effect.flip);
        assert.strictEqual(error.reason, "refused");
        assert.strictEqual(error.code, "not_found");
        const validation = yield* runs.validate("actor", { ...context, source: "broken TOML" });
        assert.isFalse(validation.valid);
        assert.deepStrictEqual(validation.issues, ["error: invalid TOML"]);
      }).pipe(
        Effect.provide(
          provide((_actor, method) =>
            method === "integration.runs.logs"
              ? Effect.fail(new Recording.RecordingError({ reason: "refused", code: "not_found" }))
              : Effect.succeed({ valid: false, issues: ["error: invalid TOML"] }),
          ),
        ),
      ),
  );
  it.effect("loads exact historical details independently of a truncated compact list", () =>
    Effect.gen(function* () {
      const runs = yield* Runs.Runs;
      const list = yield* runs.list("actor", context);
      assert.isTrue(list.runsTruncated);
      assert.strictEqual(list.retainedRunCount, 27);
      assert.deepStrictEqual(list.runs, []);
      const detail = yield* runs.get("actor", {
        ...context,
        runID: "failed-run",
        stepOffset: 16,
        stepLimit: 16,
      });
      assert.strictEqual(detail.run.id, "failed-run");
      assert.strictEqual(detail.run.steps[0]!.exitCode, 17);
      assert.strictEqual(detail.totalSteps, 42);
      assert.strictEqual(detail.nextStepOffset, 17);
    }).pipe(
      Effect.provide(
        provide((_actor, method, input) => {
          if (method === "integration.runs.list")
            return Effect.succeed({
              ...overview,
              runs: [],
              retainedRunCount: 27,
              runsTruncated: true,
            });
          assert.strictEqual(method, "integration.runs.get");
          assert.strictEqual((input as C.RunGetInput).runID, "failed-run");
          assert.strictEqual((input as C.RunGetInput).stepOffset, 16);
          return Effect.succeed({ run: overview.runs[0], totalSteps: 42, nextStepOffset: 17 });
        }),
      ),
    ),
  );
  it.effect(
    "preserves explicit source-owned resolution proofs and omission without synthesizing resolution",
    () =>
      Effect.gen(function* () {
        const runs = yield* Runs.Runs;
        const inventory = yield* runs.failures("actor", context);
        assert.isTrue(inventory.runsTruncated);
        assert.deepStrictEqual(inventory.runs, []);
        assert.deepStrictEqual(inventory.resolutions, [
          {
            runID: "failed-run",
            causeVersion: "exact-outcome",
            resolvedByRunID: "successful-rerun",
            observedAt: "2026-10-04T00:01:00Z",
          },
        ]);
      }).pipe(
        Effect.provide(
          provide((_actor, method, input) => {
            assert.strictEqual(method, "integration.runs.failures");
            assert.deepStrictEqual(input, context);
            return Effect.succeed({
              revision: "r2",
              storageError: null,
              retainedRunCount: 27,
              runsTruncated: true,
              runs: [],
              resolutions: [
                {
                  runID: "failed-run",
                  causeVersion: "exact-outcome",
                  resolvedByRunID: "successful-rerun",
                  observedAt: "2026-10-04T00:01:00Z",
                },
              ],
            });
          }),
        ),
      ),
  );
  it.effect("decodes legacy history without inventing a retained total or detail capability", () =>
    Effect.gen(function* () {
      const runs = yield* Runs.Runs;
      const value = yield* runs.list("actor", context);
      assert.strictEqual(value.retainedRunCount, undefined);
      assert.strictEqual(value.runsTruncated, undefined);
      assert.strictEqual(value.detailAvailable, undefined);
      assert.strictEqual(value.runs[0]!.steps[0]!.exitCode, 17);
    }).pipe(
      Effect.provide(
        provide(() => {
          const { retainedRunCount: _count, runsTruncated: _truncated, ...legacy } = overview;
          return Effect.succeed(legacy);
        }),
      ),
    ),
  );
});
