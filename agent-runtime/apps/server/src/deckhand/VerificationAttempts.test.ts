import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@cinderdeck/shared/nodeSqliteClient";
// @effect-diagnostics nodeBuiltinImport:off - deterministic native operation identity fixtures.
import * as NodeCrypto from "node:crypto";
import * as C from "@cinderdeck/contracts/deckhand/verificationAttemptsRpc";
import type * as B from "@cinderdeck/contracts/deckhand/builds";
import type * as R from "@cinderdeck/contracts/deckhand/recordingsRpc";
import * as Attempts from "./VerificationAttempts.ts";
import * as OwnedPreviewAttestations from "./OwnedPreviewAttestations.ts";
import * as Builds from "./Builds.ts";
import * as Verification from "./Verification.ts";
import * as Recordings from "./Recordings.ts";
import * as Relationships from "./Relationships.ts";
import * as CurrentCheckout from "./CurrentCheckout.ts";
import * as D from "@cinderdeck/contracts/deckhand";
import * as Backend from "./WorkspaceBackend.ts";
import * as Identity from "./CheckoutIdentity.ts";
import * as Runner from "../processRunner.ts";
const sha = "a".repeat(64),
  head = "b".repeat(40),
  time = "2026-10-03T10:00:00Z";
const key = (phase: string) =>
  `verification:${NodeCrypto.createHash("sha256").update(`attempt:${phase}`).digest("hex")}`;
const context = { installationID: "native", workspaceID: "lane", generation: 3 };
const snapshot = {
  repositoryID: "repo",
  canonicalRepositoryKeys: ["github.com/cardin/app"],
  checkoutPhysicalID: sha,
  repositoryPhysicalID: "c".repeat(64),
  head,
  capturedAt: time,
  fingerprint: {
    schemaVersion: 1,
    hash: sha,
    state: "complete" as const,
    trackedCount: 0,
    untrackedCount: 0,
    omittedCount: 0,
    detail: null,
  },
  complete: true,
};
const preview = Schema.decodeUnknownSync(C.AttemptPreview)({
  reference: { projectId: "project", host: "github.com", repository: "cardin/app", number: 7 },
  featureID: "feature",
  checkoutID: "checkout",
  serviceID: "web",
  context,
  head,
  repositoryKeys: ["github.com/cardin/app"],
  observedAt: time,
  descriptor: {
    adapter: {
      serviceID: "web",
      buildTaskID: "build",
      requiredTaskIDs: ["test"],
      artifactName: "app.js",
      stampPath: "/.build-stamp",
      servedArtifactPath: "/app.js",
    },
    definitionHash: sha,
    workflowHash: sha,
    repositories: [snapshot],
    detail: null,
  },
  repositories: [
    {
      repositoryID: snapshot.repositoryID,
      canonicalRepositoryKeys: snapshot.canonicalRepositoryKeys,
      checkoutPhysicalID: sha,
      repositoryPhysicalID: snapshot.repositoryPhysicalID,
      head,
    },
  ],
});
const receipt = (): B.BuildReceipt => ({
  id: "receipt",
  request: {
    ...context,
    operationKey: key("prepare"),
    serviceID: "web",
    expectedDefinitionHash: sha,
    expectedWorkflowHash: sha,
    expectedRepositories: preview.repositories,
    requiredTaskIDs: ["test"],
  },
  adapter: preview.descriptor.adapter,
  state: "running",
  createdAt: time,
  updatedAt: time,
  detail: null,
  buildRunID: "run-build",
  definitionHash: sha,
  workflowHash: sha,
  repositoriesAtStart: [snapshot],
  repositoriesAtEnd: [snapshot],
  artifact: { name: "app.js", sha256: sha, size: 30 },
  launch: { process: { pid: 123, pgid: 123, startTime: 1 }, nonceHash: sha, startedAt: time },
  checks: [
    {
      taskID: "test",
      runID: "run-test",
      status: "succeeded",
      buildMatched: true,
      finishedAt: time,
      outcomeHash: sha,
    },
  ],
  observations: [],
  operations: [
    { operationKey: key("prepare"), action: "prepare", state: "accepted" },
    { operationKey: key("launch"), action: "launch", state: "accepted" },
    { operationKey: key("checks"), action: "checks", state: "accepted" },
  ],
  reservationState: "held",
});
const observation = (phase: "start" | "end"): B.BuildObservation => ({
  receiptID: "receipt",
  workspaceID: "lane",
  serviceID: "web",
  phase,
  state: "matched",
  observedAt: time,
  artifactSHA256: sha,
  servedArtifactSHA256: sha,
  sourceUnchanged: true,
  processMatched: true,
  stampMatched: true,
  detail: null,
});
const recording = (): R.Recording => ({
  id: "recording",
  title: "Pinned review",
  state: "ready",
  createdAt: time,
  duration: 3,
  actor: "alice",
  capture: "window",
  primaryWorkspaceID: "lane",
  capturedWorkspaceIDs: ["lane"],
  capturedWorkspaceNames: ["Lane"],
  lineCount: 0,
  errorCount: 0,
  warningCount: 0,
  playable: true,
  paused: false,
  controlAllowed: false,
  detail: null,
  checkOutcome: "unverified",
  markers: [],
  repositories: [
    {
      workspaceID: "lane",
      repositoryID: "repo",
      branch: "review",
      head,
      changedFiles: 0,
      canonicalRepositoryKeys: snapshot.canonicalRepositoryKeys,
      repositoryPhysicalId: snapshot.repositoryPhysicalID,
      snapshotComplete: true,
      endHead: head,
      sourceFingerprint: snapshot.fingerprint,
      endSourceFingerprint: snapshot.fingerprint,
    },
  ],
  buildProof: {
    receiptID: "receipt",
    artifactSHA256: sha,
    launchNonceHash: sha,
    start: observation("start"),
    end: observation("end"),
  },
});
const attempt = (
  pending: C.VerificationAttempt["pendingAction"] = null,
): C.VerificationAttempt => ({
  operationKey: "attempt",
  preview,
  createdAt: time,
  updatedAt: time,
  phase: pending ? "unknown" : "ready",
  pendingAction: pending,
  receipt: receipt(),
  recordingID: null,
  recordingProof: null,
  proofHash: null,
  verdict: "incomplete",
  detail: "Saved",
  currentHead: head,
});
const encodePreview = Schema.encodeEffect(Schema.fromJsonString(C.AttemptPreview));
const encodeAttempt = Schema.encodeEffect(Schema.fromJsonString(C.VerificationAttempt));
const seed = (value: C.VerificationAttempt) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const original = yield* encodePreview(preview);
    const encoded = yield* encodeAttempt(value);
    yield* sql`INSERT INTO deckhand_verification_attempts(operation_key,actor_id,pr_key,original_json,record_json) VALUES('attempt','alice','pr',${original},${encoded})`;
  });
