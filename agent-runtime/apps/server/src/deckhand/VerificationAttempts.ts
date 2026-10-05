// @effect-diagnostics nodeBuiltinImport:off - immutable operation identities and local proof digests.
import * as NodeCrypto from "node:crypto";
import * as C from "@cinderdeck/contracts/deckhand/verificationAttemptsRpc";
import * as B from "@cinderdeck/contracts/deckhand/builds";
import * as R from "@cinderdeck/contracts/deckhand/recordingsRpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Builds from "./Builds.ts";
import * as Verification from "./Verification.ts";
import * as Recordings from "./Recordings.ts";
import * as Relationships from "./Relationships.ts";
import * as CurrentCheckout from "./CurrentCheckout.ts";
import * as WorkspaceBackend from "./WorkspaceBackend.ts";
import * as CheckoutIdentity from "./CheckoutIdentity.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Migrations from "./Migrations.ts";
import * as OwnedPreviewAttestations from "./OwnedPreviewAttestations.ts";
import type { OwnedPreviewProof } from "@cinderdeck/contracts/deckhand/ownedPreviewRpc";
import { resolveReviewerSource } from "./ReviewerSource.ts";
import { makeKeyedSerialExecutor } from "../orchestration-v2/KeyedSerialExecutor.ts";
const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const encode = Schema.encodeEffect(Schema.fromJsonString(C.VerificationAttempt));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(C.VerificationAttempt));
const encodeRecording = Schema.encodeEffect(Schema.fromJsonString(R.Recording));
const encodePrepare = Schema.encodeEffect(Schema.fromJsonString(B.BuildPrepareInput));
const encodePreview = Schema.encodeEffect(Schema.fromJsonString(C.AttemptPreview));
const isError = Schema.is(C.AttemptError);
type BoundScope = Pick<C.AttemptPreview, "featureID" | "checkoutID" | "context">;
const scopeMatches = (preview: BoundScope, bound: BoundScope) =>
  preview.featureID === bound.featureID &&
  preview.checkoutID === bound.checkoutID &&
  preview.context.installationID === bound.context.installationID &&
  preview.context.workspaceID === bound.context.workspaceID &&
  preview.context.generation === bound.context.generation;
export class VerificationAttempts extends Context.Service<
  VerificationAttempts,
  {
    readonly preview: (
      actor: string,
      input: C.AttemptPreviewInput,
      bound?: BoundScope,
    ) => Effect.Effect<C.AttemptPreview, C.AttemptError>;
    readonly start: (
      actor: string,
      input: C.AttemptStart,
      bound?: BoundScope,
    ) => Effect.Effect<C.VerificationAttempt, C.AttemptError>;
    readonly get: (
      actor: string,
      input: C.AttemptLookup,
      bound?: BoundScope,
    ) => Effect.Effect<C.VerificationAttempt, C.AttemptError>;
    readonly list: (
      actor: string,
      input: { readonly reference: C.AttemptPreviewInput["reference"] },
      bound?: BoundScope,
    ) => Effect.Effect<ReadonlyArray<C.AttemptSummary>, C.AttemptError>;
    readonly advance: (
      actor: string,
      input: C.AttemptAdvance,
      bound?: BoundScope,
    ) => Effect.Effect<C.VerificationAttempt, C.AttemptError>;
  }
