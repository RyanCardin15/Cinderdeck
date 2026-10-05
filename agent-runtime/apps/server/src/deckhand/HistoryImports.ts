// @effect-diagnostics nodeBuiltinImport:off - Consistent read-only SQLite history snapshots; all writes stay in the owned archive.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodeProcess from "node:process";
import * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as C from "@cinderdeck/contracts/deckhand/historyImportRpc";
import * as ServerConfig from "../config.ts";
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const exclusions = [
  "credentials and auth sessions",
  "provider runtime and continuation",
  "pending commands and scheduled tasks",
  "settings and secrets",
  "attachment files and repository contents",
];
const failure = (code: string, reason: string) => new C.HistoryImportError({ code, reason });
const owns = (child: string, parent: string) => {
  const relative = NodePath.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};
const scalarString = (row: Record<string, NodeSqlite.SQLOutputValue>, key: string) => {
  const value = row[key];
  if (typeof value !== "string")
    throw failure("unsupported_schema", "The source history has an incompatible field.");
  return value;
};
const count = (db: NodeSqlite.DatabaseSync, table: "threads" | "messages") => {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return Number(row?.count ?? 0);
};
const writeJSON = async (file: string, value: unknown) => {
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
  await NodeFSP.rename(temporary, file);
};
const isHistoryError = Schema.is(C.HistoryImportError);
const reportDecode = Schema.decodeUnknownPromise(C.HistoryImportReport);
async function archiveDirectory(root: string, importID: string) {
  if (!/^[a-f0-9]{64}$/.test(importID))
    throw failure("not_found", "This history import is unavailable.");
  const directory = NodePath.join(root, importID);
  const stat = await NodeFSP.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await NodeFSP.realpath(directory)) !== directory
  )
    throw failure("unsafe_path", "The history archive directory changed.");
  return directory;
}
async function readReport(directory: string, epoch: string): Promise<C.HistoryImportReport> {
  const privateReport = JSON.parse(
    await NodeFSP.readFile(NodePath.join(directory, "report.json"), "utf8"),
  );
  const report = await reportDecode(privateReport);
  if (report.state !== "preparing" || privateReport.runtimeEpoch === epoch) return report;
  // A second CLI/UI service must never call a still-running copy interrupted.
  // Signal0 only checks the captured owner PID; it does not send a signal.
  const owner = privateReport.ownerPID;
  if (Number.isSafeInteger(owner) && owner > 1) {
    try {
      NodeProcess.kill(owner, 0);
      return report;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") return report;
    }
  }
  return {
    ...report,
    state: "interrupted",
    detail:
      "Copy interrupted. Remove this partial archive or start a new import with a new operation key; partial history is not published.",
  };
}
async function copyHistory(
  directory: string,
  sourcePath: string,
  initial: C.HistoryImportReport,
  epoch: string,
  signal: AbortSignal,
) {
  const snapshotPath = NodePath.join(directory, "source-snapshot.sqlite");
  const archivePath = NodePath.join(directory, "history.sqlite");
  let source: NodeSqlite.DatabaseSync | undefined,
    snapshot: NodeSqlite.DatabaseSync | undefined,
    archive: NodeSqlite.DatabaseSync | undefined;
  try {
    if (typeof NodeSqlite.backup !== "function")
      throw failure(
        "unsupported_runtime",
        "History import requires a Node runtime with the SQLite backup API.",
      );
    signal.throwIfAborted();
    source = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true, allowExtension: false });
    const deadline = DateTime.toEpochMillis(DateTime.nowUnsafe()) + 120_000;
    await NodeSqlite.backup(source, snapshotPath, {
      rate: 256,
      progress: ({ totalPages }) => {
        signal.throwIfAborted();
        if (
          DateTime.toEpochMillis(DateTime.nowUnsafe()) > deadline ||
          totalPages * 65536 > MAX_BYTES * 16
        )
          throw failure("copy_limit", "The history snapshot exceeded its copy budget.");
      },
    });
    source.close();
    source = undefined;
    await NodeFSP.chmod(snapshotPath, 0o600);
    if ((await NodeFSP.stat(snapshotPath)).size > MAX_BYTES)
      throw failure("copy_limit", "The history snapshot is larger than the supported 2 GiB limit.");
    const hash = NodeCrypto.createHash("sha256");
    for await (const chunk of NodeFS.createReadStream(snapshotPath)) {
      signal.throwIfAborted();
      hash.update(chunk);
    }
    initial = { ...initial, sourceSha256: hash.digest("hex") };
    snapshot = new NodeSqlite.DatabaseSync(snapshotPath, { readOnly: true, allowExtension: false });
    snapshot.exec("PRAGMA trusted_schema=OFF");
    const tables = snapshot.prepare("SELECT name, sql FROM sqlite_master WHERE type='table'").all();
    for (const name of [
      "effect_sql_migrations",
      "orchestration_v2_projection_threads",
      "orchestration_v2_projection_messages",
    ]) {
      const table = tables.find((row) => row.name === name);
      if (!table || typeof table.sql !== "string" || /^CREATE\s+VIRTUAL/i.test(table.sql))
        throw failure(
          "unsupported_schema",
          "Only the supported Cinderdeck V2 history schema can be copied.",
        );
    }
    const version = Number(
      snapshot.prepare("SELECT MAX(migration_id) AS version FROM effect_sql_migrations").get()
        ?.version,
    );
    initial = {
      ...initial,
      sourceSchemaVersion: Number.isSafeInteger(version) && version >= 0 ? version : null,
    };
    if (![55, 56].includes(version))
      throw failure(
        "unsupported_schema",
        "This Cinderdeck schema is not supported. History import currently supports V2 migrations 55 and 56.",
      );
    const required = {
      orchestration_v2_projection_threads: [
        "thread_id",
        "project_id",
        "title",
        "default_provider",
        "created_at",
        "updated_at",
        "archived_at",
        "deleted_at",
      ],
      orchestration_v2_projection_messages: [
        "message_id",
        "thread_id",
        "role",
        "created_at",
        "payload_json",
      ],
    };
    for (const [table, fields] of Object.entries(required)) {
      const columns = snapshot.prepare(`PRAGMA table_info(${table})`).all();
      if (!fields.every((field) => columns.some((row) => row.name === field)))
        throw failure(
          "unsupported_schema",
          "The source history projection columns are incompatible.",
        );
    }
    const ledger = snapshot
      .prepare("SELECT name FROM effect_sql_migrations WHERE migration_id=55")
      .get();
    if (ledger?.name !== "OrchestrationV2")
      throw failure(
        "unsupported_schema",
        "The source migration history diverges from the supported Cinderdeck schema.",
      );
    archive = new NodeSqlite.DatabaseSync(archivePath);
    await NodeFSP.chmod(archivePath, 0o600);
    archive.exec(
      "PRAGMA journal_mode=DELETE; CREATE TABLE threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, provider TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL, deleted INTEGER NOT NULL); CREATE TABLE messages (message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, text TEXT NOT NULL, attachments INTEGER NOT NULL, historical_payload TEXT NOT NULL); CREATE INDEX history_messages_thread ON messages(thread_id,created_at,message_id)",
    );
    let cursor = "",
      threadCount = 0,
      messageCount = 0,
      attachmentCount = 0;
    while (true) {
      signal.throwIfAborted();
      const rows = snapshot
        .prepare(
          "SELECT thread_id,project_id,title,default_provider,created_at,updated_at,archived_at,deleted_at FROM orchestration_v2_projection_threads WHERE thread_id > ? ORDER BY thread_id LIMIT 100",
        )
        .all(cursor);
      if (!rows.length) break;
      archive.exec("BEGIN");
      for (const row of rows) {
        const id = scalarString(row, "thread_id");
        if (id.length > 512 || scalarString(row, "title").length > 4096)
          throw failure(
            "unsupported_schema",
            "A historical thread exceeds the supported field limits.",
          );
        archive
          .prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)")
          .run(
            id,
            scalarString(row, "project_id"),
            scalarString(row, "title"),
            scalarString(row, "default_provider"),
            scalarString(row, "created_at"),
            scalarString(row, "updated_at"),
            row.archived_at === null ? 0 : 1,
            row.deleted_at === null ? 0 : 1,
          );
        cursor = id;
        threadCount++;
      }
      archive.exec("COMMIT");
      if (threadCount > 100_000)
        throw failure("copy_limit", "This history exceeds the 100,000-thread archive limit.");
      await NodeTimersPromises.setImmediate();
    }
    cursor = "";
    while (true) {
      signal.throwIfAborted();
      const rows = snapshot
        .prepare(
          "SELECT message_id,thread_id,role,created_at,payload_json FROM orchestration_v2_projection_messages WHERE message_id > ? ORDER BY message_id LIMIT 100",
        )
        .all(cursor);
      if (!rows.length) break;
      archive.exec("BEGIN");
      for (const row of rows) {
        const payloadText = scalarString(row, "payload_json");
        const payload: unknown = JSON.parse(payloadText);
        if (
          !payload ||
          typeof payload !== "object" ||
          !("text" in payload) ||
          typeof payload.text !== "string"
        )
          throw failure(
            "unsupported_schema",
            "A historical message has an unsupported text representation.",
          );
        const attachments =
          "attachments" in payload && Array.isArray(payload.attachments)
            ? payload.attachments.length
            : 0;
        const id = scalarString(row, "message_id");
        if (
          id.length > 512 ||
          scalarString(row, "role").length > 160 ||
          payloadText.length > 16 * 1024 * 1024
        )
          throw failure("copy_limit", "A historical message exceeds the supported field limit.");
        archive
          .prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?)")
          .run(
            id,
            scalarString(row, "thread_id"),
            scalarString(row, "role"),
            scalarString(row, "created_at"),
            payload.text,
            attachments,
            payloadText,
          );
        cursor = id;
        messageCount++;
        attachmentCount += attachments;
      }
      archive.exec("COMMIT");
      if (messageCount > 2_000_000)
        throw failure("copy_limit", "This history exceeds the 2,000,000-message archive limit.");
      await NodeTimersPromises.setImmediate();
    }
    if (
      Number(
        snapshot.prepare("SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads").get()
          ?.count,
      ) !== threadCount ||
      Number(
        snapshot.prepare("SELECT COUNT(*) AS count FROM orchestration_v2_projection_messages").get()
          ?.count,
      ) !== messageCount
    )
      throw failure(
        "unsupported_schema",
        "The source IDs cannot be copied without losing history.",
      );
    archive.close();
    archive = undefined;
    snapshot.close();
    snapshot = undefined;
    signal.throwIfAborted();
    const ready: C.HistoryImportReport = {
      ...initial,
      state: "ready",
      sourceSha256: initial.sourceSha256,
      sourceSchemaVersion: version,
      threads: threadCount,
      messages: messageCount,
      attachmentsNotCopied: attachmentCount,
      finishedAt: DateTime.formatIso(DateTime.nowUnsafe()),
      detail:
        "History copied into a separate read-only archive. Original IDs and full message text are preserved; attachment files and provider continuation are unavailable.",
    };
    await writeJSON(NodePath.join(directory, "report.json"), {
      ...ready,
      runtimeEpoch: epoch,
      ownerPID: NodeProcess.pid,
    });
    return ready;
  } catch (error) {
    const report: C.HistoryImportReport = {
      ...initial,
      state: signal.aborted ? "interrupted" : "failed",
      finishedAt: DateTime.formatIso(DateTime.nowUnsafe()),
      detail: isHistoryError(error)
        ? error.reason
        : "The history could not be copied. The source and current Cinderdeck history were not changed.",
    };
    await writeJSON(NodePath.join(directory, "report.json"), {
      ...report,
      runtimeEpoch: epoch,
      ownerPID: NodeProcess.pid,
    });
    return report;
  } finally {
    source?.close();
    snapshot?.close();
    archive?.close();
    await NodeFSP.rm(snapshotPath, { force: true });
    for (const suffix of ["-wal", "-shm", "-journal"])
      await NodeFSP.rm(snapshotPath + suffix, { force: true });
    const report = await readReport(directory, epoch);
    if (report.state !== "ready") await NodeFSP.rm(archivePath, { force: true });
  }
}
export class HistoryImports extends Context.Service<
  HistoryImports,
  {
    readonly importHistory: (
      actor: string,
      input: C.HistoryImportInput,
    ) => Effect.Effect<C.HistoryImportReport, C.HistoryImportError>;
    readonly wait: (
      input: C.HistoryIdentity,
    ) => Effect.Effect<C.HistoryImportReport, C.HistoryImportError>;
    readonly get: (
      input: C.HistoryIdentity,
    ) => Effect.Effect<C.HistoryImportReport, C.HistoryImportError>;
    readonly list: (
      input: C.HistoryListInput,
    ) => Effect.Effect<C.HistoryImportList, C.HistoryImportError>;
    readonly threads: (
      input: C.HistoryThreadInput,
    ) => Effect.Effect<C.HistoryThreadPage, C.HistoryImportError>;
    readonly messages: (
      input: C.HistoryMessageInput,
    ) => Effect.Effect<C.HistoryMessagePage, C.HistoryImportError>;
    readonly messageText: (
      input: C.HistoryMessageTextInput,
    ) => Effect.Effect<C.HistoryMessageText, C.HistoryImportError>;
    readonly remove: (
      input: C.HistoryIdentity,
    ) => Effect.Effect<C.HistoryImportReport, C.HistoryImportError>;
  }
