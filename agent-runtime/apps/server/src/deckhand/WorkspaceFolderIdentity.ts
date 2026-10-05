import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { PhysicalCheckout } from "@cinderdeck/contracts/deckhand";
import * as CheckoutIdentity from "./CheckoutIdentity.ts";

/** Git stays strict for branch operations; ordinary workspace folders get a stable local identity. */
export const resolveWorkspaceFolder = (
  identity: CheckoutIdentity.CheckoutIdentity["Service"],
  path: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(path);
    const info = yield* fs.stat(root);
    if (info.type !== "Directory")
      return yield* new CheckoutIdentity.CheckoutIdentityError({
        path,
        operation: "not_directory",
      });
    const checkout = yield* identity.resolve(root).pipe(Effect.result);
    if (checkout._tag === "Success" && checkout.success.root === root) return checkout.success;
    if (checkout._tag === "Failure" && checkout.failure.operation !== "not_git")
      return yield* checkout.failure;
    // A selected subfolder remains that exact folder, even inside a Git repository.
    // This also permits the repository and its documentation folder in one workspace.
    const key = Option.match(info.ino, {
      onSome: (ino) => `${info.dev}:${ino}`,
      onNone: () => root,
    });
    const physicalId = NodeCrypto.createHash("sha256")
      .update(`workspace-folder:${key}`)
      .digest("hex");
    return {
      physicalId,
      repositoryPhysicalId: physicalId,
      root,
      commonDirectory: root,
      gitDirectory: root,
      branch: null,
      commit: null,
      remotes: [],
    } satisfies PhysicalCheckout;
  }).pipe(
    Effect.mapError((error) =>
      Schema.is(CheckoutIdentity.CheckoutIdentityError)(error)
        ? error
        : new CheckoutIdentity.CheckoutIdentityError({
            path,
            operation: "workspace_folder",
            cause: error,
          }),
    ),
  );
