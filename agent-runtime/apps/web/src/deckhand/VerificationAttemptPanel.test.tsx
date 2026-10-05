// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId } from "@cinderdeck/contracts";
import * as C from "@cinderdeck/contracts/deckhand/verificationAttemptsRpc";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const commands = vi.hoisted(() => ({
  preview: vi.fn(),
  start: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  advance: vi.fn(),
  read: vi.fn<(target: object, signal: AbortSignal) => Promise<C.VerificationAttempt>>(),
  clear: () => {},
}));
vi.mock("@cinderdeck/client-runtime/state/runtime", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const Effect = await import("effect/Effect");
  const queries = new Map();
  commands.clear = () => queries.clear();
  return {
    createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options,
    createEnvironmentRpcQueryAtomFamily:
      (
        _runtime: unknown,
        options: { tag: string; idleTtlMs: number; staleTimeMs: number; refreshIntervalMs: number },
      ) =>
      (target: object) => {
        expect(options.tag).toBe("deckhand.verificationAttempt.get");
        const key = JSON.stringify(target);
        if (!queries.has(key))
          queries.set(
            key,
            Atom.make(
              Effect.tryPromise({
                try: (signal) => commands.read(target, signal),
                catch: () => new C.AttemptError({ reason: "source_unavailable" }),
              }),
            ).pipe(
              Atom.swr({ staleTime: options.staleTimeMs, revalidateOnMount: true }),
              Atom.setIdleTTL(options.idleTtlMs),
              Atom.setIdleTTL(options.idleTtlMs),
            ),
          );
        return queries.get(key);
      },
  };
});
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { tag: string }) =>
    ({
      "deckhand.verificationAttempt.preview": commands.preview,
      "deckhand.verificationAttempt.start": commands.start,
      "deckhand.verificationAttempt.get": commands.get,
      "deckhand.verificationAttempt.list": commands.list,
      "deckhand.verificationAttempt.advance": commands.advance,
    })[command.tag],
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("./OwnedPreviewCaptureControl", () => ({ OwnedPreviewCaptureControl: () => null }));
vi.mock("../lib/utils", () => ({ randomUUID: () => "new-attempt" }));
import { VerificationAttemptPanel } from "./VerificationAttemptPanel";
const reference = Schema.decodeSync(C.AttemptPreviewInput.fields.reference)({
  projectId: "project",
  repository: "owner/repo",
  number: 7,
});
const preview = Schema.decodeSync(C.AttemptPreview)({
  reference,
  featureID: "feature",
  checkoutID: "checkout",
  serviceID: "web",
  context: { installationID: "native", workspaceID: "lane", generation: 3 },
  head: "b".repeat(40),
  repositoryKeys: ["github.com/owner/repo"],
  observedAt: "2026-10-04T10:00:00Z",
  repositories: [],
  descriptor: {
    adapter: {
      serviceID: "web",
      buildTaskID: "build",
      requiredTaskIDs: ["test"],
      artifactName: "index.html",
      stampPath: "/stamp",
      servedArtifactPath: "/",
    },
    definitionHash: "a".repeat(64),
    workflowHash: "a".repeat(64),
    repositories: [],
    detail: null,
  },
});
const attempt = (
  phase: C.VerificationAttempt["phase"] = "unknown",
  pendingAction: C.VerificationAttempt["pendingAction"] = "prepare",
  operationKey = "saved-attempt",
): C.VerificationAttempt => ({
  operationKey,
  preview,
  createdAt: "2026-10-04T10:00:00Z",
  updatedAt: "2026-10-04T10:00:01Z",
  phase,
  pendingAction,
  receipt: {
    id: "receipt",
    request: {
      ...preview.context,
      operationKey: "native-prepare",
      serviceID: "web",
      expectedDefinitionHash: preview.descriptor.definitionHash,
      expectedWorkflowHash: preview.descriptor.workflowHash,
      expectedRepositories: [],
      requiredTaskIDs: ["test"],
    },
    adapter: preview.descriptor.adapter,
    state: phase === "completed" ? "finalized" : "ready",
    createdAt: "2026-10-04T10:00:00Z",
    updatedAt: "2026-10-04T10:00:01Z",
    detail: null,
    buildRunID: "actual-build",
    definitionHash: preview.descriptor.definitionHash,
    workflowHash: preview.descriptor.workflowHash,
    repositoriesAtStart: [],
    repositoriesAtEnd: [],
    artifact: null,
    launch: null,
    checks: [],
    observations: [],
    operations: [],
    reservationState: phase === "completed" ? "released" : "held",
  },
  recordingID: null,
  recordingProof: null,
  proofHash: null,
  verdict: "incomplete",
  detail: "Saved action has no definitive receipt.",
  currentHead: preview.head,
});
let root: Root;
let element: HTMLDivElement;
let registry: AtomRegistry.AtomRegistry;
const onCaptureContext = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  for (const command of [
    commands.preview,
    commands.start,
    commands.get,
    commands.list,
    commands.advance,
    commands.read,
  ])
    command.mockReset();
  commands.clear();
  commands.list.mockResolvedValue({ _tag: "Success", value: [C.toAttemptSummary(attempt())] });
  commands.get.mockResolvedValue({ _tag: "Success", value: attempt() });
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
const render = async (environment = "computer", candidate?: object) =>
  act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <VerificationAttemptPanel
          environmentId={EnvironmentId.make(environment)}
          reference={{ ...reference }}
          candidate={candidate as Parameters<typeof VerificationAttemptPanel>[0]["candidate"]}
          recordingID=""
          onCaptureContext={onCaptureContext}
        />
      </RegistryContext.Provider>,
    ),
  );
