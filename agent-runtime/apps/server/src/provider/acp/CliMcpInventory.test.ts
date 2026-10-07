// @effect-diagnostics preferSchemaOverJson:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ProcessRunner, type ProcessRunInput } from "../../processRunner.ts";
import {
  cliMcpSessionArgs,
  copilotMcpPreferenceArgs,
  cursorMcpServersFromOutput,
  cursorMcpToolsFromOutput,
  listCliMcpServers,
} from "./CliMcpInventory.ts";

const preferences = {
  disabledServers: ["linear", "deckhand"],
  disabledTools: {
    github: ["delete_issue", "delete_issue"],
    linear: ["read"],
    deckhand: ["t3_thread_send"],
  },
};

describe("CLI MCP inventory", () => {
  it("maps Cursor states, colon names and ANSI output without exposing error URLs", () => {
    expect(
      cursorMcpServersFromOutput(
        "team:docs: \u001b[32mready\u001b[0m\nlogin: requires_authentication\noff: disabled\nproject: not loaded (needs approval)\nbroken: Error: https://secret:token@example.test/?key=value\ndeckhand: ready",
      ),
    ).toMatchObject([
      { name: "broken", status: "failed" },
      { name: "login", status: "needsAuth" },
      { name: "off", status: "disabled" },
      { name: "project", status: "pending" },
      { name: "team:docs", status: "connected" },
    ]);
    expect(JSON.stringify(cursorMcpServersFromOutput("broken: Error: token-value"))).not.toContain(
      "token-value",
    );
    expect(
      cursorMcpServersFromOutput(
        "No MCP servers configured (expected in .cursor/mcp.json or ~/.cursor/mcp.json)",
      ),
    ).toEqual([]);
    expect(() => cursorMcpServersFromOutput("Unexpected output")).toThrow();
    expect(cursorMcpServersFromOutput("deckhand: ready")).toEqual([]);
  });

  it("parses the full Cursor tool list and rejects truncated output", () => {
    expect(
      cursorMcpToolsFromOutput("Tools for team docs (2):\n- read (id)\n- search (query, limit)"),
    ).toEqual([{ name: "read" }, { name: "search" }]);
    expect(cursorMcpToolsFromOutput("No tools available for 'empty'.")).toEqual([]);
    expect(() => cursorMcpToolsFromOutput("Tools for docs (2):\n- read (id)")).toThrow();
  });

  it("applies Copilot's server and tool deny flags without changing other Registry agents or Cinderdeck", () => {
    expect(copilotMcpPreferenceArgs(preferences)).toEqual([
      "--disable-mcp-server=linear",
      "--deny-tool=github(delete_issue)",
    ]);
    expect(cliMcpSessionArgs({ agentId: "github-copilot-cli" }, preferences)).toEqual(
      copilotMcpPreferenceArgs(preferences),
    );
    expect(cliMcpSessionArgs({ agentId: "cursor" }, preferences)).toEqual([]);
    expect(cliMcpSessionArgs({ agentId: "other" }, preferences)).toEqual([]);
    expect(() =>
      copilotMcpPreferenceArgs({ disabledServers: [], disabledTools: { "bad(*)": ["read"] } }),
    ).toThrow();
  });

  it.effect(
    "uses the instance executable, environment and cwd, skips off servers and retains healthy siblings",
    () =>
      Effect.gen(function* () {
        const calls: ProcessRunInput[] = [];
        const result = yield* listCliMcpServers({
          kind: "cursor",
          command: "/fixture/agent",
          cwd: "/fixture/project",
          environment: { HOME: "/fixture/home", CURSOR_API_KEY: "fixture-only" },
        }).pipe(
          Effect.provideService(ProcessRunner, {
            run: (input) => {
              calls.push(input);
              return Effect.succeed({
                code: ChildProcessSpawner.ExitCode(input.args[2] === "broken" ? 1 : 0),
                stdout:
                  input.args[1] === "list"
                    ? "good: ready\nbroken: ready\noff: disabled\nauth: requires_authentication"
                    : "Tools for good (1):\n- read (id)",
                stderr: "fixture-secret",
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              });
            },
          }),
        );
        expect(calls).toHaveLength(3);
        expect(
          calls.every(
            (call) =>
              call.command === "/fixture/agent" &&
              call.cwd === "/fixture/project" &&
              call.env?.HOME === "/fixture/home",
          ),
        ).toBe(true);
        expect(result.find((s) => s.name === "good")?.tools).toEqual([{ name: "read" }]);
        expect(result.find((s) => s.name === "broken")?.error).toContain("could not list");
        expect(JSON.stringify(result)).not.toContain("fixture-secret");
      }),
  );
});
