import * as NodeOS from "node:os";
import { assert, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
// @effect-diagnostics-next-line nodeBuiltinImport:off - mock the synchronous login-shell boundary; never launch a real shell.
import * as NodeChildProcess from "node:child_process";
import { HostProcessEnvironment, HostProcessPlatform } from "@cinderdeck/shared/hostProcess";

import { fixPath, hydratePosixHome } from "./os-jank.ts";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

it("hydrates HOME for minimal service environments from the user account", () => {
  const env: NodeJS.ProcessEnv = {};

  hydratePosixHome(env);

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("hydrates HOME independently of a blank process HOME", () => {
  const originalHome = process.env.HOME;
  const env: NodeJS.ProcessEnv = { HOME: " " };

  try {
    process.env.HOME = " ";
    hydratePosixHome(env);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("preserves an explicitly configured HOME", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };

  hydratePosixHome(env, () => {
    throw new Error("HOME lookup should not run");
  });

  assert.equal(env.HOME, "/custom/home");
});

// Exercise the real headless service path with a synthetic login-shell response.
effectIt.effect("pairs the login shell PATH with mise state and replaces stale state", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .mocked(NodeChildProcess.execFileSync)
        .mockReturnValue(
          [
            "__DECKHAND_ENV_PATH_START__",
            "/synthetic/mise/bin:/usr/bin",
            "__DECKHAND_ENV_PATH_END__",
            "__DECKHAND_ENV___MISE_DIFF_START__",
            "shell-record",
            "__DECKHAND_ENV___MISE_DIFF_END__",
          ].join("\n"),
        ),
    ),
    () =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = {
          SHELL: "/bin/bash",
          HOME: "/synthetic/home",
          PATH: "/usr/bin",
          __MISE_DIFF: "stale-record",
        };
        yield* fixPath().pipe(
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.provideService(HostProcessEnvironment, env),
          Effect.provide(NodeServices.layer),
        );
        assert.equal(env.PATH, "/synthetic/mise/bin:/usr/bin");
        assert.equal(env.__MISE_DIFF, "shell-record");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);
