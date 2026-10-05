// @effect-diagnostics nodeBuiltinImport:off - SHA-256 identifies local files; Git/process I/O uses services.
import * as NodeCrypto from "node:crypto";
import type { PhysicalCheckout } from "@cinderdeck/contracts/deckhand";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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
    readonly missingRegistration: (
      repository: PhysicalCheckout,
      root: string,
    ) => Effect.Effect<PhysicalCheckout | null, CheckoutIdentityError>;
  }
>()("@cinderdeck/server/deckhand/CheckoutIdentity") {}

const isIdentityError = Schema.is(CheckoutIdentityError);
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const paths = yield* Path.Path;
  const physical = Effect.fn(function* (directory: string, path: string) {
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
    const physicalId = yield* physical(gitDirectory, path);
    const repositoryPhysicalId = yield* physical(commonDirectory, path);
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
  // Git retains a missing checkout's registration/inode until cleanup. Resolve
  // it only from this repository's metadata, never from a saved pathname alone.
  const missingRegistration: CheckoutIdentity["Service"]["missingRegistration"] = (
    repository,
    root,
  ) =>
    Effect.gen(function* () {
      if (!paths.isAbsolute(root) || (yield* fs.exists(root))) return null;
      const canonicalMissing = Effect.fn(function* (value: string) {
        let ancestor = paths.resolve(value);
        const suffix: string[] = [];
        for (let depth = 0; depth < 128; depth++) {
          if (yield* fs.exists(ancestor))
            return paths.join(yield* fs.realPath(ancestor), ...suffix);
          const parent = paths.dirname(ancestor);
          if (parent === ancestor) break;
          suffix.unshift(paths.basename(ancestor));
          ancestor = parent;
        }
        return yield* new CheckoutIdentityError({
          path: root,
          operation: "canonicalize missing registration",
        });
      });
      const registrations = paths.join(repository.commonDirectory, "worktrees");
      if (!(yield* fs.exists(registrations))) return null;
      const canonicalRegistrations = yield* fs.realPath(registrations);
      if (canonicalRegistrations !== registrations)
        return yield* new CheckoutIdentityError({
          path: root,
          operation: "validate registrations",
        });
      const entries = yield* fs.readDirectory(registrations);
      if (entries.length > 64)
        return yield* new CheckoutIdentityError({ path: root, operation: "registration limit" });
      const expected = yield* canonicalMissing(paths.join(root, ".git"));
      const line = Effect.fn(function* (file: string) {
        const info = yield* fs.stat(file);
        if (info.type !== "File" || info.size > 4096) return null;
        const value = (yield* fs.readFileString(file)).replace(/\n$/, "");
        return value && value.length <= 4096 && !/[\r\n\0]/.test(value) ? value : null;
      });
      for (const entry of entries) {
        const directory = yield* fs.realPath(paths.join(registrations, entry));
        if (paths.dirname(directory) !== registrations)
          return yield* new CheckoutIdentityError({
            path: root,
            operation: "validate registration directory",
          });
        const pointer = yield* line(paths.join(directory, "gitdir"));
        if (
          pointer === null ||
          (yield* canonicalMissing(paths.resolve(directory, pointer))) !== expected
        )
          continue;
        const common = yield* line(paths.join(directory, "commondir"));
        if (
          common === null ||
          (yield* fs.realPath(paths.resolve(directory, common))) !== repository.commonDirectory ||
          (yield* physical(repository.commonDirectory, root)) !== repository.repositoryPhysicalId
        )
          return yield* new CheckoutIdentityError({
            path: root,
            operation: "validate registration common directory",
          });
        return {
          ...repository,
          root: paths.dirname(expected),
          gitDirectory: directory,
          physicalId: yield* physical(directory, root),
          branch: null,
          commit: null,
        };
      }
      return null;
    }).pipe(
      Effect.mapError((cause) =>
        isIdentityError(cause)
          ? cause
          : new CheckoutIdentityError({ path: root, operation: "missing registration", cause }),
      ),
    );
  return CheckoutIdentity.of({ resolve, missingRegistration });
});
export const layer = Layer.effect(CheckoutIdentity, make);
