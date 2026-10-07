// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics preferSchemaOverJson:off
// Background computer use. Agents read a Mac app's accessibility tree and act
// on its elements through the native helper, which never moves the user's
// pointer or activates the app. Each conversation needs the person's approval
// per app; an app is used by one conversation at a time.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@cinderdeck/shared/hostProcess";
import * as C from "@cinderdeck/contracts/deckhand/computerUse";
import * as ServerConfig from "../config.ts";
import { parseKeyChord } from "./ComputerUseKeys.ts";
import { makeNativeComputerUse, type ComputerUseCall } from "./ComputerUseNative.ts";
import { makeComputerUseScripts } from "./ComputerUseScript.ts";
import {
  diffTree,
  formatTree,
  snapshotTree,
  type ComputerNode,
  type TreeSnapshot,
} from "./ComputerUseTree.ts";

export interface ComputerActor {
  readonly threadId: string;
  /** Shown on the agent cursor and in the approval prompt. */
  readonly label: string;
}

export type ComputerAction =
  | { readonly kind: "click"; readonly input: C.ComputerClick }
  | { readonly kind: "drag"; readonly input: C.ComputerDrag }
  | { readonly kind: "press_key"; readonly input: C.ComputerPressKey }
  | { readonly kind: "type_text"; readonly input: C.ComputerTypeText }
  | { readonly kind: "scroll"; readonly input: C.ComputerScroll }
  | { readonly kind: "set_value"; readonly input: C.ComputerSetValue }
  | { readonly kind: "select_text"; readonly input: C.ComputerSelectText }
  | { readonly kind: "perform_secondary_action"; readonly input: C.ComputerSecondaryAction }
  | { readonly kind: "paste"; readonly input: C.ComputerPaste }
  | { readonly kind: "activate_app"; readonly input: C.ComputerApp };

export interface ApprovalStore {
  readonly load: () => Promise<ReadonlyArray<string>>;
  readonly save: (bundleIds: ReadonlyArray<string>) => Promise<void>;
}

export interface ComputerUseCore {
  readonly listApps: (actor: ComputerActor) => Promise<C.ComputerListAppsResult>;
  readonly getAppState: (
    actor: ComputerActor,
    input: C.ComputerGetAppState,
  ) => Promise<C.ComputerAppState>;
  readonly act: (actor: ComputerActor, action: ComputerAction) => Promise<C.ComputerActionResult>;
}

const ONCE_MS = 10 * 60_000;
const DENIAL_MS = 60_000;
const LEASE_MS = 90_000;
const VIEW_LIMIT = 300;

const fail = (reason: C.ComputerUseError["reason"], detail?: string) =>
  new C.ComputerUseError({ reason, ...(detail ? { detail } : {}) });
const isComputerUseError = Schema.is(C.ComputerUseError);
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const finite = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const buttons = { l: "left", r: "right", m: "middle" } as const;
const directions = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
} as const;

type View = {
  readonly windowKey: string;
  readonly snapshot: TreeSnapshot;
  readonly scale: number | undefined;
};

export function fileApprovalStore(stateDir: string): ApprovalStore {
  const path = NodePath.join(stateDir, "computer-use", "approvals.json");
  let saving = Promise.resolve();
  return {
    load: async () => {
      try {
        const value = record(JSON.parse(await NodeFSP.readFile(path, "utf8")));
        return Array.isArray(value.alwaysAllow)
          ? value.alwaysAllow.filter((id): id is string => typeof id === "string")
          : [];
      } catch {
        return [];
      }
    },
    save: (bundleIds) => {
      const next = saving.then(async () => {
        await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
        const temporary = `${path}.${process.pid}.tmp`;
        await NodeFSP.writeFile(
          temporary,
          JSON.stringify({ version: 1, alwaysAllow: [...bundleIds].sort() }, null, 2),
        );
        await NodeFSP.rename(temporary, path);
      });
      saving = next.catch(() => {});
      return next;
    },
  };
}

