// @effect-diagnostics nodeBuiltinImport:off - Tests create only isolated synthetic source/archive databases.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";
import * as HistoryImports from "./HistoryImports.ts";
async function sourceFixture(root: string, version = 56) {
  const sourceRoot = NodePath.join(await NodeFSP.realpath(root), "source");
  await NodeFSP.mkdir(sourceRoot);
  const file = NodePath.join(sourceRoot, "source.sqlite");
  const db = new NodeSqlite.DatabaseSync(file);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE effect_sql_migrations(migration_id INTEGER PRIMARY KEY,name TEXT); CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,project_id TEXT,title TEXT,default_provider TEXT,created_at TEXT,updated_at TEXT,archived_at TEXT,deleted_at TEXT); CREATE TABLE orchestration_v2_projection_messages(message_id TEXT PRIMARY KEY,thread_id TEXT,role TEXT,created_at TEXT,payload_json TEXT); CREATE TABLE auth_sessions(token TEXT); CREATE TABLE pending_tasks(command TEXT); INSERT INTO auth_sessions VALUES ('source-private-credential'); INSERT INTO pending_tasks VALUES ('do-not-run')",
  );
  db.prepare("INSERT INTO effect_sql_migrations VALUES (?,?)").run(55, "OrchestrationV2");
  if (version !== 55)
    db.prepare("INSERT INTO effect_sql_migrations VALUES (?,?)").run(
      version,
      version === 56 ? "RemoveRedundantProjectionIndexes" : "FutureSchema",
    );
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?,?)").run(
    "original-thread",
    "original-project",
    "Historical review",
    "claude",
    "2026-01-01",
    "2026-01-02",
    null,
    null,
  );
  const text = "Historical message 😀 " + "🐈".repeat(20_000);
  db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES (?,?,?,?,?)").run(
    "original-message",
    "original-thread",
    "assistant",
    "2026-01-02",
    JSON.stringify({ text, attachments: [{ id: "old-asset", name: "clip.mp4" }] }),
  );
  return { file, db, text };
}
const withStore = <A, E, R>(root: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      HistoryImports.layer.pipe(
        Layer.provide(ServerConfig.layerTest(root, NodePath.join(root, "deckhand"))),
      ),
    ),
  );
