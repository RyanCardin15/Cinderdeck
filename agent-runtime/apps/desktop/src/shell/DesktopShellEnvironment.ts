import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

type EnvironmentPatch = Record<string, string>;

interface ShellEnvironmentConfig {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly userShell: Option.Option<string>;
}

const DesktopShellEnvironmentProbe = Schema.Literals(["login-shell", "launchctl-path"]);
type DesktopShellEnvironmentProbe = typeof DesktopShellEnvironmentProbe.Type;

const desktopShellEnvironmentCommandFields = {
  probe: DesktopShellEnvironmentProbe,
  executable: Schema.String,
  argumentCount: Schema.Number,
};

export class DesktopShellEnvironmentCommandError extends Schema.TaggedError<DesktopShellEnvironmentCommandError>()(
  "DesktopShellEnvironmentCommandError",
  {
    ...desktopShellEnvironmentCommandFields,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop shell environment ${this.probe} probe (${this.executable}) failed.`;
  }
}

export class DesktopShellEnvironmentCommandTimeoutError extends Schema.TaggedError<DesktopShellEnvironmentCommandTimeoutError>()(
  "DesktopShellEnvironmentCommandTimeoutError",
  {
    ...desktopShellEnvironmentCommandFields,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Desktop shell environment ${this.probe} probe (${this.executable}) timed out after ${this.timeoutMs}ms.`;
  }
}

export class DesktopShellEnvironment extends Context.Service<
  DesktopShellEnvironment,
  {
    readonly installIntoProcess: Effect.Effect<void>;
  }
>()("@cinderdeck/desktop/shell/DesktopShellEnvironment") {}

const LOGIN_SHELL_ENV_NAMES = [
  "PATH",
  "DISPLAY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSH_AUTH_SOCK",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;
const LOCALE_ENV_NAMES = ["LANG", "LC_ALL", "LC_CTYPE"] as const;
const FALLBACK_LC_CTYPE = "en_US.UTF-8";
const PATH_DELIMITER = ":";
const LOGIN_SHELL_TIMEOUT = Duration.seconds(5);
const LAUNCHCTL_TIMEOUT = Duration.seconds(2);
const PROCESS_TERMINATE_GRACE = Duration.seconds(1);

const trimNonEmpty = (value: string | null | undefined): Option.Option<string> =>
  Option.fromNullishOr(value).pipe(
    Option.map((entry) => entry.trim()),
    Option.filter((entry) => entry.length > 0),
  );

const readEnvPath = (env: NodeJS.ProcessEnv): Option.Option<string> => trimNonEmpty(env.PATH);

const pathComparisonKey = (entry: string) => entry.trim().replace(/^"+|"+$/g, "");

const mergePaths = (values: ReadonlyArray<Option.Option<string>>): Option.Option<string> => {
  const entries: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (Option.isNone(value)) continue;

    for (const entry of value.value.split(PATH_DELIMITER)) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;

      const key = pathComparisonKey(trimmed);
      if (key.length === 0 || seen.has(key)) continue;

      seen.add(key);
      entries.push(trimmed);
    }
  }

  return entries.length > 0 ? Option.some(entries.join(PATH_DELIMITER)) : Option.none();
};

const listLoginShellCandidates = (config: ShellEnvironmentConfig): ReadonlyArray<string> => {
  const fallback = config.platform === "darwin" ? "/bin/zsh" : "";
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const candidate of [
    trimNonEmpty(config.env.SHELL),
    config.userShell,
    trimNonEmpty(fallback),
  ]) {
    if (Option.isNone(candidate) || seen.has(candidate.value)) continue;
    seen.add(candidate.value);
    candidates.push(candidate.value);
  }

  return candidates;
};

const startMarker = (name: string) => `__DECKHAND_ENV_${name}_START__`;
const endMarker = (name: string) => `__DECKHAND_ENV_${name}_END__`;

const executableName = (command: string): string => command.split(/[\\/]/u).at(-1) ?? command;

const logShellEnvironmentCommandError = (
  error: DesktopShellEnvironmentCommandError | DesktopShellEnvironmentCommandTimeoutError,
) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      component: "desktop-shell-environment",
      error,
    }),
  );

const capturePosixEnvironmentCommand = (names: ReadonlyArray<string>) =>
  names
    .map((name) => {
      return [
        `printf '%s\\n' '${startMarker(name)}'`,
        `printenv ${name} || true`,
        `printf '%s\\n' '${endMarker(name)}'`,
      ].join("; ");
    })
    .join("; ");

const extractEnvironment = (output: string, names: ReadonlyArray<string>): EnvironmentPatch => {
  const environment: EnvironmentPatch = {};

  for (const name of names) {
    const start = output.indexOf(startMarker(name));
    if (start === -1) continue;

    const valueStart = start + startMarker(name).length;
    const end = output.indexOf(endMarker(name), valueStart);
    if (end === -1) continue;

    const value = output
      .slice(valueStart, end)
      .replace(/^\r?\n/, "")
      .replace(/\r?\n$/, "");
    if (value.length > 0) {
      environment[name] = value;
    }
  }

  return environment;
};

