#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Node's fs.cp keeps framework symlinks verbatim and createRequire resolves staged native packages.

import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";

import { fromYaml } from "@cinderdeck/shared/schemaYaml";
import { HostProcessPlatform } from "@cinderdeck/shared/hostProcess";
import { clerkFrontendApiHostnameFromPublishableKey } from "@cinderdeck/shared/relayAuth";
import { resolveSpawnCommand } from "@cinderdeck/shared/shell";
import rootPackageJson from "../package.json" with { type: "json" };
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import { applyWebBrandAssets } from "./apply-web-brand-assets.ts";
import {
  BRAND_ASSET_PATHS,
  resolveWebAssetBrandForChannel,
  type WebAssetBrand,
} from "./lib/brand-assets.ts";
import { getDefaultBuildArch } from "./lib/build-target-arch.ts";
import {
  findInlinedExternalPackages,
  selectCliRuntimeExternalDependencies,
} from "./lib/cli-external-packages.ts";
import { loadRepoEnv } from "./lib/public-config.ts";
import { selectDesktopRuntimeExternalDependencies } from "./lib/desktop-external-packages.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const DESKTOP_APP_ID = "com.ryancardin.cinderdeck.runtime";
// The native Cinderdeck bundle owns installation, URL registration and updates.
// The runtime is packaged only as its private macOS Chromium agent window.
const DESKTOP_PRODUCT_NAME = "Cinderdeck";
const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/u;

const BuildPlatform = Schema.Literals(["mac"]);
const BuildArch = Schema.Literals(["arm64", "x64", "universal"]);

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});
type WorkspaceConfig = typeof WorkspaceConfig.Type;

const StageWorkspaceConfig = Schema.Struct({
  supportedArchitectures: Schema.Struct({
    os: Schema.Array(Schema.String),
    cpu: Schema.Array(Schema.String),
    libc: Schema.optional(Schema.Array(Schema.String)),
  }),
  // pnpm 11 only reads these from pnpm-workspace.yaml (not package.json#pnpm).
  // Without allowBuilds the staged `vp install --prod` fails with
  // ERR_PNPM_IGNORED_BUILDS for packages that have lifecycle scripts.
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  nodeLinker: Schema.optional(Schema.Literals(["hoisted"])),
});
type StageWorkspaceConfig = typeof StageWorkspaceConfig.Type;

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));
const encodeStageWorkspaceConfig = Schema.encodeEffect(fromYaml(StageWorkspaceConfig));

const readWorkspaceConfig = Effect.fn("readWorkspaceConfig")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const workspaceYaml = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));
  return yield* decodeWorkspaceConfig(workspaceYaml);
});

interface DesktopBuildIconAssets {
  readonly macIconPng: string;
}

const MAC_CLI_FLAG = "--mac";
const MAC_DEFAULT_TARGET = "dmg";
const MAC_ARCH_CHOICES: ReadonlyArray<typeof BuildArch.Type> = ["arm64", "x64", "universal"];
export const RESOURCE_MONITOR_EXECUTABLE = "t3-resource-monitor";

