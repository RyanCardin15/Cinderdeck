// @effect-diagnostics nodeBuiltinImport:off - SHA-256 identifies local files; Git/process I/O uses services.
import * as NodeCrypto from "node:crypto";
import type { PhysicalCheckout } from "@t3tools/contracts/deckhand";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";

function remoteKey(raw: string): string {
  try {
    const url = new URL(raw);
    if (["http:", "https:", "ssh:", "git:"].includes(url.protocol) && url.hostname) {
      const path = url.pathname
        .replace(/\/+$/, "")
        .replace(/\.git$/i, "")
        .replace(/^\/+/, "");
      return `${url.host.toLowerCase()}/${path.toLowerCase()}`;
    }
  } catch {
    /* SCP-style and local remotes are not URLs. */
  }
  const scp = /^(?:[^@\s]+@)?([^:/\s]+):(.+)$/.exec(raw);
  if (scp?.[1] && scp[2]) {
    return `${scp[1].toLowerCase()}/${scp[2]
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "")
      .toLowerCase()}`;
  }
  // Local or unparseable remotes stay identifiable without exposing paths or embedded secrets.
  return `local:${NodeCrypto.createHash("sha256").update(raw).digest("hex")}`;
}

export class CheckoutIdentityError extends Schema.TaggedError<CheckoutIdentityError>()(
  "CheckoutIdentityError",
  { path: Schema.String, operation: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return `Cannot resolve checkout identity during ${this.operation}.`;
  }
}
export class CheckoutIdentity extends Context.Service<
  CheckoutIdentity,
  {
    readonly resolve: (path: string) => Effect.Effect<PhysicalCheckout, CheckoutIdentityError>;
  }
>()("t3/deckhand/CheckoutIdentity") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const resolve = Effect.fn("deckhand.checkoutIdentity.resolve")(function* (path: string) {
    const git = (args: ReadonlyArray<string>) =>
      runner
        .run({
          command: "git",
          args: ["-C", path, ...args],
          timeout: Duration.seconds(10),
          maxOutputBytes: 65536,
          env: { LC_ALL: "C" },
        })
        .pipe(
          Effect.mapError((cause) => new CheckoutIdentityError({ path, operation: "git", cause })),
        );
    const canonical = (value: string) =>
      fs
        .realPath(value)
        .pipe(
          Effect.mapError(
            (cause) => new CheckoutIdentityError({ path, operation: "canonicalize", cause }),
          ),
        );
    const physical = Effect.fn(function* (directory: string) {
      const info = yield* fs
        .stat(directory)
        .pipe(
          Effect.mapError((cause) => new CheckoutIdentityError({ path, operation: "stat", cause })),
        );
      // Inodes survive rename. Filesystems without file IDs retain a canonical-path fallback.
      const key = Option.match(info.ino, {
        onSome: (ino) => `${info.dev}:${ino}`,
        onNone: () => directory,
      });
      return NodeCrypto.createHash("sha256").update(key).digest("hex");
    });
    const roots = yield* git([
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
      "--git-dir",
    ]);
    if (roots.code !== 0 || roots.stdoutTruncated || roots.stdoutInvalidUtf8) {
      const ordinaryDirectory =
        roots.code === 128 &&
        !roots.stderrTruncated &&
        !roots.stderrInvalidUtf8 &&
        roots.stderr.trim() ===
          "fatal: not a git repository (or any of the parent directories): .git";
      return yield* new CheckoutIdentityError({
        path,
        operation: ordinaryDirectory ? "not_git" : "resolve Git root",
      });
    }
    const [rootPath, commonPath, gitPath, ...extra] = roots.stdout.trim().split("\n");
    if (!rootPath || !commonPath || !gitPath || extra.length) {
      return yield* new CheckoutIdentityError({ path, operation: "validate Git paths" });
    }
    const root = yield* canonical(rootPath);
    const commonDirectory = yield* canonical(commonPath);
    const gitDirectory = yield* canonical(gitPath);
    const physicalId = yield* physical(gitDirectory);
    const repositoryPhysicalId = yield* physical(commonDirectory);
    const head = yield* git(["rev-parse", "--verify", "HEAD"]);
    const branch = yield* git(["symbolic-ref", "--short", "-q", "HEAD"]);
    const remoteResult = yield* git(["remote", "-v"]);
    if (remoteResult.code !== 0 || remoteResult.stdoutTruncated || remoteResult.stdoutInvalidUtf8) {
      return yield* new CheckoutIdentityError({ path, operation: "read remotes" });
    }
    const remotes = new Map<string, string>();
    for (const line of remoteResult.stdout.split("\n")) {
      const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
      if (match?.[1] && match[2]) remotes.set(match[1], remoteKey(match[2]));
    }
    return {
      physicalId,
      repositoryPhysicalId,
      root,
      commonDirectory,
      gitDirectory,
      branch: branch.code === 0 ? branch.stdout.trim() : null,
      commit: head.code === 0 ? head.stdout.trim() : null,
      remotes: [...remotes].map(([name, canonicalKey]) => ({ name, canonicalKey })),
    } satisfies PhysicalCheckout;
  });
  return CheckoutIdentity.of({ resolve });
});
export const layer = Layer.effect(CheckoutIdentity, make);