>()("@cinderdeck/server/deckhand/HistoryImports") {}
class HistoryArchiveLocation extends Context.Service<
  HistoryArchiveLocation,
  { readonly baseDir: string; readonly stateDir: string; readonly dbPath: string }
>()("@cinderdeck/server/deckhand/HistoryImports/HistoryArchiveLocation") {}
const make = Effect.gen(function* () {
  const config = yield* HistoryArchiveLocation;
  const scope = yield* Scope.Scope;
  if (owns(NodePath.resolve(config.baseDir), NodePath.join(NodeOS.homedir(), ".t3")))
    return yield* Effect.fail(
      failure("unsafe_path", "History imports require a separate Cinderdeck store."),
    );
  yield* Effect.promise(() => NodeFSP.mkdir(config.stateDir, { recursive: true, mode: 0o700 }));
  const root = NodePath.join(
    yield* Effect.promise(() => NodeFSP.realpath(config.stateDir)),
    "history-imports",
  );
  yield* Effect.promise(() => NodeFSP.mkdir(root, { recursive: true, mode: 0o700 }));
  const rootStat = yield* Effect.promise(() => NodeFSP.lstat(root));
  if (rootStat.isSymbolicLink() || (yield* Effect.promise(() => NodeFSP.realpath(root))) !== root)
    return yield* Effect.fail(
      failure("unsafe_path", "The history import directory must be owned by this Cinderdeck store."),
    );
  const epoch = NodeCrypto.randomUUID();
  const jobs = new Map<string, Fiber.Fiber<C.HistoryImportReport, C.HistoryImportError>>();
  const importsLock = yield* Semaphore.make(1);
  const active = new Set<string>();
  const attempt = <A>(fn: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({
      try: fn,
      catch: (error) =>
        isHistoryError(error)
          ? error
          : failure(
              "archive_unavailable",
              "The history archive is unavailable. Check its report and execution computer.",
            ),
    });
  const get = (input: C.HistoryIdentity) =>
    attempt(async () => readReport(await archiveDirectory(root, input.importID), epoch));
  const withArchive = <A>(input: C.HistoryIdentity, fn: (db: NodeSqlite.DatabaseSync) => A) =>
    attempt(async () => {
      const directory = await archiveDirectory(root, input.importID);
      if ((await readReport(directory, epoch)).state !== "ready")
        throw failure("not_ready", "This history copy is not ready.");
      const file = NodePath.join(directory, "history.sqlite");
      const stat = await NodeFSP.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || (await NodeFSP.realpath(file)) !== file)
        throw failure("unsafe_path", "The history archive file changed.");
      const db = new NodeSqlite.DatabaseSync(file, { readOnly: true, allowExtension: false });
      try {
        return fn(db);
      } finally {
        db.close();
      }
    });
  return HistoryImports.of({
    importHistory: (actor, input) =>
      Effect.gen(function* () {
        const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        const accepted = yield* attempt(async () => {
          if (
            !actor ||
            !input.operationKey ||
            input.operationKey.length > 512 ||
            !NodePath.isAbsolute(input.sourceDatabasePath)
          )
            throw failure(
              "invalid_input",
              "Choose an absolute source database path and a new import key.",
            );
          const requested = NodePath.resolve(input.sourceDatabasePath);
          const sourcePath = await NodeFSP.realpath(requested);
          if (sourcePath !== requested || (await NodeFSP.lstat(requested)).isSymbolicLink())
            throw failure(
              "unsafe_path",
              "Choose the real source database path; directory and file symlinks are refused.",
            );
          const stat = await NodeFSP.stat(sourcePath);
          if (
            !stat.isFile() ||
            stat.size > MAX_BYTES ||
            stat.size < 100 ||
            owns(sourcePath, root) ||
            owns(root, NodePath.dirname(sourcePath)) ||
            sourcePath ===
              (await NodeFSP.realpath(config.dbPath).catch(() => NodePath.resolve(config.dbPath)))
          )
            throw failure(
              "unsafe_path",
              "Choose a separate Cinderdeck database within the supported 2 GiB limit.",
            );
          const importID = NodeCrypto.createHash("sha256")
            .update(actor + "\0" + input.operationKey)
            .digest("hex");
          const directory = NodePath.join(root, importID);
          try {
            if (
              active.size >= 2 &&
              !(await NodeFSP.stat(directory)
                .then(() => true)
                .catch(() => false))
            )
              throw failure(
                "busy",
                "Two history copies are already running. Recover their reports before starting another.",
              );
            await NodeFSP.mkdir(directory, { mode: 0o700 });
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST")
              throw error;
            await archiveDirectory(root, importID);
            const intent = JSON.parse(
              await NodeFSP.readFile(NodePath.join(directory, "intent.json"), "utf8"),
            );
            if (intent.sourcePath !== sourcePath || intent.actor !== actor)
              throw failure(
                "key_conflict",
                "This import key belongs to a different reviewed source.",
              );
            return {
              report: await readReport(directory, epoch),
              directory,
              sourcePath,
              fresh: false,
            };
          }
          const report: C.HistoryImportReport = {
            importID,
            state: "preparing",
            sourceLabel: NodePath.basename(sourcePath),
            sourceSha256: null,
            sourceSchemaVersion: null,
            archiveSchemaVersion: 1,
            createdAt,
            finishedAt: null,
            threads: 0,
            messages: 0,
            attachmentsNotCopied: 0,
            historyOnly: true,
            providerContinuation: "unsupported",
            detail: "Creating a consistent read-only history snapshot.",
            exclusions,
          };
          await writeJSON(NodePath.join(directory, "intent.json"), {
            actor,
            sourcePath,
            operationKey: input.operationKey,
          });
          await writeJSON(NodePath.join(directory, "report.json"), {
            ...report,
            runtimeEpoch: epoch,
            ownerPID: NodeProcess.pid,
          });
          return { report, directory, sourcePath, fresh: true };
        });
        if (accepted.fresh) {
          active.add(accepted.report.importID);
          const fiber = yield* attempt((signal) =>
            copyHistory(accepted.directory, accepted.sourcePath, accepted.report, epoch, signal),
          ).pipe(
            Effect.ensuring(Effect.sync(() => active.delete(accepted.report.importID))),
            Effect.forkIn(scope),
          );
          jobs.set(accepted.report.importID, fiber);
        }
        return accepted.report;
      }).pipe(importsLock.withPermits(1)),
    get,
    wait: (input) =>
      get(input).pipe(
        Effect.flatMap((report) => {
          const job = jobs.get(input.importID);
          return report.state === "preparing" && job ? Fiber.join(job) : Effect.succeed(report);
        }),
      ),
    list: (input) =>
      attempt(async () => {
        if (input.limit < 1 || input.limit > 20 || input.offset < 0)
          throw failure("invalid_input", "History list pages support at most 20 imports.");
        const entries = (await NodeFSP.readdir(root))
          .filter((id) => /^[a-f0-9]{64}$/.test(id))
          .sort();
        const items = await Promise.all(
          entries
            .slice(input.offset, input.offset + input.limit)
            .map(async (id) => readReport(await archiveDirectory(root, id), epoch)),
        );
        return {
          items,
          total: entries.length,
          nextOffset:
            input.offset + items.length < entries.length ? input.offset + items.length : null,
        };
      }),
    threads: (input) =>
      withArchive(input, (db) => {
        if (input.limit < 1 || input.limit > 50 || input.offset < 0)
          throw failure("invalid_input", "History thread pages support at most 50 rows.");
        const total = count(db, "threads");
        const items = db
          .prepare(
            "SELECT thread.*, (SELECT COUNT(*) FROM messages WHERE thread_id=thread.thread_id) AS message_count FROM threads AS thread ORDER BY updated_at DESC,thread_id LIMIT ? OFFSET ?",
          )
          .all(input.limit, input.offset)
          .map((row) => ({
            threadID: scalarString(row, "thread_id"),
            projectID: scalarString(row, "project_id"),
            title: scalarString(row, "title"),
            provider: scalarString(row, "provider"),
            createdAt: scalarString(row, "created_at"),
            updatedAt: scalarString(row, "updated_at"),
            archived: row.archived === 1,
            deleted: row.deleted === 1,
            messageCount: Number(row.message_count),
          }));
        return {
          items,
          total,
          nextOffset: input.offset + items.length < total ? input.offset + items.length : null,
        };
      }),
    messages: (input) =>
      withArchive(input, (db) => {
        if (input.limit < 1 || input.limit > 20 || input.offset < 0)
          throw failure("invalid_input", "History message pages support at most 20 rows.");
        const total = Number(
          db.prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id=?").get(input.threadID)
            ?.count ?? 0,
        );
        const items = db
          .prepare(
            "SELECT message_id,thread_id,role,created_at,substr(text,1,2048) AS excerpt,length(text) AS length,attachments FROM messages WHERE thread_id=? ORDER BY created_at,message_id LIMIT ? OFFSET ?",
          )
          .all(input.threadID, input.limit, input.offset)
          .map((row) => ({
            messageID: scalarString(row, "message_id"),
            threadID: scalarString(row, "thread_id"),
            role: scalarString(row, "role"),
            createdAt: scalarString(row, "created_at"),
            text: scalarString(row, "excerpt"),
            totalCharacters: Number(row.length),
            nextTextOffset: Number(row.length) > 2048 ? 2048 : null,
            attachmentsNotCopied: Number(row.attachments),
          }));
        return {
          items,
          total,
          nextOffset: input.offset + items.length < total ? input.offset + items.length : null,
        };
      }),
    messageText: (input) =>
      withArchive(input, (db) => {
        if (input.limit < 1 || input.limit > 32768 || input.offset < 0)
          throw failure("invalid_input", "History text reads support at most 32,768 characters.");
        const pageSize = Math.min(input.limit, 16384);
        const row = db
          .prepare(
            "SELECT substr(text,?,?) AS text,length(text) AS length FROM messages WHERE message_id=?",
          )
          .get(input.offset + 1, pageSize, input.messageID);
        if (!row) throw failure("not_found", "This historical message is unavailable.");
        const totalCharacters = Number(row.length);
        const text = scalarString(row, "text");
        return {
          text,
          totalCharacters,
          nextOffset: input.offset + pageSize < totalCharacters ? input.offset + pageSize : null,
        };
      }),
    remove: (input) =>
      attempt(async () => {
        const directory = await archiveDirectory(root, input.importID);
        const report = await readReport(directory, epoch);
        if (
          report.state === "preparing" ||
          active.has(input.importID) ||
          (jobs.has(input.importID) && (await readReport(directory, epoch)).state === "preparing")
        )
          throw failure(
            "busy",
            "Wait for this history copy to finish before removing its archive.",
          );
        await NodeFSP.rm(NodePath.join(directory, "history.sqlite"), { force: true });
        for (const name of [
          "source-snapshot.sqlite",
          "source-snapshot.sqlite-wal",
          "source-snapshot.sqlite-shm",
          "source-snapshot.sqlite-journal",
        ])
          await NodeFSP.rm(NodePath.join(directory, name), { force: true });
        const removed: C.HistoryImportReport = {
          ...report,
          state: "removed",
          detail:
            "Imported archive removed. The source Cinderdeck history and current Cinderdeck threads were not changed.",
        };
        await writeJSON(NodePath.join(directory, "report.json"), {
          ...removed,
          runtimeEpoch: epoch,
          ownerPID: NodeProcess.pid,
        });
        return removed;
      }),
  });
});
const domainLayer = Layer.effect(HistoryImports, make);
export const layer = domainLayer.pipe(
  Layer.provide(
    Layer.effect(
      HistoryArchiveLocation,
      Effect.map(ServerConfig.ServerConfig, (config) => ({
        baseDir: config.baseDir,
        stateDir: config.stateDir,
        dbPath: config.dbPath,
      })),
    ),
  ),
);
export const layerForRoot = (baseDir: string) =>
  domainLayer.pipe(
    Layer.provide(
      Layer.succeed(HistoryArchiveLocation, {
        baseDir,
        stateDir: NodePath.join(baseDir, "userdata"),
        dbPath: NodePath.join(baseDir, "userdata", "statev2.sqlite"),
      }),
    ),
  );