export function resolveResourceMonitorRustTargets(
  arch: typeof BuildArch.Type,
): ReadonlyArray<string> {
  if (arch === "universal") {
    return ["aarch64-apple-darwin", "x86_64-apple-darwin"];
  }
  return [arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"];
}

interface BuildCliInput {
  readonly platform: Option.Option<typeof BuildPlatform.Type>;
  readonly target: Option.Option<string>;
  readonly arch: Option.Option<typeof BuildArch.Type>;
  readonly buildVersion: Option.Option<string>;
  readonly outputDir: Option.Option<string>;
  readonly skipBuild: Option.Option<boolean>;
  readonly keepStage: Option.Option<boolean>;
  readonly signed: Option.Option<boolean>;
  readonly verbose: Option.Option<boolean>;
}

export class MacPasskeySigningConfigurationResolutionError extends Schema.TaggedError<MacPasskeySigningConfigurationResolutionError>()(
  "MacPasskeySigningConfigurationResolutionError",
  {
    cause: Schema.Defect(),
  },
) {
  static fromCause(
    cause: unknown,
  ): MacPasskeySigningConfigurationError | MacPasskeySigningConfigurationResolutionError {
    return isMacPasskeySigningConfigurationError(cause)
      ? cause
      : new MacPasskeySigningConfigurationResolutionError({ cause });
  }

  override get message(): string {
    return "Failed to resolve macOS passkey signing configuration.";
  }
}

export class KeyringNativePackageMissingError extends Schema.TaggedError<KeyringNativePackageMissingError>()(
  "KeyringNativePackageMissingError",
  {
    packageName: Schema.String,
    binaryFileName: Schema.String,
    packageEntryPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Keyring native package is missing: ${this.packageName}`;
  }
}

export class ClerkPasskeyNativePackageMissingError extends Schema.TaggedError<ClerkPasskeyNativePackageMissingError>()(
  "ClerkPasskeyNativePackageMissingError",
  {
    packageName: Schema.String,
    binaryFileName: Schema.String,
    packageEntryPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Clerk passkey native package is missing: ${this.packageName}`;
  }
}

export class UnsupportedHostBuildPlatformError extends Schema.TaggedError<UnsupportedHostBuildPlatformError>()(
  "UnsupportedHostBuildPlatformError",
  {
    hostPlatform: Schema.String,
  },
) {
  override get message(): string {
    return `Unsupported host platform '${this.hostPlatform}'.`;
  }
}

export class UnsupportedDesktopBuildArchitectureError extends Schema.TaggedError<UnsupportedDesktopBuildArchitectureError>()(
  "UnsupportedDesktopBuildArchitectureError",
  {
    platform: BuildPlatform,
    arch: BuildArch,
    supportedArchitectures: Schema.Array(BuildArch),
  },
) {
  override get message(): string {
    return `Unsupported architecture '${this.arch}' for ${this.platform}.`;
  }
}

export class BuildCommandFailedError extends Schema.TaggedError<BuildCommandFailedError>()(
  "BuildCommandFailedError",
  {
    command: Schema.String,
    exitCode: Schema.Int,
    stdoutTail: Schema.optionalKey(Schema.String),
    stderrTail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    const outputSections = [
      `Command: ${this.command}`,
      formatOutputSection("stdout", this.stdoutTail ?? ""),
      formatOutputSection("stderr", this.stderrTail ?? ""),
    ].filter((section): section is string => section !== undefined);
    const outputSuffix = outputSections.length > 0 ? `\n\n${outputSections.join("\n\n")}` : "";
    return `Command exited with non-zero exit code (${this.exitCode})${outputSuffix}`;
  }
}

const MAC_DESKTOP_BUILD_PREREQUISITES = [
  { id: "rust", description: "Rust/Cargo and the requested Rust target" },
  { id: "clang", description: "Xcode Command Line Tools (clang)" },
  { id: "make", description: "Xcode Command Line Tools (make)" },
  { id: "sips", description: "macOS image tool (sips)" },
  { id: "iconutil", description: "macOS icon tool (iconutil)" },
  { id: "lipo", description: "Xcode universal-binary tool (lipo)" },
] as const;

export class MacDesktopBuildPrerequisitesMissingError extends Schema.TaggedError<MacDesktopBuildPrerequisitesMissingError>()(
  "MacDesktopBuildPrerequisitesMissingError",
  {
    missing: Schema.Array(Schema.String),
    rustTargets: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const details = MAC_DESKTOP_BUILD_PREREQUISITES.filter((requirement) =>
      this.missing.includes(requirement.id),
    )
      .map((requirement) => `  - ${requirement.description}`)
      .join("\n");
    return [
      "macOS desktop build prerequisites are missing:",
      details,
      "",
      "Install Apple's build tools with:",
      "  xcode-select --install",
      "Install Rust from https://rustup.rs, then add the requested target(s):",
      `  rustup target add ${this.rustTargets.join(" ")}`,
      "",
      "Then rerun the desktop artifact command.",
    ].join("\n");
  }
}

export class ResourceMonitorBuildOutputMissingError extends Schema.TaggedError<ResourceMonitorBuildOutputMissingError>()(
  "ResourceMonitorBuildOutputMissingError",
  {
    binaryPath: Schema.String,
    rustTarget: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Resource monitor build for ${this.rustTarget} did not produce ${this.binaryPath}.`;
  }
}

export class DesktopIconSourceMissingError extends Schema.TaggedError<DesktopIconSourceMissingError>()(
  "DesktopIconSourceMissingError",
  {
    platform: BuildPlatform,
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Desktop macOS icon source is missing at ${this.sourcePath}`;
  }
}

export class DesktopDmgBackgroundSourceMissingError extends Schema.TaggedError<DesktopDmgBackgroundSourceMissingError>()(
  "DesktopDmgBackgroundSourceMissingError",
  {
    channel: Schema.Literals(["latest", "nightly"]),
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Desktop ${this.channel} DMG background source is missing at ${this.sourcePath}`;
  }
}

export class BundledClientAssetsMissingError extends Schema.TaggedError<BundledClientAssetsMissingError>()(
  "BundledClientAssetsMissingError",
  {
    indexPath: Schema.String,
    missingFiles: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const preview = this.missingFiles.slice(0, 6).join(", ");
    const suffix = this.missingFiles.length > 6 ? ` (+${this.missingFiles.length - 6} more)` : "";
    return `Bundled client references missing files in ${this.indexPath}: ${preview}${suffix}. Rebuild web/server artifacts.`;
  }
}

const dependencyResolutionDescriptions = {
  "server-production": "production dependencies",
  "workspace-overrides": "overrides",
  "desktop-runtime": "desktop runtime dependencies",
} as const;
const DependencyResolutionKind = Schema.Literals([
  "server-production",
  "workspace-overrides",
  "desktop-runtime",
]);

export class DesktopBuildDependencyResolutionError extends Schema.TaggedError<DesktopBuildDependencyResolutionError>()(
  "DesktopBuildDependencyResolutionError",
  {
    kind: DependencyResolutionKind,
    manifestPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not resolve ${dependencyResolutionDescriptions[this.kind]} from ${this.manifestPath}.`;
  }
}

export class MissingServerProductionDependenciesError extends Schema.TaggedError<MissingServerProductionDependenciesError>()(
  "MissingServerProductionDependenciesError",
  {
    manifestPath: Schema.String,
  },
) {
  override get message(): string {
    return `Could not resolve production dependencies from ${this.manifestPath}.`;
  }
}

const DesktopBuildInputArtifact = Schema.Literals([
  "desktop-dist",
  "desktop-resources",
  "server-dist",
  "bundled-server-client",
]);
type DesktopBuildInputArtifact = typeof DesktopBuildInputArtifact.Type;
const desktopBuildInputArtifactNames = {
  "desktop-dist": "desktopDist",
  "desktop-resources": "desktopResources",
  "server-dist": "serverDist",
  "bundled-server-client": "bundled server client",
} satisfies Record<DesktopBuildInputArtifact, string>;

/**
 * Imported by every server module, so it is inlined in any correctly bundled
 * build. Its absence means the bundle went back to externalizing its
 * dependencies, which the staged runtime closure does not cover.
 */
const BUNDLE_SELF_CONTAINED_SENTINEL = "effect";

export class ExternalizedBundleError extends Schema.TaggedError<ExternalizedBundleError>()(
  "ExternalizedBundleError",
  { sentinel: Schema.String, inlinedPackageCount: Schema.Number },
) {
  override get message(): string {
    return `The server bundle did not inline "${this.sentinel}" (${this.inlinedPackageCount} packages inlined). The bundle is meant to be self-contained apart from the runtime externals; if its dependencies are external again they will be absent from the packaged app, and the backend will fail with ERR_MODULE_NOT_FOUND. Check the deps.alwaysBundle wiring in apps/server/vite.config.ts.`;
  }
}

export class InlinedNativePackageError extends Schema.TaggedError<InlinedNativePackageError>()(
  "InlinedNativePackageError",
  { packages: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `The server bundle inlined packages that load native binaries: ${this.packages.join(", ")}. A node-gyp-build style loader resolves prebuilds relative to its own file, so inlined into a chunk it finds none and the importer quietly falls back to a slower JS path. Add them to CLI_RUNTIME_EXTERNAL_PREFIXES in scripts/lib/cli-external-packages.ts so they stay external and are staged in the packaged app.`;
  }
}

export class InlinedExternalPackageError extends Schema.TaggedError<InlinedExternalPackageError>()(
  "InlinedExternalPackageError",
  { packages: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `The server bundle inlined packages that must stay external: ${this.packages.join(", ")}. These are native addons or their loaders; inlined, they resolve prebuilds relative to the bundle and silently lose native acceleration. Check the deps.neverBundle wiring in apps/server/vite.config.ts.`;
  }
}

export class MissingDesktopBuildInputError extends Schema.TaggedError<MissingDesktopBuildInputError>()(
  "MissingDesktopBuildInputError",
  {
    artifact: DesktopBuildInputArtifact,
    artifactPath: Schema.String,
    buildCommand: Schema.Literal("vp run build:desktop"),
  },
) {
  override get message(): string {
    return `Missing ${desktopBuildInputArtifactNames[this.artifact]} at ${this.artifactPath}. Run '${this.buildCommand}' first.`;
  }
}

export class MacProvisioningProfileNotFoundError extends Schema.TaggedError<MacProvisioningProfileNotFoundError>()(
  "MacProvisioningProfileNotFoundError",
  {
    provisioningProfilePath: Schema.String,
  },
) {
  override get message(): string {
    return `macOS provisioning profile not found: ${this.provisioningProfilePath}`;
  }
}

export class DesktopBuildDistDirectoryMissingError extends Schema.TaggedError<DesktopBuildDistDirectoryMissingError>()(
  "DesktopBuildDistDirectoryMissingError",
  {
    distPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Build completed but dist directory was not found at ${this.distPath}`;
  }
}

export class DesktopBuildNoArtifactsProducedError extends Schema.TaggedError<DesktopBuildNoArtifactsProducedError>()(
  "DesktopBuildNoArtifactsProducedError",
  {
    distPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Build completed but no files were produced in ${this.distPath}`;
  }
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const COMMAND_OUTPUT_TAIL_LENGTH = 20_000;

function appendOutputTail(acc: string, chunk: string): string {
  const next = acc + chunk;
  return next.length > COMMAND_OUTPUT_TAIL_LENGTH ? next.slice(-COMMAND_OUTPUT_TAIL_LENGTH) : next;
}

function formatOutputSection(label: string, output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  return `${label} tail:\n${trimmed}`;
}

const collectCommandStream = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  output: NodeJS.WriteStream,
  verbose: boolean,
): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFoldEffect(
      () => "",
      (acc, chunk) =>
        Effect.as(
          verbose ? Effect.sync(() => output.write(chunk)) : Effect.void,
          appendOutputTail(acc, chunk),
        ),
    ),
  );

const spawnAndCollectOutput = Effect.fn("spawnAndCollectOutput")(function* (
  command: ChildProcess.Command,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);

  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  return { stdout, stderr, exitCode } as const;
});

const resolveGitCommitHash = Effect.fn("resolveGitCommitHash")(function* (repoRoot: string) {
  const result = yield* spawnAndCollectOutput(
    ChildProcess.make("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: repoRoot,
    }),
  ).pipe(
    Effect.orElseSucceed(() => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    })),
  );

  if (result.exitCode !== 0) {
    return "unknown";
  }
  const hash = result.stdout.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
    return "unknown";
  }
  return hash.toLowerCase();
});

const resolveGitSourceDirty = Effect.fn("resolveGitSourceDirty")(function* (repoRoot: string) {
  const result = yield* spawnAndCollectOutput(
    ChildProcess.make("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: repoRoot,
    }),
  ).pipe(Effect.orElseSucceed(() => ({ stdout: "", stderr: "", exitCode: 1 })));
  return result.exitCode === 0 ? result.stdout.trim().length > 0 : null;
});

interface ResolvedBuildOptions {
  readonly platform: typeof BuildPlatform.Type;
  readonly target: string;
  readonly arch: typeof BuildArch.Type;
  readonly version: string | undefined;
  readonly outputDir: string;
  readonly skipBuild: boolean;
  readonly keepStage: boolean;
  readonly signed: boolean;
  readonly verbose: boolean;
}

interface StagePackageJson {
  readonly name: string;
  readonly version: string;
  readonly buildVersion: string;
  readonly deckhandCommitHash: string;
  readonly deckhandSourceDirty: boolean | null;
  readonly private: true;
  readonly packageManager: string;
  readonly description: string;
  readonly homepage: string;
  readonly author: string;
  readonly main: string;
  readonly build: Record<string, unknown>;
  readonly dependencies: Record<string, unknown>;
  readonly devDependencies: {
    readonly electron: string;
  };
}

export const copyDesktopBuildOutputs = Effect.fn("copyDesktopBuildOutputs")(function* (
  stageDistDir: string,
  outputDir: string,
  target: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(outputDir, { recursive: true });
  const artifacts: string[] = [];
  for (const entry of yield* fs.readDirectory(stageDistDir)) {
    const source = path.join(stageDistDir, entry);
    const destination = path.join(outputDir, entry);
    const stat = yield* fs.stat(source);
    if (stat.type === "Directory" && target === "dir") {
      // Framework links must remain relative when the app is moved out of staging.
      yield* Effect.tryPromise({
        try: () =>
          NodeFSP.cp(source, destination, {
            recursive: true,
            verbatimSymlinks: true,
            errorOnExist: true,
            force: false,
          }),
        catch: (cause) => new DesktopBuildOutputCopyError({ cause }),
      });
      artifacts.push(destination);
    } else if (stat.type === "File") {
      yield* fs.copyFile(source, destination);
      if (!entry.startsWith("builder-")) artifacts.push(destination);
    }
  }
  return artifacts;
});
export class DesktopBuildOutputCopyError extends Schema.TaggedError<DesktopBuildOutputCopyError>()(
  "DesktopBuildOutputCopyError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not copy the unpacked application. Choose a new output directory; existing app directories are not overwritten.";
  }
}