const click = async (label: string) => {
  const button = [...element.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(label),
  );
  expect(button, label).toBeDefined();
  expect(button?.disabled, label).toBe(false);
  await act(async () => button?.click());
};
const openSaved = () => click("bbbbbbbbbbbb");
it("reconciles only the saved GET every three seconds and stops when the action is ready", async () => {
  commands.read.mockResolvedValueOnce(attempt()).mockResolvedValue(attempt("ready", null));
  await render();
  await openSaved();
  expect(element.textContent).toContain("Watching the saved action");
  expect(commands.read.mock.calls[0]?.[0]).toEqual({
    environmentId: "computer",
    input: { operationKey: "saved-attempt" },
  });
  expect(commands.read).toHaveBeenCalledTimes(1);
  // An equivalent PR object from the parent must not reset the selected attempt.
  await render();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(element.textContent).not.toContain("Watching the saved action");
  expect(
    [...element.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Launch built service"),
    )?.disabled,
  ).toBe(false);
  const reads = commands.read.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000);
  });
  expect(commands.read).toHaveBeenCalledTimes(reads);
  expect(commands.start).not.toHaveBeenCalled();
  expect(commands.advance).not.toHaveBeenCalled();
});
it("retains receipt and errors when automatic reads fail, with manual refresh still available", async () => {
  commands.read.mockRejectedValue(new Error("offline"));
  await render();
  await openSaved();
  expect(element.textContent).toContain("Status is unavailable");
  expect(element.textContent).toContain("actual-build");
  commands.get.mockResolvedValue({ _tag: "Success", value: attempt("ready", null) });
  await click("Refresh receipt");
  expect(element.textContent).not.toContain("Status is unavailable");
  expect(commands.get).toHaveBeenCalledTimes(2);
  expect(commands.advance).not.toHaveBeenCalled();
});
it("recovers a lost start response using its original key without resubmitting the build", async () => {
  commands.list.mockResolvedValue({ _tag: "Success", value: [] });
  commands.preview.mockResolvedValue({ _tag: "Success", value: preview });
  commands.start.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Error("Response lost")),
  });
  let resolveRead!: (value: C.VerificationAttempt) => void;
  commands.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
  );
  await render("computer", { feature: { id: "feature" }, checkout: { id: "checkout" } });
  const input = element.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "web");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Pin current PR head");
  await click("Build pinned revision");
  expect(element.textContent).toContain("Response lost");
  expect(commands.read.mock.calls[0]?.[0]).toEqual({
    environmentId: "computer",
    input: { operationKey: "new-attempt" },
  });
  expect(
    [...element.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Refresh saved attempt"),
    )?.disabled,
  ).toBe(false);
  await act(async () => resolveRead(attempt("ready", null, "new-attempt")));
  expect(element.textContent).toContain("actual-build");
  expect(element.textContent).not.toContain("Response lost");
  expect(commands.start).toHaveBeenCalledTimes(1);
  expect(commands.advance).not.toHaveBeenCalled();
});
it("cancels a departed environment read and ignores its late positive result", async () => {
  let resolveOld!: (value: C.VerificationAttempt) => void;
  let oldSignal: AbortSignal | undefined;
  commands.read.mockImplementationOnce((_target, signal) => {
    oldSignal = signal;
    return new Promise((resolve) => {
      resolveOld = resolve;
    });
  });
  await render();
  await openSaved();
  commands.list.mockResolvedValue({ _tag: "Success", value: [] });
  await render("other-computer");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(oldSignal?.aborted).toBe(true);
  await act(async () =>
    resolveOld({ ...attempt("completed", null), verdict: "matches", buildAndChecksMatch: true }),
  );
  expect(element.textContent).not.toContain("Verification matches this commit");
  expect(element.textContent).not.toContain("actual-build");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000);
  });
  expect(commands.read).toHaveBeenCalledTimes(1);
});
it.each(["launch", "checks", "finalize", "cancel"] as const)(
  "observes an unresolved %s without replaying it and stops at completion",
  async (action) => {
    commands.get.mockResolvedValue({ _tag: "Success", value: attempt("unknown", action) });
    commands.read.mockResolvedValue({
      ...attempt("completed", null),
      verdict: "matches",
      buildAndChecksMatch: true,
    });
    await render();
    await openSaved();
    expect(element.textContent).toContain(
      "Pinned source, required checks, served artifact and the owned browser video match.",
    );
    expect(element.textContent).not.toContain("video target is unverified");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(commands.read).toHaveBeenCalledTimes(1);
    expect(commands.advance).not.toHaveBeenCalled();
    expect(commands.start).not.toHaveBeenCalled();
  },
);
it("keeps generic-window full video verification incomplete", async () => {
  commands.get.mockResolvedValue({
    _tag: "Success",
    value: { ...attempt("completed", null), buildAndChecksMatch: true },
  });
  await render();
  await openSaved();
  expect(element.textContent).toContain("Full video verification remains incomplete.");
  expect(commands.read).not.toHaveBeenCalled();
});

