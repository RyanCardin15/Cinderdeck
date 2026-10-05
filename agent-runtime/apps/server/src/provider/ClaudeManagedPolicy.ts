import { ChildProcess } from "effect/unstable/process";
import { spawnAndCollect } from "./providerSnapshot.ts";
import * as NodeURL from "node:url";
import { HostProcessIsExecutable } from "@cinderdeck/shared/hostProcess";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ServerProvider } from "@cinderdeck/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ClaudeManagedPolicyReadError extends Schema.TaggedError<ClaudeManagedPolicyReadError>()(
  "ClaudeManagedPolicyReadError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return "Claude organization policy settings could not be read. Check the provider configuration and retry.";
  }
}

// The SDK resolver reads process.env and caches policy. Isolate it per account
// and read, without mutating the server's environment or reimplementing precedence.
// Its cached remote/MDM policy is advisory; the CLI still enforces live policy,
// including policyHelper results not exposed by resolveSettings.
export const readClaudeManagedPolicy = (input: { cwd?: string; environment?: NodeJS.ProcessEnv }) =>
  Effect.gen(function* () {
    const executable = yield* HostProcessIsExecutable;
    const workerPath = NodeURL.fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "../claude-policy-worker.ts"
          : "./claude-policy-worker.mjs",
        import.meta.url,
      ),
    );
    const result = yield* spawnAndCollect(
      process.execPath,
      ChildProcess.make(process.execPath, executable ? ["__claude-policy"] : [workerPath], {
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        env: { ...(input.environment ?? process.env), ELECTRON_RUN_AS_NODE: "1" },
        extendEnv: false,
      }),
    ).pipe(
      Effect.scoped,
      Effect.timeout("10 seconds"),
      Effect.mapError((cause) => new ClaudeManagedPolicyReadError({ cause })),
    );
    if (result.code !== 0 || !["true", "false"].includes(result.stdout.trim())) {
      return yield* new ClaudeManagedPolicyReadError({
        cause: "Invalid managed settings response",
      });
    }
    return result.stdout.trim() === "true";
  });

export function constrainClaudeOptions<T extends Options>(options: T, bypassDisabled: boolean): T {
  if (!bypassDisabled) return options;
  const extraArgs = { ...options.extraArgs };
  delete extraArgs["dangerously-skip-permissions"];
  delete extraArgs["allow-dangerously-skip-permissions"];
  delete extraArgs["permission-mode"];
  return {
    ...options,
    extraArgs,
    allowDangerouslySkipPermissions: false,
    ...(options.permissionMode === "bypassPermissions"
      ? { permissionMode: "default" as const }
      : {}),
  };
}

export const claudeRuntimeModeAdjustments = (
  bypassDisabled: boolean,
): NonNullable<ServerProvider["runtimeModeAdjustments"]> =>
  bypassDisabled
    ? [
        {
          mode: "full-access",
          description:
            "Adjusted by organization policy: permission checks remain enabled and actions may require approval.",
        },
      ]
    : [];