>()("@cinderdeck/server/deckhand/VerificationAttempts") {}
// Native describe owns the complete service/task dependency graph. A checkout may
// also contain unrelated repositories; admit only the described, physically bound subset.
export function pinBuildRepositories(
  descriptor: B.BuildDescriptor,
  source: ReadonlyArray<{
    repositoryID: string;
    sourcePhysicalId: string;
    repositoryPhysicalId: string;
    commit: string;
  }>,
  current: { readonly keys: ReadonlyArray<string>; readonly head: string },
):
  | { readonly repositories: B.BuildPrepareInput["expectedRepositories"] }
  | { readonly reason: "incomplete_source" | "unrelated_repository" | "pr_head_mismatch" } {
  if (
    !descriptor.repositories.length ||
    descriptor.repositories.length > 16 ||
    new Set(descriptor.repositories.map((repo) => repo.repositoryID)).size !==
      descriptor.repositories.length
  )
    return { reason: "incomplete_source" };
  const repositories: B.BuildPrepareInput["expectedRepositories"][number][] = [];
  for (const repo of descriptor.repositories) {
    const bound = source.find((item) => item.repositoryID === repo.repositoryID);
    if (
      !bound ||
      repo.checkoutPhysicalID !== bound.sourcePhysicalId ||
      repo.repositoryPhysicalID !== bound.repositoryPhysicalId ||
      repo.head !== bound.commit ||
      !repo.complete ||
      repo.fingerprint?.state !== "complete" ||
      !repo.fingerprint.hash ||
      repo.fingerprint.untrackedCount !== 0 ||
      repo.fingerprint.trackedCount !== 0 ||
      repo.fingerprint.omittedCount !== 0
    )
      return { reason: "incomplete_source" };
    repositories.push({
      repositoryID: repo.repositoryID,
      checkoutPhysicalID: bound.sourcePhysicalId,
      repositoryPhysicalID: bound.repositoryPhysicalId,
      head: bound.commit,
      canonicalRepositoryKeys: repo.canonicalRepositoryKeys,
    });
  }
  const matched = repositories.filter((repo) =>
    repo.canonicalRepositoryKeys.some((key) => current.keys.includes(key)),
  );
  if (!matched.length) return { reason: "unrelated_repository" };
  if (matched.some((repo) => repo.head !== current.head)) return { reason: "pr_head_mismatch" };
  return { repositories };
}
// Native JSON dictionaries and RPC schema encoding may order the same fields
// differently. Freshness compares their immutable facts, never insertion order.
export function verificationPreviewIdentity(value: C.AttemptPreview): string {
  const facts = {
    reference: value.reference,
    featureID: value.featureID,
    checkoutID: value.checkoutID,
    serviceID: value.serviceID,
    context: value.context,
    head: value.head,
    repositoryKeys: [...value.repositoryKeys].sort(),
    definitionHash: value.descriptor.definitionHash,
    workflowHash: value.descriptor.workflowHash,
    adapter: value.descriptor.adapter,
    repositories: value.repositories,
    fingerprints: value.descriptor.repositories.map((repo) => ({
      repositoryID: repo.repositoryID,
      fingerprint: repo.fingerprint,
    })),
  };
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item !== null && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, canonical(entry)]),
          )
        : item;
  return JSON.stringify(canonical(facts));
}

