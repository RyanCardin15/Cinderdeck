import type { ProviderInstanceEnvironment } from "@cinderdeck/contracts";

import { expandHomePath } from "../pathExpansion.ts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if ((!environment || environment.length === 0) && !("CINDERDECK_NATIVE_UI_TOKEN" in baseEnv)) {
    return baseEnv;
  }

  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment ?? []) {
    // Child processes do not apply shell expansion to environment values.
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value)
        : variable.value;
  }
  // The native shell credential authorizes UI ownership, never provider children.
  // Remove it after overrides too, so instance configuration cannot reintroduce it.
  delete next.CINDERDECK_NATIVE_UI_TOKEN;
  return next;
}
