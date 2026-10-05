// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId } from "@t3tools/contracts";
import * as Contracts from "@t3tools/contracts/deckhand/rpc";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({
  create: vi.fn(),
  inspectCreation: vi.fn(),
  launch: vi.fn(),
  inspectLaunch: vi.fn(),
  options: vi.fn(),
  navigate: vi.fn(),
  previewReview: vi.fn(),
  confirmReview: vi.fn(),
}));
vi.mock("./state", () => ({
  createSession: "create",
  inspectSessionCreation: "inspectCreation",
  launchSession: "launch",
  inspectSessionLaunch: "inspectLaunch",
  sessionLaunchOptions: "options",
  previewLaunchReview: "previewReview",
  confirmLaunchReview: "confirmReview",
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: keyof typeof commands) => commands[command],
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => commands.navigate }));
vi.mock("../lib/runtime", () => ({ runtime: { runPromise: async () => "new-operation" } }));
import { SessionLauncher } from "./SessionLauncher";
const decodeReview = Schema.decodeSync(Contracts.ManagedLaunchReview);

const environmentId = EnvironmentId.make("computer");
const storageKey = "deckhand:create:computer:installation:source";
const request = Schema.decodeSync(Contracts.ManagedCreateInput)({
  operationKey: "saved-operation",
  installationID: "installation",
  workspaceID: "source",
  generation: 1,
  revision: "reviewed-revision",
  repositoryID: "app",
  branch: "fix/saved",
  repositoryRefs: { app: "old-commit", api: "origin/release" },
  setup: true,
  start: false,
  title: "Saved feature",
  objective: "Read the checkout",
  modelSelection: { instanceId: "codex", model: "gpt-test" },
  runtimeMode: "approval-required",
});
const resource: Contracts.IntegrationView["resources"][number] = {
  workspaceID: "source",
  generation: 1,
  revision: "reviewed-revision",
  available: true,
  workspace: {
    id: "source",
    name: "Project",
    file: "/fixture/project.toml",
    state: "ready",
    definitionChanged: false,
    issues: [],
    services: [],
    repos: ["app", "api"].map((id) => ({
      id,
      path: `/fixture/${id}`,
      branch: "main",
      dirty: false,
      changedFiles: 0,
      ahead: 0,
      behind: 0,
    })),
  },
};
const creationRecord = (
  state: Contracts.ManagedCreateRecord["state"],
  overrides: Partial<Contracts.ManagedCreateRecord> = {},
): Contracts.ManagedCreateRecord => ({
  operationKey: request.operationKey,
  laneOperationKey: "lane-operation",
  launchOperationKey: "launch-operation",
  laneID: null,
  receipt: null,
  launch: null,
  error: null,
  state,
  ...overrides,
});
const acceptedLaunch = Schema.decodeSync(Contracts.ManagedLaunchRecord)({
  operationKey: "launch-operation",
  projectId: "project",
  threadId: "thread",
  featureId: "feature",
  sessionId: "session",
  checkoutId: "checkout",
  state: "accepted",
});
const success = <T,>(value: T) => ({ _tag: "Success", value });
const failure = (reason: string) => ({
  _tag: "Failure",
  cause: Cause.fail(new Contracts.DeckhandRpcError({ reason })),
});
let root: Root;
let container: HTMLDivElement;
const onLane = vi.fn();
const onPending = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  commands.options.mockResolvedValue(
    success([
      { instanceId: "codex", label: "Codex", models: [{ id: "gpt-test", label: "Test model" }] },
    ]),
  );
  commands.create.mockResolvedValue(success(creationRecord("unknown_outcome")));
  commands.inspectCreation.mockResolvedValue(
    success(creationRecord("ready", { laneID: "created-lane" })),
  );
  commands.launch.mockResolvedValue(success(acceptedLaunch));
  commands.navigate.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(current = resource, creation = true, visible = true) {
  await act(async () =>
    root.render(
      <SessionLauncher
        environmentId={environmentId}
        installationID="installation"
        resource={current}
        enabled
        {...(creation ? { creation: { visible, onClose: vi.fn(), onLane, onPending } } : {})}
      />,
    ),
  );
}
function button(label: string) {
  const element = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(element, label).toBeDefined();
  return element!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function change(label: string, value: string) {
  if (label === "Provider account") {
    const control = [...container.querySelectorAll<HTMLButtonElement>("button[aria-label]")].find(
      (item) => item.getAttribute("aria-label")?.endsWith(` · ${value}`),
    );
    expect(control).toBeDefined();
    await act(async () => control!.click());
    return;
  }
  const item = [...container.querySelectorAll("label")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(item, label).toBeDefined();
  const control = document.getElementById(item!.htmlFor)! as HTMLInputElement;
  const prototype =
    control instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : control instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, value);
    control.dispatchEvent(
      new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}
function save() {
  localStorage.setItem(storageKey, JSON.stringify(request));
}

it("saves the complete reviewed request before dispatch and opens only the accepted conversation", async () => {
  commands.create.mockImplementation(async ({ input }) => {
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(input);
    expect(input).toMatchObject({
      repositoryID: "app",
      branch: "fix/new",
      repositoryRefs: { api: "origin/release" },
      setup: true,
      start: false,
      generation: 1,
      revision: "reviewed-revision",
    });
    return success(creationRecord("accepted", { launch: acceptedLaunch, laneID: "created-lane" }));
  });
  await render();
  await change("New lane branch", "fix/new");
  await change("api", "origin/release");
  await change("Provider account", "codex");
  await change("Model", "gpt-test");
  await change("Feature title", "New feature");
  await change("Objective", "Read the checkout");
  await click("Create lane and launch agent");
  expect(commands.create).toHaveBeenCalledTimes(1);
  expect(commands.launch).not.toHaveBeenCalled();
  expect(commands.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: "thread" },
  });
  expect(localStorage.getItem(storageKey)).toBeNull();
});

