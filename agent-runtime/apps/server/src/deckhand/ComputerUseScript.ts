/* oxlint-disable unicorn/require-post-message-target-origin -- Node workers have no browser target origin. */
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalTimersInEffect:off
// @effect-diagnostics preferSchemaOverJson:off
// Runs agent-written JavaScript against the computer-use API so one tool call
// can perform and verify many actions. Each conversation gets a persistent
// worker thread (globals survive between scripts); every API call still goes
// through the same approvals, leases and validation as the individual tools.
// This is a batching convenience, not a security sandbox.
import * as NodeWorkerThreads from "node:worker_threads";
import * as Schema from "effect/Schema";
import * as C from "@cinderdeck/contracts/deckhand/computerUse";
import type { ComputerAction, ComputerActor, ComputerUseCore } from "./ComputerUse.ts";

const OUTPUT_LIMIT = 60_000;
const isComputerUseError = Schema.is(C.ComputerUseError);
const SCREENSHOT_LIMIT = 3;
const IDLE_MS = 15 * 60_000;
const WORKER_LIMIT = 32;

const WORKER_SOURCE = String.raw`
const { parentPort } = process.getBuiltinModule("node:worker_threads");
const AsyncFunction = (async () => {}).constructor;
const { AsyncLocalStorage } = process.getBuiltinModule("node:async_hooks");
const runs = new AsyncLocalStorage();
let currentRun;
const send = (message) => parentPort.postMessage({ ...message, runId: runs.getStore() });
const pending = new Map();
let nextCall = 0;
const call = (method, args) =>
  new Promise((resolve, reject) => {
    if (runs.getStore() !== currentRun || currentRun === undefined) {
      reject(new Error("This script has finished; await computer calls before returning."));
      return;
    }
    const id = ++nextCall;
    pending.set(id, { resolve, reject });
    send({ type: "call", id, method, args: args ?? {} });
  });
const methods = [
  "list_apps", "get_app_state", "click", "drag", "press_key", "type_text", "scroll",
  "set_value", "select_text", "perform_secondary_action", "paste", "activate_app",
];
const computer = Object.freeze(Object.fromEntries(methods.map((name) => [name, (args) => call(name, args)])));
const format = (value) => {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
};
const write = (...values) => send({ type: "write", text: values.map(format).join(" ") + "\n" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(Number(ms) || 0, 0), 30000)));
globalThis.computer = computer;
globalThis.write = write;
globalThis.sleep = sleep;
globalThis.console = { log: write, info: write, warn: write, error: write, debug: write };
parentPort.on("message", async (message) => {
  if (message.type === "result") {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.ok) request.resolve(message.value);
    else request.reject(Object.assign(new Error(message.error), { reason: message.reason }));
    return;
  }
  if (message.type !== "run") return;
  currentRun = message.runId;
  await runs.run(message.runId, async () => {
  try {
    const run = new AsyncFunction("computer", "write", "sleep", message.code);
    const value = await run(computer, write, sleep);
    send({ type: "done", ok: true, value: value === undefined ? undefined : format(value) });
  } catch (error) {
    const text = error && error.stack ? String(error.stack).split("\n").slice(0, 6).join("\n") : String(error);
    send({ type: "done", ok: false, error: text });
  } finally {
    currentRun = undefined;
  }
  });
});
`;

type Entry = {
  worker: NodeWorkerThreads.Worker;
  busy: boolean;
  idle?: ReturnType<typeof setTimeout>;
};
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const actionSchemas = {
  click: C.ComputerClick,
  drag: C.ComputerDrag,
  press_key: C.ComputerPressKey,
  type_text: C.ComputerTypeText,
  scroll: C.ComputerScroll,
  set_value: C.ComputerSetValue,
  select_text: C.ComputerSelectText,
  perform_secondary_action: C.ComputerSecondaryAction,
  paste: C.ComputerPaste,
  activate_app: C.ComputerApp,
} as const;

const decode = <S extends Schema.Top>(schema: S, value: unknown): S["Type"] => {
  try {
    return Schema.decodeUnknownSync(schema as never)(value) as S["Type"];
  } catch (cause) {
    throw new C.ComputerUseError({
      reason: "invalid_input",
      detail: String(cause instanceof Error ? cause.message : cause).slice(0, 400),
    });
  }
};

