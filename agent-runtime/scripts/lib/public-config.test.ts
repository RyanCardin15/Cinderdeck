// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("discards inherited account and relay configuration at every precedence level", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_root\nT3CODE_CLERK_JWT_TEMPLATE=template_root\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_root\nT3CODE_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_local\nT3CODE_CLERK_JWT_TEMPLATE=template_local\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_local\nT3CODE_RELAY_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).T3CODE_RELAY_URL).toBe("");
    expect(
      loadRepoEnv({
        baseEnv: {
          T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
          T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
          T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
          T3CODE_RELAY_URL: "https://ci.example.test",
          VITE_POSTHOG_KEY: "synthetic-telemetry-key",
          CINDERDECK_TEST_SETTING: "kept",
        },
        repoRoot,
      }),
    ).toMatchObject({
      CINDERDECK_TEST_SETTING: "kept",
      VITE_POSTHOG_KEY: "",
      T3CODE_CLERK_PUBLISHABLE_KEY: "",
      T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "",
      VITE_CLERK_PUBLISHABLE_KEY: "",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
      T3CODE_CLERK_JWT_TEMPLATE: "",
      VITE_CLERK_JWT_TEMPLATE: "",
      EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "",
      T3CODE_RELAY_URL: "",
      VITE_T3CODE_RELAY_URL: "",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cinderdeck-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