it("restores a saved request after a changed generation and keeps inspection read-only", async () => {
  save();
  await render({ ...resource, generation: 9, revision: "new-revision" }, true, false);
  expect(
    container.querySelector('section[aria-label="Saved feature request"] h3')?.textContent,
  ).toBe("Saved feature");
  expect(commands.create).not.toHaveBeenCalled();
  await click("Check result");
  expect(commands.inspectCreation).toHaveBeenCalledWith({
    environmentId,
    input: { operationKey: request.operationKey },
  });
  expect(commands.create).not.toHaveBeenCalled();
  expect(commands.navigate).not.toHaveBeenCalled();
  await render({ ...resource, generation: 9, revision: "new-revision" }, true, true);
  await click("Continue saved request");
  expect(commands.create).toHaveBeenCalledWith({ environmentId, input: request });
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(request);
});

it("keeps uncertain creation identity through a reload and prevents editing into another request", async () => {
  save();
  commands.inspectCreation.mockResolvedValue(
    success(creationRecord("unknown_outcome", { laneID: "uncertain-lane" })),
  );
  await render();
  await click("Check result");
  expect(container.textContent).toContain("result is uncertain");
  expect(container.textContent).not.toContain("Start another feature");
  expect(container.textContent).not.toContain("Edit refused request");
  await act(async () => {
    root.unmount();
    root = createRoot(container);
  });
  await render();
  await click("Continue saved request");
  expect(commands.create).toHaveBeenCalledWith({ environmentId, input: request });
});

it("retains a failed lane and shows its setup failure without allowing another native creation on retry", async () => {
  save();
  commands.inspectCreation.mockResolvedValue(
    success(
      creationRecord("failed", {
        laneID: "kept-lane",
        error: "setup_failed",
        receipt: {
          id: "native",
          argumentHash: "a".repeat(64),
          createdAt: "2026-10-03T12:00:00Z",
          updatedAt: "2026-10-03T12:00:00Z",
          operationKey: "lane-operation",
          method: "lane.create",
          workspaceID: "source",
          generation: 1,
          state: "succeeded",
          result: { createdWorkspaceID: "kept-lane" },
          error: null,
        },
      }),
    ),
  );
  await render();
  await click("Check result");
  await click("Review created lane");
  expect(onLane).toHaveBeenCalledWith("kept-lane");
  expect(container.textContent).toContain("setup_failed");
  expect(button("Continue saved request").disabled).toBe(true);
  expect(commands.create).not.toHaveBeenCalled();
  expect(localStorage.getItem(storageKey)).not.toBeNull();
  await click("Start another feature");
  expect(localStorage.getItem(storageKey)).toBeNull();
  expect(commands.create).not.toHaveBeenCalled();
});

it("allows edits only when a definite refusal is followed by confirmation that no creation intent exists", async () => {
  save();
  commands.create.mockResolvedValue(failure("stale_context"));
  await render();
  await click("Continue saved request");
  expect(container.textContent).not.toContain("Edit refused request");
  expect(localStorage.getItem(storageKey)).not.toBeNull();
  commands.inspectCreation.mockResolvedValue(failure("missing"));
  await click("Continue saved request");
  await click("Edit refused request");
  expect(localStorage.getItem(storageKey)).toBeNull();
});

