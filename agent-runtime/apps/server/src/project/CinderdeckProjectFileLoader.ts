/**
 * CinderdeckProjectFileLoader - Effect service that loads the checked-in `t3.json`
 * project file from a workspace root.
 *
 * Loading is best-effort: a missing file resolves to `Option.none`, and
 * unreadable or invalid files are logged and treated as absent so callers
 * can fall back to their defaults.
 *
 * @module CinderdeckProjectFileLoader
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CINDERDECK_PROJECT_FILE_NAME, type CinderdeckProjectFile } from "@cinderdeck/contracts";
import { CinderdeckProjectFileFromJson } from "@cinderdeck/shared/cinderdeckProjectFile";

const decodeCinderdeckProjectFileJson = Schema.decodeEffect(CinderdeckProjectFileFromJson);

export class CinderdeckProjectFileLoadError extends Schema.TaggedError<CinderdeckProjectFileLoadError>()(
  "CinderdeckProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${CINDERDECK_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

/** Service tag for t3.json project file loading. */
export class CinderdeckProjectFileLoader extends Context.Service<
  CinderdeckProjectFileLoader,
  {
    /**
     * Load and decode `t3.json` at the workspace root.
     *
     * Never fails: missing, unreadable, or invalid files resolve to
     * `Option.none` (invalid files are logged as warnings).
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<CinderdeckProjectFile>>;
  }
>()("@cinderdeck/server/project/CinderdeckProjectFileLoader") {}

const logCinderdeckProjectFileLoadError = (error: CinderdeckProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: CinderdeckProjectFileLoader["Service"]["load"] = Effect.fn("CinderdeckProjectFileLoader.load")(
    function* (workspaceRoot) {
      const filePath = path.join(workspaceRoot, CINDERDECK_PROJECT_FILE_NAME);
      const raw = yield* fileSystem.readFileString(filePath).pipe(
        Effect.asSome,
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(Option.none<string>())
              : logCinderdeckProjectFileLoadError(
                  new CinderdeckProjectFileLoadError({
                    operation: "read",
                    workspaceRoot,
                    filePath,
                    cause: error,
                  }),
                ).pipe(Effect.as(Option.none<string>())),
        }),
      );
      if (Option.isNone(raw)) {
        return Option.none<CinderdeckProjectFile>();
      }
      return yield* decodeCinderdeckProjectFileJson(raw.value).pipe(
        Effect.asSome,
        Effect.catchTags({
          SchemaError: (error) =>
            logCinderdeckProjectFileLoadError(
              new CinderdeckProjectFileLoadError({
                operation: "decode",
                workspaceRoot,
                filePath,
                cause: error,
              }),
            ).pipe(Effect.as(Option.none<CinderdeckProjectFile>())),
        }),
      );
    },
  );

  return CinderdeckProjectFileLoader.of({ load });
});

export const layer = Layer.effect(CinderdeckProjectFileLoader, make);
