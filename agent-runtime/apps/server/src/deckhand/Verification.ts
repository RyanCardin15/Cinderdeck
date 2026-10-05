import * as AttentionObservations from "./AttentionObservations.ts";
// @effect-diagnostics nodeBuiltinImport:off - Immutable local evidence digests.
import * as NodeCrypto from "node:crypto";
import * as C from "@cinderdeck/contracts/deckhand/verificationRpc";
import * as Recording from "@cinderdeck/contracts/deckhand/recordingsRpc";
import * as Contracts from "@cinderdeck/contracts/deckhand";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Relationships from "./Relationships.ts";
import * as Recordings from "./Recordings.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as GitHubPullRequestCli from "../pullRequest/GitHubPullRequestCli.ts";
const isError = Schema.is(C.VerificationError);
const decodeScenario = Schema.decodeUnknownEffect(Schema.fromJsonString(C.VerificationScenario));
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
export function sourceAssessment(
  recording: Recording.Recording,
  keys: ReadonlyArray<string>,
  head: string | null,
): Pick<C.Evidence, "sourceState" | "buildState" | "reason"> {
  const matched = recording.repositories.filter((repo) =>
    repo.canonicalRepositoryKeys?.some((key) => keys.includes(key)),
  );
  const result = (sourceState: C.Evidence["sourceState"], reason: string) => ({
    sourceState,
    buildState: "unknown" as const,
    reason,
  });
  if (
    !recording.repositories.length ||
    !recording.repositories.some((repo) => repo.canonicalRepositoryKeys?.length)
  )
    return result(
      "unknown",
      "This capture predates repository provenance. Its source and served build cannot be verified.",
    );
  if (!matched.length)
    return result("unrelated", "The captured repositories do not match this pull request.");
  if (matched.some((repo) => repo.changedFiles > 0))
    return result(
      "dirty",
      "The capture includes uncommitted source. The served build identity is unknown.",
    );
  if (
    !head ||
    matched.some(
      (repo) =>
        !repo.snapshotComplete ||
        !repo.head ||
        !repo.repositoryPhysicalId ||
        !repo.diffHash ||
        repo.diffTruncated,
    )
  )
    return result(
      "unknown",
      "The immutable source snapshot is incomplete. The served build identity is unknown.",
    );
  if (matched.some((repo) => repo.head !== head))
    return result(
      "stale",
      "The PR head differs from the captured source. Record a new verification for this revision.",
    );
  return result(
    "source_match",
    "Captured clean source matches the current PR head. The served build has no captured revision proof.",
  );
}
/** User-declared scenario continuity is an association, never proof of a capture target. */
export function validateScenarioPair(
  baseline: C.Evidence | undefined,
  followup: C.Evidence | undefined,
): string | null {
  if (!baseline || !followup) return "scenario_missing_evidence";
  if (baseline.artifactID === followup.artifactID) return "scenario_same_recording";
  if (baseline.featureID !== followup.featureID) return "scenario_wrong_feature";
  if (
    ![baseline, followup].every(
      (item) => item.recording.state === "ready" && item.recording.playable,
    )
  )
    return "scenario_not_playable";
  const before = Date.parse(baseline.recording.createdAt),
    after = Date.parse(followup.recording.createdAt);
  if (!Number.isFinite(before) || !Number.isFinite(after) || before > after)
    return "scenario_chronology";
  const keys = new Set(
    baseline.recording.repositories.flatMap((repo) => repo.canonicalRepositoryKeys ?? []),
  );
  if (
    !followup.recording.repositories.some((repo) =>
      repo.canonicalRepositoryKeys?.some((key) => keys.has(key)),
    )
  )
    return "scenario_repository_unknown";
  return null;
}
export class Verification extends Context.Service<
  Verification,
  {
    readonly scenarioSave: (
      actor: string,
      input: C.VerificationScenarioSave,
    ) => Effect.Effect<C.VerificationOverview, C.VerificationError>;
    readonly scenarioRemove: (
      actor: string,
      input: C.VerificationScenarioRemove,
    ) => Effect.Effect<C.VerificationOverview, C.VerificationError>;
    readonly readHead: (
      input: C.VerificationInput,
    ) => Effect.Effect<
      { head: string | null; keys: ReadonlyArray<string>; observedAt: string },
      C.VerificationError
    >;
    readonly list: (
      actor: string,
      input: C.VerificationInput,
    ) => Effect.Effect<C.VerificationOverview, C.VerificationError>;
    readonly link: (
      actor: string,
      input: C.VerificationLink,
    ) => Effect.Effect<C.VerificationOverview, C.VerificationError>;
    readonly unlink: (
      actor: string,
      input: C.VerificationUnlink,
    ) => Effect.Effect<C.VerificationOverview, C.VerificationError>;
  }
