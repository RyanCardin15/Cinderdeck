// @effect-diagnostics nodeBuiltinImport:off - A bounded hash prevents native actor-name truncation collisions.
import * as NodeCrypto from "node:crypto";
import * as C from "@t3tools/contracts/deckhand/linkedWorkRpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Migrations from "./Migrations.ts";
import * as CurrentCheckout from "./CurrentCheckout.ts";
import * as Relationships from "./Relationships.ts";
import * as ManagedSessions from "./ManagedSessions.ts";
import * as IntegrationHub from "./IntegrationHub.ts";
import * as RecordingTransport from "./RecordingTransport.ts";
import * as CheckoutIdentity from "./CheckoutIdentity.ts";
export class LinkedWorkBridge extends Context.Service<
  LinkedWorkBridge,
  {
    readonly publish: (
      actorID: string,
      input: C.LinkedWorkPublishInput,
    ) => Effect.Effect<C.LinkedWorkRecord, C.LinkedWorkError>;
    readonly resolve: (
      input: C.LinkedWorkTarget,
    ) => Effect.Effect<C.LinkedWorkResolution, C.LinkedWorkError>;
  }
>()("t3/deckhand/LinkedWorkBridge") {}
const isError = Schema.is(C.LinkedWorkError);
const decodePublication = Schema.decodeUnknownEffect(C.LinkedWorkPublication);
const decodeRecord = Schema.decodeUnknownEffect(C.LinkedWorkRecord);
const encodePublication = Schema.encodeEffect(Schema.fromJsonString(C.LinkedWorkPublication));
const actorKey = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 48);
/** Only canonical links already attached by upstream orchestration are exported. */
export function canonicalHostingLink(pr: {
  host: string;
  repository: string;
  number: number;
  url: string;
}) {
  try {
    const url = new URL(pr.url);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== pr.host.toLowerCase() ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !Number.isSafeInteger(pr.number) ||
      pr.number <= 0
    )
      return null;
    if (
      url.pathname !== `/${pr.repository}/pull/${pr.number}` &&
      url.pathname !== `/${pr.repository}/-/merge_requests/${pr.number}`
    )
      return null;
    return { host: pr.host, repository: pr.repository, number: pr.number, url: pr.url };
  } catch {
    return null;
  }
}
export const layer = Layer.effect(
  LinkedWorkBridge,
  Effect.gen(function* () {
    yield* Migrations.migrate;
    const sql = yield* SqlClient.SqlClient;
    const scope = yield* Scope.Scope;
    const relationships = yield* Relationships.Relationships;
    const ownershipDependencies = yield* Effect.context<
      SqlClient.SqlClient | Relationships.Relationships
    >();
    const currentCheckout = (id: string) =>
      CurrentCheckout.resolveCurrentCheckout(id).pipe(Effect.provide(ownershipDependencies));

    const sessions = yield* ManagedSessions.ManagedSessions;
    const hub = yield* IntegrationHub.IntegrationHub;
    const transport = yield* RecordingTransport.RecordingTransport;
    const identities = yield* CheckoutIdentity.CheckoutIdentity;
    const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const fail = (reason: C.LinkedWorkError["reason"]) => new C.LinkedWorkError({ reason });
    const normalize = (cause: unknown) => (isError(cause) ? cause : fail("unavailable"));
    const saved = (threadId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          id: string;
        }>`SELECT id FROM deckhand_sessions WHERE thread_id = ${threadId}`;
        if (!rows[0]) return yield* fail("missing");
        const session = yield* relationships.session(rows[0].id);
        const checkout = yield* currentCheckout(session.checkoutId);
        const workspace = yield* relationships.workspace(checkout.workspaceId);
        const feature = yield* relationships.feature(session.featureId);
        if (
          workspace.backend !== "cinderdeck" ||
          checkout.environmentId !== workspace.environmentId ||
          !checkout.nativeGeneration
        )
          return yield* fail("wrong_context");
        return {
          session,
          checkout,
          workspace,
          feature,
          workspaceID: checkout.laneId ?? workspace.ownerId,
        };
      });
    const publish = (actorID: string, input: C.LinkedWorkPublishInput) =>
      Effect.gen(function* () {
        const context = yield* saved(input.threadId);
        const owned = yield* sql<{
          actor_id: string;
        }>`SELECT actor_id FROM deckhand_managed_launches WHERE json_extract(record_json, '$.threadId') = ${input.threadId} AND json_extract(record_json, '$.state') = 'accepted' LIMIT 1`;
        if (!owned[0] || owned[0].actor_id !== actorID) return yield* fail("wrong_actor");
        const native = yield* hub.resource(context.workspaceID);
        if (
          native.hello.installationID !== context.workspace.environmentId ||
          !native.resource.available ||
          native.resource.generation !== context.checkout.nativeGeneration ||
          !native.resource.workspace
        )
          return yield* fail("wrong_context");
        const observed = (yield* sessions.list({
          installationID: context.workspace.environmentId,
          workspaceID: context.workspaceID,
          generation: context.checkout.nativeGeneration!,
          limit: 20,
        })).find((item) => item.binding.id === context.session.id);
        const repos = native.resource.workspace.repos.filter((repo) =>
          context.checkout.repositories.some((item) => item.physicalId === repo.physicalID),
        );
        if (repos.length !== context.checkout.repositories.length)
          return yield* fail("wrong_context");
        const heads = yield* Effect.forEach(
          repos,
          (repo) =>
            Effect.gen(function* () {
              const stored = context.checkout.repositories.find(
                (item) => item.physicalId === repo.physicalID,
              )!;
              const current = yield* identities.resolve(repo.path).pipe(Effect.option);
              return {
                repositoryID: repo.id,
                head:
                  current._tag === "Some" &&
                  current.value.physicalId === stored.physicalId &&
                  current.value.repositoryPhysicalId === stored.repositoryPhysicalId
                    ? current.value.commit
                    : null,
              };
            }),
          { concurrency: 4 },
        );
        const binding = observed?.binding ?? {
          ...context.session,
          execution: "unknown" as const,
          connection: "unavailable" as const,
        };
        const publication = yield* decodePublication({
          installationID: context.workspace.environmentId,
          executionHostID: native.hello.executionHostID,
          environmentID: yield* environment.getEnvironmentId,
          workspaceID: context.workspaceID,
          generation: context.checkout.nativeGeneration,
          sessionID: binding.id,
          featureID: context.feature.id,
          checkoutID: context.checkout.id,
          threadID: binding.threadId,
          title: context.feature.title,
          provider: binding.providerInstanceId,
          role: binding.role,
          execution: binding.execution,
          connection: binding.connection,
          sourceSequence: binding.lastSequence,
          repositories: heads,
          pullRequests: (observed?.pullRequests ?? [])
            .filter((pr) => pr.source !== "stack-dismissed")
            .map(canonicalHostingLink)
            .filter((pr) => pr !== null)
            .slice(0, 50),
          // Workspace-wide recordings are not silently presented as session attachments.
          recordingIDs: [],
        });
        const response = yield* transport.request(
          actorKey(actorID),
          "integration.linked-work.publish",
          { installationID: publication.installationID, publication },
        );
        const record = yield* decodeRecord(response).pipe(
          Effect.mapError(() => fail("invalid_response")),
        );
        const expected = yield* encodePublication(publication);
        // Native-only evidence links can be appended after an import. Every other field is an exact echo.
        const actual = yield* encodePublication({
          ...record.publication,
          recordingIDs: publication.recordingIDs,
        });
        if (actual !== expected) return yield* fail("invalid_response");
        return record;
      }).pipe(Effect.mapError(normalize));
    const resolve = (input: C.LinkedWorkTarget) =>
      Effect.gen(function* () {
        if (input.environment !== (yield* environment.getEnvironmentId))
          return yield* fail("wrong_context");
        const context = yield* saved(input.thread);
        if (
          context.session.id !== input.session ||
          context.workspace.environmentId !== input.installation ||
          context.workspaceID !== input.workspace ||
          context.checkout.nativeGeneration !== input.generation
        )
          return yield* fail("wrong_context");
        const native = yield* hub.resource(input.workspace).pipe(Effect.option);
        return {
          target: input,
          nativeAvailable:
            native._tag === "Some" &&
            native.value.hello.installationID === input.installation &&
            native.value.resource.available &&
            native.value.resource.generation === input.generation,
        };
      }).pipe(Effect.mapError(normalize));
    let lastRow = 0;
    const scan = Effect.gen(function* () {
      const rows = yield* sql<{
        rowid: number;
        actor_id: string;
        thread_id: string;
      }>`SELECT rowid, actor_id, json_extract(record_json, '$.threadId') AS thread_id
        FROM deckhand_managed_launches WHERE rowid > ${lastRow} AND json_extract(record_json, '$.state') = 'accepted'
        ORDER BY rowid LIMIT 16`;
      if (!rows.length) {
        lastRow = 0;
        return;
      }
      lastRow = rows[rows.length - 1]!.rowid;
      const results = yield* Effect.forEach(
        rows,
        (row) =>
          publish(row.actor_id, { threadId: ThreadId.make(row.thread_id) }).pipe(Effect.result),
        { concurrency: 2 },
      );
      const failures = results.filter((item) => item._tag === "Failure");
      if (failures.length)
        yield* Effect.logDebug("Native linked-work refresh did not confirm every context", {
          attempted: rows.length,
          unavailable: failures.length,
        });
    }).pipe(
      Effect.catch(() =>
        Effect.logDebug(
          "Native linked-work registry scan unavailable; saved native observations will expire",
        ),
      ),
    );
    const worker = Effect.gen(function* () {
      while (true) {
        yield* scan;
        yield* Effect.sleep("30 seconds");
      }
    });
    yield* worker.pipe(Effect.forkIn(scope));
    return LinkedWorkBridge.of({ publish, resolve });
  }),
);
