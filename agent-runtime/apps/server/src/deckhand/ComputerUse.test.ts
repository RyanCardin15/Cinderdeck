// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";
import { fileApprovalStore, makeComputerUseCore, type ApprovalStore } from "./ComputerUse.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { ComputerUseCall } from "./ComputerUseNative.ts";

const excel = { bundleId: "com.microsoft.Excel", name: "Microsoft Excel", running: true, pid: 42 };
const alice = { threadId: "thread-a", label: "Budget review" };
const bob = { threadId: "thread-b", label: "Forecast" };

function fixture(
  options: {
    decision?: string;
    saved?: string[];
    resolved?: object;
    waitForAction?: () => Promise<void>;
  } = {},
) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let nodes: unknown[] = [
    { id: 1, parent: 0, depth: 0, role: "AXWindow", title: "Book1" },
    { id: 2, parent: 1, depth: 1, role: "AXTextField", description: "Name", value: "" },
  ];
  let clock = 1_000;
  const saved: string[][] = [];
  const call: ComputerUseCall = async (method, params = {}) => {
    calls.push({ method, params });
    switch (method) {
      case "resolveApp":
        return { ...excel, ...options.resolved };
      case "requestAccess":
        return { decision: options.decision ?? "session" };
      case "getState":
        return {
          app: excel,
          windows: [{ index: 0, title: "Book1", target: true }],
          window: { title: "Book1", width: 1600, height: 1000 },
          nodes,
          screenshot:
            params.includeScreenshot === false
              ? null
              : { data: "aW1n", mimeType: "image/jpeg", width: 800, height: 500, scale: 0.5 },
        };
      default:
        await options.waitForAction?.();
        return { ok: true };
    }
  };
  const approvals: ApprovalStore = {
    load: async () => options.saved ?? [],
    save: async (ids) => {
      saved.push([...ids]);
    },
  };
  const core = makeComputerUseCore({ call, approvals, now: () => clock });
  return {
    core,
    calls,
    saved,
    methods: () => calls.map((entry) => entry.method),
    setNodes: (next: unknown[]) => {
      nodes = next;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("computer use approvals", () => {
  it("asks once per conversation and app, then reuses a session grant", async () => {
    const test = fixture({ decision: "session" });
    await test.core.getAppState(alice, { app: "Excel" });
    await test.core.act(alice, { kind: "click", input: { app: "Excel", element_index: 2 } });
    expect(test.methods().filter((method) => method === "requestAccess")).toHaveLength(1);
    expect(test.calls.find((entry) => entry.method === "requestAccess")?.params).toMatchObject({
      appName: "Microsoft Excel",
      agent: { id: "thread-a", label: "Budget review" },
    });
    // Another conversation is asked separately.
    await test.core.getAppState(bob, { app: "Excel" });
    expect(test.methods().filter((method) => method === "requestAccess")).toHaveLength(2);
  });

  it("persists Always Allow and skips the prompt for every conversation", async () => {
    const test = fixture({ decision: "always" });
    await test.core.getAppState(alice, { app: "Excel" });
    expect(test.saved).toEqual([["com.microsoft.excel"]]);
    await test.core.getAppState(bob, { app: "Excel" });
    expect(test.methods().filter((method) => method === "requestAccess")).toHaveLength(1);

    const restored = fixture({ saved: ["com.microsoft.Excel"] });
    await restored.core.getAppState(alice, { app: "Excel" });
    expect(restored.methods()).not.toContain("requestAccess");
  });

  it("expires Allow Once after ten minutes", async () => {
    const test = fixture({ decision: "once" });
    await test.core.getAppState(alice, { app: "Excel" });
    test.advance(9 * 60_000);
    await test.core.getAppState(alice, { app: "Excel" });
    test.advance(2 * 60_000);
    await test.core.getAppState(alice, { app: "Excel" });
    expect(test.methods().filter((method) => method === "requestAccess")).toHaveLength(2);
  });

  it("refuses after a denial without prompting again for a minute and never acts", async () => {
    const test = fixture({ decision: "deny" });
    await expect(test.core.getAppState(alice, { app: "Excel" })).rejects.toMatchObject({
      reason: "approval_denied",
    });
    await expect(
      test.core.act(alice, { kind: "type_text", input: { app: "Excel", text: "x" } }),
    ).rejects.toMatchObject({ reason: "approval_denied" });
    expect(test.methods().filter((method) => method === "requestAccess")).toHaveLength(1);
    expect(test.methods()).not.toContain("type");
    expect(test.methods()).not.toContain("getState");
  });

  it("blocks terminals and Cinderdeck before asking", async () => {
    const terminal = fixture({ resolved: { bundleId: "com.googlecode.iterm2", name: "iTerm" } });
    await expect(terminal.core.getAppState(alice, { app: "iTerm" })).rejects.toMatchObject({
      reason: "app_blocked",
    });
    const self = fixture({ resolved: { bundleId: "com.cinderdeck.app", name: "Cinderdeck" } });
    await expect(
      self.core.act(alice, { kind: "click", input: { app: "Cinderdeck", x: 1, y: 1 } }),
    ).rejects.toMatchObject({ reason: "app_blocked" });
    expect([...terminal.methods(), ...self.methods()]).not.toContain("requestAccess");
  });
});

describe("computer use sharing", () => {
  it("lets one conversation act on an app at a time and frees it after the lease", async () => {
    const test = fixture({ saved: ["com.microsoft.Excel"] });
    await test.core.act(alice, { kind: "press_key", input: { app: "Excel", key: "Return" } });
    await expect(
      test.core.act(bob, { kind: "press_key", input: { app: "Excel", key: "Return" } }),
    ).rejects.toMatchObject({ reason: "app_busy" });
    // Reading stays available to the other conversation.
    await test.core.getAppState(bob, { app: "Excel" });
    test.advance(91_000);
    await test.core.act(bob, { kind: "press_key", input: { app: "Excel", key: "Return" } });
  });
});

describe("computer use state and actions", () => {
  it("returns a full tree first and only changes on the next read", async () => {
    const test = fixture({ saved: ["com.microsoft.Excel"] });
    const first = await test.core.getAppState(alice, { app: "Excel" });
    expect(first.diff).toBe(false);
    expect(first.text).toContain(
      'App: Microsoft Excel (com.microsoft.Excel)\nWindows: [0] "Book1" (target)',
    );
    expect(first.text).toContain('  2 text field "Name", Value: ""');
    expect(first.screenshot).toMatchObject({ width: 800, height: 500 });

    test.setNodes([
      { id: 1, parent: 0, depth: 0, role: "AXWindow", title: "Book1" },
      { id: 2, parent: 1, depth: 1, role: "AXTextField", description: "Name", value: "Q3" },
    ]);
    const second = await test.core.getAppState(alice, { app: "Excel" });
    expect(second.diff).toBe(true);
    expect(second.text).toContain('~ 2 text field "Name", Value: "Q3"');
    expect(second.text).not.toContain('1 window "Book1"');

    const full = await test.core.getAppState(alice, { app: "Excel", disableDiff: true });
    expect(full.diff).toBe(false);
  });

  it("converts screenshot pixels to window points using the latest read", async () => {
    const test = fixture({ saved: ["com.microsoft.Excel"] });
    await test.core.getAppState(alice, { app: "Excel" });
    await test.core.act(alice, {
      kind: "click",
      input: { app: "Excel", x: 100, y: 40, mouse_button: "r", click_count: 2 },
    });
    expect(test.calls.at(-1)).toMatchObject({
      method: "click",
      params: { app: "com.microsoft.Excel", x: 200, y: 80, button: "right", count: 2 },
    });
  });

  it("sends parsed chords to the helper and rejects unknown keys", async () => {
    const test = fixture({ saved: ["com.microsoft.Excel"] });
    await test.core.act(alice, {
      kind: "press_key",
      input: { app: "Excel", key: "super+shift+z" },
    });
    expect(test.calls.at(-1)).toMatchObject({
      method: "key",
      params: { keyCode: 6, modifiers: ["command", "shift"] },
    });
    await expect(
      test.core.act(alice, { kind: "press_key", input: { app: "Excel", key: "Hyper+q" } }),
    ).rejects.toMatchObject({ reason: "invalid_input" });
  });

  it("scrolls by pages in a direction", async () => {
    const test = fixture({ saved: ["com.microsoft.Excel"] });
    await test.core.act(alice, {
      kind: "scroll",
      input: { app: "Excel", direction: "up", element_index: 2, pages: 2 },
    });
    expect(test.calls.at(-1)).toMatchObject({
      method: "scroll",
      params: { id: 2, dx: 0, dy: -1, pages: 2 },
    });
  });
});

describe("computer use screenshot coordinates", () => {
  it("keeps the last screenshot scale across text-only reads of the same window", async () => {
    const test = fixture({ saved: ["com.microsoft.Excel"] });
    await test.core.getAppState(alice, { app: "Excel" });
    await test.core.getAppState(alice, { app: "Excel", includeScreenshot: false });
    await test.core.act(alice, { kind: "click", input: { app: "Excel", x: 100, y: 40 } });
    expect(test.calls.at(-1)?.params).toMatchObject({ x: 200, y: 80 });
  });

  it("asks for a screenshot instead of guessing coordinates without one", async () => {
    const test = fixture({ saved: ["com.microsoft.Excel"] });
    await test.core.getAppState(alice, { app: "Excel", includeScreenshot: false });
    await expect(
      test.core.act(alice, { kind: "click", input: { app: "Excel", x: 100, y: 40 } }),
    ).rejects.toMatchObject({
      reason: "invalid_input",
      detail: expect.stringContaining("includeScreenshot"),
    });
    expect(test.methods()).not.toContain("click");
  });
});

it("does not expire another conversation's lease while an action is still running", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const test = fixture({
    saved: ["com.microsoft.Excel"],
    waitForAction: async () => {
      entered();
      await gate;
    },
  });
  const first = test.core.act(alice, { kind: "press_key", input: { app: "Excel", key: "Return" } });
  await started;
  test.advance(91_000);
  await expect(
    test.core.act(bob, { kind: "press_key", input: { app: "Excel", key: "Return" } }),
  ).rejects.toMatchObject({ reason: "app_busy" });
  release();
  await first;
});

it("serializes simultaneous Always Allow writes and keeps the latest complete set", async () => {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "computer-use-approvals-"),
  );
  try {
    const store = fileApprovalStore(directory);
    await Promise.all([store.save(["test.first"]), store.save(["test.first", "test.second"])]);
    expect(await store.load()).toEqual(["test.first", "test.second"]);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