>()("@cinderdeck/server/deckhand/Verification") {}
export const verificationReferenceKey = (input: C.VerificationInput) =>
  digest(
    json([
      input.reference.projectId,
      input.reference.host ?? "github.com",
      input.reference.repository.toLowerCase(),
      input.reference.number,
    ]),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const relationships = yield* Relationships.Relationships;
  const recordings = yield* Recordings.Recordings;
  const prs = yield* PullRequestService.PullRequestService;
  const github = yield* GitHubPullRequestCli.GitHubPullRequestCli;
  const fail = (reason: string) => new C.VerificationError({ reason });
  const wrap = (cause: unknown) => (isError(cause) ? cause : fail("unavailable"));
  const key = verificationReferenceKey;
  const current = (input: C.VerificationInput) =>
    Effect.gen(function* () {
      // Resolve project/account authority before reading an authoritative current head.
      const detail = yield* prs.detail({ ...input.reference, allowStale: false });
      const host = new URL(detail.url).host.toLowerCase();
      const keys = [`${host}/${detail.repository.toLowerCase()}`];
      if (detail.headRepositoryNameWithOwner)
        keys.push(`${host}/${detail.headRepositoryNameWithOwner.toLowerCase()}`);
      let head: string | null = null;
      if (detail.provider === "github") {
        const value = yield* prs.withRoutingCredential(
          input.reference,
          github.getPullRequestDetail({
            cwd: detail.workspaceRoot,
            repository: detail.repository,
            host,
            number: detail.number,
          }),
        );
        head = value.headSha ?? null;
      }
      return { head, keys, observedAt: DateTime.formatIso(yield* DateTime.now) };
    });
  const decodeFeature = Schema.decodeUnknownEffect(Schema.fromJsonString(Contracts.Feature));
  const decodeCheckout = Schema.decodeUnknownEffect(
    Schema.fromJsonString(Contracts.CheckoutBinding),
  );
  const Manifest = Schema.Struct({
    context: Recording.RecordingIdentity,
    recording: Recording.Recording,
    linkedAtHead: Schema.NullOr(Schema.String),
  });
  const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));
  const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(Manifest));
  const list: Verification["Service"]["list"] = (_actor, input) =>
    Effect.gen(function* () {
      const state = yield* current(input);
      const rows = yield* sql<{
        feature_json: string;
        checkout_json: string;
      }>`SELECT f.record_json AS feature_json,c.record_json AS checkout_json FROM deckhand_feature_checkouts fc JOIN deckhand_features f ON f.id=fc.feature_id JOIN deckhand_checkouts c ON c.id=fc.checkout_id WHERE EXISTS (SELECT 1 FROM json_each(c.record_json,'$.repositories') repo, json_each(repo.value,'$.remotes') remote WHERE json_extract(remote.value,'$.canonicalKey') IN (SELECT value FROM json_each(${json(state.keys)}))) ORDER BY f.id,c.id LIMIT 100`;
      const contexts: Array<C.VerificationContext> = [];
      for (const row of rows) {
        const feature = yield* decodeFeature(row.feature_json);
        const checkout = yield* decodeCheckout(row.checkout_json);
        if (
          !checkout.repositories.some((repo) =>
            repo.remotes.some((remote) => state.keys.includes(remote.canonicalKey)),
          )
        )
          continue;
        const workspace = yield* relationships.workspace(checkout.workspaceId);
        contexts.push({
          feature,
          checkout,
          recordingContext:
            checkout.backend === "cinderdeck" && checkout.nativeGeneration
              ? {
                  installationID: checkout.environmentId,
                  workspaceID: checkout.laneId ?? workspace.ownerId,
                  generation: checkout.nativeGeneration,
                }
              : null,
        });
      }
      const evidenceRows = yield* sql<{
        artifact_id: string;
        feature_id: string;
        checkout_id: string;
        record_json: string;
        sha256: string;
      }>`SELECT l.artifact_id,l.feature_id,l.checkout_id,m.record_json,m.sha256 FROM deckhand_artifact_links l JOIN deckhand_artifacts a ON a.id=l.artifact_id JOIN deckhand_evidence_manifests m ON m.artifact_id=a.id WHERE a.kind='recording' AND json_extract(a.record_json,'$.prKey')=${key(input)} ORDER BY m.captured_at DESC,l.artifact_id LIMIT 100`;
      const evidence = yield* Effect.forEach(evidenceRows, (row) =>
        Effect.gen(function* () {
          if (digest(row.record_json) !== row.sha256) return yield* fail("manifest_integrity");
          const saved = yield* decodeManifest(row.record_json);
          return {
            artifactID: row.artifact_id,
            featureID: row.feature_id,
            checkoutID: row.checkout_id,
            ...saved,
            manifestHash: row.sha256,
            ...sourceAssessment(saved.recording, state.keys, state.head),
          };
        }),
      );
      const featureIDs = new Set([
        ...contexts.map((item) => item.feature.id),
        ...evidence.map((item) => item.featureID),
      ]);
      const sessions: Array<Contracts.SessionBinding> = [];
      for (const featureId of featureIDs) {
        if (sessions.length >= 100) break;
        sessions.push(
          ...(yield* relationships.sessions({ featureId, limit: 100 - sessions.length })),
        );
      }
      const scopeKey = `verification:${key(input)}`;
      const present: string[] = [];
      const problems = evidence.filter(
        (item) => item.sourceState !== "source_match" || item.buildState === "unknown",
      );
      if (problems.length) {
        const cause = yield* AttentionObservations.save({
          scopeKey,
          kind: "verification",
          causeVersion: AttentionObservations.digest([
            state.head,
            problems.map((item) => [
              item.artifactID,
              item.manifestHash,
              item.sourceState,
              item.buildState,
            ]),
          ]),
          title: `Verification needs review · PR #${input.reference.number}`,
          detail: `${problems.length} linked recording${problems.length === 1 ? "" : "s"} lack complete proof for this PR revision. Inspect source and build assessments before relying on the capture.`,
          severity: "warning",
          target: { kind: "verification", reference: input.reference },
          observedAt: state.observedAt,
          canSnooze: true,
        });
        present.push(cause.id);
      }
      yield* AttentionObservations.reconcile(scopeKey, present, state.observedAt);
      const scenarioRows = yield* sql<{
        record_json: string;
      }>`SELECT record_json FROM deckhand_verification_scenarios WHERE pr_key=${key(input)} ORDER BY id LIMIT 100`;
      const scenarios = yield* Effect.forEach(scenarioRows, (row) =>
        decodeScenario(row.record_json),
      );
      return {
        scenarios,
        head: state.head,
        repositoryKeys: state.keys,
        observedAt: state.observedAt,
        contexts,
        evidence,
        sessions,
      };
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(wrap));
  const link: Verification["Service"]["link"] = (actor, input) =>
    Effect.gen(function* () {
      const overview = yield* list(actor, input);
      const target = overview.contexts.find(
        (item) => item.feature.id === input.featureID && item.checkout.id === input.checkoutID,
      );
      if (
        !target ||
        target.feature.status !== "active" ||
        target.checkout.state !== "ready" ||
        !target.recordingContext
      )
        return yield* fail("invalid_context");
      const context = target.recordingContext;
      if (
        context.installationID !== input.recording.installationID ||
        context.workspaceID !== input.recording.workspaceID ||
        context.generation !== input.recording.generation
      )
        return yield* fail("wrong_context");
      const recording = yield* recordings.get(actor, input.recording);
      if (recording.state === "recording" || recording.state === "finalizing")
        return yield* fail("capture_in_progress");
      const prKey = key(input);
      const artifactID = digest(
        json([
          prKey,
          input.recording.installationID,
          input.recording.workspaceID,
          input.recording.generation,
          input.recording.recordingID,
        ]),
      );
      const manifest = yield* encodeManifest({
        context: input.recording,
        recording,
        linkedAtHead: overview.head,
      });
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO deckhand_artifacts(id,environment_id,kind,owner_key,record_json) VALUES(${artifactID},${context.installationID},'recording',${artifactID},${json({ prKey, recordingID: recording.id })}) ON CONFLICT DO NOTHING`;
          // First capture wins. Relinking metadata cannot rewrite previously captured provenance.
          yield* sql`INSERT INTO deckhand_evidence_manifests(id,artifact_id,record_json,sha256,captured_at) VALUES(${artifactID},${artifactID},${manifest},${digest(manifest)},${recording.createdAt}) ON CONFLICT DO NOTHING`;
          yield* sql`INSERT INTO deckhand_artifact_links(artifact_id,feature_id,checkout_id,session_id,basis) VALUES(${artifactID},${input.featureID},${input.checkoutID},NULL,'explicit') ON CONFLICT DO NOTHING`;
          const prID = digest(`pr:${prKey}:${context.installationID}`);
          yield* sql`INSERT INTO deckhand_artifacts(id,environment_id,kind,owner_key,record_json) VALUES(${prID},${context.installationID},'pull_request',${prKey},${json({ reference: input.reference })}) ON CONFLICT DO NOTHING`;
          yield* sql`INSERT INTO deckhand_artifact_links(artifact_id,feature_id,checkout_id,session_id,basis) VALUES(${prID},${input.featureID},${input.checkoutID},NULL,'explicit') ON CONFLICT DO NOTHING`;
        }),
      );
      return yield* list(actor, input);
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(wrap));
  const unlink: Verification["Service"]["unlink"] = (actor, input) =>
    Effect.gen(function* () {
      const exists =
        yield* sql`SELECT id FROM deckhand_artifacts WHERE id=${input.artifactID} AND kind='recording' AND json_extract(record_json,'$.prKey')=${key(input)}`;
      if (!exists.length) return yield* fail("missing");
      yield* sql`DELETE FROM deckhand_artifact_links WHERE artifact_id=${input.artifactID} AND feature_id=${input.featureID} AND checkout_id=${input.checkoutID}`;
      return yield* list(actor, input);
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(wrap));
  const scenarioSave: Verification["Service"]["scenarioSave"] = (actor, input) =>
    Effect.gen(function* () {
      const prKey = key(input);
      const original = json(input);
      // A retried save returns the same immutable association even after PR/source changes.
      const existing = yield* sql<{
        actor_id: string;
        request_json: string;
      }>`SELECT actor_id,request_json FROM deckhand_verification_scenarios WHERE pr_key=${prKey} AND id=${input.scenarioID}`;
      if (existing.length) {
        if (existing[0]!.actor_id !== actor || existing[0]!.request_json !== original)
          return yield* fail("scenario_conflict");
        return yield* list(actor, input);
      }
      const view = yield* list(actor, input);
      const baseline = view.evidence.find(
        (item) =>
          item.artifactID === input.baselineArtifactID && item.featureID === input.featureID,
      );
      const followup = view.evidence.find(
        (item) =>
          item.artifactID === input.followupArtifactID && item.featureID === input.featureID,
      );
      const invalid = validateScenarioPair(baseline, followup);
      if (invalid || !baseline || !followup)
        return yield* fail(invalid ?? "scenario_missing_evidence");
      const record: C.VerificationScenario = {
        id: input.scenarioID,
        title: input.title,
        featureID: baseline.featureID,
        baselineArtifactID: baseline.artifactID,
        followupArtifactID: followup.artifactID,
        baselineManifestHash: baseline.manifestHash,
        followupManifestHash: followup.manifestHash,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const count = yield* sql<{
            total: number;
          }>`SELECT COUNT(*) AS total FROM deckhand_verification_scenarios WHERE pr_key=${prKey}`;
          if ((count[0]?.total ?? 0) >= 100) return yield* fail("scenario_limit");
          yield* sql`INSERT INTO deckhand_verification_scenarios(pr_key,id,actor_id,request_json,record_json) VALUES(${prKey},${input.scenarioID},${actor},${original},${json(record)}) ON CONFLICT DO NOTHING`;
          const saved = yield* sql<{
            actor_id: string;
            request_json: string;
          }>`SELECT actor_id,request_json FROM deckhand_verification_scenarios WHERE pr_key=${prKey} AND id=${input.scenarioID}`;
          if (saved[0]?.actor_id !== actor || saved[0]?.request_json !== original)
            return yield* fail("scenario_conflict");
        }),
      );
      return yield* list(actor, input);
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(wrap));
  const scenarioRemove: Verification["Service"]["scenarioRemove"] = (actor, input) =>
    Effect.gen(function* () {
      yield* current(input);
      const row = yield* sql<{
        actor_id: string;
      }>`SELECT actor_id FROM deckhand_verification_scenarios WHERE pr_key=${key(input)} AND id=${input.scenarioID}`;
      if (row.length && row[0]!.actor_id !== actor) return yield* fail("scenario_owned_elsewhere");
      yield* sql`DELETE FROM deckhand_verification_scenarios WHERE pr_key=${key(input)} AND id=${input.scenarioID} AND actor_id=${actor}`;
      return yield* list(actor, input);
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(wrap));
  return Verification.of({
    scenarioSave,
    scenarioRemove,
    readHead: (input) => current(input).pipe(Effect.mapError(wrap)),
    list,
    link,
    unlink,
  });
});
export const layer = Layer.effect(Verification, make);