const runCommandOutput = Effect.fn("desktop.shellEnvironment.runCommandOutput")(function* (input: {
  readonly probe: DesktopShellEnvironmentProbe;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly timeout: Duration.Duration;
  readonly shell?: boolean;
}): Effect.fn.Return<string, never, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* spawner
    .string(
      ChildProcess.make(input.command, input.args, {
        shell: input.shell ?? false,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGTERM",
        forceKillAfter: PROCESS_TERMINATE_GRACE,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new DesktopShellEnvironmentCommandError({
            probe: input.probe,
            executable: executableName(input.command),
            argumentCount: input.args.length,
            cause,
          }),
      ),
      Effect.catchTags({
        DesktopShellEnvironmentCommandError: (error) =>
          logShellEnvironmentCommandError(error).pipe(Effect.as("")),
      }),
      Effect.timeoutOption(input.timeout),
    );
  if (Option.isSome(output)) {
    return output.value;
  }

  const error = new DesktopShellEnvironmentCommandTimeoutError({
    probe: input.probe,
    executable: executableName(input.command),
    argumentCount: input.args.length,
    timeoutMs: Duration.toMillis(input.timeout),
  });
  yield* logShellEnvironmentCommandError(error);
  return "";
});

const readLoginShellEnvironment = (
  shell: string,
  names: ReadonlyArray<string>,
): Effect.Effect<EnvironmentPatch, never, ChildProcessSpawner.ChildProcessSpawner> =>
  names.length === 0
    ? Effect.succeed({})
    : runCommandOutput({
        probe: "login-shell",
        command: shell,
        args: ["-ilc", capturePosixEnvironmentCommand(names)],
        timeout: LOGIN_SHELL_TIMEOUT,
      }).pipe(Effect.map((output) => extractEnvironment(output, names)));

const readLaunchctlPath = runCommandOutput({
  probe: "launchctl-path",
  command: "/bin/launchctl",
  args: ["getenv", "PATH"],
  timeout: LAUNCHCTL_TIMEOUT,
}).pipe(Effect.map(trimNonEmpty));

const installPosixEnvironment = Effect.fn("desktop.shellEnvironment.installPosixEnvironment")(
  function* (
    config: ShellEnvironmentConfig,
  ): Effect.fn.Return<void, never, ChildProcessSpawner.ChildProcessSpawner> {
    const shellEnvironment: EnvironmentPatch = {};

    for (const shell of listLoginShellCandidates(config)) {
      Object.assign(
        shellEnvironment,
        yield* readLoginShellEnvironment(shell, LOGIN_SHELL_ENV_NAMES),
      );
      if (shellEnvironment.PATH) break;
    }

    const launchctlPath =
      config.platform === "darwin" && !shellEnvironment.PATH
        ? yield* readLaunchctlPath
        : Option.none<string>();
    const mergedPath = mergePaths([
      trimNonEmpty(shellEnvironment.PATH).pipe(Option.orElse(() => launchctlPath)),
      readEnvPath(config.env),
    ]);

    if (Option.isSome(mergedPath)) {
      config.env.PATH = mergedPath.value;
    }
    if (!config.env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
      config.env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
    }

    for (const name of [
      "DISPLAY",
      "HOMEBREW_PREFIX",
      "HOMEBREW_CELLAR",
      "HOMEBREW_REPOSITORY",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ] as const) {
      if (!config.env[name] && shellEnvironment[name]) {
        config.env[name] = shellEnvironment[name];
      }
    }

    // Locale variables form one precedence group: LC_ALL can override an inherited
    // LANG or LC_CTYPE, so only hydrate the group when the process has none of them.
    if (
      config.platform === "darwin" &&
      LOCALE_ENV_NAMES.every((name) => Option.isNone(trimNonEmpty(config.env[name])))
    ) {
      for (const name of LOCALE_ENV_NAMES) {
        const value = trimNonEmpty(shellEnvironment[name]);
        if (Option.isSome(value)) {
          config.env[name] = value.value;
        }
      }

      // GUI launches inherit no locale from launchd, so spawned agents land in the C
      // locale and pbcopy decodes their UTF-8 output as MacRoman. Older supported
      // macOS releases do not provide C.UTF-8, so set only LC_CTYPE to a UTF-8 locale
      // available on those releases. Leaving LANG unset keeps C-stable collation and
      // formatting, so output parsing is unaffected.
      if (LOCALE_ENV_NAMES.every((name) => Option.isNone(trimNonEmpty(config.env[name])))) {
        config.env.LC_CTYPE = FALLBACK_LC_CTYPE;
      }
    }
  },
);

const installShellEnvironment = (
  config: ShellEnvironmentConfig,
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> =>
  config.platform === "darwin" ? installPosixEnvironment(config) : Effect.void;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const installIntoProcess: DesktopShellEnvironment["Service"]["installIntoProcess"] =
    installShellEnvironment({
      env: process.env,
      platform: environment.platform,
      userShell: Option.none(),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.withSpan("desktop.shellEnvironment.installIntoProcess"),
    );

  return DesktopShellEnvironment.of({ installIntoProcess });
});

export const layer = Layer.effect(DesktopShellEnvironment, make);
