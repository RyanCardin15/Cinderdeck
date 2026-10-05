// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalTimersInEffect:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalFetchInEffect:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics cryptoRandomUUID:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
// Native CDP boundary: transient bounded state, deadlines, and scoped resource cleanup.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as C from "@cinderdeck/contracts/deckhand/externalDebugRpc";
import {
  array,
  debugEndpoint,
  debugURL,
  nativeDebugTransport,
  number,
  record,
  redactDebugText,
  sanitizeDebugValue,
  string,
  type DebugPeer,
  type DebugTransport,
} from "./ExternalDebugCDP.ts";
import { macWindowTransport } from "./ExternalDebugMac.ts";

// UI panels and authenticated MCP callers share this thread namespace.
export const externalDebugThreadOwner = (threadId: string) => `external-debug:thread:${threadId}`;

export class ExternalDebugTransport extends Context.Service<
  ExternalDebugTransport,
  DebugTransport
>()("@cinderdeck/server/deckhand/ExternalDebug/ExternalDebugTransport") {}
type Result<A> = Effect.Effect<A, C.ExternalDebugError>;
export class ExternalDebug extends Context.Service<
  ExternalDebug,
  {
    readonly open: (actor: string, input: C.DebugOpen) => Result<C.DebugOpenResult>;
    readonly discover: (input: C.DebugEndpoint) => Result<ReadonlyArray<C.DebugTarget>>;
    readonly attach: (actor: string, input: C.DebugAttach) => Result<C.DebugSession>;
    readonly sessions: (actor: string) => Result<ReadonlyArray<C.DebugSession>>;
    readonly read: (actor: string, input: C.DebugRead) => Result<C.DebugSnapshot>;
    readonly command: (actor: string, input: C.DebugCommand) => Result<C.DebugCommandResult>;
    readonly detach: (actor: string, input: C.DebugIdentity) => Result<void>;
  }
>()("@cinderdeck/server/deckhand/ExternalDebug") {}