export const STAGE_INSTALL_ARGS = ["install", "--prod"] as const;
export const DESKTOP_ELECTRON_LANGUAGES = ["en-US"] as const;
export const DESKTOP_FILE_EXCLUSIONS = [
  // Cursor finds platform assets by walking up from argv[1]. Keep them outside
  // asar so spawning helpers and loading native addons both use real paths.
  "!**/node_modules/@cursor/sdk-*/**/*",
  "!apps/desktop/prod-resources/cursor-sdk",
  "!apps/desktop/prod-resources/cursor-sdk/**/*",
  // Cinderdeck always passes the user's installed Claude executable to the SDK,
  // so the SDK's optional platform packages (each a ~200MB bundled executable)
  // are dead weight. The trailing dash keeps the SDK's own JS package.
  "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*",
  // Nothing in the packaged app enables source maps or serves them: the web
  // client's maps alone were 50 MB of app.asar that no request ever read.
  "!**/*.map",
  "!**/*.d.cts",
] as const;
// Windows terminal helpers cannot run on macOS and slow signing and notarization.
export const MAC_FILE_EXCLUSIONS = [
  "!**/node_modules/node-pty/prebuilds/win32-*/**/*",
  "!**/node_modules/node-pty/third_party/conpty/**/*",
] as const;

// node-pty publishes both Darwin prebuilds in one package. Single-architecture
// apps only need the native target; universal apps need both. An omitted arch
// preserves the existing common exclusions for callers that only inspect the
// generic platform config.
export function resolveMacFileExclusions(arch?: typeof BuildArch.Type) {
  if (arch === undefined || arch === "universal") {
    return [...MAC_FILE_EXCLUSIONS];
  }

  const unusedArch = arch === "arm64" ? "x64" : "arm64";
  return [...MAC_FILE_EXCLUSIONS, `!**/node_modules/node-pty/prebuilds/darwin-${unusedArch}/**/*`];
}

export const DESKTOP_EXTRA_RESOURCES = [
  {
    from: "apps/desktop/prod-resources/cursor-sdk",
    to: "node_modules/@cursor",
  },
  {
    from: "apps/desktop/prod-resources/resource-monitor",
    to: "resource-monitor",
  },
] as const;

export interface MacPasskeySigningConfiguration {
  readonly appId: string;
  readonly teamId: string;
  readonly rpDomains: readonly string[];
  readonly provisioningProfilePath: string;
}

export const InvalidMacPasskeyRpDomainReason = Schema.Literals([
  "empty",
  "scheme-not-allowed",
  "parse-failed",
  "credentials-not-allowed",
  "port-not-allowed",
  "path-not-allowed",
  "query-not-allowed",
  "fragment-not-allowed",
  "hostname-mismatch",
]);
export type InvalidMacPasskeyRpDomainReason = typeof InvalidMacPasskeyRpDomainReason.Type;

export class InvalidMacPasskeyRpDomainError extends Schema.TaggedError<InvalidMacPasskeyRpDomainError>()(
  "InvalidMacPasskeyRpDomainError",
  {
    reason: InvalidMacPasskeyRpDomainReason,
    inputLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Invalid passkey RP domain (${this.reason}).`;
  }
}

export class InvalidAppleTeamIdError extends Schema.TaggedError<InvalidAppleTeamIdError>()(
  "InvalidAppleTeamIdError",
  {
    teamId: Schema.String,
  },
) {
  override get message(): string {
    return `DECKHAND_APPLE_TEAM_ID '${this.teamId}' must be a 10-character Apple Developer Team ID.`;
  }
}

export class MissingMacPasskeyProvisioningProfileError extends Schema.TaggedError<MissingMacPasskeyProvisioningProfileError>()(
  "MissingMacPasskeyProvisioningProfileError",
  {},
) {
  override get message(): string {
    return "DECKHAND_MACOS_PROVISIONING_PROFILE must point to an Associated Domains provisioning profile.";
  }
}

export class MissingMacPasskeyDomainConfigurationError extends Schema.TaggedError<MissingMacPasskeyDomainConfigurationError>()(
  "MissingMacPasskeyDomainConfigurationError",
  {},
) {
  override get message(): string {
    return "DECKHAND_CLERK_PUBLISHABLE_KEY or DECKHAND_CLERK_PASSKEY_RP_DOMAINS is required for signed macOS passkey builds.";
  }
}

export class InvalidMacPasskeyPublishableKeyError extends Schema.TaggedError<InvalidMacPasskeyPublishableKeyError>()(
  "InvalidMacPasskeyPublishableKeyError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "DECKHAND_CLERK_PUBLISHABLE_KEY is invalid.";
  }
}

export class MissingMacPasskeyRpDomainError extends Schema.TaggedError<MissingMacPasskeyRpDomainError>()(
  "MissingMacPasskeyRpDomainError",
  {},
) {
  override get message(): string {
    return "At least one Clerk passkey RP domain is required.";
  }
}

export const MacPasskeySigningConfigurationError = Schema.Union([
  InvalidMacPasskeyRpDomainError,
  InvalidAppleTeamIdError,
  MissingMacPasskeyProvisioningProfileError,
  MissingMacPasskeyDomainConfigurationError,
  InvalidMacPasskeyPublishableKeyError,
  MissingMacPasskeyRpDomainError,
]);
export type MacPasskeySigningConfigurationError = typeof MacPasskeySigningConfigurationError.Type;
export const isMacPasskeySigningConfigurationError = Schema.is(MacPasskeySigningConfigurationError);

function normalizePasskeyRpDomain(value: string): string {
  const normalized = value.trim().toLowerCase();
  const inputLength = value.length;
  if (normalized.length === 0) {
    throw new InvalidMacPasskeyRpDomainError({ reason: "empty", inputLength });
  }
  if (/^[a-z][a-z\d+.-]*:\/\//u.test(normalized)) {
    throw new InvalidMacPasskeyRpDomainError({
      reason: "scheme-not-allowed",
      inputLength,
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(`https://${normalized}`);
  } catch (cause) {
    throw new InvalidMacPasskeyRpDomainError({ reason: "parse-failed", inputLength, cause });
  }

  let reason: InvalidMacPasskeyRpDomainReason | undefined;
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    reason = "credentials-not-allowed";
  } else if (parsed.port.length > 0) {
    reason = "port-not-allowed";
  } else if (parsed.pathname !== "/") {
    reason = "path-not-allowed";
  } else if (parsed.search.length > 0) {
    reason = "query-not-allowed";
  } else if (parsed.hash.length > 0) {
    reason = "fragment-not-allowed";
  } else if (parsed.host !== normalized) {
    reason = "hostname-mismatch";
  }
  if (reason) {
    throw new InvalidMacPasskeyRpDomainError({ reason, inputLength });
  }

  return parsed.hostname;
}

export function resolveMacPasskeySigningConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): MacPasskeySigningConfiguration {
  const teamId = env.DECKHAND_APPLE_TEAM_ID?.trim().toUpperCase() ?? "";
  if (!APPLE_TEAM_ID_PATTERN.test(teamId)) {
    throw new InvalidAppleTeamIdError({ teamId });
  }

  const provisioningProfilePath = env.DECKHAND_MACOS_PROVISIONING_PROFILE?.trim() ?? "";
  if (provisioningProfilePath.length === 0) {
    throw new MissingMacPasskeyProvisioningProfileError();
  }

  const configuredRpDomains = env.DECKHAND_CLERK_PASSKEY_RP_DOMAINS?.trim();
  let rpDomains: readonly string[];
  if (configuredRpDomains) {
    rpDomains = configuredRpDomains.split(",").map(normalizePasskeyRpDomain);
  } else {
    const publishableKey = env.DECKHAND_CLERK_PUBLISHABLE_KEY?.trim();
    if (!publishableKey) {
      throw new MissingMacPasskeyDomainConfigurationError();
    }
    let hostname: string;
    try {
      hostname = clerkFrontendApiHostnameFromPublishableKey(publishableKey);
    } catch (cause) {
      throw new InvalidMacPasskeyPublishableKeyError({ cause });
    }
    rpDomains = [normalizePasskeyRpDomain(hostname)];
  }

  const uniqueRpDomains = [...new Set(rpDomains)];
  if (uniqueRpDomains.length === 0) {
    throw new MissingMacPasskeyRpDomainError();
  }

  return {
    appId: DESKTOP_APP_ID,
    teamId,
    rpDomains: uniqueRpDomains,
    provisioningProfilePath,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderMacPasskeyEntitlements(
  configuration: MacPasskeySigningConfiguration,
): string {
  const associatedDomains = configuration.rpDomains
    .map((domain) => `      <string>webcredentials:${escapeXml(domain)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.application-identifier</key>
    <string>${escapeXml(`${configuration.teamId}.${configuration.appId}`)}</string>
    <key>com.apple.developer.team-identifier</key>
    <string>${escapeXml(configuration.teamId)}</string>
    <key>com.apple.developer.associated-domains</key>
    <array>
${associatedDomains}
    </array>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
  </dict>
</plist>
`;
}

export function resolveFffNativeDependencies(
  arch: typeof BuildArch.Type,
  version: string,
): Record<string, string> {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];
  return Object.fromEntries(
    architectures.map((architecture) => [`@ff-labs/fff-bin-darwin-${architecture}`, version]),
  );
}

// The packaged app runs both processes from one app.asar, so the stage installs
// the union of what each bundle leaves external and nothing else.
export function resolveMergedStageDependencies(input: {
  readonly serverDependencies: Record<string, string>;
  readonly desktopDependencies: Record<string, string>;
  readonly arch: typeof BuildArch.Type;
  readonly fffNodeVersion: string;
}) {
  return {
    ...selectCliRuntimeExternalDependencies(input.serverDependencies),
    ...input.desktopDependencies,
    ...resolveFffNativeDependencies(input.arch, input.fffNodeVersion),
  };
}

/** Cursor's helper lookup falls through the archive to this real resources tree. */
export const stageCursorSdkPlatformPackages = Effect.fn("stageCursorSdkPlatformPackages")(
  function* (nodeModulesDir: string, destination: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(destination, { recursive: true });
    const sdkDirectory = path.join(nodeModulesDir, "@cursor/sdk");
    if (!(yield* fs.exists(sdkDirectory))) return;
    // pnpm's isolated layout puts optional packages beside the real SDK directory.
    const cursorDirectory = path.dirname(yield* fs.realPath(sdkDirectory));
    for (const name of yield* fs.readDirectory(cursorDirectory)) {
      if (!name.startsWith("sdk-")) continue;
      const source = yield* fs.realPath(path.join(cursorDirectory, name));
      yield* fs.copy(source, path.join(destination, name));
    }
  },
);

export interface ClerkPasskeyNativeArtifact {
  readonly packageName: string;
  readonly binaryFileName: string;
}

export function resolveClerkPasskeyNativeArtifacts(
  arch: typeof BuildArch.Type,
): readonly ClerkPasskeyNativeArtifact[] {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];
  return architectures.map((architecture) => ({
    packageName: `@clerk/electron-passkeys-darwin-${architecture}`,
    binaryFileName: `electron-passkeys.darwin-${architecture}.node`,
  }));
}

export function resolveKeyringNativeArtifacts(
  arch: typeof BuildArch.Type,
): readonly ClerkPasskeyNativeArtifact[] {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];
  return architectures.map((architecture) => ({
    packageName: `@napi-rs/keyring-darwin-${architecture}`,
    binaryFileName: `keyring.darwin-${architecture}.node`,
  }));
}

/**
 * Same nesting problem as the Clerk passkey binaries: pnpm keeps the platform
 * package under `@napi-rs/keyring`, electron-builder only retains collected
 * top-level dependencies, and the generated loader checks for a sibling
 * `keyring.<platform>.node` before falling back to the package. Staging the
 * binary beside `index.js` lets that first branch win.
 */
const stageKeyringNativeBinaries = Effect.fn("stageKeyringNativeBinaries")(function* (
  stageAppDir: string,
  arch: typeof BuildArch.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageEntryPath = yield* fs.realPath(
    path.join(stageAppDir, "node_modules", "@napi-rs", "keyring", "index.js"),
  );
  const packageDir = path.dirname(packageEntryPath);
  const packageRequire = NodeModule.createRequire(packageEntryPath);

  for (const artifact of resolveKeyringNativeArtifacts(arch)) {
    const sourcePath = yield* Effect.try({
      try: () => packageRequire.resolve(`${artifact.packageName}/${artifact.binaryFileName}`),
      catch: (cause) =>
        new KeyringNativePackageMissingError({
          packageName: artifact.packageName,
          binaryFileName: artifact.binaryFileName,
          packageEntryPath,
          platform: "mac",
          arch,
          cause,
        }),
    });
    yield* fs.copyFile(sourcePath, path.join(packageDir, artifact.binaryFileName));
  }
});

// pnpm nests the architecture package under @clerk/electron-passkeys, while electron-builder only
// retains collected top-level dependencies. The SDK loader checks beside index.js first, so stage
// the binary there and let electron-builder's native-addon handling unpack it from the ASAR.
const stageClerkPasskeyNativeBinaries = Effect.fn("stageClerkPasskeyNativeBinaries")(function* (
  stageAppDir: string,
  arch: typeof BuildArch.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageEntryPath = yield* fs.realPath(
    path.join(stageAppDir, "node_modules", "@clerk", "electron-passkeys", "index.js"),
  );
  const packageDir = path.dirname(packageEntryPath);
  const packageRequire = NodeModule.createRequire(packageEntryPath);

  for (const artifact of resolveClerkPasskeyNativeArtifacts(arch)) {
    const sourcePath = yield* Effect.try({
      try: () => packageRequire.resolve(artifact.packageName),
      catch: (cause) =>
        new ClerkPasskeyNativePackageMissingError({
          packageName: artifact.packageName,
          binaryFileName: artifact.binaryFileName,
          packageEntryPath,
          platform: "mac",
          arch,
          cause,
        }),
    });
    yield* fs.copyFile(sourcePath, path.join(packageDir, artifact.binaryFileName));
  }
});

export function createStageWorkspaceConfig(input: {
  readonly arch: typeof BuildArch.Type;
  readonly allowBuilds?: Record<string, boolean>;
  readonly patchedDependencies?: Record<string, string>;
  readonly overrides?: Record<string, string>;
}): StageWorkspaceConfig {
  const { arch, allowBuilds, patchedDependencies, overrides } = input;
  return {
    supportedArchitectures: {
      os: ["darwin"],
      cpu: arch === "universal" ? ["arm64", "x64"] : [arch],
    },
    ...(allowBuilds && Object.keys(allowBuilds).length > 0 ? { allowBuilds } : {}),
    ...(patchedDependencies && Object.keys(patchedDependencies).length > 0
      ? { patchedDependencies }
      : {}),
    ...(overrides && Object.keys(overrides).length > 0 ? { overrides } : {}),
  };
}

export function createStagePatchedDependencies(
  patchedDependencies: Record<string, string>,
  dependencies: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(patchedDependencies).filter(([patchKey]) =>
      Object.hasOwn(dependencies, getPatchedDependencyPackageName(patchKey)),
    ),
  );
}

function getPatchedDependencyPackageName(patchKey: string): string {
  const versionSeparator = patchKey.lastIndexOf("@");
  return versionSeparator > 0 ? patchKey.slice(0, versionSeparator) : patchKey;
}

const BuildEnvConfig = Config.all({
  platform: Config.schema(BuildPlatform, "DECKHAND_DESKTOP_PLATFORM").pipe(Config.option),
  target: Config.String("DECKHAND_DESKTOP_TARGET").pipe(Config.option),
  arch: Config.schema(BuildArch, "DECKHAND_DESKTOP_ARCH").pipe(Config.option),
  version: Config.String("DECKHAND_DESKTOP_VERSION").pipe(Config.option),
  outputDir: Config.String("DECKHAND_DESKTOP_OUTPUT_DIR").pipe(Config.option),
  skipBuild: Config.Boolean("DECKHAND_DESKTOP_SKIP_BUILD").pipe(Config.withDefault(false)),
  keepStage: Config.Boolean("DECKHAND_DESKTOP_KEEP_STAGE").pipe(Config.withDefault(false)),
  signed: Config.Boolean("DECKHAND_DESKTOP_SIGNED").pipe(Config.withDefault(false)),
  verbose: Config.Boolean("DECKHAND_DESKTOP_VERBOSE").pipe(Config.withDefault(false)),
});

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(flag, () => envValue);
const mergeOptions = <A>(a: Option.Option<A>, b: Option.Option<A>, defaultValue: A) =>
  Option.getOrElse(a, () => Option.getOrElse(b, () => defaultValue));

