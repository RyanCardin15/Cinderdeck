import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
import * as C from "@cinderdeck/contracts/deckhand/computerUse";
import type { ComputerAction, ComputerUseCore } from "./ComputerUse.ts";
import { makeComputerUseScripts } from "./ComputerUseScript.ts";

const actor = { threadId: "thread-a", label: "Agent" };
const actions: ComputerAction[] = [];
const core: ComputerUseCore = {
  listApps: async () => ({
    apps: [{ id: "com.apple.TextEdit", displayName: "TextEdit" }],
    permissions: {
      accessibility: true,
      screenRecording: true,
      postEvents: true,
      screenLocked: false,
      backgroundFocus: true,
    },
  }),
  getAppState: async (_, input) => ({
    app: input.app,
    name: "TextEdit",
    text: '1 window "Untitled"',
    diff: input.disableDiff !== true,
    screenshot: { data: "aW1n", mimeType: "image/jpeg", width: 10, height: 20 },
  }),
  act: async (_, action) => {
    if (action.kind === "set_value" && action.input.value === "boom")
      throw new C.ComputerUseError({ reason: "not_settable" });
    actions.push(action);
    return { ok: true, app: action.input.app };
  },
};
let scripts = makeComputerUseScripts(core);
afterEach(() => {
  scripts.dispose(actor.threadId);
  scripts = makeComputerUseScripts(core);
  actions.length = 0;
});

describe("computer use scripts", () => {
  it("runs several validated steps in one call and returns screenshots to the model", async () => {
    const result = await scripts.run(actor, {
      code: `
        const state = await computer.get_app_state({ app: "com.apple.TextEdit", disable_diff: true });
        write(state.text, state.diff, state.screenshot);
        await computer.click({ app: "com.apple.TextEdit", element_index: 1 });
        await computer.type_text({ app: "com.apple.TextEdit", text: "hello" });
        return "done";
      `,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toBe(
      '1 window "Untitled" false {\n  "width": 10,\n  "height": 20\n}\ndone',
    );
    expect(result.screenshots).toEqual([
      { data: "aW1n", mimeType: "image/jpeg", width: 10, height: 20 },
    ]);
    expect(actions.map((action) => action.kind)).toEqual(["click", "type_text"]);
  });

  it("keeps globals between scripts until reset", async () => {
    await scripts.run(actor, { code: "globalThis.count = 41;" });
    expect((await scripts.run(actor, { code: "return ++globalThis.count;" })).output).toBe("42");
    expect(
      (await scripts.run(actor, { code: "return typeof globalThis.count;", reset: true })).output,
    ).toBe("undefined");
  });

  it("rejects invalid arguments and surfaces API failures with their reason", async () => {
    const result = await scripts.run(actor, {
      code: `
        try { await computer.click({ app: "TextEdit", click_count: 9 }); } catch (e) { write(e.reason); }
        try { await computer.set_value({ app: "TextEdit", element_index: 3, value: "boom" }); } catch (e) { write(e.reason); }
        await computer.press_key({ app: "TextEdit" });
      `,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/^invalid_input\nnot_settable\nError: Error: invalid_input/);
    expect(actions).toEqual([]);
  });

  it("stops a runaway script at its deadline and starts fresh afterwards", async () => {
    await scripts.run(actor, { code: "globalThis.kept = true;" });
    const result = await scripts.run(actor, { code: "while (true) {}", timeout_ms: 1000 });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Script timed out after 1000 ms");
    expect((await scripts.run(actor, { code: "return typeof globalThis.kept;" })).output).toBe(
      "undefined",
    );
  });
});

describe("computer use script lifecycle", () => {
  it("drains accepted calls before allowing another script", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    scripts = makeComputerUseScripts({
      ...core,
      act: async (_, action) => {
        entered();
        await gate;
        actions.push(action);
        return { ok: true, app: action.input.app };
      },
    });
    const first = scripts.run(actor, {
      code: 'void computer.type_text({app:"TextEdit",text:"first"});',
    });
    await started;
    await expect(
      scripts.run(actor, { code: 'return "second";', reset: true }),
    ).rejects.toMatchObject({ reason: "busy" });
    release();
    expect((await first).ok).toBe(true);
    expect(actions).toHaveLength(1);
    expect((await scripts.run(actor, { code: 'return "second";' })).output).toBe("second");
  });

  it("does not mix delayed output from an old script into a new run", async () => {
    await scripts.run(actor, {
      code: 'setTimeout(() => write("old output"), 30); return "first";',
    });
    const next = await scripts.run(actor, { code: 'await sleep(80); write("second");' });
    expect(next.output).toBe("second\n");
  });

  it("reports worker exits immediately and recreates the worker", async () => {
    const result = await scripts.run(actor, { code: "process.exit(0);" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("worker exited (0)");
    expect((await scripts.run(actor, { code: 'return "recovered";' })).output).toBe("recovered");
  });
});

effectIt.live("recovers from a worker error that arrives after the script has returned", () =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      scripts.run(actor, {
        code: 'globalThis.kept = true; setTimeout(() => { throw new Error("late"); }, 20);',
      }),
    );
    yield* Effect.sleep(100);
    const result = yield* Effect.promise(() =>
      scripts.run(actor, { code: "return typeof globalThis.kept;" }),
    );
    expect(result.output).toBe("undefined");
  }),
);