it("observes one explicit launch without repeating that action", async () => {
  commands.get.mockResolvedValue({ _tag: "Success", value: attempt("ready", null) });
  commands.advance.mockResolvedValue({ _tag: "Success", value: attempt("unknown", "launch") });
  commands.read
    .mockResolvedValueOnce(attempt("unknown", "launch"))
    .mockResolvedValue(attempt("ready", null));
  await render();
  await openSaved();
  await click("Launch built service");
  expect(commands.advance).toHaveBeenCalledTimes(1);
  expect(commands.advance.mock.calls[0]?.[0]).toEqual({
    environmentId: "computer",
    input: { operationKey: "saved-attempt", action: "launch" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(element.textContent).not.toContain("Watching the saved action");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000);
  });
  expect(commands.advance).toHaveBeenCalledTimes(1);
  expect(commands.read).toHaveBeenCalledTimes(2);
  expect(element.textContent).not.toContain("Watching the saved action");
});
it("cancels a prior attempt read when another saved key is selected", async () => {
  commands.list.mockResolvedValue({
    _tag: "Success",
    value: [
      C.toAttemptSummary(attempt()),
      C.toAttemptSummary({
        ...attempt("ready", null, "other-attempt"),
        preview: { ...preview, head: "c".repeat(40) },
      }),
    ],
  });
  let resolveOld!: (value: C.VerificationAttempt) => void;
  let oldSignal: AbortSignal | undefined;
  commands.read.mockImplementationOnce((_target, signal) => {
    oldSignal = signal;
    return new Promise((resolve) => {
      resolveOld = resolve;
    });
  });
  await render();
  await openSaved();
  const selected = {
    ...attempt("ready", null, "other-attempt"),
    preview: { ...preview, head: "c".repeat(40) },
  };
  commands.get.mockResolvedValue({ _tag: "Success", value: selected });
  await click("cccccccccccc");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => resolveOld({ ...attempt("completed", null), verdict: "matches" }));
  expect(element.textContent).not.toContain("Verification matches this commit");
  expect(element.querySelector(`code`)?.textContent).toBe("cccccccccccc");
  expect(commands.get.mock.calls.at(-1)?.[0]).toEqual({
    environmentId: "computer",
    input: { operationKey: "other-attempt" },
  });
});
it("ignores an older cached receipt instead of regressing the current pending action", async () => {
  commands.read
    .mockResolvedValueOnce({
      ...attempt("completed", null),
      updatedAt: "2026-10-04T10:00:00Z",
      verdict: "matches",
    })
    .mockResolvedValue({ ...attempt("ready", null), updatedAt: "2026-10-04T10:00:02Z" });
  await render();
  await openSaved();
  expect(element.textContent).not.toContain("Verification matches this commit");
  expect(element.textContent).toContain("Watching the saved action");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(element.textContent).not.toContain("Watching the saved action");
  expect(commands.read).toHaveBeenCalledTimes(2);
});