export const resolveBuildOptions = Effect.fn("resolveBuildOptions")(function* (
  input: BuildCliInput,
) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const env = yield* BuildEnvConfig;
  const hostPlatform = yield* HostProcessPlatform;

  const platform = mergeOptions(
    input.platform,
    env.platform,
    hostPlatform === "darwin" ? ("mac" as const) : undefined,
  );

  if (!platform) {
    return yield* new UnsupportedHostBuildPlatformError({ hostPlatform });
  }

  const target = mergeOptions(input.target, env.target, MAC_DEFAULT_TARGET);
  const defaultArch = yield* getDefaultBuildArch(MAC_ARCH_CHOICES);
  const arch = mergeOptions(input.arch, env.arch, defaultArch);
  if (!MAC_ARCH_CHOICES.includes(arch)) {
    return yield* new UnsupportedDesktopBuildArchitectureError({
      platform,
      arch,
      supportedArchitectures: [...MAC_ARCH_CHOICES],
    });
  }
  const version = mergeOptions(input.buildVersion, env.version, undefined);
  const outputDir = path.resolve(repoRoot, mergeOptions(input.outputDir, env.outputDir, "release"));

  return {
    platform,
    target,
    arch,
    version,
    outputDir,
    skipBuild: resolveBooleanFlag(input.skipBuild, env.skipBuild),
    keepStage: resolveBooleanFlag(input.keepStage, env.keepStage),
    signed: resolveBooleanFlag(input.signed, env.signed),
    verbose: resolveBooleanFlag(input.verbose, env.verbose),
  } satisfies ResolvedBuildOptions;
});

const runCommand = Effect.fn("runCommand")(function* (
  command: ChildProcess.Command,
  options: {
    readonly label: string;
    readonly verbose: boolean;
  },
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* commandSpawner.spawn(command);
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectCommandStream(child.stdout, process.stdout, options.verbose),
      collectCommandStream(child.stderr, process.stderr, options.verbose),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  if (exitCode !== 0) {
    return yield* new BuildCommandFailedError({
      command: options.label,
      exitCode,
      ...(stdout.trim() ? { stdoutTail: stdout } : {}),
      ...(stderr.trim() ? { stderrTail: stderr } : {}),
    });
  }
});

const desktopBuildProbeSucceeds = Effect.fn("desktopBuildProbeSucceeds")(function* (
  command: ChildProcess.Command,
  label: string,
) {
  return yield* runCommand(command, { label, verbose: false }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});

const rustTargetIsInstalled = Effect.fn("rustTargetIsInstalled")(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  const result = yield* spawnAndCollectOutput(
    ChildProcess.make("rustc", ["--print", "target-libdir", "--target", target]),
  ).pipe(Effect.orElseSucceed(() => null));
  if (result === null || result.exitCode !== 0) return false;

  const targetLibDir = result.stdout.trim();
  if (targetLibDir === "") return false;
  const entries = yield* fs.readDirectory(targetLibDir).pipe(Effect.orElseSucceed(() => []));
  return entries.some((entry) => entry.startsWith("libstd-") && entry.endsWith(".rlib"));
});

export const preflightMacDesktopBuild = Effect.fn("preflightMacDesktopBuild")(function* (
  arch: typeof BuildArch.Type,
) {
  const rustTargets = resolveResourceMonitorRustTargets(arch);
  const reuseResourceMonitor = yield* Config.Boolean(
    "DECKHAND_DESKTOP_REUSE_RESOURCE_MONITOR",
  ).pipe(Config.withDefault(false));
  const checks = yield* Effect.all(
    {
      rust: reuseResourceMonitor
        ? Effect.succeed(true)
        : Effect.all([
            desktopBuildProbeSucceeds(ChildProcess.make("cargo", ["--version"]), "cargo"),
            Effect.forEach(rustTargets, rustTargetIsInstalled).pipe(
              Effect.map((results) => results.every(Boolean)),
            ),
          ]).pipe(Effect.map(([cargo, targets]) => cargo && targets)),
      clang: desktopBuildProbeSucceeds(ChildProcess.make("clang", ["--version"]), "clang"),
      make: desktopBuildProbeSucceeds(ChildProcess.make("make", ["--version"]), "make"),
      sips: desktopBuildProbeSucceeds(ChildProcess.make("sips", ["--help"]), "sips"),
      iconutil: desktopBuildProbeSucceeds(
        ChildProcess.make("xcrun", ["--find", "iconutil"]),
        "iconutil",
      ),
      lipo:
        arch === "universal"
          ? desktopBuildProbeSucceeds(ChildProcess.make("lipo", ["-version"]), "lipo")
          : Effect.succeed(true),
    },
    { concurrency: "unbounded" },
  );
  const missing = MAC_DESKTOP_BUILD_PREREQUISITES.filter(
    (requirement) => !checks[requirement.id],
  ).map((requirement) => requirement.id);
  if (missing.length > 0) {
    return yield* new MacDesktopBuildPrerequisitesMissingError({ missing, rustTargets });
  }
});

const NativeMarkerManifest = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodeNativeMarkerManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(NativeMarkerManifest),
);

/** Locate a package inside the pnpm store, which is where the real files live. */
const findStorePackageDirectory = Effect.fn("findStorePackageDirectory")(function* (
  repoRoot: string,
  packageName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const storeDir = path.join(repoRoot, "node_modules/.pnpm");
  const exists = (candidate: string) =>
    fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
  if (!(yield* exists(storeDir))) return null;

  const flattened = `${packageName.replace("/", "+")}@`;
  const entries = yield* fs
    .readDirectory(storeDir)
    .pipe(Effect.orElseSucceed(() => [] as string[]));
  for (const entry of entries) {
    if (!entry.startsWith(flattened)) continue;
    const candidate = path.join(storeDir, entry, "node_modules", packageName);
    if (yield* exists(candidate)) return candidate;
  }
  return null;
});

/** Whether a package builds or ships a native addon it loads at runtime. */
const hasNativeLoaderMarkers = Effect.fn("hasNativeLoaderMarkers")(function* (packageDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (candidate: string) =>
    fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));

  if (yield* exists(path.join(packageDir, "binding.gyp"))) return true;
  if (yield* exists(path.join(packageDir, "prebuilds"))) return true;

  const manifestPath = path.join(packageDir, "package.json");
  if (!(yield* exists(manifestPath))) return false;
  const source = yield* fs.readFileString(manifestPath).pipe(Effect.orElseSucceed(() => ""));
  if (source === "") return false;
  const manifest = yield* Effect.try(() => decodeNativeMarkerManifest(source)).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (manifest === null) return false;
  return Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).some(
    (dependency) => dependency.startsWith("node-gyp-build"),
  );
});

export const stageResourceMonitor = Effect.fn("stageResourceMonitor")(function* (input: {
  readonly repoRoot: string;
  readonly stageResourcesDir: string;
  readonly arch: typeof BuildArch.Type;
  readonly verbose: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(input.repoRoot, "native/resource-monitor/Cargo.toml");
  const executableName = RESOURCE_MONITOR_EXECUTABLE;
  const rustTargets = resolveResourceMonitorRustTargets(input.arch);
  const reuseResourceMonitor = yield* Config.Boolean(
    "DECKHAND_DESKTOP_REUSE_RESOURCE_MONITOR",
  ).pipe(Config.withDefault(false));
  const builtBinaries: string[] = [];

  for (const rustTarget of rustTargets) {
    if (!reuseResourceMonitor) {
      const spawnCommand = yield* resolveSpawnCommand("cargo", [
        "build",
        "--locked",
        "--release",
        "--manifest-path",
        manifestPath,
        "--target",
        rustTarget,
      ]);
      yield* runCommand(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: input.repoRoot,
          shell: spawnCommand.shell,
        }),
        {
          label: `cargo build resource monitor (${rustTarget})`,
          verbose: input.verbose,
        },
      );
    }

    const binaryPath = path.join(
      input.repoRoot,
      "native/resource-monitor/target",
      rustTarget,
      "release",
      executableName,
    );
    if (!(yield* fs.exists(binaryPath))) {
      return yield* new ResourceMonitorBuildOutputMissingError({
        binaryPath,
        rustTarget,
        platform: "mac",
        arch: input.arch,
      });
    }
    if (reuseResourceMonitor) {
      yield* Effect.log(`[desktop-artifact] Reusing cached resource monitor (${rustTarget}).`);
    }
    builtBinaries.push(binaryPath);
  }

  const destinationDirectory = path.join(input.stageResourcesDir, "resource-monitor");
  const destinationPath = path.join(destinationDirectory, executableName);
  yield* fs.remove(destinationDirectory, { recursive: true, force: true }).pipe(Effect.ignore);
  yield* fs.makeDirectory(destinationDirectory, { recursive: true });

  if (builtBinaries.length === 1) {
    yield* fs.copyFile(builtBinaries[0]!, destinationPath);
  } else {
    yield* runCommand(
      ChildProcess.make("lipo", ["-create", ...builtBinaries, "-output", destinationPath]),
      {
        label: "lipo resource monitor universal binary",
        verbose: input.verbose,
      },
    );
  }

  yield* fs.chmod(destinationPath, 0o755);
});

