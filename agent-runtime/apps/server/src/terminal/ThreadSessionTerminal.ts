/**
 * Opens a thread's native provider session in a terminal outside Cinderdeck.
 *
 * Claude Code and Codex keep their own transcripts, so the CLI can pick up any
 * session the agent runtime started. A session with a run in flight is forked
 * (Claude) so the terminal never appends to the transcript the running agent
 * owns.
 *
 * @module ThreadSessionTerminal
 */
import {
  ClaudeSettings,
  CodexSettings,
  ThreadId,
  ThreadSessionTerminalError,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type ThreadSessionTerminalInput,
  type ThreadSessionTerminalMode,
  type ThreadSessionTerminalResult,
} from "@cinderdeck/contracts";
import { HostProcessPlatform } from "@cinderdeck/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type * as ProjectService from "../project/ProjectService.ts";
import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type * as ServerSettings from "../serverSettings.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { resolveProviderInstanceTerminalEnvironment } from "./Manager.ts";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

const LIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/** Home-directory variables are safe to show in a copied command; other overrides may be secrets. */
const COPYABLE_ENV_KEYS: ReadonlySet<string> = new Set(["CLAUDE_CONFIG_DIR", "CODEX_HOME"]);

export interface SessionResumeCommand {
  readonly argv: ReadonlyArray<string>;
  readonly mode: ThreadSessionTerminalMode;
}

/** The CLI invocation that resumes `nativeId`, or undefined for drivers without a resumable CLI. */
export function buildSessionResumeCommand(input: {
  readonly driver: string;
  readonly binaryPath: string;
  readonly nativeId: string;
  readonly isLive: boolean;
}): SessionResumeCommand | undefined {
  switch (input.driver) {
    case "claudeAgent":
      return input.isLive
        ? {
            argv: [input.binaryPath, "--resume", input.nativeId, "--fork-session"],
            mode: "fork",
          }
        : { argv: [input.binaryPath, "--resume", input.nativeId], mode: "resume" };
    case "codex":
      return { argv: [input.binaryPath, "resume", input.nativeId], mode: "resume" };
    default:
      return undefined;
  }
}

