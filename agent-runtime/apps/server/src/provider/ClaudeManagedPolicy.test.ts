import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  constrainClaudeOptions,
  claudeRuntimeModeAdjustments,
  readClaudeManagedPolicy,
} from "./ClaudeManagedPolicy.ts";

it("removes bypass flags while retaining the permission callback", () => {
  const canUseTool = async () => ({ behavior: "deny" as const, message: "Needs approval" });
  const options = {
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    canUseTool,
    extraArgs: {
      "dangerously-skip-permissions": null,
      "permission-mode": "bypassPermissions",
      verbose: null,
    },
  };
  const adjusted = constrainClaudeOptions(options, true);
  assert.equal(adjusted.permissionMode, "default");
  assert.equal(adjusted.allowDangerouslySkipPermissions, false);
  assert.equal(adjusted.canUseTool, canUseTool);
  assert.deepStrictEqual(Object.entries(adjusted.extraArgs ?? {}), [["verbose", null]]);
  assert.equal(constrainClaudeOptions(options, false), options);
  assert.equal(claudeRuntimeModeAdjustments(true)[0]?.mode, "full-access");
  assert.deepStrictEqual(claudeRuntimeModeAdjustments(false), []);
});

it.effect("reads restrictive settings in an isolated provider environment", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectory({ prefix: "claude-policy-" });
    yield* fs.writeFileString(
      `${dir}/settings.json`,
      '{"permissions":{"disableBypassPermissionsMode":"disable"}}',
    );
    const original = process.env.CLAUDE_CONFIG_DIR;
    yield* Effect.gen(function* () {
      const disabled = yield* readClaudeManagedPolicy({
        cwd: dir,
        environment: { ...process.env, CLAUDE_CONFIG_DIR: dir },
      });
      assert.isTrue(disabled);
      assert.equal(process.env.CLAUDE_CONFIG_DIR, original);
    }).pipe(Effect.ensuring(fs.remove(dir, { recursive: true }).pipe(Effect.orDie)));
  }).pipe(Effect.provide(NodeServices.layer)),
);