function generateMacIconSet(
  sourcePng: string,
  targetIcns: string,
  tmpRoot: string,
  path: Path.Path,
  verbose: boolean,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const iconsetDir = path.join(tmpRoot, "icon.iconset");
    yield* fs.makeDirectory(iconsetDir, { recursive: true });

    const iconSizes = [16, 32, 128, 256, 512] as const;
    for (const size of iconSizes) {
      yield* runCommand(
        ChildProcess.make(
          {},
        )`sips -z ${size} ${size} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}.png`)}`,
        { label: `sips icon ${size}x${size}`, verbose },
      );

      const retinaSize = size * 2;
      yield* runCommand(
        ChildProcess.make(
          {},
        )`sips -z ${retinaSize} ${retinaSize} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}@2x.png`)}`,
        { label: `sips icon ${size}x${size}@2x`, verbose },
      );
    }

    yield* runCommand(ChildProcess.make({})`iconutil -c icns ${iconsetDir} -o ${targetIcns}`, {
      label: "iconutil icns",
      verbose,
    });
  });
}

function stageMacIcons(stageResourcesDir: string, sourcePng: string, verbose: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourcePng))) {
      return yield* new DesktopIconSourceMissingError({
        platform: "mac",
        sourcePath: sourcePng,
      });
    }

    const tmpRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "t3code-icon-build-",
    });

    const iconPngPath = path.join(stageResourcesDir, "icon.png");
    const iconIcnsPath = path.join(stageResourcesDir, "icon.icns");

    yield* runCommand(ChildProcess.make({})`sips -z 512 512 ${sourcePng} --out ${iconPngPath}`, {
      label: "sips mac icon",
      verbose,
    });

    yield* generateMacIconSet(sourcePng, iconIcnsPath, tmpRoot, path, verbose);
  });
}

export const stageDesktopDmgBackground = Effect.fn("stageDesktopDmgBackground")(function* (
  stageResourcesDir: string,
  channel: "latest" | "nightly",
  verbose: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourcePath = path.join(stageResourcesDir, "dmg", `dmg-background-${channel}.svg`);
  if (!(yield* fs.exists(sourcePath))) {
    return yield* new DesktopDmgBackgroundSourceMissingError({ channel, sourcePath });
  }

  for (const output of [
    { suffix: "", width: 640, height: 432 },
    { suffix: "@2x", width: 1280, height: 864 },
  ] as const) {
    const targetPath = path.join(
      stageResourcesDir,
      "dmg",
      `dmg-background-${channel}${output.suffix}.png`,
    );
    yield* runCommand(
      ChildProcess.make(
        {},
      )`sips -s format png -z ${output.height} ${output.width} ${sourcePath} --out ${targetPath}`,
      {
        label: `sips ${channel} DMG background${output.suffix || "@1x"}`,
        verbose,
      },
    );
  }
});

function validateBundledClientAssets(clientDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const indexPath = path.join(clientDir, "index.html");
    const indexHtml = yield* fs.readFileString(indexPath);
    const refs = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    const missing: string[] = [];

    for (const ref of refs) {
      const normalizedRef = ref.split("#")[0]?.split("?")[0] ?? "";
      if (!normalizedRef) continue;
      if (normalizedRef.startsWith("http://") || normalizedRef.startsWith("https://")) continue;
      if (normalizedRef.startsWith("data:") || normalizedRef.startsWith("mailto:")) continue;

      const ext = path.extname(normalizedRef);
      if (!ext) continue;

      const relativePath = normalizedRef.replace(/^\/+/, "");
      const assetPath = path.join(clientDir, relativePath);
      if (!(yield* fs.exists(assetPath))) {
        missing.push(normalizedRef);
      }
    }

    if (missing.length > 0) {
      return yield* new BundledClientAssetsMissingError({
        indexPath,
        missingFiles: missing,
      });
    }
  });
}

// The main-process bundle inlines every JS dependency (see
// apps/desktop/vite.config.ts), so the packaged app only installs the packages
// that bundle leaves external: native addons and playwright-core. Everything
// else already lives inside dist-electron and would only duplicate what the
// server bundle carries too.
export function resolveDesktopRuntimeDependencies(
  dependencies: Record<string, string> | undefined,
  catalog: Record<string, string>,
): Record<string, string> {
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return {};
  }

  return resolveCatalogDependencies(
    selectDesktopRuntimeExternalDependencies(dependencies),
    catalog,
    "apps/desktop",
  );
}

export function resolveDesktopUpdateChannel(version: string): "latest" | "nightly" {
  return /-nightly\.\d{8}\.\d+$/.test(version) ? "nightly" : "latest";
}

export function resolveDesktopWebAssetBrand(version: string): WebAssetBrand {
  return resolveWebAssetBrandForChannel(resolveDesktopUpdateChannel(version));
}

export function resolveDesktopBuildIconAssets(version: string): DesktopBuildIconAssets {
  return {
    macIconPng:
      resolveDesktopUpdateChannel(version) === "nightly"
        ? BRAND_ASSET_PATHS.nightlyMacIconPng
        : BRAND_ASSET_PATHS.productionMacIconPng,
  };
}

// Electron Builder detects pnpm from npm_config_user_agent, whose value uses
// user-agent syntax (pnpm/11.10.0) rather than packageManager syntax
// (pnpm@11.10.0).
export function resolvePackageManagerUserAgent(packageManager: string): string {
  const trimmed = packageManager.trim();
  const versionSeparator = trimmed.lastIndexOf("@");
  if (versionSeparator <= 0 || versionSeparator === trimmed.length - 1) {
    return trimmed;
  }

  return `${trimmed.slice(0, versionSeparator)}/${trimmed.slice(versionSeparator + 1)}`;
}

export const createBuildConfig = Effect.fn("createBuildConfig")(function* (
  target: string,
  version: string,
  signed: boolean,
  macPasskeySigning:
    | {
        readonly entitlementsPath: string;
        readonly provisioningProfilePath: string;
      }
    | undefined,
  arch?: typeof BuildArch.Type,
) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const buildConfig: Record<string, unknown> = {
    appId: DESKTOP_APP_ID,
    productName: DESKTOP_PRODUCT_NAME,
    artifactName: "Cinderdeck-${version}-${arch}.${ext}",
    electronLanguages: [...DESKTOP_ELECTRON_LANGUAGES],
    files: [...DESKTOP_FILE_EXCLUSIONS, ...resolveMacFileExclusions(arch)],
    directories: {
      buildResources: "apps/desktop/resources",
    },
    asarUnpack: ["**/apps/server/dist/native/**"],
    extraResources: [...DESKTOP_EXTRA_RESOURCES],
    mac: {
      target: target === "dmg" ? [target, "zip"] : [target],
      icon: "icon.icns",
      category: "public.app-category.developer-tools",
      extendInfo: {
        CFBundleName: DESKTOP_PRODUCT_NAME,
        CFBundleDisplayName: DESKTOP_PRODUCT_NAME,
        LSUIElement: true,
        NSScreenCaptureUsageDescription:
          "Cinderdeck captures the active window when you use the window capture shortcut.",
      },
      protocols: [],
      ...(signed ? { sign: path.join(repoRoot, "scripts/sign-macos.ts") } : {}),
      ...(macPasskeySigning
        ? {
            entitlements: macPasskeySigning.entitlementsPath,
            provisioningProfile: macPasskeySigning.provisioningProfilePath,
          }
        : {}),
    },
  };

  if (target === "dmg") {
    buildConfig.dmg = {
      // Give the themed installer its own Finder volume name. Finder caches
      // DMG window backgrounds by volume name, so reusing a generic name can
      // make a newly built background look unchanged during testing.
      title: `${DESKTOP_PRODUCT_NAME} ${version} Installer`,
      background: `dmg/dmg-background-${resolveDesktopUpdateChannel(version)}.png`,
      window: {
        width: 640,
        // The DMG backend derives bounds from the image, including Finder's
        // 32px title bar. Keep the last 32px of the artwork free of content.
        height: 432,
      },
      contents: [
        { x: 166, y: 214, type: "file" },
        { x: 474, y: 214, type: "link", path: "/Applications" },
      ],
      iconSize: 120,
      iconTextSize: 12,
    };
  }

  return buildConfig;
});

export class PrivateShellBuildError extends Schema.TaggedError<PrivateShellBuildError>()(
  "PrivateShellBuildError",
  { detail: Schema.String },
) {
  override get message(): string { return this.detail; }
}

export function privateShellBuildError(options: Pick<ResolvedBuildOptions, "platform" | "target">): string | undefined {
  return options.platform === "mac" && options.target === "dir"
    ? undefined
    : "Build the Cinderdeck runtime with --platform mac --target dir; package the complete app with scripts/build-unified.sh.";
}