export function makeComputerUseCore(options: {
  readonly call: ComputerUseCall;
  readonly approvals: ApprovalStore;
  readonly now?: () => number;
}): ComputerUseCore {
  const { call, approvals } = options;
  const now = options.now ?? Date.now;
  let always: Set<string> | undefined;
  let loading: Promise<void> | undefined;
  const grants = new Map<string, number>();
  const denials = new Map<string, number>();
  const prompts = new Map<string, Promise<void>>();
  const leases = new Map<string, { threadId: string; until: number }>();
  const views = new Map<string, View>();
  const active = new Map<string, number>();

  const agent = (actor: ComputerActor) => ({ id: actor.threadId, label: actor.label });
  const grantKey = (actor: ComputerActor, bundleId: string) =>
    `${actor.threadId}\0${bundleId.toLowerCase()}`;

  const resolve = async (input: string) => {
    const raw = await call("resolveApp", { app: input, launch: false });
    const bundleId = text(raw.bundleId);
    if (!bundleId) throw fail("app_missing", input);
    if (C.isComputerUseBlocked(bundleId)) throw fail("app_blocked", bundleId);
    return { bundleId, name: text(raw.name) || bundleId };
  };

  const ensureAccess = async (actor: ComputerActor, bundleId: string, name: string) => {
    loading ??= approvals.load().then((ids) => {
      always = new Set(ids.map((id) => id.toLowerCase()));
    });
    await loading;
    if (always!.has(bundleId.toLowerCase())) return;
    const key = grantKey(actor, bundleId);
    if ((grants.get(key) ?? 0) > now()) return;
    if ((denials.get(key) ?? 0) > now()) throw fail("approval_denied", name);
    // Concurrent calls from one conversation share a single prompt.
    let prompt = prompts.get(key);
    if (!prompt) {
      prompt = (async () => {
        const answer = text(
          (await call("requestAccess", { appName: name, bundleId, agent: agent(actor) }, 130_000))
            .decision,
        );
        if (answer === "always") {
          always!.add(bundleId.toLowerCase());
          await approvals.save([...always!]);
        } else if (answer === "session") grants.set(key, Number.POSITIVE_INFINITY);
        else if (answer === "once") grants.set(key, now() + ONCE_MS);
        else {
          denials.set(key, now() + DENIAL_MS);
          throw fail("approval_denied", name);
        }
      })().finally(() => prompts.delete(key));
      prompts.set(key, prompt);
    }
    await prompt;
  };

  const claim = (actor: ComputerActor, bundleId: string) => {
    const id = bundleId.toLowerCase();
    const lease = leases.get(id);
    if (
      lease &&
      lease.threadId !== actor.threadId &&
      (lease.until > now() || (active.get(id) ?? 0) > 0)
    ) {
      throw fail("app_busy", bundleId);
    }
    leases.set(id, { threadId: actor.threadId, until: now() + LEASE_MS });
  };

  const prepare = async (actor: ComputerActor, app: string, mutation: boolean) => {
    const resolved = await resolve(app);
    await ensureAccess(actor, resolved.bundleId, resolved.name);
    if (mutation) claim(actor, resolved.bundleId);
    return resolved;
  };

  // Screenshot pixels to window points, using this conversation's latest read.
  const points = (actor: ComputerActor, bundleId: string, x: number, y: number) => {
    const scale = views.get(grantKey(actor, bundleId))?.scale;
    if (scale === undefined)
      throw fail(
        "invalid_input",
        "Read the app with includeScreenshot: true before using screenshot coordinates.",
      );
    return { x: x / scale, y: y / scale };
  };

  const remember = (key: string, view: View) => {
    views.delete(key);
    views.set(key, view);
    if (views.size > VIEW_LIMIT) {
      const oldest = views.keys().next();
      if (!oldest.done) views.delete(oldest.value);
    }
  };

  const getAppState: ComputerUseCore["getAppState"] = async (actor, input) => {
    const { bundleId, name } = await prepare(actor, input.app, false);
    const raw = await call(
      "getState",
      {
        app: bundleId,
        includeScreenshot: input.includeScreenshot !== false,
        ...(input.window !== undefined ? { window: input.window } : {}),
        agent: agent(actor),
      },
      30_000,
    );
    const nodes = (Array.isArray(raw.nodes) ? raw.nodes : [])
      .map(record)
      .filter((node) => typeof node.id === "number" && typeof node.role === "string")
      .map((node) => node as unknown as ComputerNode);
    const windows = (Array.isArray(raw.windows) ? raw.windows : []).map(record);
    const window = record(raw.window);
    const screenshot = record(raw.screenshot);
    const hasImage = typeof screenshot.data === "string" && screenshot.data.length > 0;
    const target = windows.find((row) => row.target === true);
    const windowKey = `${finite(target?.index, -1)}:${text(target?.title)}:${finite(window.width, 0)}x${finite(window.height, 0)}`;
    const key = grantKey(actor, bundleId);
    const previous = views.get(key);
    const scale = hasImage
      ? finite(screenshot.scale, 1) || 1
      : previous?.windowKey === windowKey
        ? previous.scale
        : undefined;
    const diff =
      input.disableDiff !== true && previous?.windowKey === windowKey
        ? diffTree(previous.snapshot, nodes)
        : null;
    remember(key, { windowKey, snapshot: snapshotTree(nodes), scale });

    const header = [`App: ${name} (${bundleId})`];
    if (windows.length > 0) {
      header.push(
        `Windows: ${windows
          .slice(0, 12)
          .map(
            (row) =>
              `[${finite(row.index, 0)}] ${JSON.stringify(text(row.title))}${row.target === true ? " (target)" : ""}${row.minimized === true ? " (minimized)" : ""}`,
          )
          .join(", ")}`,
      );
    } else header.push("The app has no open window; only its menu bar is listed.");
    if (hasImage) {
      header.push(
        `Screenshot: ${finite(screenshot.width, 0)}x${finite(screenshot.height, 0)} px of a ${Math.round(finite(window.width, 0))}x${Math.round(finite(window.height, 0))} pt window; x/y inputs use screenshot pixels.`,
      );
    } else if (raw.screenshotError) {
      header.push(`Screenshot unavailable (${text(raw.screenshotError)}).`);
    }
    if (typeof raw.focusedId === "number") header.push(`Focused element: ${raw.focusedId}`);
    if (raw.selectedText) header.push(`Selected text: ${JSON.stringify(text(raw.selectedText))}`);
    if (raw.truncated === true)
      header.push(
        `Tree truncated at ${nodes.length} elements; scroll or open a narrower view for the rest.`,
      );
    return {
      app: bundleId,
      name,
      text: `${header.join("\n")}\n\n${diff?.text ?? formatTree(nodes)}`,
      diff: diff !== null,
      screenshot: hasImage
        ? {
            data: text(screenshot.data),
            mimeType: text(screenshot.mimeType) || "image/jpeg",
            width: finite(screenshot.width, 0),
            height: finite(screenshot.height, 0),
          }
        : null,
    };
  };

  const act: ComputerUseCore["act"] = async (actor, action) => {
    const { bundleId } = await prepare(actor, action.input.app, true);
    const id = bundleId.toLowerCase();
    active.set(id, (active.get(id) ?? 0) + 1);
    try {
      const base = { app: bundleId, agent: agent(actor) };
      switch (action.kind) {
        case "click": {
          const { element_index, x, y } = action.input;
          if (element_index === undefined && (x === undefined || y === undefined))
            throw fail("invalid_input", "Pass element_index, or both x and y.");
          const button = action.input.mouse_button ?? "left";
          await call("click", {
            ...base,
            ...(element_index !== undefined
              ? { id: element_index }
              : points(actor, bundleId, x!, y!)),
            button: button in buttons ? buttons[button as keyof typeof buttons] : button,
            count: action.input.click_count ?? 1,
          });
          break;
        }
        case "drag": {
          const from = points(actor, bundleId, action.input.from_x, action.input.from_y);
          const to = points(actor, bundleId, action.input.to_x, action.input.to_y);
          await call("drag", { ...base, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y });
          break;
        }
        case "press_key": {
          const parsed = parseKeyChord(action.input.key);
          if (!parsed) throw fail("invalid_input", `Unknown key ${action.input.key}.`);
          if ("text" in parsed) await call("type", { ...base, text: parsed.text });
          else await call("key", { ...base, keyCode: parsed.keyCode, modifiers: parsed.modifiers });
          break;
        }
        case "type_text":
          await call(
            "type",
            {
              ...base,
              text: action.input.text,
              ...(action.input.element_index !== undefined
                ? { id: action.input.element_index }
                : {}),
            },
            60_000,
          );
          break;
        case "scroll": {
          const { element_index, x, y, direction } = action.input;
          const unit = directions[direction];
          await call("scroll", {
            ...base,
            ...(element_index !== undefined
              ? { id: element_index }
              : x !== undefined && y !== undefined
                ? points(actor, bundleId, x, y)
                : {}),
            dx: unit.dx,
            dy: unit.dy,
            pages: action.input.pages ?? 1,
          });
          break;
        }
        case "set_value":
          await call("setValue", {
            ...base,
            id: action.input.element_index,
            value: action.input.value,
          });
          break;
        case "select_text":
          await call("selectText", {
            ...base,
            id: action.input.element_index,
            text: action.input.text,
            ...(action.input.prefix !== undefined ? { prefix: action.input.prefix } : {}),
            ...(action.input.suffix !== undefined ? { suffix: action.input.suffix } : {}),
            mode: action.input.selection_type ?? "text",
          });
          break;
        case "perform_secondary_action":
          await call("secondaryAction", {
            ...base,
            id: action.input.element_index,
            action: action.input.action,
          });
          break;
        case "paste":
          await call("paste", { ...base, text: action.input.text });
          break;
        case "activate_app":
          await call("activate", base);
          return {
            ok: true,
            app: bundleId,
            note: "The app is now in front of the user's work. Prefer background actions.",
          };
      }
      return { ok: true, app: bundleId };
    } finally {
      const count = (active.get(id) ?? 1) - 1;
      if (count === 0) active.delete(id);
      else active.set(id, count);
      leases.set(id, { threadId: actor.threadId, until: now() + LEASE_MS });
    }
  };

  const listApps: ComputerUseCore["listApps"] = async () => {
    const [apps, permissions] = await Promise.all([call("listApps"), call("permissions")]);
    return {
      apps: (Array.isArray(apps.apps) ? apps.apps : [])
        .map(record)
        .filter((row) => typeof row.id === "string" && !C.isComputerUseBlocked(row.id))
        .map((row) => ({
          id: text(row.id),
          ...(typeof row.displayName === "string" ? { displayName: row.displayName } : {}),
          ...(typeof row.isRunning === "boolean" ? { isRunning: row.isRunning } : {}),
          ...(typeof row.lastUsedDate === "string" ? { lastUsedDate: row.lastUsedDate } : {}),
          ...(typeof row.useCount === "number" ? { useCount: row.useCount } : {}),
        })),
      permissions: {
        accessibility: permissions.accessibility === true,
        screenRecording: permissions.screenRecording === true,
        postEvents: permissions.postEvents === true,
        screenLocked: permissions.screenLocked === true,
        backgroundFocus: permissions.backgroundFocus === true,
      },
    };
  };

  return { listApps, getAppState, act };
}

