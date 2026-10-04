import { assert, describe, it } from "@effect/vitest";
import { AuthAdministrativeScopes, AuthSessionId, EnvironmentId } from "@t3tools/contracts";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Access from "./ActorAccess.ts";
import * as Journal from "./OperationJournal.ts";

const issuedAt = DateTime.makeUnsafe("2026-10-04T00:00:00.000Z");
const expiresAt = DateTime.makeUnsafe("2099-10-04T00:00:00.000Z");
const client = {
  label: null,
  ipAddress: null,
  userAgent: null,
  deviceType: "unknown" as const,
  os: null,
  browser: null,
};
const session = (
  id: string,
  overrides: Partial<AuthenticatedSession> = {},
): AuthenticatedSession => ({
  sessionId: AuthSessionId.make(id),
  subject: "desktop-bootstrap",
  method: "bearer-access-token",
  scopes: AuthAdministrativeScopes,
  expiresAt,
  ...overrides,
});
const persist = (value: AuthenticatedSession) =>
  Effect.gen(function* () {
    const repo = yield* AuthSessions.AuthSessionRepository;
    yield* repo.create({
      sessionId: value.sessionId,
      subject: value.subject,
      method: value.method,
      scopes: value.scopes,
      issuedAt,
      expiresAt: expiresAt,
      client,
    });
  });
const replace = (value: AuthenticatedSession) =>
  Effect.gen(function* () {
    const repo = yield* AuthSessions.AuthSessionRepository;
    return yield* repo.createReplacingActive({
      session: {
        sessionId: value.sessionId,
        subject: value.subject,
        method: value.method,
        scopes: value.scopes,
        issuedAt,
        expiresAt,
        client,
      },
      revokedAt: issuedAt,
    });
  });
const operation = (operationKey: string) => ({
  operationKey,
  installationID: "native-installation",
  workspaceID: "lane",
  generation: 4,
  revision: "source-revision",
  method: "services.start" as const,
  arguments: { workspace: "lane", services: ["web"] },
});
const fixture = (environmentID = "environment") =>
  Layer.mergeAll(Access.layer, AuthSessions.layer, Journal.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        SqlitePersistenceMemory,
        Layer.succeed(ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make(environmentID)),
        }),
      ),
    ),
  );

