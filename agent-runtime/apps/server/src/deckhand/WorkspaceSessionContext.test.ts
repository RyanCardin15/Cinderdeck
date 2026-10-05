import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@cinderdeck/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";
import { resolveWorkspaceFolder } from "./WorkspaceFolderIdentity.ts";
import * as CheckoutIdentity from "./CheckoutIdentity.ts";
import { workspaceContextText } from "./WorkspaceSessionContext.ts";
import { buildCodexTurnStartParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeClaudeQueryOptions } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { readAntigravityClientTextFile } from "../provider/acp/AntigravityClientFiles.ts";

describe("custom workspace access", () => {
  it.effect("keeps a selected subfolder distinct from its enclosing Git root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runner = yield* ProcessRunner.ProcessRunner;
      const identity = yield* CheckoutIdentity.CheckoutIdentity;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "workspace-subfolder-" });
      yield* runner.run({ command: "git", args: ["init", root] });
      yield* fs.makeDirectory(`${root}/docs`);
      const repo = yield* resolveWorkspaceFolder(identity, root);
      const docs = yield* resolveWorkspaceFolder(identity, `${root}/docs`);
      assert.equal(docs.root, yield* fs.realPath(`${root}/docs`));
      assert.notEqual(repo.physicalId, docs.physicalId);
    }).pipe(
      Effect.provide(
        CheckoutIdentity.layer.pipe(
          Layer.provideMerge(ProcessRunner.layer),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.scoped,
    ),
  );
  it.effect("grants exact paths without widening read-only Codex sessions", () =>
    Effect.gen(function* () {
      const build = (readOnly: boolean) =>
        buildCodexTurnStartParams({
          nativeThreadId: "workspace",
          codexInput: [{ type: "text", text: "work" }],
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimePolicy: {
            cwd: "/app",
            interactionMode: "default",
            runtimeMode: readOnly ? "approval-required" : "auto",
            workspaceFolders: ["/app", "/docs"],
            workspaceFiles: ["/references/brief.md"],
          },
        });
      const writer = yield* build(false);
      assert.deepEqual(writer.sandboxPolicy, {
        type: "workspaceWrite",
        writableRoots: ["/app", "/docs", "/references/brief.md"],
      });
      assert.equal((yield* build(true)).sandboxPolicy?.type, "readOnly");
    }),
  );
  it("gives Claude additional folders and supplies individual paths as context", () => {
    const options = makeClaudeQueryOptions({
      nativeThreadId: "custom",
      resume: false,
      cwd: "/app",
      workspaceFolders: ["/docs"],
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet-4-6" },
    });
    assert.deepEqual(options.additionalDirectories, ["/app", "/docs"]);
    const context = workspaceContextText({
      workspaceFolders: ["/app", "/docs"],
      workspaceFiles: ["/references/brief.md"],
    });
    assert.include(context, '"/references/brief.md"');
    assert.notInclude(context, '"/references"');
  });
  it.effect("allows selected files through ACP and rejects unselected siblings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "workspace-reference-" });
      const selected = path.join(root, "selected.md");
      const sibling = path.join(root, "private.md");
      yield* fs.writeFileString(selected, "selected");
      yield* fs.writeFileString(sibling, "private");
      const read = (file: string) =>
        readAntigravityClientTextFile({
          fileSystem: fs,
          path,
          allowedRoots: [selected],
          request: { sessionId: "workspace", path: file },
        });
      assert.equal((yield* read(selected)).content, "selected");
      assert.equal((yield* read(sibling).pipe(Effect.result))._tag, "Failure");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect("identifies ordinary folders consistently and rejects files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "workspace-folder-" });
      const identity = CheckoutIdentity.CheckoutIdentity.of({
        resolve: (path) =>
          Effect.fail(new CheckoutIdentity.CheckoutIdentityError({ path, operation: "not_git" })),
        missingRegistration: () => Effect.succeed(null),
      });
      const one = yield* resolveWorkspaceFolder(identity, root);
      assert.equal(one.physicalId, (yield* resolveWorkspaceFolder(identity, root)).physicalId);
      assert.equal(one.branch, null);
      yield* fs.writeFileString(`${root}/file.md`, "file");
      assert.equal(
        (yield* resolveWorkspaceFolder(identity, `${root}/file.md`).pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
