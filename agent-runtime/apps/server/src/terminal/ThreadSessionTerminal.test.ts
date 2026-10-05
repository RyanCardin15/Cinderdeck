// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSessionResumeCommand,
  renderSessionCopyCommand,
  renderSessionTerminalScript,
} from "./ThreadSessionTerminal.ts";

describe("buildSessionResumeCommand", () => {
  it("forks a live Claude session instead of writing into its transcript", () => {
    expect(
      buildSessionResumeCommand({
        driver: "claudeAgent",
        binaryPath: "claude",
        nativeId: "abc",
        isLive: true,
      }),
    ).toEqual({ argv: ["claude", "--resume", "abc", "--fork-session"], mode: "fork" });
    expect(
      buildSessionResumeCommand({
        driver: "claudeAgent",
        binaryPath: "claude",
        nativeId: "abc",
        isLive: false,
      }),
    ).toEqual({ argv: ["claude", "--resume", "abc"], mode: "resume" });
  });

  it("has no command for providers without a resumable CLI", () => {
    expect(
      buildSessionResumeCommand({
        driver: "cursor",
        binaryPath: "x",
        nativeId: "a",
        isLive: false,
      }),
    ).toBeUndefined();
  });
});

describe("renderSessionCopyCommand", () => {
  it("keeps home directories and drops other environment overrides", () => {
    expect(
      renderSessionCopyCommand({
        cwd: "/work/it's here",
        env: { CLAUDE_CONFIG_DIR: "/homes/work", ANTHROPIC_API_KEY: "secret" },
        argv: ["claude", "--resume", "abc"],
      }),
    ).toBe("cd '/work/it'\\''s here' && CLAUDE_CONFIG_DIR=/homes/work claude --resume abc");
  });
});

describe("renderSessionTerminalScript", () => {
  it("runs the CLI in the workspace with the instance environment and removes itself", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "session-terminal-"));
    try {
      const workspace = NodePath.join(root, "it's a workspace");
      NodeFS.mkdirSync(workspace);
      const capture = NodePath.join(root, "capture.txt");
      const fakeCli = NodePath.join(root, "fake-cli");
      NodeFS.writeFileSync(
        fakeCli,
        `#!/bin/sh\n{ pwd; echo "$SESSION_HOME"; printf '%s\\n' "$@"; } > '${capture}'\n`,
        { mode: 0o700 },
      );
      const script = NodePath.join(root, "Resume session.command");
      NodeFS.writeFileSync(
        script,
        renderSessionTerminalScript({
          cwd: workspace,
          env: { SESSION_HOME: "/homes/a b" },
          argv: [fakeCli, "--resume", "id with 'quotes'"],
        }),
        { mode: 0o700 },
      );

      const result = NodeChildProcess.spawnSync(script, {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SHELL: "/bin/sh" },
        stdio: ["ignore", "ignore", "pipe"],
      });

      expect(result.status).toBe(0);
      expect(NodeFS.existsSync(script)).toBe(false);
      expect(NodeFS.readFileSync(capture, "utf8").split("\n")).toEqual([
        workspace,
        "/homes/a b",
        "--resume",
        "id with 'quotes'",
        "",
      ]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
