import { HostProcessArchitecture } from "@cinderdeck/shared/hostProcess";
import * as Effect from "effect/Effect";

export type BuildArch = "arm64" | "x64" | "universal";

export const getDefaultBuildArch = Effect.fn("getDefaultBuildArch")(function* (
  archChoices: ReadonlyArray<BuildArch>,
) {
  const processArch = yield* HostProcessArchitecture;
  const hostArch = processArch === "arm64" || processArch === "x64" ? processArch : undefined;
  if (hostArch && archChoices.includes(hostArch)) {
    return hostArch;
  }

  return archChoices[0] ?? "x64";
});