const buildDesktopArtifact = Effect.fn("buildDesktopArtifact")(function* (
  options: ResolvedBuildOptions,
) {
  const productError = privateShellBuildError(options);
  if (productError) return yield* new PrivateShellBuildError({ detail: productError });
  const repoRoot = yield* RepoRoot;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const hostPlatform = yield* HostProcessPlatform;
  if (hostPlatform === "darwin") {
    yield* preflightMacDesktopBuild(options.arch);
  }
  const workspaceConfig = yield* readWorkspaceConfig();
  const workspaceCatalog = workspaceConfig.catalog ?? {};
  const workspaceOverrides = workspaceConfig.overrides ?? {};
  const workspacePatchedDependencies = workspaceConfig.patchedDependencies ?? {};
  const workspaceAllowBuilds = workspaceConfig.allowBuilds ?? {};

  const electronVersion = desktopPackageJson.dependencies.electron;

  const serverDependencies = serverPackageJson.dependencies;
  if (!serverDependencies || Object.keys(serverDependencies).length === 0) {
    return yield* new MissingServerProductionDependenciesError({
      manifestPath: "apps/server/package.json",
    });
  }

  const resolvedOverrides = yield* Effect.try({
    try: () => resolveCatalogDependencies(workspaceOverrides, workspaceCatalog, "apps/desktop"),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "workspace-overrides",
        manifestPath: "pnpm-workspace.yaml",
        cause,
      }),
  });

  const resolvedServerDependencies = yield* Effect.try({
    try: () => resolveCatalogDependencies(serverDependencies, workspaceCatalog, "apps/server"),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "server-production",
        manifestPath: "apps/server/package.json",
        cause,
      }),
  });
  const resolvedDesktopRuntimeDependencies = yield* Effect.try({
    try: () => resolveDesktopRuntimeDependencies(desktopPackageJson.dependencies, workspaceCatalog),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "desktop-runtime",
        manifestPath: "apps/desktop/package.json",
        cause,
      }),
  });

  const appVersion = options.version ?? serverPackageJson.version;
  const iconAssets = resolveDesktopBuildIconAssets(appVersion);
  const commitHash = yield* resolveGitCommitHash(repoRoot);
  const sourceDirty = yield* resolveGitSourceDirty(repoRoot);
  const mkdir = options.keepStage ? fs.makeTempDirectory : fs.makeTempDirectoryScoped;
  const stageRoot = yield* mkdir({
    prefix: `deckhand-desktop-${options.platform}-stage-`,
  });

  const stageAppDir = path.join(stageRoot, "app");
  const stageResourcesDir = path.join(stageAppDir, "apps/desktop/resources");
  const distDirs = {
    desktopDist: path.join(repoRoot, "apps/desktop/dist-electron"),
    desktopResources: path.join(repoRoot, "apps/desktop/resources"),
    serverDist: path.join(repoRoot, "apps/server/dist"),
  };
  const bundledClientEntry = path.join(distDirs.serverDist, "client/index.html");

  if (!options.skipBuild) {
    yield* Effect.log("[desktop-artifact] Building desktop/server/web artifacts...");
    const spawnCommand = yield* resolveSpawnCommand("vp", [
      "run",
      "--filter",
      "@cinderdeck/desktop",
      "build",
    ]);
    yield* runCommand(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: repoRoot,
        shell: spawnCommand.shell,
      }),
      { label: "vp run build:desktop", verbose: options.verbose },
    );
  }

  const requiredBuildInputs = [
    { artifact: "desktop-dist", artifactPath: distDirs.desktopDist },
    { artifact: "desktop-resources", artifactPath: distDirs.desktopResources },
    { artifact: "server-dist", artifactPath: distDirs.serverDist },
  ] as const;
  for (const input of requiredBuildInputs) {
    if (!(yield* fs.exists(input.artifactPath))) {
      return yield* new MissingDesktopBuildInputError({
        ...input,
        buildCommand: "vp run build:desktop",
      });
    }
  }

  // Assert against the emitted bundle, not the bundler config. `alwaysBundle`
  // only forces packages IN, so a transitive dependency of an external package
  // is bundled by default however the predicate is written — that silently
  // inlined a native loader (node-gyp-build-optional-packages) while every
  // list-based test still passed. An inlined native loader resolves its
  // prebuilds relative to the bundle and quietly falls back to a slower
  // pure-JS path, so this fails the build rather than shipping a silent
  // regression.
  {
    const chunkNames = (yield* fs.readDirectory(distDirs.serverDist)).filter((entry) =>
      entry.endsWith(".mjs"),
    );
    let totalRegions = 0;
    const inlined = new Set<string>();
    const inlinedPackages = new Set<string>();
    for (const chunkName of chunkNames) {
      const source = yield* fs.readFileString(path.join(distDirs.serverDist, chunkName));
      const scan = findInlinedExternalPackages(source);
      totalRegions += scan.regionCount;
      for (const name of scan.inlined) inlined.add(name);
      for (const name of scan.inlinedPackages) inlinedPackages.add(name);
    }
    if (inlined.size > 0) {
      return yield* new InlinedExternalPackageError({
        packages: [...inlined].sort(),
      });
    }
    // No regions at all means the scan went blind (marker format changed), not
    // that the bundle is clean.
    if (totalRegions === 0) {
      return yield* new InlinedExternalPackageError({
        packages: ["<no module regions found; the bundle scan needs updating>"],
      });
    }
    // The check above is one-directional: it only proves nothing external got
    // inlined. A regression to externalizing everything would also pass it,
    // since source-file regions still exist -- and that is the failure this
    // whole change exists to prevent, because those packages are not in the
    // staged runtime closure and the backend would die on ERR_MODULE_NOT_FOUND.
    // `effect` is imported by every server module, so it is inlined in any
    // correctly bundled build.
    // The list-based check above only sees packages someone already thought to
    // list. bufferutil and utf-8-validate were inlined for exactly that reason:
    // native, but absent from the list, so nothing flagged them. Ask the store
    // what each inlined package actually is instead.
    const nativeInlined: string[] = [];
    for (const name of [...inlinedPackages].sort()) {
      const packageDir = yield* findStorePackageDirectory(repoRoot, name);
      if (packageDir === null) continue;
      if (yield* hasNativeLoaderMarkers(packageDir)) nativeInlined.push(name);
    }
    if (nativeInlined.length > 0) {
      return yield* new InlinedNativePackageError({ packages: nativeInlined });
    }

    if (!inlinedPackages.has(BUNDLE_SELF_CONTAINED_SENTINEL)) {
      return yield* new ExternalizedBundleError({
        sentinel: BUNDLE_SELF_CONTAINED_SENTINEL,
        inlinedPackageCount: inlinedPackages.size,
      });
    }
  }

  if (!(yield* fs.exists(bundledClientEntry))) {
    return yield* new MissingDesktopBuildInputError({
      artifact: "bundled-server-client",
      artifactPath: bundledClientEntry,
      buildCommand: "vp run build:desktop",
    });
  }

  const webAssetBrand = resolveDesktopWebAssetBrand(appVersion);
  yield* applyWebBrandAssets(webAssetBrand, "apps/server/dist/client");
  yield* Effect.log(`[desktop-artifact] Applied ${webAssetBrand} web client branding.`);
  yield* validateBundledClientAssets(path.dirname(bundledClientEntry));

  yield* fs.makeDirectory(path.join(stageAppDir, "apps/desktop"), { recursive: true });
  yield* fs.makeDirectory(path.join(stageAppDir, "apps/server"), { recursive: true });

  yield* Effect.log("[desktop-artifact] Staging release app...");
  yield* fs.copyFile(path.join(repoRoot, "LICENSE"), path.join(stageAppDir, "LICENSE"));
  yield* fs.copy(distDirs.desktopDist, path.join(stageAppDir, "apps/desktop/dist-electron"));
  yield* fs.copy(distDirs.desktopResources, stageResourcesDir);
  if (options.target === "dmg") {
    yield* stageDesktopDmgBackground(
      stageResourcesDir,
      resolveDesktopUpdateChannel(appVersion),
      options.verbose,
    );
  }
  yield* fs.copy(distDirs.serverDist, path.join(stageAppDir, "apps/server/dist"));
  yield* stageResourceMonitor({
    repoRoot,
    stageResourcesDir,
    arch: options.arch,
    verbose: options.verbose,
  });

  yield* stageMacIcons(
    stageResourcesDir,
    path.join(repoRoot, iconAssets.macIconPng),
    options.verbose,
  );

  // electron-builder filters the buildResources directory out of packaged
  // resources, so extraResources are copied from this sibling instead.
  const stageProdResourcesDir = path.join(stageAppDir, "apps/desktop/prod-resources");
  yield* fs.copy(stageResourcesDir, stageProdResourcesDir);

  const configuredMacPasskeySigning = options.signed
    ? yield* Effect.try({
        try: () => resolveMacPasskeySigningConfiguration(loadRepoEnv({ repoRoot })),
        catch: MacPasskeySigningConfigurationResolutionError.fromCause,
      })
    : undefined;
  const macPasskeySigning = configuredMacPasskeySigning
    ? {
        ...configuredMacPasskeySigning,
        provisioningProfilePath: path.resolve(
          repoRoot,
          configuredMacPasskeySigning.provisioningProfilePath,
        ),
      }
    : undefined;
  const macEntitlementsPath = macPasskeySigning
    ? path.join(stageAppDir, "entitlements.mac.plist")
    : undefined;
  if (macPasskeySigning && macEntitlementsPath) {
    if (!(yield* fs.exists(macPasskeySigning.provisioningProfilePath))) {
      return yield* new MacProvisioningProfileNotFoundError({
        provisioningProfilePath: macPasskeySigning.provisioningProfilePath,
      });
    }
    yield* fs.writeFileString(macEntitlementsPath, renderMacPasskeyEntitlements(macPasskeySigning));
  }

  const stageDependencies = resolveMergedStageDependencies({
    serverDependencies: resolvedServerDependencies,
    desktopDependencies: resolvedDesktopRuntimeDependencies,
    arch: options.arch,
    fffNodeVersion: serverPackageJson.dependencies["@ff-labs/fff-node"],
  });
  const stagePatchedDependencies = createStagePatchedDependencies(
    workspacePatchedDependencies,
    stageDependencies,
  );
  const stagePackageJson: StagePackageJson = {
    name: "deckhand",
    version: appVersion,
    buildVersion: appVersion,
    deckhandCommitHash: commitHash,
    deckhandSourceDirty: sourceDirty,
    private: true,
    packageManager: rootPackageJson.packageManager,
    description: "Cinderdeck internal agent window",
    homepage: "https://cardinlabs.com",
    author: "Cardin Labs",
    main: "apps/desktop/dist-electron/boot.cjs",
    build: yield* createBuildConfig(
      options.target,
      appVersion,
      options.signed,
      macPasskeySigning && macEntitlementsPath
        ? {
            entitlementsPath: macEntitlementsPath,
            provisioningProfilePath: macPasskeySigning.provisioningProfilePath,
          }
        : undefined,
      options.arch,
    ),
    dependencies: stageDependencies,
    devDependencies: {
      electron: electronVersion,
    },
  };

  const stagePackageJsonString = yield* encodeJsonString(stagePackageJson);
  yield* fs.writeFileString(path.join(stageAppDir, "package.json"), `${stagePackageJsonString}\n`);
  const stageWorkspaceConfig = createStageWorkspaceConfig({
    arch: options.arch,
    allowBuilds: workspaceAllowBuilds,
    patchedDependencies: stagePatchedDependencies,
    overrides: resolvedOverrides,
  });
  const stageWorkspaceConfigString = yield* encodeStageWorkspaceConfig(stageWorkspaceConfig);
  yield* fs.writeFileString(
    path.join(stageAppDir, "pnpm-workspace.yaml"),
    stageWorkspaceConfigString,
  );

  if (Object.keys(stagePatchedDependencies).length > 0) {
    yield* fs.copy(path.join(repoRoot, "patches"), path.join(stageAppDir, "patches"));
  }

  yield* Effect.log("[desktop-artifact] Installing staged production dependencies...");
  const installCommand = yield* resolveSpawnCommand("vp", [...STAGE_INSTALL_ARGS]);
  yield* runCommand(
    ChildProcess.make(installCommand.command, installCommand.args, {
      cwd: stageAppDir,
      shell: installCommand.shell,
    }),
    { label: "vp install --prod", verbose: options.verbose },
  );
  yield* stageClerkPasskeyNativeBinaries(stageAppDir, options.arch);
  yield* stageKeyringNativeBinaries(stageAppDir, options.arch);
  yield* stageCursorSdkPlatformPackages(
    path.join(stageAppDir, "node_modules"),
    path.join(stageProdResourcesDir, "cursor-sdk"),
  );

  // electron-builder treats several set-but-empty variables (e.g. CSC_LINK="")
  // as enabled, so copy the host env and scrub empty values instead of relying
  // on `extendEnv` merging.
  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
  };
  buildEnv.npm_config_user_agent = resolvePackageManagerUserAgent(rootPackageJson.packageManager);
  for (const [key, value] of Object.entries(buildEnv)) {
    if (value === "") {
      delete buildEnv[key];
    }
  }
  if (!options.signed) {
    buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    delete buildEnv.CSC_LINK;
    delete buildEnv.CSC_KEY_PASSWORD;
    delete buildEnv.APPLE_API_KEY;
    delete buildEnv.APPLE_API_KEY_ID;
    delete buildEnv.APPLE_API_ISSUER;
  }
  if (options.verbose) {
    const debugNamespaces = [
      "electron-builder",
      "electron-builder:*",
      "electron-osx-sign*",
      "electron-notarize*",
    ];
    buildEnv.DEBUG = [buildEnv.DEBUG, ...debugNamespaces].filter(Boolean).join(",");
  }

  yield* Effect.log(
    `[desktop-artifact] Building ${options.platform}/${options.target} (arch=${options.arch}, version=${appVersion})...`,
  );
  const builderArgs = [
    "exec",
    "--filter",
    "@cinderdeck/desktop",
    "--",
    "electron-builder",
    "--projectDir",
    stageAppDir,
    MAC_CLI_FLAG,
    `--${options.arch}`,
    "--publish",
    "never",
  ];
  const builderCommand = yield* resolveSpawnCommand("vp", builderArgs, { env: buildEnv });
  yield* runCommand(
    ChildProcess.make(builderCommand.command, builderCommand.args, {
      cwd: repoRoot,
      env: buildEnv,
      shell: builderCommand.shell,
    }),
    {
      label: `vp exec --filter @cinderdeck/desktop -- electron-builder --projectDir ${stageAppDir} ${MAC_CLI_FLAG} --${options.arch} --publish never`,
      verbose: options.verbose,
    },
  );

  const stageDistDir = path.join(stageAppDir, "dist");
  if (!(yield* fs.exists(stageDistDir))) {
    return yield* new DesktopBuildDistDirectoryMissingError({
      distPath: stageDistDir,
      platform: options.platform,
      arch: options.arch,
    });
  }

  const copiedArtifacts = yield* copyDesktopBuildOutputs(
    stageDistDir,
    options.outputDir,
    options.target,
  );

  if (copiedArtifacts.length === 0) {
    return yield* new DesktopBuildNoArtifactsProducedError({
      distPath: stageDistDir,
      platform: options.platform,
      arch: options.arch,
    });
  }

  yield* Effect.log("[desktop-artifact] Done. Artifacts:").pipe(
    Effect.annotateLogs({ artifacts: copiedArtifacts }),
  );
});

