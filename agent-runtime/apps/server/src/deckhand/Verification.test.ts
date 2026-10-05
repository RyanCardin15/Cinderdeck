import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@cinderdeck/shared/nodeSqliteClient";
import { PullRequestDetail, PullRequestRef } from "@cinderdeck/contracts";
import * as C from "@cinderdeck/contracts/deckhand";
import * as R from "@cinderdeck/contracts/deckhand/recordingsRpc";
import * as V from "./Verification.ts";
import * as Relationships from "./Relationships.ts";
import * as Recordings from "./Recordings.ts";
import * as Migrations from "./Migrations.ts";
import * as PRs from "../pullRequest/PullRequestService.ts";
import * as GitHub from "../pullRequest/GitHubPullRequestCli.ts";
import type { GitHubPullRequestCore } from "../pullRequest/gitHubPullRequestJson.ts";
const reference = Schema.decodeUnknownSync(PullRequestRef)({
  projectId: "project",
  host: "github.com",
  repository: "cardin/app",
  number: 7,
});
const detail = Schema.decodeUnknownSync(PullRequestDetail)({
  provider: "github",
  capabilities: {
    diff: true,
    comment: false,
    actions: [],
    mergeMethods: [],
    search: true,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
  projectId: "project",
  projectTitle: "App",
  workspaceRoot: "/fixture",
  repository: "cardin/app",
  number: 7,
  title: "Retry",
  body: "",
  url: "https://github.com/cardin/app/pull/7",
  author: null,
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "retry",
  baseBranch: "main",
  createdAt: "2026-10-03T00:00:00Z",
  updatedAt: "2026-10-03T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
});
const core = (head: string): GitHubPullRequestCore => ({
  number: detail.number,
  title: detail.title,
  url: detail.url,
  author: detail.author,
  headBranch: detail.headBranch,
  baseBranch: detail.baseBranch,
  state: detail.state,
  isDraft: detail.isDraft,
  mergeability: detail.mergeability,
  additions: detail.additions,
  deletions: detail.deletions,
  createdAt: detail.createdAt,
  updatedAt: detail.updatedAt,
  labels: detail.labels,
  body: detail.body,
  changedFiles: detail.changedFiles,
  mergedAt: detail.mergedAt,
  closedAt: detail.closedAt,
  checks: detail.checks,
  headSha: head,
  authorId: null,
  reviewDecision: null,
  reviewRequestLogins: [],
  hasTeamReviewRequest: false,
  checksState: null,
  headRepositoryOwner: "cardin",
  viewerAccess: {
    canWrite: false,
    canTriage: false,
    canUpdate: false,
    didAuthor: false,
    mergeCapabilities: detail.mergeCapabilities,
  },
  comparison: null,
  checksTruncated: false,
});
const secondCheckoutID = Schema.decodeUnknownSync(C.CheckoutBindingId)("checkout2");
const identity = {
  installationID: "native",
  workspaceID: "lane",
  generation: 2,
  recordingID: "clip",
};
const recording = Schema.decodeUnknownSync(R.Recording)({
  id: "clip",
  title: "Retry works",
  state: "ready",
  createdAt: "2026-10-03T00:00:00Z",
  duration: 10,
  actor: "Cinderdeck",
  capture: "Browser",
  primaryWorkspaceID: "lane",
  capturedWorkspaceIDs: ["lane"],
  capturedWorkspaceNames: ["App"],
  lineCount: 2,
  errorCount: 0,
  warningCount: 0,
  playable: true,
  paused: false,
  controlAllowed: false,
  detail: null,
  checkOutcome: "passed",
  markers: [{ id: "mark", t: 3, label: "Retry succeeds", outcome: "pass" }],
  repositories: [
    {
      workspaceID: "lane",
      repositoryID: "app",
      branch: "retry",
      head: "abc",
      changedFiles: 0,
      canonicalRepositoryKeys: ["github.com/cardin/app"],
      repositoryPhysicalId: "physical",
      snapshotComplete: true,
      capturedAt: "2026-10-03T00:00:00Z",
      diffHash: "empty-diff-hash",
    },
  ],
});
const workspace = Schema.decodeUnknownSync(C.WorkspaceBinding)({
  id: "workspace",
  environmentId: "native",
  backend: "cinderdeck",
  ownerId: "app.toml",
  generation: 2,
  revision: 1,
  name: "App",
  state: "active",
});
const feature = Schema.decodeUnknownSync(C.Feature)({
  id: "feature",
  workspaceId: "workspace",
  title: "Retry",
  objective: "Verify retry",
  status: "active",
  revision: 1,
  createdAt: recording.createdAt,
  updatedAt: recording.createdAt,
});
const checkout = Schema.decodeUnknownSync(C.CheckoutBinding)({
  id: "checkout",
  workspaceId: "workspace",
  workspaceGeneration: 2,
  nativeGeneration: 2,
  environmentId: "native",
  backend: "cinderdeck",
  kind: "lane",
  laneId: "lane",
  state: "ready",
  revision: 1,
  repositories: [
    {
      physicalId: "checkout-physical",
      repositoryPhysicalId: "physical",
      root: "/fixture",
      gitDirectory: "/fixture/.git/worktrees/lane",
      commonDirectory: "/fixture/.git",
      branch: "retry",
      commit: "abc",
      remotes: [{ name: "origin", canonicalKey: "github.com/cardin/app" }],
    },
  ],
});
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Migrations.migrate;
  const relationships = yield* Relationships.Relationships;
  yield* relationships.putWorkspace(workspace, null);
  yield* relationships.putFeature(feature, null);
  yield* relationships.putCheckout(checkout, null);
  yield* relationships.linkCheckout(feature.id, checkout.id, true);
  return sql;
});
const testLayer = (read: () => R.Recording, head: () => string) => {
  const sql = NodeSqliteClient.layer({ filename: ":memory:" });
  const relationships = Relationships.layer.pipe(Layer.provideMerge(sql));
  return V.layer.pipe(
    Layer.provideMerge(relationships),
    Layer.provide(Layer.mock(Recordings.Recordings)({ get: () => Effect.sync(read) })),
    Layer.provide(
      Layer.mock(PRs.PullRequestService)({
        detail: () => Effect.succeed(detail),
        withRoutingCredential: (_ref, operation) => operation,
      }),
    ),
    Layer.provide(
      Layer.mock(GitHub.GitHubPullRequestCli)({
        getPullRequestDetail: () => Effect.sync(() => core(head())),
      }),
    ),
  );
};
describe("PR verification provenance", () => {
  it("separates clean source matches from unknown served build, dirty source, old revision and legacy captures", () => {
    assert.strictEqual(
      V.sourceAssessment(recording, ["github.com/cardin/app"], "abc").sourceState,
      "source_match",
    );
    assert.strictEqual(
      V.sourceAssessment(recording, ["github.com/cardin/app"], "abc").buildState,
      "unknown",
    );
    assert.strictEqual(
      V.sourceAssessment(recording, ["github.com/cardin/app"], "def").sourceState,
      "stale",
    );
    assert.strictEqual(
      V.sourceAssessment(
        {
          ...recording,
          repositories: recording.repositories.map((repo) => ({ ...repo, changedFiles: 1 })),
        },
        ["github.com/cardin/app"],
        "abc",
      ).sourceState,
      "dirty",
    );
    assert.strictEqual(
      V.sourceAssessment(
        {
          ...recording,
          repositories: recording.repositories.map(
            ({ canonicalRepositoryKeys: _, ...repo }) => repo,
          ),
        },
        ["github.com/cardin/app"],
        "abc",
      ).sourceState,
      "unknown",
    );
    assert.strictEqual(
      V.sourceAssessment(recording, ["github.com/other/app"], "abc").sourceState,
      "unrelated",
    );
  });
  it.effect(
    "keeps manifests immutable across relink, PR head movement, primary checkout changes and unlink",
    () => {
      let value = recording,
        head = "abc";
      return Effect.gen(function* () {
        const sql = yield* seed;
        const service = yield* V.Verification;
        const input = {
          reference,
          featureID: feature.id,
          checkoutID: checkout.id,
          recording: identity,
        };
        const first = yield* service.link("actor", input);
        const evidence = first.evidence[0]!;
        assert.strictEqual(evidence.sourceState, "source_match");
        value = {
          ...recording,
          repositories: recording.repositories.map((repo) => ({
            ...repo,
            head: "new-native-head",
            changedFiles: 2,
          })),
        };
        head = "def";
        const again = yield* service.link("actor", input);
        assert.strictEqual(again.evidence[0]!.manifestHash, evidence.manifestHash);
        assert.strictEqual(again.evidence[0]!.recording.repositories[0]!.head, "abc");
        assert.strictEqual(again.evidence[0]!.sourceState, "stale");
        const relationships = yield* Relationships.Relationships;
        const second = {
          ...checkout,
          id: secondCheckoutID,
          laneId: "lane2",
          repositories: checkout.repositories.map((repo) => ({
            ...repo,
            physicalId: "new-checkout",
          })),
        };
        yield* relationships.putCheckout(second, null);
        yield* relationships.linkCheckout(feature.id, second.id, true);
        const moved = yield* service.list("actor", { reference });
        assert.strictEqual(moved.evidence[0]!.manifestHash, evidence.manifestHash);
        const updateError =
          yield* sql`UPDATE deckhand_evidence_manifests SET record_json='{}' WHERE artifact_id=${evidence.artifactID}`.pipe(
            Effect.flip,
          );
        assert.isDefined(updateError);
        yield* service.unlink("actor", {
          reference,
          featureID: feature.id,
          checkoutID: checkout.id,
          artifactID: evidence.artifactID,
        });
        const rows =
          yield* sql`SELECT id FROM deckhand_evidence_manifests WHERE artifact_id=${evidence.artifactID}`;
        assert.strictEqual(rows.length, 1);
        const relinked = yield* service.link("actor", input);
        assert.strictEqual(relinked.evidence[0]!.manifestHash, evidence.manifestHash);
      }).pipe(
        Effect.provide(
          testLayer(
            () => value,
            () => head,
          ),
        ),
      );
    },
  );
  it.effect(
    "refuses a recording from another execution computer or generation before reading it",
    () => {
      let reads = 0;
      return Effect.gen(function* () {
        yield* seed;
        const service = yield* V.Verification;
        for (const wrong of [
          { ...identity, installationID: "other" },
          { ...identity, generation: 3 },
        ]) {
          const error = yield* service
            .link("actor", {
              reference,
              featureID: feature.id,
              checkoutID: checkout.id,
              recording: wrong,
            })
            .pipe(Effect.flip);
          assert.strictEqual(error.reason, "wrong_context");
        }
        assert.strictEqual(reads, 0);
      }).pipe(
        Effect.provide(
          testLayer(
            () => {
              reads++;
              return recording;
            },
            () => "abc",
          ),
        ),
      );
    },
  );
  it.effect(
    "persists immutable before/after manifests, deduplicates retry and refuses incompatible comparisons",
    () => {
      let value = recording;
      return Effect.gen(function* () {
        const sql = yield* seed;
        const service = yield* V.Verification;
        const before = yield* service.link("actor", {
          reference,
          featureID: feature.id,
          checkoutID: checkout.id,
          recording: identity,
        });
        value = {
          ...recording,
          id: "after",
          createdAt: "2026-10-03T00:01:00Z",
          repositories: recording.repositories.map((repo) => ({ ...repo, head: "def" })),
        };
        const linked = yield* service.link("actor", {
          reference,
          featureID: feature.id,
          checkoutID: checkout.id,
          recording: { ...identity, recordingID: "after" },
        });
        const baseline = before.evidence[0]!;
        const followup = linked.evidence.find((item) => item.recording.id === "after")!;
        const input = {
          reference,
          scenarioID: "scenario-one",
          featureID: feature.id,
          title: "Payment retry",
          baselineArtifactID: baseline.artifactID,
          followupArtifactID: followup.artifactID,
        };
        const saved = yield* service.scenarioSave("actor", input);
        assert.strictEqual(saved.scenarios?.length, 1);
        assert.strictEqual(saved.scenarios?.[0]?.baselineManifestHash, baseline.manifestHash);
        assert.strictEqual(saved.scenarios?.[0]?.followupManifestHash, followup.manifestHash);
        assert.strictEqual(
          saved.evidence.find((item) => item.recording.id === "after")?.buildState,
          "unknown",
        );
        const retry = yield* service.scenarioSave("actor", input);
        assert.deepEqual(retry.scenarios, saved.scenarios);
        const conflict = yield* service
          .scenarioSave("actor", { ...input, title: "Different scenario" })
          .pipe(Effect.flip);
        assert.strictEqual(conflict.reason, "scenario_conflict");
        for (const [change, reason] of [
          [{ followupArtifactID: baseline.artifactID }, "scenario_same_recording"],
          [
            { baselineArtifactID: followup.artifactID, followupArtifactID: baseline.artifactID },
            "scenario_chronology",
          ],
          [{ followupArtifactID: "missing" }, "scenario_missing_evidence"],
        ] as const) {
          const error = yield* service
            .scenarioSave("actor", { ...input, scenarioID: reason, ...change })
            .pipe(Effect.flip);
          assert.strictEqual(error.reason, reason);
        }
        const immutable =
          yield* sql`UPDATE deckhand_verification_scenarios SET record_json='{}' WHERE id='scenario-one'`.pipe(
            Effect.flip,
          );
        assert.isDefined(immutable);
        yield* service.unlink("actor", {
          reference,
          featureID: feature.id,
          checkoutID: checkout.id,
          artifactID: baseline.artifactID,
        });
        const unavailable = yield* service.list("actor", { reference });
        assert.deepEqual(unavailable.scenarios, saved.scenarios);
        assert.isFalse(
          unavailable.evidence.some((item) => item.artifactID === baseline.artifactID),
        );
        const refusal = yield* service
          .scenarioRemove("other-actor", { reference, scenarioID: input.scenarioID })
          .pipe(Effect.flip);
        assert.strictEqual(refusal.reason, "scenario_owned_elsewhere");
        const removed = yield* service.scenarioRemove("actor", {
          reference,
          scenarioID: input.scenarioID,
        });
        assert.deepEqual(removed.scenarios, []);
        const retained =
          yield* sql`SELECT id FROM deckhand_evidence_manifests WHERE id=${baseline.artifactID}`;
        assert.strictEqual(retained.length, 1);
      }).pipe(
        Effect.provide(
          testLayer(
            () => value,
            () => "abc",
          ),
        ),
      );
    },
  );
});