describe("Deckhand owner actor recovery", () => {
  it.effect(
    "recovers a real revoked singleton desktop grant without rewriting durable/native identity",
    () =>
      Effect.gen(function* () {
        const old = session("old-session"),
          current = session("current-session"),
          next = session("next-session");
        yield* persist(old);
        const journal = yield* Journal.OperationJournal;
        yield* journal.claim(old.sessionId, operation("original-native-key"));
        const sql = yield* SqlClient.SqlClient;
        const before =
          yield* sql`SELECT * FROM deckhand_operations WHERE operation_key='original-native-key'`;
        assert.deepEqual(yield* replace(current), [old.sessionId]);
        const auth = yield* AuthSessions.AuthSessionRepository;
        const historical = yield* auth.getById({ sessionId: old.sessionId });
        assert.isTrue(Option.isSome(historical));
        assert.isNotNull(Option.getOrThrow(historical).revokedAt);
        const access = yield* Access.ActorAccess;
        const actor = yield* access.resolve(current, {
          type: "operation",
          operationKey: "original-native-key",
        });
        assert.equal(actor, old.sessionId);
        assert.equal((yield* journal.read(actor, "original-native-key")).input.generation, 4);
        assert.deepEqual(
          yield* sql`SELECT * FROM deckhand_operations WHERE operation_key='original-native-key'`,
          before,
        );
        const canonical = yield* access.resolve(current);
        assert.equal(canonical, Access.desktopOwnerActor("environment"));
        assert.isBelow(canonical.length, 60);
        yield* journal.claim(canonical, operation("new-key"));
        yield* replace(next);
        assert.equal(yield* access.resolve(next), canonical);
        assert.equal(
          yield* access.resolve(next, { type: "operation", operationKey: "new-key" }),
          canonical,
        );
        assert.equal(
          yield* access.resolve(next, { type: "operation", operationKey: "original-native-key" }),
          old.sessionId,
        );
      }).pipe(Effect.provide(fixture())),
  );

  it.effect(
    "keeps paired, CLI, other-method and unproven desktop claims on the exact session",
    () =>
      Effect.gen(function* () {
        const access = yield* Access.ActorAccess;
        const cases = [
          session("paired", { subject: "paired-client" }),
          session("cli", { subject: "cli-issued-session" }),
          session("cookie", { method: "browser-session-cookie" }),
          session("restricted", { scopes: ["orchestration:read"] }),
        ];
        for (const value of cases) {
          yield* persist(value);
          assert.equal(yield* access.resolve(value), value.sessionId);
          assert.deepEqual(yield* access.aliases(value), [value.sessionId]);
        }
        yield* persist(session("forged", { subject: "paired-client" }));
        assert.equal(yield* access.resolve(session("forged")), "forged");
        assert.equal(yield* access.resolve(session("missing")), "missing");
        const revoked = session("revoked");
        yield* persist(revoked);
        yield* replace(session("active"));
        assert.equal(yield* access.resolve(revoked), revoked.sessionId);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE auth_sessions SET expires_at='1960-01-01T00:00:00.000Z' WHERE session_id='active'`;
        assert.equal(yield* access.resolve(session("active")), "active");
      }).pipe(Effect.provide(fixture())),
  );

  it.effect(
    "refuses unrelated or insufficient historical authority even alongside an owned key",
    () =>
      Effect.gen(function* () {
        const historical = session("historical"),
          current = session("current");
        yield* persist(historical);
        yield* replace(current);
        const journal = yield* Journal.OperationJournal;
        yield* journal.claim(historical.sessionId, operation("mine"));
        yield* persist(session("paired", { subject: "paired-client" }));
        yield* journal.claim("paired", operation("theirs"));
        yield* persist(session("weak-owner", { scopes: ["orchestration:read"] }));
        yield* journal.claim("weak-owner", operation("weak"));
        yield* journal.claim("missing-historical-auth", operation("missing-auth"));
        const access = yield* Access.ActorAccess;
        for (const key of ["theirs", "weak", "missing-auth"]) {
          const actor = yield* access.resolve(current, { type: "operation", operationKey: key });
          assert.equal(actor, current.sessionId);
          assert.equal(
            (yield* journal.read(actor, key).pipe(Effect.flip)).reason,
            "operation_missing",
          );
        }
        assert.equal(
          yield* access.resolve(current, [
            { type: "operation", operationKey: "mine" },
            { type: "operation", operationKey: "theirs" },
          ]),
          current.sessionId,
        );
      }).pipe(Effect.provide(fixture())),
  );

  it.effect("recovers an exact prepared creation launch before its launch receipt exists", () =>
    Effect.gen(function* () {
      const old = session("old"),
        current = session("current");
      yield* persist(old);
      yield* replace(current);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO deckhand_managed_creations(operation_key,actor_id,input_json,record_json) VALUES('creation',${old.sessionId},'{}','{"launchOperationKey":"prepared-launch"}')`;
      const access = yield* Access.ActorAccess;
      assert.equal(
        yield* access.resolve(current, { type: "launch", operationKey: "prepared-launch" }),
        old.sessionId,
      );
      assert.equal(
        yield* access.resolve(current, { type: "launch", operationKey: "unrelated" }),
        Access.desktopOwnerActor("environment"),
      );
      yield* sql`INSERT INTO deckhand_launch_reviews(launch_operation_key,actor_id,original_input_json,review_json) VALUES('prepared-launch',${old.sessionId},'{}','{}')`;
      assert.equal(
        yield* access.resolve(current, { type: "launch", operationKey: "prepared-launch" }),
        old.sessionId,
      );
      yield* sql`INSERT INTO deckhand_launch_reviews(launch_operation_key,actor_id,original_input_json,review_json) VALUES('conflicting-launch',${Access.desktopOwnerActor("environment")},'{}','{}')`;
      yield* sql`INSERT INTO deckhand_managed_creations(operation_key,actor_id,input_json,record_json) VALUES('another-creation',${old.sessionId},'{}','{"launchOperationKey":"conflicting-launch"}')`;
      assert.equal(
        (yield* access
          .resolve(current, { type: "launch", operationKey: "conflicting-launch" })
          .pipe(Effect.flip)).reason,
        "ambiguous",
      );
    }).pipe(Effect.provide(fixture())),
  );

  it.effect(
    "binds a new capture to its exact saved attempt and refuses conflicting owner histories",
    () =>
      Effect.gen(function* () {
        const old = session("old"),
          current = session("current");
        yield* persist(old);
        yield* replace(current);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO deckhand_verification_attempts(operation_key,actor_id,pr_key,original_json,record_json) VALUES('attempt',${old.sessionId},'actual-pr-key','{}','{"receipt":{"id":"build-receipt"}}')`;
        const access = yield* Access.ActorAccess;
        assert.equal(
          yield* access.resolve(current, [
            { type: "capture", captureKey: "new-capture" },
            { type: "attempt", operationKey: "attempt" },
          ]),
          old.sessionId,
        );
        assert.equal(
          yield* access.resolve(current, { type: "build", receiptID: "build-receipt" }),
          old.sessionId,
        );
        assert.equal(
          yield* access.resolve(current, { type: "build", receiptID: "native-only-unassociated" }),
          Access.desktopOwnerActor("environment"),
        );
        yield* sql`INSERT INTO deckhand_owned_preview_captures(capture_key,actor_id,original_json,record_json) VALUES('saved',${old.sessionId},'{}','{"status":{"receipt":{"operationKey":"import-key","recordingID":"video"}}}')`;
        assert.equal(
          yield* access.resolve(current, { type: "recording", recordingID: "video" }),
          old.sessionId,
        );
        assert.equal(
          yield* access.resolve(current, { type: "preview-import", operationKey: "import-key" }),
          old.sessionId,
        );
        yield* sql`INSERT INTO deckhand_owned_preview_captures(capture_key,actor_id,original_json,record_json) VALUES('conflicting',${Access.desktopOwnerActor("environment")},'{}','{}')`;
        assert.equal(
          (yield* access
            .resolve(current, [
              { type: "capture", captureKey: "conflicting" },
              { type: "attempt", operationKey: "attempt" },
            ])
            .pipe(Effect.flip)).reason,
          "ambiguous",
        );
      }).pipe(Effect.provide(fixture())),
  );

  it.effect(
    "resolves exact ownership keys and thread recovery while preserving original receipts",
    () =>
      Effect.gen(function* () {
        const old = session("old"),
          current = session("current");
        yield* persist(old);
        yield* replace(current);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO deckhand_ownership_transitions(id,actor_id,physical_id,original_json,record_json) VALUES('ownership:original',${old.sessionId},'physical','{"generation":4}','{"operationKey":"adopt","threadId":"thread","state":"unknown_outcome"}')`;
        const before = yield* sql`SELECT * FROM deckhand_ownership_transitions`;
        const access = yield* Access.ActorAccess;
        for (const resource of [
          { type: "ownership-id" as const, id: "ownership:original" },
          { type: "ownership-key" as const, operationKey: "adopt" },
        ])
          assert.equal(yield* access.resolve(current, resource), old.sessionId);
        assert.deepEqual(yield* sql`SELECT * FROM deckhand_ownership_transitions`, before);
        assert.equal(
          yield* access.resolve(current, { type: "thread", threadId: "thread" }),
          Access.desktopOwnerActor("environment"),
        );
        yield* sql`INSERT INTO deckhand_managed_launches(operation_key,actor_id,input_json,record_json) VALUES('launch',${old.sessionId},'{}','{"threadId":"thread","state":"accepted"}')`;
        assert.equal(
          yield* access.resolve(current, { type: "thread", threadId: "thread" }),
          old.sessionId,
        );
        assert.equal(
          yield* access.resolve(current, { type: "ownership-id", id: "missing" }),
          Access.desktopOwnerActor("environment"),
        );
        const aliases = yield* access.aliases(current);
        assert.sameMembers(
          [...aliases],
          [old.sessionId, current.sessionId, Access.desktopOwnerActor("environment")],
        );
        assert.notEqual(
          Access.desktopOwnerActor("another-environment"),
          Access.desktopOwnerActor("environment"),
        );
      }).pipe(Effect.provide(fixture())),
  );

  it.effect(
    "separates the original managed writer actor from the exact current adoption actor",
    () =>
      Effect.gen(function* () {
        const writer = session("writer-owner"),
          adopter = session("adoption-owner"),
          current = session("current");
        yield* persist(writer);
        yield* replace(adopter);
        yield* replace(current);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO deckhand_workspaces(id,environment_id,backend,owner_id,generation,revision,record_json) VALUES('workspace','environment','standalone','owner',1,1,'{}')`;
        yield* sql`INSERT INTO deckhand_checkouts(id,workspace_id,revision,record_json) VALUES('origin','workspace',1,'{}'),('target','workspace',1,'{}')`;
        yield* sql`INSERT INTO deckhand_features(id,workspace_id,revision,record_json) VALUES('feature','workspace',1,'{}')`;
        yield* sql`INSERT INTO deckhand_sessions(id,thread_id,feature_id,checkout_id,record_json) VALUES('session','thread','feature','origin','{}')`;
        yield* sql`INSERT INTO deckhand_managed_launches(operation_key,actor_id,input_json,record_json) VALUES('launch',${writer.sessionId},'{}','{"threadId":"thread","state":"accepted"}')`;
        yield* sql`INSERT INTO deckhand_ownership_transitions(id,actor_id,physical_id,original_json,record_json) VALUES('adoption',${adopter.sessionId},'physical','{}','{"operationKey":"adopt","threadId":"thread","state":"completed"}')`;
        yield* sql`INSERT INTO deckhand_checkout_ownership(original_checkout_id,target_checkout_id,transition_id,revision) VALUES('origin','target','adoption',1)`;
        const before = yield* sql`SELECT * FROM deckhand_sessions`;
        const access = yield* Access.ActorAccess;
        assert.equal(
          yield* access.resolve(current, { type: "thread", threadId: "thread" }),
          writer.sessionId,
        );
        assert.equal(
          yield* access.resolve(current, { type: "ownership-thread", threadId: "thread" }),
          adopter.sessionId,
        );
        assert.equal(
          yield* access.resolve(current, { type: "ownership-thread", threadId: "unrelated" }),
          Access.desktopOwnerActor("environment"),
        );
        assert.deepEqual(yield* sql`SELECT * FROM deckhand_sessions`, before);
      }).pipe(Effect.provide(fixture())),
  );

  it.effect(
    "ignores irrelevant bootstrap rotations and explicitly bounds actual historical workflow owners",
    () =>
      Effect.gen(function* () {
        const old = session("old"),
          current = session("current");
        yield* persist(old);
        const journal = yield* Journal.OperationJournal;
        yield* journal.claim(old.sessionId, operation("old-key"));
        yield* replace(current);
        const sql = yield* SqlClient.SqlClient;
        for (let index = 0; index < Access.ACTOR_HISTORY_LIMIT; index++)
          yield* sql`INSERT INTO auth_sessions(session_id,subject,scopes,method,issued_at,expires_at,revoked_at) SELECT ${"history-" + index},subject,scopes,method,issued_at,expires_at,issued_at FROM auth_sessions WHERE session_id='old'`;
        const access = yield* Access.ActorAccess;
        assert.sameMembers(
          [...(yield* access.aliases(current))],
          [old.sessionId, current.sessionId, Access.desktopOwnerActor("environment")],
        );
        for (let index = 0; index < Access.ACTOR_HISTORY_LIMIT; index++)
          yield* journal.claim("history-" + index, operation("workflow-" + index));
        assert.equal((yield* access.aliases(current).pipe(Effect.flip)).reason, "history_limit");
        assert.equal(
          yield* access.resolve(current, { type: "operation", operationKey: "old-key" }),
          old.sessionId,
        );
        assert.equal(
          (yield* access
            .resolve(
              current,
              Array.from({ length: 9 }, () => ({
                type: "operation" as const,
                operationKey: "old-key",
              })),
            )
            .pipe(Effect.flip)).reason,
          "resource_limit",
        );
      }).pipe(Effect.provide(fixture())),
  );
});