const buildDesktopArtifactCli = Command.make("build-desktop-artifact", {
  platform: Flag.Literals("platform", BuildPlatform.literals).pipe(
    Flag.withDescription("Build platform (env: DECKHAND_DESKTOP_PLATFORM)."),
    Flag.optional,
  ),
  target: Flag.String("target").pipe(
    Flag.withDescription(
      "Private bundle target: dir (env: DECKHAND_DESKTOP_TARGET).",
    ),
    Flag.optional,
  ),
  arch: Flag.Literals("arch", BuildArch.literals).pipe(
    Flag.withDescription(
      "Build arch, for example arm64/x64/universal (env: DECKHAND_DESKTOP_ARCH).",
    ),
    Flag.optional,
  ),
  buildVersion: Flag.String("build-version").pipe(
    Flag.withDescription("Artifact version metadata (env: DECKHAND_DESKTOP_VERSION)."),
    Flag.optional,
  ),
  outputDir: Flag.String("output-dir").pipe(
    Flag.withDescription("Output directory for artifacts (env: DECKHAND_DESKTOP_OUTPUT_DIR)."),
    Flag.optional,
  ),
  skipBuild: Flag.Boolean("skip-build").pipe(
    Flag.withDescription(
      "Skip `vp run build:desktop` and use existing dist artifacts (env: DECKHAND_DESKTOP_SKIP_BUILD).",
    ),
    Flag.optional,
  ),
  keepStage: Flag.Boolean("keep-stage").pipe(
    Flag.withDescription("Keep temporary staging files (env: DECKHAND_DESKTOP_KEEP_STAGE)."),
    Flag.optional,
  ),
  signed: Flag.Boolean("signed").pipe(
    Flag.withDescription("Enable signing/notarization discovery (env: DECKHAND_DESKTOP_SIGNED)."),
    Flag.optional,
  ),
  verbose: Flag.Boolean("verbose").pipe(
    Flag.withDescription("Stream subprocess stdout (env: DECKHAND_DESKTOP_VERBOSE)."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Build the private Cinderdeck runtime bundle."),
  Command.withHandler((input) => Effect.flatMap(resolveBuildOptions(input), buildDesktopArtifact)),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

if (import.meta.main) {
  Command.run(buildDesktopArtifactCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
