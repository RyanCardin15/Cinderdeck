// @vitest-environment jsdom
import type { EnvironmentId } from "@cinderdeck/contracts";
import { DeckhandRpcError } from "@cinderdeck/contracts/deckhand/rpc";
import * as Cause from "effect/Cause";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const boundary = vi.hoisted(() => ({ command: vi.fn(), toast: vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => boundary.command }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: boundary.toast } }));
vi.mock("../components/settings/settingsLayout", () => ({
  SettingsSection: ({ children, headerAction }: { children: unknown; headerAction?: unknown }) => (
    <section>
      {headerAction as never}
      {children as never}
    </section>
  ),
  SettingsRow: ({ title, description, status, control }: Record<string, unknown>) => (
    <div data-row={String(title)}>
      <h3>{title as never}</h3>
      <p>{description as never}</p>
      <div>{status as never}</div>
      <div>{control as never}</div>
    </div>
  ),
  SettingsUnavailableGroup: ({ message, children }: { message?: string; children: unknown }) => (
    <div>
      {message ? <p role="status">{message}</p> : null}
      {children as never}
    </div>
  ),
}));
import { AgentAccessSettings } from "./AgentAccessSettings";

const environmentId = "local" as EnvironmentId;
const status = (mcpConfigured: boolean) => ({
  cli: { installed: true, path: "/Users/me/.local/bin/cinderdeck" },
  clients: [
    {
      id: "claude",
      name: "Claude Code",
      mcpConfigured,
      mcpLocation: "claude mcp add --scope user",
      skills: { state: "missing", detail: "Installs to ~/.claude/skills" },
    },
  ],
  skills: [{ name: "cinderdeck-parallel-lanes", summary: "Run branches side by side." }],
  claudeMod: { state: "missing", detail: "Installs to ~/.claude/skills" },
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label);

it("asks to connect a computer before reading anything", async () => {
  await act(async () => root.render(<AgentAccessSettings environmentId={null} />));
  expect(container.querySelector('[role="status"]')!.textContent).toContain("execution computer");
  expect(boundary.command).not.toHaveBeenCalled();
});

it("connects MCP for one agent and shows the state Cinderdeck reports back", async () => {
  boundary.command
    .mockResolvedValueOnce({
      _tag: "Success",
      value: { ok: true, detail: "", status: status(false) },
    })
    .mockResolvedValueOnce({
      _tag: "Success",
      value: { ok: true, detail: "registered", status: status(true) },
    });
  await act(async () => root.render(<AgentAccessSettings environmentId={environmentId} />));
  expect(container.textContent).toContain("MCP not set up");
  expect(container.textContent).toContain("Claude Code mod");

  await act(async () => button("Connect MCP")!.click());

  expect(boundary.command).toHaveBeenLastCalledWith({
    environmentId,
    input: { action: "mcp", agent: "claude", instructions: true },
  });
  expect(container.textContent).toContain("MCP connected");
  expect(button("Reconnect")).toBeDefined();
  expect(boundary.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
});

it("explains an older Cinderdeck that cannot set up agents", async () => {
  boundary.command.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(new DeckhandRpcError({ reason: "unsupported_capability" })),
  });
  await act(async () => root.render(<AgentAccessSettings environmentId={environmentId} />));
  expect(container.querySelector('[role="status"]')!.textContent).toContain("Update Cinderdeck");
  expect(button("Connect MCP")).toBeUndefined();
});
