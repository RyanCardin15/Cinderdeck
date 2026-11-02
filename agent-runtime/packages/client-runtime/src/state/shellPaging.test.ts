import { it as effectIt } from "@effect/vitest";
import { EnvironmentId, ThreadId, type OrchestrationV2ShellPage } from "@cinderdeck/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { expect, it, beforeEach, vi } from "vite-plus/test";
import { createShellPagingAtoms, currentPageRows, type ShellPageRow } from "./shellPaging.ts";
import type { EnvironmentShellState } from "./shell.ts";
import { v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

const boundary = vi.hoisted(() => ({
  read: vi.fn(),
  queries: new Map<string, Atom.Writable<AsyncResult.AsyncResult<ReadonlyArray<ShellPageRow>>>>(),
  execute: null as unknown as (input: {
    generation: number;
    scope: object;
  }) => Effect.Effect<ReadonlyArray<ShellPageRow>>,
}));
vi.mock("../rpc/client.ts", () => ({
  request: (_tag: unknown, input: unknown) => boundary.read(input),
}));
vi.mock("./runtime.ts", () => ({
  createEnvironmentQueryAtomFamily: (
    _runtime: unknown,
    options: { execute: typeof boundary.execute },
  ) => {
    boundary.execute = options.execute;
    return (target: unknown) => {
      const key = JSON.stringify(target);
      if (!boundary.queries.has(key))
        boundary.queries.set(
          key,
          Atom.make<AsyncResult.AsyncResult<ReadonlyArray<ShellPageRow>>>(AsyncResult.initial()),
        );
      return boundary.queries.get(key)!;
    };
  },
}));
const id = EnvironmentId.make("paging");
beforeEach(() => {
  boundary.queries.clear();
  boundary.read.mockReset();
});

it("keeps full/legacy snapshots independent of the new RPC and discards pages across authoritative generations", () => {
  const state = Atom.make<EnvironmentShellState>({
    status: "live",
    error: Option.none(),
    snapshot: Option.some(v2ShellSnapshot),
    generation: 1,
  });
  const pages = createShellPagingAtoms(null as never, () => state);
  const registry = AtomRegistry.make();
  const atom = pages(id, {});
  const stop = registry.mount(atom);
  try {
    expect(registry.get(atom)).toEqual([]);
    expect(boundary.queries.size).toBe(0);
    registry.set(state, {
      ...registry.get(state),
      snapshot: Option.some({ ...v2ShellSnapshot, deferredThreads: true }),
    });
    expect(registry.get(atom)).toEqual([]);
    const first = [...boundary.queries.values()][0]!;
    registry.set(first, AsyncResult.success([{ shell: v2ThreadShell, sequence: 5 }]));
    expect(registry.get(atom)).toEqual([v2ThreadShell]);
    registry.set(state, { ...registry.get(state), generation: 2 });
    expect(registry.get(atom)).toEqual([]);
    expect(boundary.queries.size).toBe(2);
    registry.set(
      first,
      AsyncResult.success([{ shell: { ...v2ThreadShell, title: "Stale computer" }, sequence: 6 }]),
    );
    expect(registry.get(atom)).toEqual([]);
    registry.set(state, { ...registry.get(state), snapshot: Option.some(v2ShellSnapshot) });
    expect(registry.get(atom)).toEqual([]);
  } finally {
    stop();
    registry.dispose();
  }
});

it("tracks each page's own watermark so a late page cannot resurrect deleted or archived threads", () => {
  const early = { ...v2ThreadShell, id: ThreadId.make("early") };
  const late = { ...v2ThreadShell, id: ThreadId.make("late") };
  expect(
    currentPageRows(
      [
        { shell: early, sequence: 5 },
        { shell: late, sequence: 20 },
      ],
      new Map([[early.id, 10]]),
    ),
  ).toEqual([late]);
});

effectIt.effect("reads each page with an advancing cursor and refuses a repeating cursor", () =>
  Effect.gen(function* () {
    createShellPagingAtoms(null as never, () => null as never);
    const next = ThreadId.make("next");
    boundary.read
      .mockReturnValueOnce(
        Effect.succeed({
          snapshotSequence: 5,
          threads: [v2ThreadShell],
          nextId: next,
        } satisfies OrchestrationV2ShellPage),
      )
      .mockReturnValueOnce(
        Effect.succeed({
          snapshotSequence: 6,
          threads: [],
          nextId: null,
        } satisfies OrchestrationV2ShellPage),
      );
    const rows = yield* boundary.execute({ generation: 1, scope: {} });
    expect(rows).toEqual([{ shell: v2ThreadShell, sequence: 5 }]);
    expect(boundary.read.mock.calls.map(([input]) => input)).toEqual([{}, { afterId: next }]);
    boundary.read
      .mockReset()
      .mockReturnValue(Effect.succeed({ snapshotSequence: 7, threads: [], nextId: next }));
    expect(yield* Effect.result(boundary.execute({ generation: 2, scope: {} }))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ShellPageCursorError" },
    });
  }),
);

it("coalesces status, retries and sibling lookups onto one canonical family query", () => {
  const root = ThreadId.make("root");
  const child = ThreadId.make("child");
  const state = Atom.make<EnvironmentShellState>({
    status: "live",
    error: Option.none(),
    generation: 1,
    snapshot: Option.some({
      ...v2ShellSnapshot,
      deferredThreads: true,
      deferredThreadRefs: [{ id: child, projectId: v2ThreadShell.projectId, rootThreadId: root }],
    }),
  });
  const pages = createShellPagingAtoms(null as never, () => state);
  const registry = AtomRegistry.make();
  try {
    registry.get(pages.resultAtom(id, { projectIds: [], threadIds: [child] }));
    registry.get(pages.resultAtom(id, { projectIds: [], threadIds: [root] }));
    expect(boundary.queries.size).toBe(1);
    pages.refresh(registry, id, { projectIds: [], threadIds: [child] });
    expect(boundary.queries.size).toBe(1);
  } finally {
    registry.dispose();
  }
});

it("observing a present conversation's status does not hydrate its descendants", () => {
  const state = Atom.make<EnvironmentShellState>({
    status: "live",
    error: Option.none(),
    generation: 1,
    snapshot: Option.some({ ...v2ShellSnapshot, deferredThreads: true }),
  });
  const pages = createShellPagingAtoms(null as never, () => state);
  const registry = AtomRegistry.make();
  const scope = { projectIds: [], threadIds: [v2ThreadShell.id] };
  try {
    expect(AsyncResult.isSuccess(registry.get(pages.statusAtom(id, scope)))).toBe(true);
    expect(boundary.queries.size).toBe(0);
    registry.get(pages.resultAtom(id, scope));
    expect(boundary.queries.size).toBe(1);
  } finally {
    registry.dispose();
  }
});
