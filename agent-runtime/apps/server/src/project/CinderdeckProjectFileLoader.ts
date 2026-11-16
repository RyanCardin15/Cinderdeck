import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { T3_PROJECT_FILE_NAME, type CinderdeckProjectFile } from "@cinderdeck/contracts";
import { CinderdeckProjectFileFromJson } from "@cinderdeck/shared/cinderdeckProjectFile";

const decodeT3ProjectFileJson = Schema.decodeEffect(CinderdeckProjectFileFromJson);

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
    return `Failed to ${this.operation} ${T3_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

export class CinderdeckProjectFileLoader extends Context.Service<
  CinderdeckProjectFileLoader,
  {
    /** Never fails; missing/unreadable/invalid files return none, with warnings for invalid files. */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<CinderdeckProjectFile>>;
  }
>()("@cinderdeck/server/project/CinderdeckProjectFileLoader") {}

const logT3ProjectFileLoadError = (error: CinderdeckProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: CinderdeckProjectFileLoader["Service"]["load"] = Effect.fn("CinderdeckProjectFileLoader.load")(
    function* (workspaceRoot) {
      const filePath = path.join(workspaceRoot, T3_PROJECT_FILE_NAME);
      const raw = yield* fileSystem.readFileString(filePath).pipe(
        Effect.asSome,
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(Option.none<string>())
              : logT3ProjectFileLoadError(
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
      return yield* decodeT3ProjectFileJson(raw.value).pipe(
        Effect.asSome,
        Effect.catchTags({
          SchemaError: (error) =>
            logT3ProjectFileLoadError(
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
