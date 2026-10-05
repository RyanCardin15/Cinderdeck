import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Config from "effect/Config";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";
import * as C from "@cinderdeck/contracts/deckhand/historyImportRpc";
import * as HistoryImports from "../deckhand/HistoryImports.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const withArchive = <A, E, R>(
  baseDir: Option.Option<string>,
  effect: Effect.Effect<A, E, R | HistoryImports.HistoryImports>,
) =>
  Effect.gen(function* () {
    const configured = yield* Config.String("DECKHAND_HOME").pipe(Config.option);
    const root = yield* resolveBaseDir(
      Option.getOrUndefined(Option.orElse(baseDir, () => configured)),
    );
    return yield* effect.pipe(Effect.provide(HistoryImports.layerForRoot(root)), Effect.scoped);
  });
const copy = Command.make("copy", {
  baseDir: baseDirFlag,
  source: Flag.String("source").pipe(
    Flag.withDescription(
      "Real absolute path to the Cinderdeck V2 SQLite database. Opened read-only; never copied as a live file.",
    ),
  ),
  operationKey: Flag.String("operation-key").pipe(
    Flag.withDescription(
      "Stable explicit key for this reviewed copy; reuse it to recover a lost result.",
    ),
  ),
}).pipe(
  Command.withDescription(
    "Copy supported Cinderdeck V2 thread/message history into an isolated Cinderdeck archive. No credentials, pending work, provider continuation or attachment files are imported.",
  ),
  Command.withHandler(({ baseDir, source, operationKey }) =>
    withArchive(
      baseDir,
      Effect.gen(function* () {
        const service = yield* HistoryImports.HistoryImports;
        const accepted = yield* service.importHistory("local-cli", {
          sourceDatabasePath: source,
          operationKey,
        });
        const report = yield* service.wait({ importID: accepted.importID });
        yield* Console.log(yield* encode(report));
        if (report.state !== "ready")
          return yield* new C.HistoryImportError({
            code: "copy_failed",
            reason: report.detail ?? "History copy did not complete.",
          });
      }),
    ),
  ),
);
const list = Command.make("list", {
  baseDir: baseDirFlag,
  offset: Flag.Int("offset").pipe(Flag.withDefault(0)),
}).pipe(
  Command.withDescription("Read at most 20 archive receipts; no source database is opened."),
  Command.withHandler(({ baseDir, offset }) =>
    withArchive(
      baseDir,
      Effect.gen(function* () {
        const service = yield* HistoryImports.HistoryImports;
        yield* Console.log(yield* encode(yield* service.list({ offset, limit: 20 })));
      }),
    ),
  ),
);
const remove = Command.make("remove", {
  baseDir: baseDirFlag,
  importID: Argument.String("import-id"),
}).pipe(
  Command.withDescription(
    "Remove only the imported archive while retaining its report; original Cinderdeck and current Cinderdeck threads stay unchanged.",
  ),
  Command.withHandler(({ baseDir, importID }) =>
    withArchive(
      baseDir,
      Effect.gen(function* () {
        const service = yield* HistoryImports.HistoryImports;
        yield* Console.log(yield* encode(yield* service.remove({ importID })));
      }),
    ),
  ),
);
const threads = Command.make("threads", {
  baseDir: baseDirFlag,
  importID: Argument.String("import-id"),
  offset: Flag.Int("offset").pipe(Flag.withDefault(0)),
}).pipe(
  Command.withDescription(
    "Read a bounded 50-row page of archived original thread IDs without provider controls.",
  ),
  Command.withHandler(({ baseDir, importID, offset }) =>
    withArchive(
      baseDir,
      Effect.gen(function* () {
        const service = yield* HistoryImports.HistoryImports;
        yield* Console.log(yield* encode(yield* service.threads({ importID, offset, limit: 50 })));
      }),
    ),
  ),
);
const messages = Command.make("messages", {
  baseDir: baseDirFlag,
  importID: Argument.String("import-id"),
  threadID: Argument.String("thread-id"),
  offset: Flag.Int("offset").pipe(Flag.withDefault(0)),
}).pipe(
  Command.withDescription(
    "Read a bounded 20-message archive page. Full text continues through the text command.",
  ),
  Command.withHandler(({ baseDir, importID, threadID, offset }) =>
    withArchive(
      baseDir,
      Effect.gen(function* () {
        const service = yield* HistoryImports.HistoryImports;
        yield* Console.log(
          yield* encode(yield* service.messages({ importID, threadID, offset, limit: 20 })),
        );
      }),
    ),
  ),
);
const text = Command.make("text", {
  baseDir: baseDirFlag,
  importID: Argument.String("import-id"),
  messageID: Argument.String("message-id"),
  offset: Flag.Int("offset").pipe(Flag.withDefault(0)),
}).pipe(
  Command.withDescription(
    "Read preserved message text in bounded Unicode chunks; use the returned nextOffset.",
  ),
  Command.withHandler(({ baseDir, importID, messageID, offset }) =>
    withArchive(
      baseDir,
      Effect.gen(function* () {
        const service = yield* HistoryImports.HistoryImports;
        yield* Console.log(
          yield* encode(yield* service.messageText({ importID, messageID, offset, limit: 32768 })),
        );
      }),
    ),
  ),
);
export const historyImportCommand = Command.make("history-import").pipe(
  Command.withDescription(
    "Explicit read-only Cinderdeck history copy and schema report. Archived conversations preserve original IDs but cannot resume provider sessions.",
  ),
  Command.withSubcommands([copy, list, threads, messages, text, remove]),
);