export function assessAttempt(
  preview: C.AttemptPreview,
  receipt: B.BuildReceipt,
  recording: R.Recording,
  owned?: { proof: OwnedPreviewProof; operationKey: string },
): { verdict: C.VerificationAttempt["verdict"]; buildAndChecksMatch: boolean } {
  if (receipt.checks.some((check) => check.status === "failed"))
    return { verdict: "checks_failed", buildAndChecksMatch: false };
  const expected = preview.repositories;
  const stable = (snapshots: typeof receipt.repositoriesAtStart) =>
    snapshots.length === expected.length &&
    expected.every((repo) => {
      const start = receipt.repositoriesAtStart.find(
        (item) => item.repositoryID === repo.repositoryID,
      );
      const item = snapshots.find((item) => item.repositoryID === repo.repositoryID);
      return Boolean(
        item &&
        start &&
        item.complete &&
        item.checkoutPhysicalID === repo.checkoutPhysicalID &&
        item.repositoryPhysicalID === repo.repositoryPhysicalID &&
        item.head === repo.head &&
        item.fingerprint?.state === "complete" &&
        item.fingerprint.hash &&
        item.fingerprint.hash === start.fingerprint?.hash &&
        item.fingerprint.untrackedCount === 0 &&
        item.fingerprint.trackedCount === 0 &&
        item.fingerprint.omittedCount === 0 &&
        repo.canonicalRepositoryKeys.every((key) => item.canonicalRepositoryKeys.includes(key)),
      );
    });
  const required = preview.descriptor.adapter.requiredTaskIDs;
  const checks =
    required.length > 0 &&
    required.every((task) =>
      receipt.checks.some(
        (check) =>
          check.taskID === task &&
          check.status === "succeeded" &&
          check.finishedAt &&
          check.outcomeHash &&
          check.buildMatched === true,
      ),
    );
  const proof = recording.buildProof;
  const observed = (value: B.BuildObservation | undefined | null, phase: "start" | "end") =>
    Boolean(
      value &&
      value.phase === phase &&
      value.receiptID === receipt.id &&
      value.workspaceID === preview.context.workspaceID &&
      value.serviceID === preview.serviceID &&
      value.state === "matched" &&
      value.sourceUnchanged &&
      value.processMatched &&
      value.stampMatched &&
      value.artifactSHA256 === receipt.artifact?.sha256 &&
      value.servedArtifactSHA256 === receipt.artifact?.sha256,
    );
  const startTime = Date.parse(proof?.start.observedAt ?? "");
  const endTime = Date.parse(proof?.end?.observedAt ?? "");
  const recordingStart = Date.parse(recording.createdAt);
  const boundaries =
    Number.isFinite(startTime) &&
    Number.isFinite(endTime) &&
    Number.isFinite(recordingStart) &&
    endTime >= startTime &&
    Math.abs(startTime - recordingStart) <= 10000 &&
    Math.abs(endTime - (recordingStart + recording.duration * 1000)) <= 10000;
  const captureSources = expected.every((repo) =>
    recording.repositories.some(
      (item) =>
        item.workspaceID === preview.context.workspaceID &&
        item.repositoryID === repo.repositoryID &&
        item.repositoryPhysicalId === repo.repositoryPhysicalID &&
        item.head === repo.head &&
        item.endHead === repo.head &&
        item.changedFiles === 0 &&
        item.snapshotComplete === true &&
        item.sourceFingerprint?.state === "complete" &&
        item.endSourceFingerprint?.state === "complete" &&
        item.sourceFingerprint.hash === item.endSourceFingerprint.hash &&
        item.sourceFingerprint.hash ===
          receipt.repositoriesAtStart.find((source) => source.repositoryID === repo.repositoryID)
            ?.fingerprint?.hash,
    ),
  );
  const buildAndChecksMatch = Boolean(
    boundaries &&
    captureSources &&
    checks &&
    receipt.buildRunID &&
    receipt.definitionHash === preview.descriptor.definitionHash &&
    receipt.workflowHash === preview.descriptor.workflowHash &&
    stable(receipt.repositoriesAtStart) &&
    stable(receipt.repositoriesAtEnd) &&
    receipt.artifact &&
    receipt.launch &&
    recording.state === "ready" &&
    recording.playable &&
    proof?.receiptID === receipt.id &&
    proof.artifactSHA256 === receipt.artifact.sha256 &&
    proof.launchNonceHash === receipt.launch.nonceHash &&
    observed(proof.start, "start") &&
    observed(proof.end, "end"),
  );
  const targetMatches =
    owned &&
    OwnedPreviewAttestations.ownedPreviewMatches(
      owned.proof,
      { operationKey: owned.operationKey, preview },
      receipt.id,
      recording,
    );
  return {
    verdict: buildAndChecksMatch && targetMatches ? "matches" : "incomplete",
    buildAndChecksMatch,
  };
}
const make = Effect.gen(function* () {
  yield* Migrations.migrate;
  const sql = yield* SqlClient.SqlClient;
  const builds = yield* Builds.Builds;
  const currentCheckouts = yield* CurrentCheckout.CurrentCheckout;
  const relationships = yield* Relationships.Relationships;
  const verification = yield* Verification.Verification;
  const recordings = yield* Recordings.Recordings;
  const ownedAttestations = yield* OwnedPreviewAttestations.OwnedPreviewAttestations;
  const sourceDependencies = yield* Effect.context<
    | Relationships.Relationships
    | WorkspaceBackend.WorkspaceBackend
    | CheckoutIdentity.CheckoutIdentity
    | ProcessRunner.ProcessRunner
    | SqlClient.SqlClient
  >();
  const locks = yield* makeKeyedSerialExecutor<string>();
  const fail = (reason: string) => new C.AttemptError({ reason });
  const wrap = (cause: unknown) => (isError(cause) ? cause : fail("unavailable"));
  const assertCurrentScope = (preview: C.AttemptPreview) =>
    Effect.gen(function* () {
      const checkout = yield* currentCheckouts.current(preview.checkoutID);
      const workspace = yield* relationships.workspace(checkout.workspaceId);
      if (
        checkout.backend !== "cinderdeck" ||
        checkout.state !== "ready" ||
        workspace.state !== "active" ||
        checkout.workspaceGeneration !== workspace.generation ||
        checkout.environmentId !== preview.context.installationID ||
        checkout.nativeGeneration !== preview.context.generation ||
        (checkout.laneId ?? workspace.ownerId) !== preview.context.workspaceID ||
        preview.repositories.some(
          (repo) =>
            !checkout.repositories.some(
              (current) =>
                current.physicalId === repo.checkoutPhysicalID &&
                current.repositoryPhysicalId === repo.repositoryPhysicalID,
            ),
        )
      )
        return yield* fail("current_checkout_changed");
    });
  const now = () => DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const phaseKey = (key: string, phase: string) => `verification:${hash(`${key}:${phase}`)}`;
  const prKey = (reference: C.AttemptPreviewInput["reference"]) =>
    hash(
      `${reference.projectId}:${reference.host ?? "github.com"}:${reference.repository.toLowerCase()}:${reference.number}`,
    );
  const preview: VerificationAttempts["Service"]["preview"] = (actor, input, bound) =>
    Effect.gen(function* () {
      if (bound && (input.featureID !== bound.featureID || input.checkoutID !== bound.checkoutID))
        return yield* fail("stale_binding");
      const current = yield* verification.readHead(input);
      if (!current.head) return yield* fail("unsupported_pr_head");
      const source = yield* resolveReviewerSource({
        featureId: input.featureID,
        sourceCheckoutId: input.checkoutID,
      }).pipe(Effect.provideContext(sourceDependencies));
      const context = {
        installationID: source.installationID,
        workspaceID: source.reviewerContext.sourceWorkspaceID,
        generation: source.reviewerContext.sourceGeneration,
      };
      if (bound && !scopeMatches({ ...input, context }, bound)) return yield* fail("stale_binding");
      const descriptor = yield* builds.describe(actor, { ...context, serviceID: input.serviceID });
      if (descriptor.adapter.serviceID !== input.serviceID) return yield* fail("stale_context");
      const pinned = pinBuildRepositories(descriptor, source.reviewerContext.repositories, {
        keys: current.keys,
        head: current.head,
      });
      if ("reason" in pinned) return yield* fail(pinned.reason);
      const repositories = pinned.repositories;
      return {
        ...input,
        context,
        head: current.head,
        repositoryKeys: current.keys,
        observedAt: current.observedAt,
        descriptor,
        repositories,
      };
    }).pipe(Effect.mapError(wrap));
  const read = (actor: string, key: string, bound?: BoundScope) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        record_json: string;
      }>`SELECT record_json FROM deckhand_verification_attempts WHERE operation_key=${key} AND actor_id=${actor}`;
      if (!rows[0]) return yield* fail("missing");
      const value = yield* decode(rows[0].record_json);
      if (bound && !scopeMatches(value.preview, bound)) return yield* fail("stale_binding");
      return value;
    });
  const save = (actor: string, value: C.VerificationAttempt) =>
    Effect.gen(function* () {
      const record = yield* encode({ ...value, updatedAt: yield* now() });
      yield* sql`UPDATE deckhand_verification_attempts SET record_json=${record} WHERE operation_key=${value.operationKey} AND actor_id=${actor}`;
      return yield* decode(record);
    });
  const matchesReceipt = (value: C.VerificationAttempt, receipt: B.BuildReceipt) =>
    Effect.gen(function* () {
      const expected: B.BuildPrepareInput = {
        ...value.preview.context,
        operationKey: phaseKey(value.operationKey, "prepare"),
        serviceID: value.preview.serviceID,
        expectedDefinitionHash: value.preview.descriptor.definitionHash,
        expectedWorkflowHash: value.preview.descriptor.workflowHash,
        expectedRepositories: value.preview.repositories,
        requiredTaskIDs: value.preview.descriptor.adapter.requiredTaskIDs,
      };
      if ((yield* encodePrepare(expected)) !== (yield* encodePrepare(receipt.request)))
        return yield* fail("receipt_identity_mismatch");
    });
  const applyReceipt = (actor: string, value: C.VerificationAttempt, receipt: B.BuildReceipt) =>
    Effect.gen(function* () {
      yield* matchesReceipt(value, receipt);
      if (value.pendingAction) {
        const action = value.pendingAction;
        const observed = receipt.operations.find(
          (item) =>
            item.operationKey ===
              (value.pendingNativeOperationKey ?? phaseKey(value.operationKey, action)) &&
            item.action === (action === "cancel" || action === "finalize" ? "finish" : action),
        );
        if (!observed || observed.state === "pending" || observed.state === "unknown")
          return yield* save(actor, {
            ...value,
            receipt,
            phase: "unknown",
            detail:
              "The saved action has no definitive native receipt. Recover this same attempt; do not repeat the action.",
          });
      }
      const phase: C.VerificationAttempt["phase"] =
        receipt.state === "cancelled"
          ? "cancelled"
          : receipt.state === "finalized"
            ? "completed"
            : receipt.state === "failed"
              ? "failed"
              : receipt.state === "unknown"
                ? "unknown"
                : receipt.state === "preparing"
                  ? "preparing"
                  : receipt.state === "checking"
                    ? "checking"
                    : receipt.state === "launching"
                      ? "launching"
                      : "ready";
      const targetProof = value.recordingProof
        ? yield* ownedAttestations.get(actor, value.recordingProof.id)
        : null;
      const liveRecording =
        value.recordingProof && targetProof
          ? yield* recordings
              .get(actor, { ...value.preview.context, recordingID: value.recordingProof.id })
              .pipe(
                Effect.catch(() =>
                  Effect.succeed({ ...value.recordingProof!, videoIntegrity: "unknown" as const }),
                ),
              )
          : value.recordingProof;
      const assessment = liveRecording
        ? assessAttempt(
            value.preview,
            receipt,
            liveRecording,
            targetProof ? { proof: targetProof, operationKey: value.operationKey } : undefined,
          )
        : null;
      return yield* save(actor, {
        ...value,
        receipt,
        buildAndChecksMatch: assessment?.buildAndChecksMatch ?? false,
        phase,
        pendingAction: null,
        verdict:
          value.recordingProof && phase === "completed"
            ? value.currentHead && value.currentHead !== value.preview.head
              ? "earlier_revision"
              : assessment!.verdict
            : value.verdict,
        detail:
          assessment?.verdict === "matches"
            ? "Source, required checks, declared served artifact and the owned browser recording match this PR revision."
            : assessment?.buildAndChecksMatch
              ? "Build and required check receipts match the pinned source and served artifact. The recording target is not attested to this service; full verification remains incomplete."
              : (receipt.detail ?? "Native build receipt retained. Refresh to inspect progress."),
      });
    });
  const unknown = (actor: string, value: C.VerificationAttempt) =>
    save(actor, {
      ...value,
      phase: "unknown",
      verdict: value.verdict === "matches" ? "incomplete" : value.verdict,
      detail:
        "The native outcome is uncertain. Recover this saved attempt before taking another action.",
    });
  const reconcile = (actor: string, value: C.VerificationAttempt) =>
    Effect.gen(function* () {
      const receipt = yield* builds
        .get(actor, {
          ...value.preview.context,
          operationKey: phaseKey(value.operationKey, "prepare"),
        })
        .pipe(Effect.result);
      let next =
        receipt._tag === "Success"
          ? yield* applyReceipt(actor, value, receipt.success)
          : yield* unknown(actor, value);
      const head = yield* verification
        .readHead({ reference: value.preview.reference })
        .pipe(Effect.result);
      if (head._tag === "Success")
        next = yield* save(actor, {
          ...next,
          currentHead: head.success.head,
          verdict:
            next.recordingProof && head.success.head && head.success.head !== value.preview.head
              ? "earlier_revision"
              : next.verdict,
        });
      else
        next = yield* save(actor, {
          ...next,
          currentHead: null,
          verdict: next.verdict === "matches" ? "incomplete" : next.verdict,
          detail:
            "The current PR head is unavailable. Saved proof is retained; refresh before relying on a current-revision result.",
        });
      return next;
    });
  const get: VerificationAttempts["Service"]["get"] = (actor, input, bound) =>
    locks
      .withLock(
        input.operationKey,
        Effect.gen(function* () {
          return yield* reconcile(actor, yield* read(actor, input.operationKey, bound));
        }),
      )
      .pipe(Effect.mapError(wrap));
  const start: VerificationAttempts["Service"]["start"] = (actor, input, bound) =>
    locks
      .withLock(
        input.operationKey,
        Effect.gen(function* () {
          const rows = yield* sql<{
            actor_id: string;
            original_json: string;
            record_json: string;
          }>`SELECT actor_id,original_json,record_json FROM deckhand_verification_attempts WHERE operation_key=${input.operationKey}`;
          if (bound && !scopeMatches(input.preview, bound)) return yield* fail("stale_binding");
          const originalJSON = yield* encodePreview(input.preview);
          if (rows[0]) {
            if (rows[0].actor_id !== actor || rows[0].original_json !== originalJSON)
              return yield* fail("operation_conflict");
            return yield* reconcile(actor, yield* decode(rows[0].record_json));
          }
          const fresh = yield* preview(actor, input.preview, bound);
          if (verificationPreviewIdentity(fresh) !== verificationPreviewIdentity(input.preview))
            return yield* fail("stale_preview");
          const createdAt = yield* now();
          let value: C.VerificationAttempt = {
            operationKey: input.operationKey,
            preview: input.preview,
            createdAt,
            updatedAt: createdAt,
            phase: "preparing",
            pendingAction: "prepare",
            receipt: null,
            recordingID: null,
            recordingProof: null,
            proofHash: null,
            buildAndChecksMatch: false,
            verdict: "incomplete",
            currentHead: fresh.head,
            detail: "Preparing the declared build in the selected checkout.",
          };
          const encoded = yield* encode(value);
          yield* sql`INSERT INTO deckhand_verification_attempts(operation_key,actor_id,pr_key,original_json,record_json) VALUES(${input.operationKey},${actor},${prKey(input.preview.reference)},${originalJSON},${encoded})`;
          const receipt = yield* builds
            .prepare(actor, {
              ...fresh.context,
              operationKey: phaseKey(input.operationKey, "prepare"),
              serviceID: fresh.serviceID,
              expectedDefinitionHash: fresh.descriptor.definitionHash,
              expectedWorkflowHash: fresh.descriptor.workflowHash,
              expectedRepositories: fresh.repositories,
              requiredTaskIDs: fresh.descriptor.adapter.requiredTaskIDs,
            })
            .pipe(Effect.result);
          value =
            receipt._tag === "Success"
              ? yield* applyReceipt(actor, value, receipt.success)
              : yield* unknown(actor, value);
          return value;
        }),
      )
      .pipe(Effect.mapError(wrap));
  const advance: VerificationAttempts["Service"]["advance"] = (actor, input, bound) =>
    locks
      .withLock(
        input.operationKey,
        Effect.gen(function* () {
          if (input.cancellationKey && input.action !== "cancel")
            return yield* fail("invalid_cancellation_key");
          let value = yield* reconcile(actor, yield* read(actor, input.operationKey, bound));
          if (input.action !== "cancel") yield* assertCurrentScope(value.preview);
          const nativeOperationKey = input.cancellationKey
            ? phaseKey(value.operationKey, `cancel:${input.cancellationKey}`)
            : phaseKey(value.operationKey, input.action);
          const explicitCancellationRetry =
            input.action === "cancel" &&
            Boolean(input.cancellationKey) &&
            nativeOperationKey !== value.pendingNativeOperationKey;
          if (
            !value.receipt ||
            ((value.phase === "unknown" || value.pendingAction) &&
              (input.action !== "cancel" ||
                ((value.pendingAction === "cancel" || value.pendingAction === "finalize") &&
                  !explicitCancellationRetry)))
          )
            return yield* fail("recover_before_action");
          const nativeReceipt = value.receipt;
          if (["completed", "cancelled"].includes(value.phase)) return value;
          if (input.action !== "cancel") {
            const head = yield* verification.readHead({ reference: value.preview.reference });
            if (head.head !== value.preview.head && input.action !== "finalize")
              return yield* fail("pr_head_changed");
            value = { ...value, currentHead: head.head };
          }
          if (
            (input.action === "launch" || input.action === "checks") &&
            nativeReceipt.operations.some(
              (operation) => operation.operationKey === phaseKey(value.operationKey, input.action),
            )
          )
            return value;
          if (input.action === "launch" && !["ready", "running"].includes(nativeReceipt.state))
            return yield* fail("build_not_ready");
          if (input.action === "checks" && !["ready", "running"].includes(nativeReceipt.state))
            return yield* fail("build_not_ready");
          if (input.action === "finalize") {
            if (!input.recordingID) return yield* fail("recording_required");
            const recording = yield* recordings.get(actor, {
              ...value.preview.context,
              recordingID: input.recordingID,
            });
            if (recording.state !== "ready" || !recording.playable)
              return yield* fail("recording_incomplete");
            const targetProof = yield* ownedAttestations.get(actor, recording.id);
            const assessment = assessAttempt(
              value.preview,
              nativeReceipt,
              recording,
              targetProof ? { proof: targetProof, operationKey: value.operationKey } : undefined,
            );
            const manifest = yield* encodeRecording(recording);
            value = {
              ...value,
              recordingID: recording.id,
              recordingProof: recording,
              proofHash: hash(manifest),
              verdict:
                value.currentHead !== value.preview.head ? "earlier_revision" : assessment.verdict,
              buildAndChecksMatch: assessment.buildAndChecksMatch,
            };
          }
          value = yield* save(actor, {
            ...value,
            phase:
              input.action === "launch"
                ? "launching"
                : input.action === "checks"
                  ? "checking"
                  : "finalizing",
            pendingAction: input.action,
            pendingNativeOperationKey: nativeOperationKey,
          });
          const action = {
            ...value.preview.context,
            receiptID: nativeReceipt.id,
            operationKey: nativeOperationKey,
          };
          const result = yield* (
            input.action === "launch"
              ? builds.launch(actor, action)
              : input.action === "checks"
                ? builds.runChecks(actor, action)
                : builds.finish(actor, { ...action, cancel: input.action === "cancel" })
          ).pipe(Effect.result);
          return result._tag === "Success"
            ? yield* applyReceipt(actor, value, result.success)
            : yield* unknown(actor, value);
        }),
      )
      .pipe(Effect.mapError(wrap));
  const list: VerificationAttempts["Service"]["list"] = (actor, input, bound) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        record_json: string;
      }>`SELECT record_json FROM deckhand_verification_attempts WHERE actor_id=${actor} AND pr_key=${prKey(input.reference)} ORDER BY json_extract(record_json,'$.createdAt') DESC LIMIT 30`;
      const head = yield* verification.readHead(input).pipe(Effect.result);
      const values = yield* Effect.forEach(rows, (row) => decode(row.record_json));
      return values
        .filter((value) => !bound || scopeMatches(value.preview, bound))
        .map((value): C.VerificationAttempt => ({
          ...value,
          currentHead: head._tag === "Success" ? head.success.head : null,
          verdict:
            value.recordingProof &&
            head._tag === "Success" &&
            head.success.head &&
            head.success.head !== value.preview.head
              ? "earlier_revision"
              : value.verdict === "matches"
                ? "incomplete"
                : value.verdict,
        }))
        .map(C.toAttemptSummary);
    }).pipe(Effect.mapError(wrap));
  return VerificationAttempts.of({ preview, start, get, list, advance });
});
export const layer = Layer.effect(VerificationAttempts, make);
