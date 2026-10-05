// @effect-diagnostics nodeBuiltinImport:off - Local support collection never opens a database or reads user content.
import * as NodeOS from "node:os";
import { HostProcessPlatform, HostProcessArchitecture } from "@cinderdeck/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import packageJson from "../../package.json" with { type: "json" };
const presence = (value: string | undefined) => Boolean(value?.trim());
export function diagnosticConfiguration(env: Readonly<Record<string, string | undefined>>) {
  return {
    explicitDataRoot: presence(env.DECKHAND_HOME),
    desktopProfileOverride: presence(env.DECKHAND_PROFILE_ROOT),
    upstreamDataRootIgnored: presence(env.T3CODE_HOME),
    cinderdeckSocketOverride: presence(env.DECKHAND_CINDERDECK_SOCKET),
    analyticsConfigured: presence(env.DECKHAND_POSTHOG_KEY) && presence(env.DECKHAND_POSTHOG_HOST),
    traceExporterConfigured: presence(env.DECKHAND_OTLP_TRACES_URL),
    updateFeed: !presence(env.DECKHAND_DESKTOP_UPDATE_REPOSITORY)
      ? "unconfigured"
      : env.DECKHAND_DESKTOP_UPDATE_REPOSITORY?.trim().toLowerCase() === "pingdotgg/t3code"
        ? "upstream_refused"
        : "configured_not_verified",
  };
}
export function publicProviderVersion(output: string): string | null {
  // Export only a bounded version token, never a command's arbitrary output.
  return (
    output
      .slice(0, 4096)
      .match(/\b(\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][A-Za-z0-9.-]{1,64})?)\b/)?.[1] ?? null
  );
}
const probe = (name: "codex" | "claude") =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        NodeChildProcess.execFile(
          name,
          ["--version"],
          { timeout: 3000, maxBuffer: 4096, windowsHide: true },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      }),
    catch: () => "unavailable" as const,
  }).pipe(
    Effect.map((output) => ({
      name,
      state: publicProviderVersion(output) ? "available" : "unrecognized",
      version: publicProviderVersion(output),
    })),
    Effect.orElseSucceed(() => ({ name, state: "unavailable", version: null })),
  );
export const collectLocalDiagnostics = (input: {
  readonly baseDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly providerVersions: boolean;
  readonly explicitDataRoot?: boolean;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const collectedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const platform = yield* HostProcessPlatform;
    const arch = yield* HostProcessArchitecture;
    const storage = yield* Effect.forEach(
      [
        "statev2.sqlite",
        "settings.json",
        "desktop-settings.json",
        "client-settings.json",
        "logs",
      ] as const,
      (name) =>
        fs.exists(path.join(input.baseDir, "userdata", name)).pipe(
          Effect.map((exists) => ({ name, state: exists ? "present" : "missing" })),
          Effect.orElseSucceed(() => ({ name, state: "unreadable" })),
        ),
      { concurrency: 5 },
    );
    const providers = input.providerVersions
      ? yield* Effect.all([probe("codex"), probe("claude")], { concurrency: 2 })
      : [];
    return {
      schemaVersion: 1,
      product: "Cinderdeck",
      version: packageJson.version,
      collectedAt,
      runtime: {
        node: process.version,
        platform,
        arch,
        osRelease: NodeOS.release(),
      },
      configuration: {
        ...diagnosticConfiguration(input.env),
        explicitDataRoot: input.explicitDataRoot || presence(input.env.DECKHAND_HOME),
      },
      storage,
      providers,
      integration: {
        state: "not_contacted",
        detail:
          "This offline report does not contact Cinderdeck or establish integration compatibility.",
      },
      included: [
        "runtime versions",
        "configuration presence",
        "storage presence",
        ...(input.providerVersions ? ["bounded provider version tokens"] : []),
      ],
      excluded: [
        "credentials",
        "environment values",
        "filesystem paths",
        "database contents",
        "logs",
        "transcripts",
        "recordings",
        "source files",
      ],
    };
  });