export function quoteShellArgument(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** A one-line command a person can paste into any POSIX shell. */
export function renderSessionCopyCommand(input: {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly argv: ReadonlyArray<string>;
}): string {
  const assignments = Object.entries(input.env)
    .filter(([key]) => COPYABLE_ENV_KEYS.has(key))
    .map(([key, value]) => `${key}=${quoteShellArgument(value)}`);
  return [
    `cd ${quoteShellArgument(input.cwd)} &&`,
    ...assignments,
    ...input.argv.map(quoteShellArgument),
  ].join(" ");
}

/**
 * A `.command` script for the user's terminal app. It deletes itself first
 * (it may hold provider credentials from the instance environment), runs the
 * CLI through the login shell so PATH matches the user's own terminal, and
 * leaves an interactive shell in the workspace when the CLI exits.
 */
export function renderSessionTerminalScript(input: {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly argv: ReadonlyArray<string>;
}): string {
  const exports = Object.entries(input.env).map(
    ([key, value]) => `export ${key}=${quoteShellArgument(value)}`,
  );
  const command = input.argv.map(quoteShellArgument).join(" ");
  return [
    "#!/bin/sh",
    'rm -f -- "$0"',
    `cd ${quoteShellArgument(input.cwd)} || exit 1`,
    ...exports,
    'login_shell="${SHELL:-/bin/zsh}"',
    `"$login_shell" -l -c ${quoteShellArgument(command)}`,
    'exec "$login_shell" -l',
    "",
  ].join("\n");
}

const resolveBinaryPath = (driver: string, config: unknown): string => {
  if (driver === "claudeAgent") {
    return Option.match(decodeClaudeSettings(config ?? {}), {
      onNone: () => "claude",
      onSome: (settings) => settings.binaryPath,
    });
  }
  return Option.match(decodeCodexSettings(config ?? {}), {
    onNone: () => "codex",
    onSome: (settings) => settings.binaryPath,
  });
};

const pickProviderThread = (projection: {
  readonly thread: { readonly activeProviderThreadId: string | null };
  readonly providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>;
}): OrchestrationV2ProviderThread | undefined => {
  const withNativeId = projection.providerThreads.filter(
    (candidate) => candidate.nativeThreadRef?.nativeId != null,
  );
  return (
    withNativeId.find((candidate) => candidate.id === projection.thread.activeProviderThreadId) ??
    withNativeId.at(-1)
  );
};

export const openThreadSessionTerminal = Effect.fn("terminal.openThreadSession")(function* (
  services: {
    readonly threadManagement: ThreadManagementService.ThreadManagementService["Service"];
    readonly projectService: ProjectService.ProjectService["Service"];
    readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
  },
  input: ThreadSessionTerminalInput,
): Effect.fn.Return<
  ThreadSessionTerminalResult,
  ThreadSessionTerminalError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const threadId = input.threadId;
  const fail = (reason: ThreadSessionTerminalError["reason"], cause?: unknown) =>
    new ThreadSessionTerminalError({
      threadId,
      reason,
      ...(cause === undefined ? {} : { cause }),
    });

  const projection = yield* services.threadManagement
    .getThreadRecords(ThreadId.make(threadId), ["providerThreads", "runs"])
    .pipe(Effect.mapError((cause) => fail("thread-unavailable", cause)));
  const providerThread = pickProviderThread(projection);
  const nativeId = providerThread?.nativeThreadRef?.nativeId;
  if (providerThread === undefined || nativeId == null) {
    return yield* fail("no-native-session");
  }

  const project = yield* services.projectService
    .getById(projection.thread.projectId)
    .pipe(Effect.mapError((cause) => fail("thread-unavailable", cause)));
  if (Option.isNone(project)) {
    return yield* fail("thread-unavailable");
  }
  const cwd = projection.thread.worktreePath ?? project.value.workspaceRoot;

  const settings = yield* services.serverSettings.getSettings.pipe(
    Effect.mapError((cause) => fail("thread-unavailable", cause)),
  );
  const instance = deriveProviderInstanceConfigMap(settings)[providerThread.providerInstanceId];
  const resume = buildSessionResumeCommand({
    driver: providerThread.driver,
    binaryPath: resolveBinaryPath(providerThread.driver, instance?.config),
    nativeId,
    isLive: projection.runs.some((run) => LIVE_RUN_STATUSES.has(run.status)),
  });
  if (resume === undefined) {
    return yield* fail("unsupported-provider");
  }

  const path = yield* Path.Path;
  const env =
    instance === undefined
      ? {}
      : yield* resolveProviderInstanceTerminalEnvironment({
          serverSettings: services.serverSettings,
          path,
          rawProviderInstanceId: providerThread.providerInstanceId,
          env: undefined,
        }).pipe(Effect.mapError((cause) => fail("launch-failed", cause)));
  const command = renderSessionCopyCommand({ cwd, env, argv: resume.argv });
  if (input.launch === false) {
    return { command, mode: resume.mode, launched: false };
  }

  if ((yield* HostProcessPlatform) !== "darwin") {
    return yield* fail("unsupported-platform");
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* Effect.gen(function* () {
    const directory = yield* fileSystem.makeTempDirectory({ prefix: "cinderdeck-session-" });
    const scriptPath = path.join(directory, "Resume session.command");
    yield* fileSystem.writeFileString(
      scriptPath,
      renderSessionTerminalScript({ cwd, env, argv: resume.argv }),
      { mode: 0o700 },
    );
    yield* fileSystem.chmod(scriptPath, 0o700);
    // `open` hands the script to whichever app handles .command files
    // (Terminal unless the user picked iTerm or another terminal).
    const handle = yield* spawner.spawn(
      ChildProcess.make("open", [scriptPath], {
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    const exitCode = yield* handle.exitCode;
    if (exitCode !== 0) {
      return yield* Effect.fail(`open exited with ${exitCode}`);
    }
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) => fail("launch-failed", cause)),
  );
  return { command, mode: resume.mode, launched: true };
});