it("refuses transport dispatch when storage is corrupt or cannot save the new operation", async () => {
  localStorage.setItem(storageKey, "not json");
  await render();
  expect(button("Create lane and launch agent").disabled).toBe(true);
  expect(commands.create).not.toHaveBeenCalled();
  await act(async () => {
    root.unmount();
    root = createRoot(container);
  });
  localStorage.clear();
  await render();
  await change("New lane branch", "fix/new");
  await change("Provider account", "codex");
  await change("Model", "gpt-test");
  await change("Feature title", "Feature");
  await change("Objective", "Read");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage full");
  });
  await click("Create lane and launch agent");
  expect(commands.create).not.toHaveBeenCalled();
  expect(container.textContent).toContain("could not be saved or sent");
});

it("launches an agent task in the selected existing context without native lane creation", async () => {
  const launchKey = "deckhand:launch:computer:installation:source:1";
  commands.launch.mockImplementation(async ({ input }) => {
    expect(JSON.parse(localStorage.getItem(launchKey)!)).toEqual(input);
    expect(input).toMatchObject({
      operationKey: "new-operation",
      installationID: "installation",
      workspaceID: "source",
      generation: 1,
      revision: "reviewed-revision",
      repositoryID: "app",
      title: "Investigate payment retries",
      objective: "Inspect the retry flow and propose a focused fix.",
      modelSelection: { instanceId: "codex", model: "gpt-test" },
      runtimeMode: "approval-required",
    });
    expect(input).not.toHaveProperty("branch");
    return success(acceptedLaunch);
  });
  await render(resource, false);
  await click("＋ New session");
  expect(container.textContent).not.toContain("Feature title");
  expect(container.textContent).not.toContain("Objective");
  await change("Provider account", "codex");
  await change("Model", "gpt-test");
  await change("Agent task", "Investigate payment retries");
  await change("Instructions", "Inspect the retry flow and propose a focused fix.");
  await click("Start session");
  expect(commands.launch).toHaveBeenCalledTimes(1);
  expect(commands.create).not.toHaveBeenCalled();
  expect(commands.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: "thread" },
  });
  expect(localStorage.getItem(launchKey)).toBeNull();
});

it("preserves existing-checkout launch behavior with no native creation", async () => {
  localStorage.setItem("deckhand:launch:computer:installation:source:1", JSON.stringify(request));
  await render(resource, false);
  await click("Retry saved launch");
  expect(commands.launch).toHaveBeenCalledTimes(1);
  expect(commands.create).not.toHaveBeenCalled();
  expect(commands.navigate).toHaveBeenCalledTimes(1);
});

it("checking an accepted request does not start or navigate a provider until the user opens it", async () => {
  save();
  commands.inspectCreation.mockResolvedValue(
    success(creationRecord("accepted", { laneID: "created-lane", launch: acceptedLaunch })),
  );
  await render();
  await click("Check result");
  expect(commands.create).not.toHaveBeenCalled();
  expect(commands.launch).not.toHaveBeenCalled();
  expect(commands.navigate).not.toHaveBeenCalled();
  expect(localStorage.getItem(storageKey)).toBeNull();
  await click("Open conversation");
  expect(commands.navigate).toHaveBeenCalledTimes(1);
});

it("can reload provider choices after a transient failure without changing the saved intent", async () => {
  save();
  commands.options.mockResolvedValueOnce(failure("unavailable_provider"));
  await render();
  expect(container.textContent).toContain("could not be loaded");
  await click("Reload providers");
  expect(container.textContent).not.toContain("could not be loaded");
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(request);
  expect(commands.create).not.toHaveBeenCalled();
});

it("shows a fresh context for explicit confirmation and retries only the immutable saved request", async () => {
  save();
  const review = decodeReview({
    operationKey: request.operationKey,
    kind: "creation",
    installationID: "installation",
    workspaceID: "created-lane",
    generation: 7,
    revision: "new-revision",
    repositories: [
      {
        repositoryID: "app",
        checkout: {
          physicalId: "physical",
          repositoryPhysicalId: "repo",
          root: "/fixture/created/app",
          commonDirectory: "/fixture/app/.git",
          gitDirectory: "/fixture/app/.git/worktrees/created",
          branch: "fix/saved",
          commit: "abc123",
          remotes: [],
        },
      },
    ],
  });
  commands.previewReview.mockResolvedValue(success(review));
  commands.confirmReview.mockResolvedValue(success(review));
  await render();
  await click("Review latest context");
  expect(container.textContent).toContain("/fixture/created/app");
  expect(button("Continue saved request").disabled).toBe(true);
  expect(commands.create).not.toHaveBeenCalled();
  expect(commands.confirmReview).not.toHaveBeenCalled();
  await click("Confirm reviewed context");
  expect(commands.confirmReview).toHaveBeenCalledWith({ environmentId, input: review });
  expect(commands.create).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(request);
  await click("Continue saved request");
  expect(commands.create).toHaveBeenCalledWith({ environmentId, input: request });
});
