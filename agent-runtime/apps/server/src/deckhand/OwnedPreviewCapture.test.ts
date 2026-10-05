import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@cinderdeck/shared/nodeSqliteClient";
// @effect-diagnostics nodeBuiltinImport:off - deterministic proof fixtures.
import * as NodeCrypto from "node:crypto";
import * as C from "@cinderdeck/contracts/deckhand/verificationAttemptsRpc";
import type * as B from "@cinderdeck/contracts/deckhand/builds";
import type * as R from "@cinderdeck/contracts/deckhand/recordingsRpc";
import * as O from "@cinderdeck/contracts/deckhand/ownedPreviewRpc";
import * as D from "@cinderdeck/contracts/deckhand";
import * as Capture from "./OwnedPreviewCapture.ts";
import * as Proofs from "./OwnedPreviewAttestations.ts";
import * as Attempts from "./VerificationAttempts.ts";
import * as Builds from "./Builds.ts";
import * as Recordings from "./Recordings.ts";
import * as Transport from "./RecordingTransport.ts";
import * as Relationships from "./Relationships.ts";
import * as CurrentCheckout from "./CurrentCheckout.ts";
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
});
const observation = (phase: "start" | "end" | "check"): B.BuildObservation => ({
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

const target: O.OwnedPreviewTarget = {
  tabID: "tab",
  webContentsID: 17,
  targetID: "chromium-target",
  frameID: "main-frame",
  documentID: "fresh-document",
  url: "http://127.0.0.1:43123/",
  observedAt: time,
};
const session = Schema.decodeUnknownSync(D.SessionBinding)({
  id: "session",
  threadId: "thread",
  providerSessionId: null,
  providerInstanceId: "codex",
  featureId: "feature",
  checkoutId: "checkout",
  repositoryScope: [sha],
  role: "reviewer",
  desiredAccess: "write",
  execution: "idle",
  connection: "unavailable",
  lastSequence: 1,
  capabilities: {
    nativeResume: true,
    interrupt: false,
    steering: false,
    approvals: false,
    questions: false,
    enforcedReadOnly: false,
    imageInput: false,
    videoInput: false,
    managed: true,
  },
  observedAt: time,
});
const checkout = Schema.decodeUnknownSync(D.CheckoutBinding)({
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
  repositories: [],
});
const workspace = Schema.decodeUnknownSync(D.WorkspaceBinding)({
  id: "workspace",
  environmentId: "native",
  backend: "cinderdeck",
  ownerId: "base",
  generation: 1,
  revision: 1,
  name: "App",
  state: "active",
});
const savedRecording = (): R.Recording => ({
  ...recording(),
  sourceVideoSHA256: "d".repeat(64),
  sourceVideoSizeBytes: 40,
  videoSHA256: "e".repeat(64),
  videoSizeBytes: 32,
  videoIntegrity: "matched",
});
const proof = (): O.OwnedPreviewProof => ({
  captureKey: "capture",
  attemptOperationKey: "attempt",
  ...context,
  featureID: "feature",
  checkoutID: "checkout",
  buildReceiptID: "receipt",
  recordingID: "recording",
  start: target,
  end: target,
  firstFrameAt: time,
  consumedArtifactSHA256: sha,
  consumedArtifactURL: new URL("/app.js", target.url).href,
  frameCount: 2,
  sourceVideoSHA256: "d".repeat(64),
  sourceVideoSizeBytes: 40,
  videoSHA256: "e".repeat(64),
  videoSizeBytes: 32,
  uninterrupted: true,
});
const setupCapture = (state: {
  calls: string[];
  currentUnavailable?: boolean;
  effectiveID?: string;
  ready: boolean;
  hasSession: boolean;
  recording: R.Recording;
}) => {
  const dependencies = Layer.mergeAll(
    Layer.mock(CurrentCheckout.CurrentCheckout)({
      current: () =>
        state.currentUnavailable
          ? Effect.fail(new CurrentCheckout.CurrentCheckoutError({ reason: "pending" }))
          : Effect.succeed({
              ...checkout,
              id: D.CheckoutBindingId.make(state.effectiveID ?? checkout.id),
            }),
    }),
    Layer.mock(Attempts.VerificationAttempts)({ get: () => Effect.succeed(attempt()) }),
    Layer.mock(Builds.Builds)({
      observe: (_actor, input) =>
        Effect.succeed({ ...observation(input.phase), serviceURL: target.url }),
    }),
    Layer.mock(Recordings.Recordings)({ get: () => Effect.succeed(state.recording) }),
    Layer.mock(Relationships.Relationships)({
      sessions: () => Effect.succeed(state.hasSession ? [session] : []),
      session: () => Effect.succeed(session),
      checkout: () => Effect.succeed(checkout),
      workspace: () => Effect.succeed(workspace),
    }),
    Layer.mock(Transport.RecordingTransport)({
      request: (_actor, method) =>
        Effect.sync(() => {
          state.calls.push(method);
          return {
            operationKey: "owned-preview:capture",
            recordingID: "recording",
            token: "native-token",
            state: state.ready ? "ready" : "capturing",
            receivedBytes: state.ready ? 40 : 0,
            hostStartedAt: time,
            clockQuality: "estimated",
            detail: null,
            sha256: null,
            duration: state.ready ? 3 : null,
          };
        }),
    }),
  );
  return Capture.layer.pipe(
    Layer.provide(dependencies),
    Layer.provideMerge(Proofs.layer),
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  );
};
describe("Owned preview authority and immutable media joins", () => {
  it("admits only the actual owned loopback origin, exact target identity and private Main credential", () => {
    assert.isTrue(Capture.targetMatchesOwnedService(target, target.url));
    for (const url of [
      "http://127.0.0.1:43124/",
      "https://127.0.0.1:43123/",
      "http://remote.example:43123/",
      undefined,
    ])
      assert.isFalse(Capture.targetMatchesOwnedService(target, url));
    assert.isFalse(
      Capture.targetMatchesOwnedService(
        { ...target, url: "http://user@127.0.0.1:43123/" },
        target.url,
      ),
    );
    assert.isTrue(Proofs.privateCredentialMatches(sha, sha));
    assert.isFalse(Proofs.privateCredentialMatches(undefined, sha));
    assert.isFalse(Proofs.privateCredentialMatches(sha, "z".repeat(64)));
    assert.isFalse(Proofs.privateCredentialMatches(sha, "🧡".repeat(32)));
  });
  it("upgrades only the same immutable attempt, context, build and actual source→saved bytes", () => {
    const value = savedRecording(),
      build = receipt();
    assert.equal(
      Attempts.assessAttempt(preview, build, value, { proof: proof(), operationKey: "attempt" })
        .verdict,
      "matches",
    );
    for (const changed of [
      { attemptOperationKey: "other" },
      { generation: 4 },
      { buildReceiptID: "other" },
      { recordingID: "other" },
      { sourceVideoSHA256: sha },
      { videoSHA256: sha },
      { firstFrameAt: "2026-10-03T10:00:30Z" },
      { end: { ...target, frameID: "replacement" } },
      { end: { ...target, documentID: "replacement" } },
      { consumedArtifactSHA256: "c".repeat(64) },
    ]) {
      assert.equal(
        Attempts.assessAttempt(preview, build, value, {
          proof: { ...proof(), ...changed },
          operationKey: "attempt",
        }).verdict,
        "incomplete",
      );
    }
    assert.equal(Attempts.assessAttempt(preview, build, value).verdict, "incomplete");
    assert.equal(
      Attempts.assessAttempt(
        preview,
        build,
        { ...value, videoIntegrity: "changed" as const },
        { proof: proof(), operationKey: "attempt" },
      ).verdict,
      "incomplete",
    );
  });
  it.effect(
    "persists real-session intent before effects, refuses wrong capability/replay and stores completed private proof",
    () => {
      const state = {
        calls: [] as string[],
        ready: false,
        hasSession: true,
        recording: savedRecording(),
      };
      return Effect.gen(function* () {
        const service = yield* Capture.OwnedPreviewCapture;
        const saved = yield* service.intent("alice", {
          captureKey: "capture",
          attemptOperationKey: "attempt",
        });
        assert.equal(state.calls.length, 0);
        assert.deepEqual(
          yield* service.intent("alice", { captureKey: "capture", attemptOperationKey: "attempt" }),
          saved,
        );
        assert.equal(
          (yield* service
            .begin({
              ...saved,
              token: sha,
              target,
              consumedArtifactSHA256: sha,
              consumedArtifactURL: new URL("/app.js", target.url).href,
              clientMonotonicMs: 0,
            })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(state.calls.length, 0);
        const started = yield* service.begin({
          ...saved,
          target,
          consumedArtifactSHA256: sha,
          consumedArtifactURL: new URL("/app.js", target.url).href,
          clientMonotonicMs: 0,
        });
        assert.equal(started.state, "capturing");
        assert.equal(state.calls.filter((method) => method.endsWith(".begin")).length, 1);
        assert.equal(
          (yield* service
            .begin({
              ...saved,
              target,
              consumedArtifactSHA256: sha,
              consumedArtifactURL: new URL("/app.js", target.url).href,
              clientMonotonicMs: 0,
            })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          (yield* service.get("mallory", { captureKey: "capture" }).pipe(Effect.result))._tag,
          "Failure",
        );
        yield* service.event({
          ...saved,
          event: "first_frame",
          clientMonotonicMs: 1,
          observedAt: time,
        });
        state.ready = true;
        const finished = yield* service.finish({
          ...saved,
          target,
          sourceVideoSHA256: "d".repeat(64),
          sourceVideoSizeBytes: 40,
          frameCount: 2,
          uninterrupted: true,
          invalidationReason: null,
        });
        assert.equal(finished.state, "ready");
        const proofs = yield* Proofs.OwnedPreviewAttestations;
        assert.deepEqual(yield* proofs.get("alice", "recording"), proof());
        assert.isNull(yield* proofs.get("mallory", "recording"));
        assert.equal(
          (yield* proofs.put("alice", { ...proof(), sourceVideoSHA256: sha }).pipe(Effect.result))
            ._tag,
          "Failure",
        );
        const sql = yield* SqlClient.SqlClient;
        assert.equal(
          (yield* sql`UPDATE deckhand_owned_preview_proofs SET actor_id='mallory'`.pipe(
            Effect.result,
          ))._tag,
          "Failure",
        );
        const before = state.calls.filter((method) => method.endsWith(".finish")).length;
        yield* service.finish({
          ...saved,
          target,
          sourceVideoSHA256: "d".repeat(64),
          sourceVideoSizeBytes: 40,
          frameCount: 2,
          uninterrupted: true,
          invalidationReason: null,
        });
        assert.equal(state.calls.filter((method) => method.endsWith(".finish")).length, before);
      }).pipe(Effect.provide(setupCapture(state)));
    },
  );
  it.effect(
    "blocks pending ownership and refuses an effective checkout transition after preparation before native effects",
    () => {
      const state = {
        calls: [] as string[],
        ready: false,
        hasSession: true,
        recording: savedRecording(),
        currentUnavailable: true,
        effectiveID: "checkout",
      };
      return Effect.gen(function* () {
        const service = yield* Capture.OwnedPreviewCapture;
        assert.equal(
          (yield* service
            .intent("alice", { captureKey: "capture", attemptOperationKey: "attempt" })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(state.calls.length, 0);
        state.currentUnavailable = false;
        const saved = yield* service.intent("alice", {
          captureKey: "capture",
          attemptOperationKey: "attempt",
        });
        state.effectiveID = "adopted-checkout";
        assert.equal(
          (yield* service
            .begin({
              ...saved,
              target,
              consumedArtifactSHA256: sha,
              consumedArtifactURL: new URL("/app.js", target.url).href,
              clientMonotonicMs: 0,
            })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(state.calls.length, 0);
      }).pipe(Effect.provide(setupCapture(state)));
    },
  );
  it.effect(
    "refuses capture without a real matching connected session before native effects",
    () => {
      const state = {
        calls: [] as string[],
        ready: false,
        hasSession: false,
        recording: savedRecording(),
      };
      return Effect.gen(function* () {
        const service = yield* Capture.OwnedPreviewCapture;
        assert.equal(
          (yield* service
            .intent("alice", { captureKey: "capture", attemptOperationKey: "attempt" })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(state.calls.length, 0);
      }).pipe(Effect.provide(setupCapture(state)));
    },
  );
  it.effect("retains video without target proof after navigation or byte substitution", () => {
    const state = {
      calls: [] as string[],
      ready: false,
      hasSession: true,
      recording: savedRecording(),
    };
    return Effect.gen(function* () {
      const service = yield* Capture.OwnedPreviewCapture;
      const saved = yield* service.intent("alice", {
        captureKey: "capture",
        attemptOperationKey: "attempt",
      });
      yield* service.begin({
        ...saved,
        target,
        consumedArtifactSHA256: sha,
        consumedArtifactURL: new URL("/app.js", target.url).href,
        clientMonotonicMs: 0,
      });
      yield* service.event({
        ...saved,
        event: "first_frame",
        clientMonotonicMs: 1,
        observedAt: time,
      });
      state.ready = true;
      const finished = yield* service.finish({
        ...saved,
        target: { ...target, url: target.url + "other" },
        sourceVideoSHA256: sha,
        sourceVideoSizeBytes: 40,
        frameCount: 2,
        uninterrupted: false,
        invalidationReason: "Navigated",
      });
      assert.equal(finished.state, "failed");
      assert.equal(finished.recordingID, "recording");
      assert.isNull(yield* (yield* Proofs.OwnedPreviewAttestations).get("alice", "recording"));
    }).pipe(Effect.provide(setupCapture(state)));
  });
});