const currentBinding = Schema.decodeUnknownSync(D.CheckoutBinding)({
  id: "checkout",
  workspaceId: "workspace",
  environmentId: "native",
  backend: "cinderdeck",
  workspaceGeneration: 1,
  nativeGeneration: 3,
  revision: 1,
  kind: "lane",
  laneId: "lane",
  state: "ready",
  repositories: [
    {
      physicalId: sha,
      repositoryPhysicalId: "c".repeat(64),
      root: "/fixture",
      commonDirectory: "/fixture/.git",
      gitDirectory: "/fixture/.git",
      branch: "review",
      commit: head,
      remotes: [],
    },
  ],
});
const currentWorkspace = Schema.decodeUnknownSync(D.WorkspaceBinding)({
  id: "workspace",
  environmentId: "native",
  backend: "cinderdeck",
  ownerId: "base",
  generation: 1,
  revision: 1,
  name: "Fixture",
  state: "active",
});
const setup = (state: {
  receipt: B.BuildReceipt;
  head: string | null;
  writes: number;
  pendingOwnership?: boolean;
}) =>
  Attempts.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Builds.Builds)({
          get: () => Effect.sync(() => state.receipt),
          launch: () =>
            Effect.sync(() => {
              state.writes++;
              return state.receipt;
            }),
          runChecks: () =>
            Effect.sync(() => {
              state.writes++;
              return state.receipt;
            }),
          finish: (_actor, input) =>
            Effect.sync(() => {
              state.writes++;
              state.receipt = {
                ...state.receipt,
                state: input.cancel ? "cancelled" : "finalized",
                reservationState: "released",
                operations: [
                  ...state.receipt.operations,
                  { operationKey: input.operationKey, action: "finish", state: "accepted" },
                ],
              };
              return state.receipt;
            }),
        }),
        Layer.mock(Verification.Verification)({
          readHead: () =>
            Effect.sync(() => ({
              head: state.head,
              keys: preview.repositoryKeys,
              observedAt: time,
            })),
        }),
        Layer.mock(OwnedPreviewAttestations.OwnedPreviewAttestations)({
          get: () => Effect.succeed(null),
        }),
        Layer.mock(Recordings.Recordings)({ get: () => Effect.succeed(recording()) }),
        Layer.mock(CurrentCheckout.CurrentCheckout)({
          current: () =>
            state.pendingOwnership
              ? Effect.fail(new CurrentCheckout.CurrentCheckoutError({ reason: "pending" }))
              : Effect.succeed(currentBinding),
        }),
        Layer.mock(Relationships.Relationships)({
          workspace: () => Effect.succeed(currentWorkspace),
        }),
        Layer.mock(Backend.WorkspaceBackend)({}),
        Layer.mock(Identity.CheckoutIdentity)({}),
        Layer.mock(Runner.ProcessRunner)({}),
      ),
    ),
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  );
describe("Durable pinned verification attempts", () => {
  it.effect(
    "retains an uncertain launch and never repeats it when native recovery only reports the old receipt",
    () => {
      const state: {
        receipt: B.BuildReceipt;
        head: string | null;
        writes: number;
        pendingOwnership?: boolean;
      } = {
        receipt: {
          ...receipt(),
          operations: receipt().operations.filter((op) => op.action !== "launch"),
        },
        head,
        writes: 0,
      };
      return Effect.gen(function* () {
        const service = yield* Attempts.VerificationAttempts;
        yield* seed(attempt("launch"));
        const saved = yield* service.get("alice", { operationKey: "attempt" });
        assert.equal(saved.phase, "unknown");
        assert.equal(saved.pendingAction, "launch");
        const result = yield* service
          .advance("alice", { operationKey: "attempt", action: "launch" })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.equal(state.writes, 0);
        state.receipt = receipt();
        const recovered = yield* service.get("alice", { operationKey: "attempt" });
        assert.equal(recovered.pendingAction, null);
        yield* service.advance("alice", { operationKey: "attempt", action: "launch" });
        assert.equal(state.writes, 0);
      }).pipe(Effect.provide(setup(state)));
    },
  );
  it.effect(
    "blocks a new build phase during pending ownership while allowing exact original cleanup",
    () => {
      const state = { receipt: receipt(), head, writes: 0, pendingOwnership: true };
      return Effect.gen(function* () {
        const service = yield* Attempts.VerificationAttempts;
        yield* seed(attempt());
        assert.equal(
          (yield* service
            .advance("alice", { operationKey: "attempt", action: "checks" })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(state.writes, 0);
        const stopped = yield* service.advance("alice", {
          operationKey: "attempt",
          action: "cancel",
        });
        assert.equal(stopped.phase, "cancelled");
        assert.equal(state.writes, 1);
      }).pipe(Effect.provide(setup(state)));
    },
  );
  it.effect(
    "refuses a changed PR head before launch or check effects and conceals another actor's attempt",
    () => {
      const state = { receipt: receipt(), head: "d".repeat(40), writes: 0 };
      return Effect.gen(function* () {
        const service = yield* Attempts.VerificationAttempts;
        yield* seed(attempt());
        assert.equal(
          (yield* service.get("bob", { operationKey: "attempt" }).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          (yield* service
            .advance("alice", { operationKey: "attempt", action: "checks" })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(state.writes, 0);
      }).pipe(Effect.provide(setup(state)));
    },
  );
  it.effect(
    "persists immutable recording proof before native finalization and truthfully labels changed PR heads",
    () => {
      const state = { receipt: receipt(), head, writes: 0 };
      return Effect.gen(function* () {
        const service = yield* Attempts.VerificationAttempts;
        yield* seed(attempt());
        const finalized = yield* service.advance("alice", {
          operationKey: "attempt",
          action: "finalize",
          recordingID: "recording",
        });
        assert.equal(finalized.phase, "completed");
        assert.equal(finalized.verdict, "incomplete");
        assert.isTrue(finalized.buildAndChecksMatch);
        assert.isNotNull(finalized.proofHash);
        assert.equal(state.writes, 1);
        const sql = yield* SqlClient.SqlClient;
        assert.equal(
          (yield* sql`UPDATE deckhand_verification_attempts SET record_json=json_set(record_json,'$.recordingProof',NULL,'$.proofHash',NULL) WHERE operation_key='attempt'`.pipe(
            Effect.result,
          ))._tag,
          "Failure",
        );
        state.head = "d".repeat(40);
        const changed = yield* service.get("alice", { operationKey: "attempt" });
        assert.equal(changed.verdict, "earlier_revision");
        assert.deepEqual(changed.recordingProof, finalized.recordingProof);
        yield* service.advance("alice", {
          operationKey: "attempt",
          action: "finalize",
          recordingID: "other",
        });
        assert.equal(state.writes, 1);
      }).pipe(Effect.provide(setup(state)));
    },
  );
  it.effect(
    "rejects retargeted provider scope before native reads or effects and permits only deliberate new cancellation intent",
    () => {
      const state = { receipt: receipt(), head, writes: 0 };
      return Effect.gen(function* () {
        const service = yield* Attempts.VerificationAttempts;
        yield* seed({ ...attempt("cancel"), pendingNativeOperationKey: key("cancel") });
        const bound = { featureID: "feature", checkoutID: "different", context };
        assert.equal(
          (yield* service.get("alice", { operationKey: "attempt" }, bound).pipe(Effect.result))
            ._tag,
          "Failure",
        );
        assert.equal(
          (yield* service
            .advance("alice", { operationKey: "attempt", action: "cancel" }, bound)
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          (yield* service
            .advance("alice", { operationKey: "attempt", action: "cancel" })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(state.writes, 0);
        const cancelled = yield* service.advance("alice", {
          operationKey: "attempt",
          action: "cancel",
          cancellationKey: "manual-cleanup-2",
        });
        assert.equal(cancelled.phase, "cancelled");
        assert.equal(cancelled.receipt?.reservationState, "released");
        assert.equal(state.writes, 1);
      }).pipe(Effect.provide(setup(state)));
    },
  );
  it("pins the described service subset while refusing missing dependencies, unexpected repositories, and unrelated PR source", () => {
    const bound = {
      repositoryID: "repo",
      sourcePhysicalId: snapshot.checkoutPhysicalID,
      repositoryPhysicalId: snapshot.repositoryPhysicalID,
      commit: head,
    };
    const dependency = {
      ...snapshot,
      repositoryID: "api",
      canonicalRepositoryKeys: ["github.com/cardin/api"],
    };
    const source = [
      bound,
      { ...bound, repositoryID: "api" },
      { ...bound, repositoryID: "unrelated" },
    ];
    const current = { keys: preview.repositoryKeys, head };
    const descriptor = { ...preview.descriptor, repositories: [snapshot, dependency] };
    const selected = Attempts.pinBuildRepositories(descriptor, source, current);
    assert.isTrue("repositories" in selected);
    if ("repositories" in selected)
      assert.deepEqual(
        selected.repositories.map((repo) => repo.repositoryID),
        ["repo", "api"],
      );
    assert.deepEqual(Attempts.pinBuildRepositories(descriptor, [bound], current), {
      reason: "incomplete_source",
    });
    assert.deepEqual(
      Attempts.pinBuildRepositories(
        { ...descriptor, repositories: [snapshot, { ...dependency, repositoryID: "unexpected" }] },
        source,
        current,
      ),
      { reason: "incomplete_source" },
    );
    assert.deepEqual(
      Attempts.pinBuildRepositories(
        { ...descriptor, repositories: [snapshot, snapshot] },
        source,
        current,
      ),
      { reason: "incomplete_source" },
    );
    assert.deepEqual(
      Attempts.pinBuildRepositories(
        { ...descriptor, repositories: [{ ...snapshot, checkoutPhysicalID: "f".repeat(64) }] },
        source,
        current,
      ),
      { reason: "incomplete_source" },
    );
    assert.deepEqual(
      Attempts.pinBuildRepositories({ ...descriptor, repositories: [dependency] }, source, current),
      { reason: "unrelated_repository" },
    );
    assert.deepEqual(
      Attempts.pinBuildRepositories(descriptor, source, { ...current, head: "d".repeat(40) }),
      { reason: "pr_head_mismatch" },
    );
  });
  it("requires named successful checks, all dependency snapshots, and exact served artifact at both capture endpoints", () => {
    const build = receipt(),
      capture = recording();
    assert.deepEqual(Attempts.assessAttempt(preview, build, capture), {
      verdict: "incomplete",
      buildAndChecksMatch: true,
    });
    assert.deepEqual(
      Attempts.assessAttempt(
        preview,
        { ...build, checks: [{ ...build.checks[0]!, status: "failed" }] },
        capture,
      ),
      { verdict: "checks_failed", buildAndChecksMatch: false },
    );
    assert.deepEqual(
      Attempts.assessAttempt(
        preview,
        {
          ...build,
          repositoriesAtEnd: [
            { ...snapshot, fingerprint: { ...snapshot.fingerprint, hash: "e".repeat(64) } },
          ],
        },
        capture,
      ),
      { verdict: "incomplete", buildAndChecksMatch: false },
    );
    assert.deepEqual(
      Attempts.assessAttempt(preview, build, {
        ...capture,
        buildProof: {
          ...capture.buildProof!,
          end: { ...observation("end"), servedArtifactSHA256: "e".repeat(64) },
        },
      }),
      { verdict: "incomplete", buildAndChecksMatch: false },
    );
    assert.deepEqual(
      Attempts.assessAttempt(
        preview,
        { ...build, checks: [{ ...build.checks[0]!, buildMatched: false }] },
        capture,
      ),
      { verdict: "incomplete", buildAndChecksMatch: false },
    );
    const { buildProof: _proof, ...legacy } = capture;
    assert.deepEqual(Attempts.assessAttempt(preview, build, legacy), {
      verdict: "incomplete",
      buildAndChecksMatch: false,
    });
  });
});

describe("preview freshness across the native/RPC boundary", () => {
  it("accepts schema-reordered repository facts while refusing actual source or adapter changes", () => {
    const nativeRepositories = Attempts.pinBuildRepositories(
      preview.descriptor,
      [
        {
          repositoryID: snapshot.repositoryID,
          sourcePhysicalId: sha,
          repositoryPhysicalId: snapshot.repositoryPhysicalID,
          commit: head,
        },
      ],
      { keys: preview.repositoryKeys, head },
    );
    if ("reason" in nativeRepositories) throw Error(nativeRepositories.reason);
    const native = { ...preview, repositories: nativeRepositories.repositories };
    const wire = Schema.encodeSync(C.AttemptPreview)(native);
    assert.notEqual(JSON.stringify(native.repositories), JSON.stringify(wire.repositories));
    assert.equal(
      Attempts.verificationPreviewIdentity(native),
      Attempts.verificationPreviewIdentity(Schema.decodeUnknownSync(C.AttemptPreview)(wire)),
    );
    assert.equal(
      Attempts.verificationPreviewIdentity(native),
      Attempts.verificationPreviewIdentity({
        ...native,
        observedAt: "2026-10-04T00:00:00Z",
        descriptor: {
          ...native.descriptor,
          repositories: [{ ...snapshot, capturedAt: "2026-10-04T00:00:00Z" }],
        },
      }),
    );
    assert.notEqual(
      Attempts.verificationPreviewIdentity(native),
      Attempts.verificationPreviewIdentity({ ...native, head: "c".repeat(40) }),
    );
    assert.notEqual(
      Attempts.verificationPreviewIdentity(native),
      Attempts.verificationPreviewIdentity({
        ...native,
        descriptor: { ...native.descriptor, workflowHash: "d".repeat(64) },
      }),
    );
    assert.notEqual(
      Attempts.verificationPreviewIdentity(native),
      Attempts.verificationPreviewIdentity({
        ...native,
        descriptor: {
          ...native.descriptor,
          repositories: [
            { ...snapshot, fingerprint: { ...snapshot.fingerprint, hash: "e".repeat(64) } },
          ],
        },
      }),
    );
  });
});
