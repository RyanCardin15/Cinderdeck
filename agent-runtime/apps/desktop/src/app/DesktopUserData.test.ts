import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect("identifies a failed inspection and preserves its cause", () => {
  const legacyPath = "/profiles/Cinderdeck (Dev)";
  const cause = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "exists",
    pathOrDescriptor: legacyPath,
  });
  return Effect.gen(function* () {
    const error = yield* resolveUserDataPath({
      appDataDirectory: "/profiles",
      isDevelopment: true,
    }).pipe(Effect.flip);
    assert.equal(error.operation, "inspect");
    assert.equal(error.resourcePath, legacyPath);
    assert.equal(error.category, "PermissionDenied");
    assert.strictEqual(error.cause, cause);
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({ exists: () => Effect.fail(cause) }),
    ),
    Effect.provide(NodeServices.layer),
  );
});

it.effect("keeps a legacy development profile and otherwise uses the current name", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-profile-" });

    assert.equal(
      yield* resolveUserDataPath({ appDataDirectory: directory, isDevelopment: true }),
      path.join(directory, "deckhand-dev"),
    );
    yield* fs.makeDirectory(path.join(directory, "Cinderdeck (Dev)"));
    assert.equal(
      yield* resolveUserDataPath({ appDataDirectory: directory, isDevelopment: true }),
      path.join(directory, "Cinderdeck (Dev)"),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("gives a packaged build its own profile without copying legacy state", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-profile-" });
    yield* fs.makeDirectory(path.join(directory, "Cinderdeck (Alpha)"));
    yield* fs.writeFileString(path.join(directory, "Cinderdeck (Alpha)", "Local State"), "{}");

    assert.equal(
      yield* resolveUserDataPath({ appDataDirectory: directory, isDevelopment: false }),
      path.join(directory, "deckhand-v2"),
    );
    assert.isFalse(yield* fs.exists(path.join(directory, "deckhand-v2")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
