import type { RuntimeMode, ServerProvider } from "@cinderdeck/contracts";
import * as Effect from "effect/Effect";
import * as AcpErrors from "effect-acp/errors";

import type { AcpSessionRuntime } from "./AcpSessionRuntime.ts";
import type { AcpSessionModeState } from "./AcpRuntimeModel.ts";

const PERMISSION_MODES = ["default", "auto_edit", "yolo"] as const;

/** Only move toward more approval, never toward broader access. */
function resolveAntigravityPermissionMode(
  requested: string,
  modes: AcpSessionModeState | undefined,
): string | undefined {
  if (modes === undefined) return requested;
  const rank = PERMISSION_MODES.findIndex((mode) => mode === requested);
  if (rank < 0) return requested;
  return PERMISSION_MODES.slice(0, rank + 1)
    .toReversed()
    .find((mode) => modes.availableModes.some((available) => available.id === mode));
}

/** Used at the runtime boundary, including resumed sessions and text helpers. */
export function withAntigravityPermissionPolicy<
  T extends Pick<AcpSessionRuntime["Service"], "getModeState" | "setMode">,
>(runtime: T): Omit<T, "setMode"> & Pick<AcpSessionRuntime["Service"], "setMode"> {
  return {
    ...runtime,
    setMode: (requested: string) =>
      Effect.gen(function* () {
        const modes = yield* runtime.getModeState;
        const selected = resolveAntigravityPermissionMode(requested, modes);
        if (selected === undefined) {
          return yield* AcpErrors.AcpRequestError.invalidParams(
            `Antigravity permission policy does not allow '${requested}' or a more restrictive mode. Allowed modes: ${modes?.availableModes.map((mode) => mode.id).join(", ") || "none"}.`,
          );
        }
        return yield* runtime.setMode(selected);
      }),
  };
}

export function antigravityRuntimeModeAdjustments(
  modes: AcpSessionModeState | undefined,
): NonNullable<ServerProvider["runtimeModeAdjustments"]> {
  const choices: ReadonlyArray<readonly [RuntimeMode, string]> = [
    ["approval-required", "default"],
    ["auto", "default"],
    ["auto-accept-edits", "auto_edit"],
    ["full-access", "yolo"],
  ];
  return choices.flatMap(([mode, requested]) => {
    const selected = resolveAntigravityPermissionMode(requested, modes);
    return selected === requested
      ? []
      : [
          {
            mode,
            source: "provider" as const,
            description:
              selected === undefined
                ? "Unavailable under Antigravity's permission policy. No equally restrictive mode is available."
                : `Antigravity's permission policy adjusts this mode to ${selected === "default" ? "ask for approval" : "auto-accept edits"}.`,
          },
        ];
  });
}
