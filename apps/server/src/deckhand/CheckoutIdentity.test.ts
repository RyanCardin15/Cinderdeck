import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";
import * as CheckoutIdentity from "./CheckoutIdentity.ts";

const TestLayer = CheckoutIdentity.layer.pipe(
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);
it.layer(TestLayer)("physical checkout identity", (it) => {
  it.effect("distinguishes an ordinary directory from missing or damaged Git metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const resolver = yield* CheckoutIdentity.CheckoutIdentity;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "deckhand-non-git-" });
      assert.equal((yield* resolver.resolve(root).pipe(Effect.flip)).operation, "not_git");
      assert.notEqual(
        (yield* resolver.resolve(root + "/missing").pipe(Effect.flip)).operation,
        "not_git",
      );
      yield* fs.writeFileString(
        root + "/.git",
        "gitdir: /nonexistent-deckhand-fixture-git-directory\n",
      );
      assert.notEqual((yield* resolver.resolve(root).pipe(Effect.flip)).operation, "not_git");
    }),
  );
  it.effect(
    "aliases, moves, worktrees and clones coordinate by physical identity while fork hosts remain distinct",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runner = yield* ProcessRunner.ProcessRunner;
        const resolver = yield* CheckoutIdentity.CheckoutIdentity;
        const temp = yield* fs.makeTempDirectoryScoped({ prefix: "deckhand-identity-" });
        const root = path.join(temp, "project with spaces");
        const alias = path.join(temp, "alias");
        const lane = path.join(temp, "lane");
        const copy = path.join(temp, "clone");
        yield* fs.makeDirectory(root);
        const git = (cwd: string, args: readonly string[]) =>
          runner
            .run({ command: "git", args: ["-C", cwd, ...args] })
            .pipe(Effect.tap((result) => Effect.sync(() => assert.equal(result.code, 0))));
        yield* git(root, ["init", "-b", "main"]);
        yield* git(root, [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "baseline",
        ]);
        yield* git(root, [
          "remote",
          "add",
          "origin",
          "https://username:do-not-export@enterprise.example:8443/fork/widget.git",
        ]);
        yield* git(root, ["remote", "add", "upstream", "git@enterprise.example:base/widget.git"]);
        yield* fs.symlink(root, alias);
        const initial = yield* resolver.resolve(root);
        const fromAlias = yield* resolver.resolve(alias);
        assert.equal(initial.physicalId, fromAlias.physicalId);
        assert.equal(initial.root, fromAlias.root);
        assert.deepEqual(initial.remotes, [
          { name: "origin", canonicalKey: "enterprise.example:8443/fork/widget" },
          { name: "upstream", canonicalKey: "enterprise.example/base/widget" },
        ]);
        yield* git(root, ["worktree", "add", "-b", "feature", lane]);
        const linked = yield* resolver.resolve(lane);
        assert.notEqual(initial.physicalId, linked.physicalId);
        assert.equal(initial.repositoryPhysicalId, linked.repositoryPhysicalId);
        yield* git(temp, ["clone", root, copy]);
        const cloned = yield* resolver.resolve(copy);
        assert.notEqual(initial.physicalId, cloned.physicalId);
        assert.notEqual(initial.repositoryPhysicalId, cloned.repositoryPhysicalId);
        const moved = path.join(temp, "renamed");
        yield* git(root, ["worktree", "move", lane, moved]);
        const afterMove = yield* resolver.resolve(moved);
        assert.equal(linked.physicalId, afterMove.physicalId);
        assert.notEqual(linked.root, afterMove.root);
        yield* git(moved, ["checkout", "--detach"]);
        const detached = yield* resolver.resolve(moved);
        assert.equal(detached.branch, null);
        assert.equal(detached.commit, initial.commit);
      }).pipe(Effect.scoped),
  );
  it.effect("rejects a folder without Git metadata instead of fabricating a checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const resolver = yield* CheckoutIdentity.CheckoutIdentity;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "deckhand-not-git-" });
      const error = yield* resolver.resolve(temp).pipe(Effect.flip);
      assert.equal(error._tag, "CheckoutIdentityError");
    }).pipe(Effect.scoped),
  );
});
