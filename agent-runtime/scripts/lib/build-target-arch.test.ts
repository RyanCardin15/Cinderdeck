import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HostProcessArchitecture } from "@cinderdeck/shared/hostProcess";

import { getDefaultBuildArch } from "./build-target-arch.ts";

const withHostArch = (arch: NodeJS.Architecture) =>
  Effect.provideService(HostProcessArchitecture, arch);

describe("build-target-arch", () => {
  it.effect("selects the host architecture when the target supports it", () =>
    Effect.gen(function* () {
      const arch = yield* getDefaultBuildArch(["arm64", "x64", "universal"]).pipe(
        withHostArch("x64"),
      );

      assert.equal(arch, "x64");
    }),
  );

  it.effect("falls back to the first supported architecture for other hosts", () =>
    Effect.gen(function* () {
      const arch = yield* getDefaultBuildArch(["arm64", "x64", "universal"]).pipe(
        withHostArch("ia32"),
      );

      assert.equal(arch, "arm64");
    }),
  );
});