export function makeComputerUseScripts(core: ComputerUseCore) {
  const workers = new Map<string, Entry>();
  let sequence = 0;

  const dispose = (threadId: string) => {
    const entry = workers.get(threadId);
    if (!entry) return;
    workers.delete(threadId);
    if (entry.idle) clearTimeout(entry.idle);
    void entry.worker.terminate();
  };

  const acquire = (threadId: string) => {
    const existing = workers.get(threadId);
    if (existing) return existing;
    if (workers.size >= WORKER_LIMIT) {
      const idle = [...workers].find(([, entry]) => !entry.busy);
      if (!idle) throw new C.ComputerUseError({ reason: "busy" });
      dispose(idle[0]);
    }
    const worker = new NodeWorkerThreads.Worker(WORKER_SOURCE, {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    worker.unref();
    const entry: Entry = { worker, busy: false };
    // Errors can also arrive from timers after a script has returned. Keep a
    // permanent listener so an idle worker cannot crash the server.
    const discard = () => {
      if (workers.get(threadId) === entry) dispose(threadId);
    };
    worker.on("error", discard);
    worker.on("exit", discard);
    workers.set(threadId, entry);
    return entry;
  };

  const dispatch = async (
    actor: ComputerActor,
    method: string,
    args: unknown,
    screenshots: C.ComputerScreenshot[],
  ): Promise<unknown> => {
    if (method === "list_apps") return core.listApps(actor);
    if (method === "get_app_state") {
      const raw = record(args);
      const input = decode(C.ComputerGetAppState, {
        ...raw,
        ...(raw.disable_diff !== undefined ? { disableDiff: raw.disable_diff } : {}),
        ...(raw.include_screenshot !== undefined
          ? { includeScreenshot: raw.include_screenshot }
          : {}),
        disable_diff: undefined,
        include_screenshot: undefined,
      });
      const state = await core.getAppState(actor, input);
      if (state.screenshot) {
        screenshots.push(state.screenshot);
        if (screenshots.length > SCREENSHOT_LIMIT) screenshots.shift();
      }
      // Pixels go to the model with the tool result, not into the script.
      return {
        ...state,
        screenshot: state.screenshot
          ? { width: state.screenshot.width, height: state.screenshot.height }
          : null,
      };
    }
    if (!(method in actionSchemas)) throw new C.ComputerUseError({ reason: "invalid_input" });
    const kind = method as keyof typeof actionSchemas;
    return core.act(actor, { kind, input: decode(actionSchemas[kind], args) } as ComputerAction);
  };

  const run = async (
    actor: ComputerActor,
    input: C.ComputerScript,
  ): Promise<C.ComputerScriptResult> => {
    if (workers.get(actor.threadId)?.busy) {
      throw new C.ComputerUseError({
        reason: "busy",
        detail: "A script is already running in this conversation.",
      });
    }
    if (input.reset) dispose(actor.threadId);
    const entry = acquire(actor.threadId);
    if (entry.busy) {
      throw new C.ComputerUseError({
        reason: "busy",
        detail: "A script is already running in this conversation.",
      });
    }
    entry.busy = true;
    if (entry.idle) clearTimeout(entry.idle);
    const screenshots: C.ComputerScreenshot[] = [];
    let output = "";
    let clipped = false;
    const append = (chunk: string) => {
      if (output.length + chunk.length > OUTPUT_LIMIT) {
        output += chunk.slice(0, Math.max(0, OUTPUT_LIMIT - output.length));
        clipped = true;
      } else output += chunk;
    };
    const timeoutMs = input.timeout_ms ?? 60_000;
    const runId = ++sequence;
    const calls = new Set<Promise<void>>();
    let done = false;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean, tail?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        entry.worker.off("message", onMessage);
        entry.worker.off("error", onError);
        entry.worker.off("exit", onExit);
        entry.busy = false;
        if (workers.get(actor.threadId) === entry) {
          entry.idle = setTimeout(() => dispose(actor.threadId), IDLE_MS);
          entry.idle.unref();
        }
        if (tail) append(output && !output.endsWith("\n") ? `\n${tail}` : tail);
        if (clipped) output += "\n[output truncated]";
        resolve({ ok, output: output || (ok ? "(no output)" : ""), screenshots });
      };
      const onMessage = (raw: unknown) => {
        const message = record(raw);
        if (message.runId !== runId) return;
        if (message.type === "write" && typeof message.text === "string") append(message.text);
        else if (message.type === "done") {
          done = true;
          // Await already-dispatched calls before allowing the next script.
          void Promise.all(calls).then(() =>
            finish(
              message.ok === true,
              message.ok === true
                ? typeof message.value === "string"
                  ? message.value
                  : undefined
                : `Error: ${String(message.error)}`,
            ),
          );
        } else if (!done && message.type === "call" && typeof message.id === "number") {
          const id = message.id;
          const request = dispatch(actor, String(message.method), message.args, screenshots).then(
            (value) => {
              if (!settled) entry.worker.postMessage({ type: "result", id, ok: true, value });
            },
            (cause: unknown) => {
              if (settled) return;
              const error = isComputerUseError(cause)
                ? { reason: cause.reason, error: `${cause.reason}: ${cause.message}` }
                : { reason: "unavailable", error: "unavailable: The request failed." };
              entry.worker.postMessage({ type: "result", id, ok: false, ...error });
            },
          );
          calls.add(request);
          void request.finally(() => calls.delete(request));
        }
      };
      const onError = (error: unknown) => {
        dispose(actor.threadId);
        finish(false, `Script worker failed: ${String(error)}`);
      };
      const onExit = (code: number) => {
        dispose(actor.threadId);
        finish(false, `Script worker exited (${code}); its globals were reset.`);
      };
      const timer = setTimeout(() => {
        dispose(actor.threadId);
        finish(
          false,
          `Script timed out after ${timeoutMs} ms; its globals were reset. Already dispatched app actions may still finish; read the app state before retrying.`,
        );
      }, timeoutMs);
      entry.worker.on("message", onMessage);
      entry.worker.once("error", onError);
      entry.worker.once("exit", onExit);
      entry.worker.postMessage({ type: "run", code: input.code, runId });
    });
  };

  return {
    run,
    dispose,
    disposeAll: () => {
      for (const id of workers.keys()) dispose(id);
    },
  };
}