type Result<A> = Effect.Effect<A, C.ComputerUseError>;
export class ComputerUse extends Context.Service<
  ComputerUse,
  {
    readonly listApps: (actor: ComputerActor) => Result<C.ComputerListAppsResult>;
    readonly getAppState: (
      actor: ComputerActor,
      input: C.ComputerGetAppState,
    ) => Result<C.ComputerAppState>;
    readonly act: (actor: ComputerActor, action: ComputerAction) => Result<C.ComputerActionResult>;
    readonly script: (
      actor: ComputerActor,
      input: C.ComputerScript,
    ) => Result<C.ComputerScriptResult>;
  }
>()("@cinderdeck/server/deckhand/ComputerUse") {}

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => (isComputerUseError(cause) ? cause : fail("unavailable")),
  });

const make = (core: ComputerUseCore, scripts = makeComputerUseScripts(core)) => {
  return ComputerUse.of({
    listApps: (actor) => attempt(() => core.listApps(actor)),
    getAppState: (actor, input) => attempt(() => core.getAppState(actor, input)),
    act: (actor, action) => attempt(() => core.act(actor, action)),
    script: (actor, input) => attempt(() => scripts.run(actor, input)),
  });
};

export const layerLive = Layer.effect(
  ComputerUse,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const native = makeNativeComputerUse({ platform: yield* HostProcessPlatform });
    const core = makeComputerUseCore({
      call: native,
      approvals: fileApprovalStore(config.stateDir),
    });
    const scripts = makeComputerUseScripts(core);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        scripts.disposeAll();
        native.dispose();
      }),
    );
    return make(core, scripts);
  }),
);
