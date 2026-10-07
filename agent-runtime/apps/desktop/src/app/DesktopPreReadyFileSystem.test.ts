import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";
import * as DesktopUserData from "./DesktopUserData.ts";

const resolveDevelopmentUserData = (appDataDirectory: string) =>
  DesktopUserData.resolveUserDataPath({
    appDataDirectory,
    isDevelopment: true,
  }).pipe(Effect.provide(DesktopPreReadyFileSystem.layer));

it.layer(NodeServices.layer)("DesktopPreReadyFileSystem", (it) => {
  it.effect("finds the legacy development profile synchronously", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pre-ready-fs-" });

      assert.equal(yield* resolveDevelopmentUserData(root), path.join(root, "deckhand-dev"));

      yield* fileSystem.makeDirectory(path.join(root, "Cinderdeck (Dev)"));
      assert.equal(yield* resolveDevelopmentUserData(root), path.join(root, "Cinderdeck (Dev)"));
    }),
  );

  it.effect.skipIf(process.getuid?.() === 0)(
    "fails instead of treating an unreadable profile as missing",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pre-ready-fs-" });
        yield* fileSystem.chmod(root, 0o000);
        yield* Effect.addFinalizer(() => fileSystem.chmod(root, 0o700).pipe(Effect.orDie));

        const exit = yield* Effect.exit(resolveDevelopmentUserData(root));

        assert.isTrue(Exit.isFailure(exit));
      }),
  );
});
