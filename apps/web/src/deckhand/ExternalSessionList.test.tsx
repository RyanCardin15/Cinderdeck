// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId } from "@t3tools/contracts";
import * as C from "@t3tools/contracts/deckhand/externalSessionsRpc";
import * as Schema from "effect/Schema";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const commands = vi.hoisted(() => ({
  list: vi.fn<
    (
      target: object,
      signal: AbortSignal,
    ) => Promise<
      { _tag: "Success"; value: ReadonlyArray<C.ExternalSessionView> } | { _tag: "Failure" }
    >
  >(),
  clear: () => {},
}));
vi.mock("@t3tools/client-runtime/state/runtime", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const Effect = await import("effect/Effect");
  const C = await import("@t3tools/contracts/deckhand/externalSessionsRpc");
  const queries = new Map();
  commands.clear = () => queries.clear();
  return {
    createEnvironmentRpcQueryAtomFamily:
      (
        _runtime: unknown,
        options: { idleTtlMs: number; staleTimeMs: number; refreshIntervalMs: number },
      ) =>
      (target: object) => {
        const key = JSON.stringify(target);
        if (!queries.has(key)) {
          const effect = Effect.promise((signal) => commands.list(target, signal)).pipe(
            Effect.flatMap((response) =>
              response._tag === "Success"
                ? Effect.succeed(response.value)
                : Effect.fail(new C.ExternalSessionError({ reason: "source_unavailable" })),
            ),
          );
          queries.set(
            key,
            Atom.make(effect).pipe(
              Atom.swr({ staleTime: options.staleTimeMs, revalidateOnMount: true }),
              Atom.setIdleTTL(options.idleTtlMs),
              Atom.withRefresh(options.refreshIntervalMs),
              Atom.setIdleTTL(options.idleTtlMs),
            ),
          );
        }
        return queries.get(key);
      },
  };
});
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
import { ExternalSessionList } from "./ExternalSessionList";
const reported = Schema.decodeSync(C.ExternalSessionView)({
  installationID: "installation",
  workspaceID: "lane",
  generation: 3,
  featureId: "feature",
  checkoutId: "checkout",
  id: "external:11111111-1111-1111-1111-111111111111",
  providerName: "Claude",
  providerSessionId: "claimed-id",
  title: "Reported review",
  role: "reviewer",
  repositoryScope: ["physical"],
  reportedExecution: "working",
  reportedCapabilities: ["read_only", "resume"],
  source: "registrant_reported",
  lastSequence: 1,
  registeredAt: "2026-10-03T00:00:00Z",
  lastSeenAt: "2026-10-03T00:01:00Z",
  expiresAt: "2026-10-03T00:03:00Z",
  archivedAt: null,
  connection: "stale",
  leaseSeconds: 120,
  control: {
    transcript: false,
    interrupt: false,
    resume: false,
    approvals: false,
    writerReservation: false,
  },
});
let root: Root;
let element: HTMLDivElement;
let registry: AtomRegistry.AtomRegistry;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  commands.list.mockReset();
  commands.clear();
  registry = AtomRegistry.make({ defaultIdleTTL: 400 });
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  registry.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const render = async (generation = 3) =>
  act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <ExternalSessionList
          environmentId={EnvironmentId.make("computer")}
          installationID="installation"
          workspaceID="lane"
          generation={generation}
        />
      </RegistryContext.Provider>,
    ),
  );
it("shows stale external claims without managed navigation or controls", async () => {
  commands.list.mockResolvedValue({ _tag: "Success", value: [reported] });
  await render();
  expect(element.textContent).toContain("Last reported: working");
  expect(element.textContent).toContain("Connection lost / last seen");
  expect(element.textContent).toContain("do not grant Deckhand controls");
  expect(element.querySelectorAll("button,a")).toHaveLength(0);
  expect(commands.list.mock.calls[0]?.[0]).toEqual({
    environmentId: "computer",
    input: { installationID: "installation", workspaceID: "lane", generation: 3, limit: 20 },
  });
});
it("resolves empty and refused reads instead of retaining the loading state", async () => {
  commands.list.mockResolvedValueOnce({ _tag: "Success", value: [] });
  await render();
  expect(element.textContent).toContain("No registered external sessions in this context.");
  expect(element.textContent).not.toContain("Loading external sessions");
  commands.list.mockResolvedValue({ _tag: "Failure" });
  await render(4);
  expect(element.textContent).toContain("External session state is unavailable.");
  expect(element.textContent).not.toContain("Loading external sessions");
});
it("interrupts a departed context read and never lets its late result replace the new generation", async () => {
  vi.useFakeTimers();
  let resolveOld!: (value: {
    _tag: "Success";
    value: ReadonlyArray<C.ExternalSessionView>;
  }) => void;
  let oldSignal: AbortSignal | undefined;
  commands.list
    .mockImplementationOnce((_target, signal: AbortSignal) => {
      oldSignal = signal;
      return new Promise((resolve) => {
        resolveOld = resolve;
      });
    })
    .mockResolvedValue({ _tag: "Success", value: [] });
  await render();
  expect(element.textContent).toContain("Loading external sessions");
  await render(4);
  await act(async () => {
    // React's registry also disposes wrapped dependency atoms on its bounded
    // idle schedule; the departed read must end before the next 15s refresh.
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(oldSignal?.aborted).toBe(true);
  expect(element.textContent).toContain("No registered external sessions in this context.");
  await act(async () => {
    resolveOld({ _tag: "Success", value: [reported] });
  });
  expect(element.textContent).not.toContain("Reported review");
  expect(commands.list.mock.calls.at(-1)?.[0]).toEqual({
    environmentId: "computer",
    input: { installationID: "installation", workspaceID: "lane", generation: 4, limit: 20 },
  });
});
it("preserves last observed rows on refresh failure and clears them when selected generation changes", async () => {
  vi.useFakeTimers();
  commands.list
    .mockResolvedValueOnce({ _tag: "Success", value: [reported] })
    .mockResolvedValue({ _tag: "Failure" });
  await render();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(element.textContent).toContain("Retained rows show only the last observed report");
  expect(element.textContent).toContain("Reported review");
  await render(4);
  expect(element.textContent).not.toContain("Reported review");
  expect(element.textContent).toContain("unavailable");
});