describe("Explicit read-only Cinderdeck history archive", () => {
  it.effect(
    "copies a consistent active WAL snapshot, preserves full Unicode history and excludes credentials/pending work",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "deckhand-history-wal-" });
        const source = yield* Effect.acquireRelease(
          Effect.promise(() => sourceFixture(root)),
          (value) => Effect.sync(() => value.db.close()),
        );
        // The concurrent writer's uncommitted row must never enter the snapshot.
        yield* Effect.sync(() =>
          source.db.exec(
            "BEGIN IMMEDIATE; INSERT INTO orchestration_v2_projection_messages VALUES ('uncommitted','original-thread','user','2026-01-03','{\"text\":\"not committed\"}')",
          ),
        );
        yield* withStore(
          root,
          Effect.gen(function* () {
            const service = yield* HistoryImports.HistoryImports;
            const accepted = yield* service.importHistory("admin-actor", {
              operationKey: "copy-one",
              sourceDatabasePath: source.file,
            });
            assert.equal(accepted.state, "preparing");
            const identity = { importID: accepted.importID };
            const report = yield* service.wait(identity);
            assert.equal(report.state, "ready");
            assert.equal(report.threads, 1);
            assert.equal(report.messages, 1);
            assert.equal(report.attachmentsNotCopied, 1);
            assert.equal(report.providerContinuation, "unsupported");
            assert.equal(report.sourceSchemaVersion, 56);
            const threads = yield* service.threads({ ...identity, offset: 0, limit: 50 });
            assert.equal(threads.items[0]?.threadID, "original-thread");
            assert.equal(threads.items[0]?.messageCount, 1);
            const messages = yield* service.messages({
              ...identity,
              threadID: "original-thread",
              offset: 0,
              limit: 20,
            });
            const first = messages.items[0]!;
            assert.equal(first.messageID, "original-message");
            assert.equal(first.attachmentsNotCopied, 1);
            assert.isBelow(first.text.length, 4097);
            let recovered = first.text;
            let offset = first.nextTextOffset;
            while (offset !== null) {
              const chunk = yield* service.messageText({
                ...identity,
                messageID: first.messageID,
                offset,
                limit: 32768,
              });
              recovered += chunk.text;
              offset = chunk.nextOffset;
              assert.isBelow(chunk.text.length, 32769);
            }
            assert.equal(recovered, source.text);
            const archive = yield* Effect.sync(
              () =>
                new NodeSqlite.DatabaseSync(
                  NodePath.join(
                    root,
                    "deckhand",
                    "userdata",
                    "history-imports",
                    identity.importID,
                    "history.sqlite",
                  ),
                  { readOnly: true },
                ),
            );
            yield* Effect.sync(() => {
              assert.deepEqual(
                archive
                  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                  .all()
                  .map((row) => row.name),
                ["messages", "threads"],
              );
              archive.close();
            });
            assert.isFalse(
              yield* fs.exists(
                NodePath.join(
                  root,
                  "deckhand",
                  "userdata",
                  "history-imports",
                  identity.importID,
                  "source-snapshot.sqlite",
                ),
              ),
            );
            assert.equal(
              (yield* service.importHistory("admin-actor", {
                operationKey: "copy-one",
                sourceDatabasePath: source.file,
              })).importID,
              identity.importID,
            );
            yield* service.remove(identity);
            assert.equal((yield* service.get(identity)).state, "removed");
            assert.isFalse(
              yield* fs.exists(
                NodePath.join(
                  root,
                  "deckhand",
                  "userdata",
                  "history-imports",
                  identity.importID,
                  "history.sqlite",
                ),
              ),
            );
          }),
        );
        yield* Effect.sync(() => {
          source.db.exec("ROLLBACK");
          assert.equal(
            source.db
              .prepare("SELECT COUNT(*) AS count FROM orchestration_v2_projection_messages")
              .get()?.count,
            1,
          );
          assert.equal(
            source.db.prepare("SELECT token FROM auth_sessions").get()?.token,
            "source-private-credential",
          );
          assert.equal(
            source.db.prepare("SELECT command FROM pending_tasks").get()?.command,
            "do-not-run",
          );
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "reports future schema incompatibility without publishing partial history or retaining a credential snapshot",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "deckhand-history-future-" });
        const source = yield* Effect.acquireRelease(
          Effect.promise(() => sourceFixture(root, 57)),
          (value) => Effect.sync(() => value.db.close()),
        );
        yield* withStore(
          root,
          Effect.gen(function* () {
            const service = yield* HistoryImports.HistoryImports;
            const report = yield* service
              .importHistory("admin", { operationKey: "future", sourceDatabasePath: source.file })
              .pipe(Effect.flatMap((value) => service.wait({ importID: value.importID })));
            assert.equal(report.state, "failed");
            assert.equal(report.sourceSchemaVersion, 57);
            assert.include(report.detail ?? "", "not supported");
            const folder = NodePath.join(
              root,
              "deckhand",
              "userdata",
              "history-imports",
              report.importID,
            );
            assert.isFalse(yield* fs.exists(NodePath.join(folder, "source-snapshot.sqlite")));
            assert.isFalse(yield* fs.exists(NodePath.join(folder, "history.sqlite")));
            assert.isTrue(
              (yield* Effect.exit(
                service.threads({ importID: report.importID, offset: 0, limit: 1 }),
              ))._tag === "Failure",
            );
          }),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "refuses source symlinks and changing a saved operation source instead of retargeting",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "deckhand-history-path-" });
        const source = yield* Effect.acquireRelease(
          Effect.promise(() => sourceFixture(root)),
          (value) => Effect.sync(() => value.db.close()),
        );
        const link = NodePath.join(root, "linked.sqlite");
        yield* Effect.promise(() => NodeFSP.symlink(source.file, link));
        yield* withStore(
          root,
          Effect.gen(function* () {
            const service = yield* HistoryImports.HistoryImports;
            assert.isTrue(
              (yield* Effect.exit(
                service.importHistory("admin", {
                  operationKey: "symlink",
                  sourceDatabasePath: link,
                }),
              ))._tag === "Failure",
            );
            const report = yield* service.importHistory("admin", {
              operationKey: "same",
              sourceDatabasePath: source.file,
            });
            yield* service.wait({ importID: report.importID });
            const other = NodePath.join(NodePath.dirname(source.file), "other.sqlite");
            yield* Effect.promise(() => NodeFSP.copyFile(source.file, other));
            assert.isTrue(
              (yield* Effect.exit(
                service.importHistory("admin", { operationKey: "same", sourceDatabasePath: other }),
              ))._tag === "Failure",
            );
            assert.equal((yield* service.list({ offset: 0, limit: 20 })).total, 1);
          }),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
