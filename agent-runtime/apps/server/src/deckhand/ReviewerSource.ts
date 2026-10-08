import * as Rpc from "@cinderdeck/contracts/deckhand/rpc";
import { blockingWorkspaceIssue } from "@cinderdeck/shared/workspaceChat";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as WorkspaceBackend from "./WorkspaceBackend.ts";
import * as Relationships from "./Relationships.ts";
import { resolveCurrentCheckout } from "./CurrentCheckout.ts";
import * as CheckoutIdentity from "./CheckoutIdentity.ts";
export class ReviewerSourceError extends Schema.TaggedError<ReviewerSourceError>()(
  "ReviewerSourceError",
  {
    reason: Schema.Literals(["stale_context", "dirty_source", "invalid_feature"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.reason === "dirty_source"
      ? "Commit or discard source changes before scheduling a review."
      : "Refresh the feature’s checkout before scheduling a review.";
  }
}
const isSourceError = Schema.is(ReviewerSourceError);
/** Native revisions also cover services, dirty status and display hydration.
 * Only committed heads and ownership identify the reviewed source. */
export function reviewerContextMatches(a: Rpc.ReviewerLaunchContext, b: Rpc.ReviewerLaunchContext) {
  return (
    a.featureId === b.featureId &&
    a.sourceCheckoutId === b.sourceCheckoutId &&
    a.sourceWorkspaceID === b.sourceWorkspaceID &&
    a.sourceGeneration === b.sourceGeneration &&
    a.repositories.length === b.repositories.length &&
    a.repositories.every((repo) =>
      b.repositories.some(
        (other) =>
          repo.repositoryID === other.repositoryID &&
          repo.sourcePhysicalId === other.sourcePhysicalId &&
          repo.repositoryPhysicalId === other.repositoryPhysicalId &&
          repo.commit === other.commit,
      ),
    )
  );
}
// Shared service-domain resolution is used by both preview and managed creation;
// calling the general creation RPC cannot bypass source provenance checks.
export const resolveReviewerSource = (input: {
  featureId: string;
  sourceCheckoutId: string;
  repositoryPhysicalId?: string;
}) =>
  Effect.gen(function* () {
    const store = yield* Relationships.Relationships;
    const backend = yield* WorkspaceBackend.WorkspaceBackend;
    const identities = yield* CheckoutIdentity.CheckoutIdentity;
    const sql = yield* SqlClient.SqlClient;
    const feature = yield* store.feature(input.featureId);
    const origin = yield* store.checkout(input.sourceCheckoutId);
    const links =
      yield* sql`SELECT checkout_id FROM deckhand_feature_checkouts WHERE feature_id=${feature.id} AND checkout_id=${origin.id}`;
    if (!links.length || feature.status !== "active" || feature.workspaceId !== origin.workspaceId)
      return yield* new ReviewerSourceError({ reason: "invalid_feature" });
    const checkout = yield* resolveCurrentCheckout(origin.id);
    const workspace = yield* store.workspace(checkout.workspaceId);
    if (
      origin.repositories.length !== checkout.repositories.length ||
      origin.repositories.some(
        (repo) =>
          !checkout.repositories.some(
            (current) =>
              current.physicalId === repo.physicalId &&
              current.repositoryPhysicalId === repo.repositoryPhysicalId,
          ),
      )
    )
      return yield* new ReviewerSourceError({ reason: "stale_context" });
    if (
      checkout.state !== "ready" ||
      workspace.state !== "active" ||
      workspace.backend !== "cinderdeck" ||
      !checkout.nativeGeneration
    )
      return yield* new ReviewerSourceError({ reason: "invalid_feature" });
    const source = yield* backend.context(checkout.laneId ?? workspace.ownerId);
    const primary = checkout.laneId ? yield* backend.context(workspace.ownerId) : source;
    if (
      source.hello.installationID !== workspace.environmentId ||
      primary.hello.installationID !== workspace.environmentId ||
      !source.resource.available ||
      !primary.resource.available ||
      !source.resource.workspace ||
      !primary.resource.workspace ||
      primary.resource.workspace.lane ||
      blockingWorkspaceIssue(source.resource.workspace.issues) ||
      blockingWorkspaceIssue(primary.resource.workspace.issues)
    )
      return yield* new ReviewerSourceError({ reason: "stale_context" });
    const native = source.resource.workspace;
    const base = primary.resource.workspace;
    if (
      !native.repos.length ||
      native.repos.length > 64 ||
      native.repos.length !== checkout.repositories.length ||
      native.repos.length !== base.repos.length ||
      new Set(native.repos.map((repo) => repo.id)).size !== native.repos.length
    )
      return yield* new ReviewerSourceError({ reason: "stale_context" });
    const repositories = yield* Effect.forEach(native.repos, (repo) =>
      Effect.gen(function* () {
        const actual = yield* identities.resolve(repo.path);
        const bound = checkout.repositories.find((item) => item.physicalId === actual.physicalId);
        const parent = base.repos.find((item) => item.id === repo.id);
        if (
          !parent ||
          !bound ||
          bound.repositoryPhysicalId !== actual.repositoryPhysicalId ||
          !actual.commit
        )
          return yield* new ReviewerSourceError({ reason: "stale_context" });
        const parentPhysical = yield* identities.resolve(parent.path);
        if (parentPhysical.repositoryPhysicalId !== actual.repositoryPhysicalId)
          return yield* new ReviewerSourceError({ reason: "stale_context" });
        // Inspect HEAD, not the worktree. Uncommitted edits never enter the reviewer lane.
        const after = yield* identities.resolve(repo.path);
        if (after.commit !== actual.commit || after.physicalId !== actual.physicalId)
          return yield* new ReviewerSourceError({ reason: "stale_context" });
        return {
          repositoryID: repo.id,
          sourcePhysicalId: actual.physicalId,
          repositoryPhysicalId: actual.repositoryPhysicalId,
          commit: actual.commit,
        };
      }),
    );
    const selected = input.repositoryPhysicalId
      ? repositories.find((repo) => repo.sourcePhysicalId === input.repositoryPhysicalId)
      : repositories[0];
    if (!selected) return yield* new ReviewerSourceError({ reason: "stale_context" });
    return {
      installationID: workspace.environmentId,
      workspaceID: workspace.ownerId,
      generation: primary.resource.generation,
      revision: primary.resource.revision,
      repositoryID: selected.repositoryID,
      repositoryPath: native.repos.find((repo) => repo.id === selected.repositoryID)!.path,
      title: feature.title,
      reviewerContext: {
        featureId: feature.id,
        sourceCheckoutId: origin.id,
        sourceWorkspaceID: source.resource.workspaceID,
        sourceGeneration: source.resource.generation,
        sourceRevision: source.resource.revision,
        repositories,
      },
    } satisfies Rpc.ReviewerLaunchPreview;
  }).pipe(
    Effect.mapError((cause) =>
      isSourceError(cause) ? cause : new ReviewerSourceError({ reason: "stale_context", cause }),
    ),
  );
