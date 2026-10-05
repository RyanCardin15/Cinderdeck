import * as Config from "effect/Config";
import { HostProcessEnvironment } from "@cinderdeck/shared/hostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";
import { baseDirFlag } from "./config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { collectLocalDiagnostics } from "../deckhand/LocalDiagnostics.ts";
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
class DiagnosticExportError extends CliError.UserError {
  override get message() {
    return "Could not create the diagnostics file. Choose an existing directory and a new filename; existing files are never overwritten.";
  }
}
export const diagnosticsCommand = Command.make("diagnostics", {
  baseDir: baseDirFlag,
  output: Flag.String("output").pipe(
    Flag.optional,
    Flag.withDescription("Save one bounded JSON report to a new local file. Nothing is uploaded."),
  ),
  providerVersions: Flag.Boolean("provider-versions").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Also run local Codex/Claude --version commands with a 3-second, 4 KiB limit each. Only version tokens are exported.",
    ),
  ),
}).pipe(
  Command.withDescription(
    "Inspect Cinderdeck identity and configuration without reading credentials, databases, transcripts or logs. Offline structural report; not a connection or compatibility test.",
  ),
  Command.withHandler(({ baseDir, output, providerVersions }) =>
    Effect.gen(function* () {
      const configured = yield* Config.String("DECKHAND_HOME").pipe(Config.option);
      const root = yield* resolveBaseDir(
        Option.getOrUndefined(Option.orElse(baseDir, () => configured)),
      );
      const env = yield* HostProcessEnvironment;
      const report = yield* collectLocalDiagnostics({
        baseDir: root,
        env,
        providerVersions,
        explicitDataRoot: Option.isSome(baseDir),
      });
      const json = (yield* encodeReport(report)) + "\n";
      if (Option.isSome(output)) {
        const fs = yield* FileSystem.FileSystem;
        yield* fs
          .writeFileString(output.value, json, { flag: "wx", mode: 0o600 })
          .pipe(Effect.mapError((cause) => new DiagnosticExportError({ cause })));
        yield* Console.log(
          "Saved local Cinderdeck diagnostics. Review the listed included/excluded scopes before sharing.",
        );
      } else yield* Console.log(json);
    }),
  ),
);