type Session = {
  actor: string;
  view: C.DebugSession;
  peer: DebugPeer | null;
  touched: number;
  sequence: number;
  events: C.DebugEvent[];
  scripts: Map<string, { id: string; url: string }>;
  contexts: Map<number, { id: number; name: string; origin: string }>;
  frames: C.DebugSnapshot["callFrames"];
  frameAt: number;
  image: string | null;
  imageSequence: number;
  framePending: Promise<void> | null;
  imageUnavailable: boolean;
  requests: Map<string, { url: string; method: string; status: number; started: number }>;
};
const fail = (reason: C.ExternalDebugError["reason"]) => new C.ExternalDebugError({ reason });
const isDebugError = Schema.is(C.ExternalDebugError);
const wrap = (cause: unknown) => (isDebugError(cause) ? cause : fail("unavailable"));
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: wrap });
const boundedSet = <K, V>(map: Map<K, V>, key: K, value: V, maximum: number) => {
  map.set(key, value);
  if (map.size > maximum) {
    const first = map.keys().next();
    if (!first.done) map.delete(first.value);
  }
};
const remoteText = (raw: unknown) => {
  const value = record(raw);
  if (value.value !== undefined) {
    try {
      return JSON.stringify(value.value);
    } catch {
      return "(unserializable)";
    }
  }
  return string(value.description) || string(value.type);
};
const make = Effect.gen(function* () {
  const transport = yield* ExternalDebugTransport;
  const sessions = new Map<string, Session>();
  const reservations = new Map<string, string>();
  const add = (
    session: Session,
    kind: C.DebugEvent["kind"],
    text: string,
    level: C.DebugEvent["level"] = "info",
  ) => {
    session.events.push({
      sequence: ++session.sequence,
      at: new Date().toISOString(),
      kind,
      level,
      text: redactDebugText(text),
    });
    if (session.events.length > 500) session.events.splice(0, session.events.length - 500);
  };
  const event = (session: Session, method: string, params: Record<string, unknown>) => {
    if (method === "Native.disconnected") {
      add(
        session,
        "connection",
        `Mac capture stopped (${redactDebugText(string(params.domain), 100)} ${number(params.code)}).`,
        "warning",
      );
    } else if (method === "Runtime.consoleAPICalled") {
      const type = string(params.type);
      add(
        session,
        "console",
        array(params.args).slice(0, 20).map(remoteText).join(" "),
        type === "error" || type === "assert" ? "error" : type === "warning" ? "warning" : "info",
      );
    } else if (method === "Runtime.exceptionThrown") {
      const details = record(params.exceptionDetails);
      add(
        session,
        "exception",
        `${remoteText(details.exception) || string(details.text)} ${debugURL(string(details.url))}:${number(details.lineNumber) + 1}`,
        "error",
      );
    } else if (method === "Runtime.executionContextCreated") {
      const c = record(params.context);
      boundedSet(
        session.contexts,
        number(c.id),
        {
          id: number(c.id),
          name: redactDebugText(string(c.name), 200),
          origin: debugURL(string(c.origin)),
        },
        64,
      );
    } else if (method === "Runtime.executionContextDestroyed")
      session.contexts.delete(number(params.executionContextId));
    else if (method === "Runtime.executionContextsCleared") session.contexts.clear();
    else if (method === "Debugger.scriptParsed") {
      const id = string(params.scriptId);
      if (id && id.length <= 240)
        boundedSet(session.scripts, id, { id, url: debugURL(string(params.url)) }, 1000);
    } else if (method === "Debugger.globalObjectCleared") {
      session.scripts.clear();
      session.frames = [];
      session.view = { ...session.view, paused: false };
    } else if (method === "Debugger.paused") {
      session.view = { ...session.view, paused: true };
      session.frames = array(params.callFrames)
        .slice(0, 40)
        .map((raw) => {
          const f = record(raw),
            location = record(f.location);
          return {
            id: string(f.callFrameId).slice(0, 240),
            functionName: redactDebugText(string(f.functionName), 500),
            url: debugURL(string(f.url)),
            scriptId: string(location.scriptId).slice(0, 240),
            line: Math.max(0, number(location.lineNumber)),
            column: Math.max(0, number(location.columnNumber)),
          };
        });
      add(session, "debugger", `Paused: ${string(params.reason)}`);
    } else if (method === "Debugger.resumed") {
      session.view = { ...session.view, paused: false };
      session.frames = [];
      add(session, "debugger", "Resumed");
    } else if (method === "Page.frameNavigated") {
      const frame = record(params.frame);
      if (!frame.parentId) {
        const url = debugURL(string(frame.url));
        session.view = { ...session.view, target: { ...session.view.target, url } };
        session.image = null;
        session.frameAt = 0;
        add(session, "navigation", url);
      }
    } else if (method === "Network.requestWillBeSent") {
      const request = record(params.request);
      boundedSet(
        session.requests,
        string(params.requestId),
        {
          url: debugURL(string(request.url)),
          method: string(request.method).slice(0, 16),
          status: 0,
          started: number(params.timestamp),
        },
        1000,
      );
    } else if (method === "Network.responseReceived") {
      const request = session.requests.get(string(params.requestId));
      if (request) request.status = number(record(params.response).status);
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      const id = string(params.requestId),
        request = session.requests.get(id);
      session.requests.delete(id);
      if (request) {
        const failed = method === "Network.loadingFailed";
        const duration = Math.max(
          0,
          Math.round((number(params.timestamp) - request.started) * 1000),
        );
        add(
          session,
          "network",
          `${request.method} ${request.status || (failed ? "FAILED" : "—")} ${request.url} · ${duration} ms${failed ? ` · ${string(params.errorText)}` : ""}`,
          failed || request.status >= 400 ? "error" : "info",
        );
      }
    }
  };
  const close = async (session: Session) => {
    const peer = session.peer;
    session.peer = null;
    session.view = { ...session.view, state: "disconnected", paused: false };
    session.image = null;
    session.frames = [];
    if (peer) {
      // Removing our debugger releases our breakpoints and paused execution.
      // Never close a target, navigate it, or terminate its host process.
      try {
        if (session.view.target.type !== "mac-window") await peer.call("Debugger.disable");
      } catch {
        /* already gone */
      }
      peer.close();
    }
  };
  const sweep = setInterval(() => {
    for (const [id, session] of sessions)
      if (Date.now() - session.touched > 15 * 60_000) {
        sessions.delete(id);
        void close(session);
      }
  }, 60_000);
  sweep.unref();
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      clearInterval(sweep);
      await Promise.all([...sessions.values()].map(close));
      sessions.clear();
    }),
  );
  const get = (actor: string, id: string) => {
    const session = sessions.get(id);
    if (!session || session.actor !== actor) throw fail("session_missing");
    session.touched = Date.now();
    return session;
  };
  const peerFor = (session: Session) => {
    if (!session.peer || session.view.state !== "connected") throw fail("disconnected");
    return session.peer;
  };
  const discover: ExternalDebug["Service"]["discover"] = (input) =>
    attempt(async () =>
      (await transport.discover(debugEndpoint(input.endpoint).href)).map(
        ({ socketURL: _socket, ...target }) => target,
      ),
    );
  const attach: ExternalDebug["Service"]["attach"] = (actor, input) =>
    attempt(async () => {
      const endpoint = debugEndpoint(input.endpoint).href;
      const key = `${endpoint}\0${input.targetId}`;
      if (
        reservations.has(key) ||
        sessions.size + reservations.size >= 16 ||
        [...sessions.values()].filter((s) => s.actor === actor).length +
          [...reservations.values()].filter((owner) => owner === actor).length >=
          4 ||
        [...sessions.values()].some(
          (s) =>
            s.view.state === "connected" &&
            s.view.endpoint === endpoint &&
            s.view.target.id === input.targetId,
        )
      )
        throw fail("busy");
      reservations.set(key, actor);
      let session: Session | undefined;
      try {
        const target = (await transport.discover(endpoint)).find((t) => t.id === input.targetId);
        if (!target) throw fail("target_missing");
        const { socketURL: _socket, ...publicTarget } = target;
        session = {
          actor,
          view: {
            sessionId: NodeCrypto.randomUUID(),
            endpoint,
            target: publicTarget,
            state: "connected",
            paused: false,
          },
          peer: null,
          touched: Date.now(),
          sequence: 0,
          events: [],
          scripts: new Map(),
          contexts: new Map(),
          requests: new Map(),
          frames: [],
          image: null,
          imageSequence: 0,
          frameAt: 0,
          framePending: null,
          imageUnavailable: false,
        };
        const current = session;
        const peer = await transport.connect(
          target,
          (method, params) => event(current, method, params),
          () => {
            current.view = { ...current.view, state: "disconnected", paused: false };
            current.image = null;
            current.frames = [];
            current.requests.clear();
            add(
              current,
              "connection",
              "Runtime disconnected. Refresh targets to reconnect.",
              "warning",
            );
          },
        );
        session.peer = peer;
        // Enable observation only. Do not wait for Office.onReady, navigate,
        // change the viewport, replace authentication, or launch another browser.
        if (target.type !== "mac-window") {
          await peer.call("Runtime.enable");
          await peer.call("Page.enable");
          await peer.call("Network.enable", {
            maxTotalBufferSize: 0,
            maxResourceBufferSize: 0,
            maxPostDataSize: 0,
          });
          try {
            await peer.call("Debugger.enable", { maxScriptsCacheSize: 1_000_000 });
          } catch {
            add(session, "debugger", "Source debugging is unavailable in this runtime.", "warning");
          }
        }
        if (session.view.state !== "connected") throw fail("disconnected");
        add(
          session,
          "connection",
          target.type === "mac-window"
            ? "Viewing the selected Mac window. WebKit debugging stays in the host's real Web Inspector."
            : "Attached to the existing runtime. Excel keeps its Office and sign-in context.",
        );
        sessions.set(session.view.sessionId, session);
        return session.view;
      } catch (cause) {
        if (session) await close(session);
        throw cause;
      } finally {
        reservations.delete(key);
      }
    });
  const read: ExternalDebug["Service"]["read"] = (actor, input) =>
    attempt(async () => {
      const session = get(actor, input.sessionId);
      if (input.after > session.sequence) throw fail("invalid_command");
      if (
        input.screenshot &&
        session.view.state === "connected" &&
        Date.now() - session.frameAt >= (session.view.target.type === "mac-window" ? 300 : 1000)
      ) {
        if (!session.framePending)
          session.framePending = (async () => {
            session.frameAt = Date.now();
            try {
              const value = await peerFor(session).call("Page.captureScreenshot", {
                format: "jpeg",
                quality: 55,
                fromSurface: true,
                captureBeyondViewport: false,
              });
              const image = string(value.data);
              if (!image || image.length > 700000 || !/^[A-Za-z0-9+/=]+$/.test(image))
                throw fail("too_large");
              if (session.view.state === "connected") {
                if (image !== session.image) session.imageSequence += 1;
                session.image = image;
              }
              session.imageUnavailable = false;
            } catch (cause) {
              session.image = null;
              session.imageUnavailable = true;
              if (isDebugError(cause) && cause.reason === "target_missing") {
                session.view = { ...session.view, state: "disconnected" };
                session.peer?.close();
                session.peer = null;
              }
            } finally {
              session.framePending = null;
            }
          })();
        await session.framePending;
      }
      const first = session.events[0]?.sequence ?? 1;
      const events = session.events.filter((e) => e.sequence > input.after).slice(0, 100);
      return {
        session: session.view,
        events,
        nextSequence: events.at(-1)?.sequence ?? session.sequence,
        dropped: Math.max(0, first - input.after - 1),
        image:
          input.screenshot && input.afterImage !== session.imageSequence ? session.image : null,
        imageSequence: session.imageSequence,
        imageUnavailable: session.imageUnavailable,
        callFrames: session.frames,
      };
    });
  const command: ExternalDebug["Service"]["command"] = (actor, input) =>
    attempt(async () => {
      const session = get(actor, input.sessionId),
        peer = peerFor(session);
      const call = (method: string, params?: Record<string, unknown>) => peer.call(method, params);
      const nativeActions = new Set(["click", "type", "key", "scroll", "focus", "permissions"]);
      if (session.view.target.type === "mac-window") {
        if (!nativeActions.has(input.action)) throw fail("unsupported");
        const fields: ReadonlyArray<keyof C.DebugCommand> =
          input.action === "click"
            ? ["x", "y", "button", "clickCount", "modifiers"]
            : input.action === "scroll"
              ? ["x", "y", "deltaX", "deltaY"]
              : input.action === "type"
                ? ["text"]
                : input.action === "key"
                  ? ["key", "modifiers"]
                  : [];
        const params: Record<string, unknown> = {};
        for (const field of fields) if (input[field] !== undefined) params[field] = input[field];
        try {
          const result = await call(`Native.${input.action}`, params);
          // Keep test evidence without copying typed workbook text into the action log.
          if (input.action !== "permissions")
            add(
              session,
              "action",
              `${input.action} accepted${input.action === "key" ? ` (${[...(input.modifiers ?? []), input.key].join("+")})` : ""}`,
            );
          return { text: JSON.stringify(result) };
        } catch (cause) {
          add(session, "action", `${input.action} failed: ${wrap(cause).reason}`, "error");
          throw cause;
        }
      }
      if (nativeActions.has(input.action)) throw fail("unsupported");
      let result: unknown;
      switch (input.action) {
        case "evaluate": {
          if (!input.expression?.trim()) throw fail("invalid_command");
          const params = {
            expression: input.expression,
            returnByValue: true,
            generatePreview: false,
            silent: false,
            timeout: 5000,
            objectGroup: "deckhand-external",
          };
          try {
            if (input.callFrameId) {
              if (!session.frames.some((f) => f.id === input.callFrameId))
                throw fail("invalid_command");
              result = await call("Debugger.evaluateOnCallFrame", {
                ...params,
                callFrameId: input.callFrameId,
              });
            } else
              result = await call("Runtime.evaluate", {
                ...params,
                ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
                awaitPromise: true,
              });
          } finally {
            try {
              await call("Runtime.releaseObjectGroup", { objectGroup: "deckhand-external" });
            } catch {
              /* runtime may have navigated */
            }
          }
          break;
        }
        case "dom":
          result = await call("Runtime.evaluate", {
            expression: "document.documentElement.outerHTML.slice(0, 180000)",
            returnByValue: true,
            timeout: 5000,
          });
          break;
        case "sources":
          result = {
            scripts: [...session.scripts.values()].slice(-200),
            totalScripts: session.scripts.size,
            contexts: [...session.contexts.values()],
          };
          break;
        case "source":
          if (!input.scriptId || !session.scripts.has(input.scriptId))
            throw fail("invalid_command");
          result = await call("Debugger.getScriptSource", { scriptId: input.scriptId });
          break;
        case "breakpoint":
          if (!input.scriptId || !session.scripts.has(input.scriptId) || input.line === undefined)
            throw fail("invalid_command");
          result = await call("Debugger.setBreakpoint", {
            location: { scriptId: input.scriptId, lineNumber: input.line, columnNumber: 0 },
          });
          break;
        case "removeBreakpoint":
          if (!input.breakpointId) throw fail("invalid_command");
          result = await call("Debugger.removeBreakpoint", { breakpointId: input.breakpointId });
          break;
        case "exceptions":
          result = await call("Debugger.setPauseOnExceptions", {
            state: input.pauseOnExceptions ?? "none",
          });
          break;
        default:
          result = await call(`Debugger.${input.action}`);
          break;
      }
      const text = JSON.stringify(sanitizeDebugValue(result), null, 2);
      if (text.length > 240000) throw fail("too_large");
      add(session, "debugger", `${input.action} completed`);
      return { text };
    });
  const open: ExternalDebug["Service"]["open"] = (actor, input) =>
    Effect.gen(function* () {
      if (!Schema.is(C.DebugOpen)(input)) return yield* Effect.fail(fail("invalid_command"));
      if (!transport.open) return yield* Effect.fail(fail("unsupported"));
      yield* attempt(() => transport.open!(input.bundleId));
      const targets = (yield* discover({ endpoint: "mac://local" })).filter(
        (target) => target.url === input.bundleId,
      );
      // Multiple workbooks/windows require an explicit choice; never guess.
      if (targets.length !== 1) return { targets, session: null };
      const target = targets[0]!;
      const existing = [...sessions.values()].find(
        (session) =>
          session.actor === actor &&
          session.view.state === "connected" &&
          session.view.target.id === target.id &&
          session.view.target.type === "mac-window",
      );
      if (existing) {
        existing.touched = Date.now();
        return { targets, session: existing.view };
      }
      const session = yield* attach(actor, { endpoint: "mac://local", targetId: target.id });
      return { targets, session };
    });
  return ExternalDebug.of({
    open,
    discover,
    attach,
    read,
    command,
    sessions: (actor) =>
      attempt(async () =>
        [...sessions.values()].filter((s) => s.actor === actor).map((s) => s.view),
      ),
    detach: (actor, input) =>
      attempt(async () => {
        const session = sessions.get(input.sessionId);
        if (!session) return;
        if (session.actor !== actor) throw fail("session_missing");
        await close(session);
        sessions.delete(input.sessionId);
      }),
  });
});
export const layer = Layer.effect(ExternalDebug, make);
export const layerLive = layer.pipe(
  Layer.provide(
    Layer.succeed(ExternalDebugTransport, {
      open: (bundleId: string) => macWindowTransport.open!(bundleId),
      discover: (endpoint: string) =>
        endpoint.startsWith("mac:")
          ? macWindowTransport.discover(endpoint)
          : nativeDebugTransport.discover(endpoint),
      connect: (target, event, disconnected) =>
        target.type === "mac-window"
          ? macWindowTransport.connect(target, event, disconnected)
          : nativeDebugTransport.connect(target, event, disconnected),
    } satisfies DebugTransport),
  ),
);