it("does not poll or retain a stale preview after a definitive before-effects refusal", async () => {
  commands.list.mockResolvedValue({ _tag: "Success", value: [] });
  commands.preview.mockResolvedValue({ _tag: "Success", value: preview });
  commands.start.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new C.AttemptError({ reason: "stale_preview" })),
  });
  await render("computer", { feature: { id: "feature" }, checkout: { id: "checkout" } });
  const input = element.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "web");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Pin current PR head");
  await click("Build pinned revision");
  expect(element.textContent).toContain("stale_preview");
  expect(element.textContent).not.toContain("Build pinned revision");
  expect(element.querySelector("input")?.disabled).toBe(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000);
  });
  expect(commands.read).not.toHaveBeenCalled();
  expect(commands.start).toHaveBeenCalledTimes(1);
  expect(commands.preview).toHaveBeenCalledTimes(1);
});

it("allows a slow exact GET to settle before scheduling another status read", async () => {
  let resolveRead!: (value: C.VerificationAttempt) => void;
  let signal: AbortSignal | undefined;
  commands.read.mockImplementationOnce((_target, readSignal) => {
    signal = readSignal;
    return new Promise((resolve) => {
      resolveRead = resolve;
    });
  });
  await render();
  await openSaved();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8000);
  });
  expect(commands.read).toHaveBeenCalledTimes(1);
  expect(signal?.aborted).toBe(false);
  await act(async () => resolveRead(attempt("ready", null)));
  expect(element.textContent).not.toContain("Watching the saved action");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000);
  });
  expect(commands.read).toHaveBeenCalledTimes(1);
});

it("opens the chosen completed result by its timestamp and exact key without claiming fresh list integrity", async () => {
  const matched = {
    ...attempt("completed", null),
    operationKey: "matched-attempt",
    createdAt: "2026-10-04T10:02:00Z",
    verdict: "matches" as const,
  };
  const incomplete = {
    ...attempt("completed", null),
    operationKey: "incomplete-attempt",
    createdAt: "2026-10-04T10:01:00Z",
  };
  // Real listings intentionally downgrade a saved match until exact GET can
  // recheck the selected recording's current bytes and proof.
  commands.list.mockResolvedValue({
    _tag: "Success",
    value: [
      C.toAttemptSummary(incomplete),
      C.toAttemptSummary({ ...matched, verdict: "incomplete" }),
    ],
  });
  commands.get.mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: input.operationKey === matched.operationKey ? matched : incomplete,
  }));
  await render();
  const dates = [...element.querySelectorAll("time")];
  expect(dates).toHaveLength(2);
  expect(dates[0]?.textContent).not.toBe(dates[1]?.textContent);
  const buttons = dates.map((date) => date.closest("button"));
  expect(buttons.every((button) => button?.textContent?.includes("Open saved result"))).toBe(true);
  expect(element.textContent).not.toContain("Matches revision");
  const selected = element
    .querySelector(`time[datetime="${matched.createdAt}"]`)
    ?.closest("button");
  expect(selected?.disabled).toBe(false);
  await act(async () => selected?.click());
  expect(commands.get).toHaveBeenCalledWith({
    environmentId: "computer",
    input: { operationKey: "matched-attempt" },
  });
  expect(element.textContent).toContain("Verification matches this commit");
  expect(commands.get).toHaveBeenCalledTimes(1);
  expect(commands.read).not.toHaveBeenCalled();
  expect(commands.advance).not.toHaveBeenCalled();
  expect(commands.start).not.toHaveBeenCalled();
});
