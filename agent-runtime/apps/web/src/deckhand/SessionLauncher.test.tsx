// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProviderInstanceId } from "@cinderdeck/contracts";
import * as Contracts from "@cinderdeck/contracts/deckhand/rpc";
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
  refresh: vi.fn(),
  defaultModel: null as import("@cinderdeck/contracts").ModelSelection | null,
  planEnabled: false,
  nextOperation: 0,
}));
vi.mock("./state", () => ({
  createSession: "create",
  inspectSessionCreation: "inspectCreation",
  launchSession: "launch",
  inspectSessionLaunch: "inspectLaunch",
  sessionLaunchOptions: "options",
  previewLaunchReview: "previewReview",
  confirmLaunchReview: "confirmReview",
  refreshWorkspaces: "refresh",
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: keyof typeof commands) => commands[command],
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => commands.navigate,
  Link: ({ children }: { children: import("react").ReactNode }) => <a>{children}</a>,
}));
vi.mock("../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({
    ...DEFAULT_SERVER_SETTINGS,
    defaultModelSelection: commands.defaultModel,
    planModeEnabled: commands.planEnabled,
  }),
}));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: "config" }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () =>
    new Map([
      [
        "computer",
        {
          providers: [
            {
              instanceId: "codex",
              driver: "codex",
              enabled: true,
              installed: true,
              status: "ready",
              models: [{ slug: "gpt-test", name: "Test model", isDefault: true }],
              auth: { status: "authenticated" },
            },
          ],
        },
      ],
    ]),
}));
vi.mock("../state/entities", () => ({ readProjects: () => [] }));
vi.mock("../lib/runtime", () => ({
  runtime: {
    runPromise: async () =>
      ++commands.nextOperation === 1 ? "new-operation" : `new-operation-${commands.nextOperation}`,
  },
}));
import { SessionLauncher } from "./SessionLauncher";
import { useChatDefaultsStore } from "./chatDefaults";
import { useComposerDraftStore } from "../composerDraftStore";
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
  commands.defaultModel = null;
  commands.planEnabled = false;
  commands.nextOperation = 0;
  useChatDefaultsStore.setState({ preferences: {}, lastModes: {}, repositories: {} });
  useComposerDraftStore.setState({
    stickyActiveProvider: null,
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
  });
  commands.options.mockResolvedValue(
    success([
      {
        instanceId: "codex",
        label: "Codex",
        supportsReadOnly: true,
        models: [{ id: "gpt-test", label: "Test model" }],
      },
    ]),
  );
  commands.create.mockResolvedValue(success(creationRecord("unknown_outcome")));
  commands.inspectCreation.mockResolvedValue(
    success(creationRecord("ready", { laneID: "created-lane" })),
  );
  commands.launch.mockResolvedValue(success(acceptedLaunch));
  commands.navigate.mockResolvedValue(undefined);
  commands.refresh.mockResolvedValue(success(undefined));
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
async function render(current = resource, creation = true, visible = true, enabled = true) {
  await act(async () =>
    root.render(
      <SessionLauncher
        environmentId={environmentId}
        installationID="installation"
        resource={current}
        enabled={enabled}
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

it("opens an empty chat in the selected checkout without asking for a task or native creation", async () => {
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
      title: "New chat",
      objective: "",
      deferStart: true,
      modelSelection: { instanceId: "codex", model: "gpt-test" },
      runtimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
      interactionMode: "default",
    });
    expect(input).not.toHaveProperty("branch");
    return success({ ...acceptedLaunch, operationKey: input.operationKey });
  });
  await render(resource, false);
  expect(container.querySelector("textarea")).toBeNull();
  expect(container.textContent).not.toContain("Agent task");
  await click("+ New chat");
  expect(commands.launch).toHaveBeenCalledTimes(1);
  expect(commands.create).not.toHaveBeenCalled();
  expect(commands.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: "thread" },
  });
  expect(localStorage.getItem(launchKey)).toBeNull();
});

it("opens a folder workspace despite service warnings and changed running service settings", async () => {
  await render(
    {
      ...resource,
      workspace: {
        ...resource.workspace!,
        root: "/fixture/suite",
        definitionChanged: true,
        issues: ["warning: api hard-codes localhost:3000"],
        repos: [
          {
            ...resource.workspace!.repos[0]!,
            id: "workspace",
            path: "/fixture/suite",
            branch: "Not a Git repository",
          },
        ],
      },
    },
    false,
  );
  expect(button("+ New chat").disabled).toBe(false);
  await click("+ New chat");
  expect(commands.launch).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({ repositoryID: "workspace", deferStart: true }),
  });
});

it("explains a workspace error and refreshes without dispatching a chat", async () => {
  await render(
    { ...resource, workspace: { ...resource.workspace!, issues: ["error: Folder is missing"] } },
    false,
  );
  expect(button("+ New chat").disabled).toBe(true);
  expect(container.textContent).toContain("Workspace settings need attention: Folder is missing");
  expect(container.textContent).not.toContain("Reconnect this checkout");
  await click("Refresh workspaces");
  expect(commands.refresh).toHaveBeenCalledWith({ environmentId, input: {} });
  expect(commands.launch).not.toHaveBeenCalled();
});

it("offers refresh for a computer connection and enables chat after current context arrives", async () => {
  await render(resource, false, true, false);
  expect(button("+ New chat").disabled).toBe(true);
  expect(container.textContent).toContain("connection to this computer");
  await click("Refresh workspaces");
  await render(resource, false);
  expect(button("+ New chat").disabled).toBe(false);
  await click("+ New chat");
  expect(commands.launch).toHaveBeenCalledTimes(1);
});

it("opens a sidebar lane session once under StrictMode with its first configured folder despite an old folder preference", async () => {
  const lane = {
    ...resource,
    workspaceID: "source--feature",
    generation: 7,
    revision: "lane-revision",
  };
  useChatDefaultsStore
    .getState()
    .rememberRepository("computer:installation:source--feature", "api");
  const onOpened = vi.fn();
  const launcher = () => (
    <StrictMode>
      <SessionLauncher
        environmentId={environmentId}
        installationID="installation"
        resource={lane}
        enabled
        compact
        autoOpen
        onOpened={onOpened}
      />
    </StrictMode>
  );
  await act(async () => root.render(launcher()));
  expect(commands.launch).toHaveBeenCalledTimes(1);
  expect(commands.launch).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({
      workspaceID: "source--feature",
      generation: 7,
      revision: "lane-revision",
      repositoryID: "app",
      deferStart: true,
      objective: "",
    }),
  });
  expect(commands.create).not.toHaveBeenCalled();
  expect(onOpened).toHaveBeenCalledTimes(1);
  expect(commands.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: "thread" },
  });
  await act(async () => root.render(launcher()));
  expect(commands.launch).toHaveBeenCalledTimes(1);
});

it("keeps an uncertain sidebar launch available for explicit retry with the original key", async () => {
  commands.launch.mockResolvedValue(success({ ...acceptedLaunch, state: "unknown_outcome" }));
  const onOpened = vi.fn();
  const launcher = () => (
    <SessionLauncher
      environmentId={environmentId}
      installationID="installation"
      resource={resource}
      enabled
      compact
      autoOpen
      onOpened={onOpened}
    />
  );
  await act(async () => root.render(launcher()));
  const first = commands.launch.mock.calls[0]![0];
  expect(commands.launch).toHaveBeenCalledTimes(1);
  expect(onOpened).not.toHaveBeenCalled();
  expect(commands.navigate).not.toHaveBeenCalled();
  await act(async () => root.render(launcher()));
  expect(commands.launch).toHaveBeenCalledTimes(1);
  commands.launch.mockResolvedValue(success(acceptedLaunch));
  await click("Retry saved chat");
  expect(commands.launch).toHaveBeenLastCalledWith(first);
  expect(onOpened).toHaveBeenCalledTimes(1);
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

it("remembers the provider, model and reasoning without requiring launcher fields", async () => {
  const remembered = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-test",
    options: [{ id: "reasoning_effort", value: "high" }],
  };
  useComposerDraftStore.getState().setStickyModelSelection(remembered);
  useChatDefaultsStore.getState().rememberModes(environmentId, { runtimeMode: "full-access" });
  await render(resource, false);
  await click("+ New chat");
  expect(commands.launch.mock.calls[0]![0].input).toMatchObject({
    modelSelection: remembered,
    runtimeMode: "full-access",
  });
});

it("replays the exact saved empty chat after an uncertain transport result", async () => {
  commands.launch.mockResolvedValueOnce(failure("launch_failed"));
  await render(resource, false);
  await click("+ New chat");
  // Recover a request made before the folder selector was removed.
  const original = { ...commands.launch.mock.calls[0]![0].input, repositoryID: "api" };
  localStorage.setItem("deckhand:launch:computer:installation:source:1", JSON.stringify(original));
  expect(
    JSON.parse(localStorage.getItem("deckhand:launch:computer:installation:source:1")!),
  ).toEqual(original);
  await act(async () => root.unmount());
  root = createRoot(container);
  await render(resource, false);
  await click("Retry saved chat");
  expect(commands.launch.mock.calls[1]![0].input).toEqual(original);
  expect(commands.navigate).toHaveBeenCalledTimes(1);
});

it("blocks a fresh chat when storage cannot save its recovery key", async () => {
  await render(resource, false);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage full");
  });
  await click("+ New chat");
  expect(commands.launch).not.toHaveBeenCalled();
});

it("uses a pinned model and reasoning instead of remembered model options", async () => {
  useComposerDraftStore.getState().setStickyModelSelection({
    instanceId: ProviderInstanceId.make("codex"),
    model: "old-model",
    options: [{ id: "reasoning_effort", value: "low" }],
  });
  commands.defaultModel = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-test",
    options: [{ id: "reasoning_effort", value: "high" }],
  };
  await render(resource, false);
  await click("+ New chat");
  expect(commands.launch.mock.calls[0]![0].input.modelSelection).toEqual(commands.defaultModel);
});

it("keeps read-only analysis available as an optional chat action", async () => {
  await render(resource, false);
  await click("Open read-only analysis chat");
  expect(commands.launch.mock.calls[0]![0].input).toMatchObject({
    access: "read_only",
    deferStart: true,
    objective: "",
  });
});

it("can open another chat after navigation without reopening the previous conversation", async () => {
  await render(resource, false);
  await click("+ New chat");
  await click("+ New chat");
  expect(commands.launch).toHaveBeenCalledTimes(2);
  expect(commands.launch.mock.calls[0]![0].input.operationKey).not.toBe(
    commands.launch.mock.calls[1]![0].input.operationKey,
  );
});

it("uses fixed Plan and permission defaults when mode memory is disabled", async () => {
  commands.planEnabled = true;
  useChatDefaultsStore
    .getState()
    .rememberModes(environmentId, { runtimeMode: "approval-required", interactionMode: "default" });
  useChatDefaultsStore
    .getState()
    .setPreferences(environmentId, { rememberModes: false, interactionMode: "plan" });
  await render(resource, false);
  await click("+ New chat");
  expect(commands.launch.mock.calls[0]![0].input).toMatchObject({
    runtimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
    interactionMode: "plan",
  });
});

it("checking an interrupted chat opens its accepted result only on request", async () => {
  commands.launch.mockResolvedValueOnce(failure("launch_failed"));
  commands.inspectLaunch.mockResolvedValue(success(acceptedLaunch));
  await render(resource, false);
  await click("+ New chat");
  await click("Check result");
  expect(commands.navigate).not.toHaveBeenCalled();
  await click("Open chat");
  expect(commands.navigate).toHaveBeenCalledTimes(1);
  expect(commands.launch).toHaveBeenCalledTimes(1);
});

it("confirms a missing recovery result before permitting another new chat", async () => {
  commands.launch.mockResolvedValueOnce(failure("stale_context"));
  commands.inspectLaunch.mockResolvedValue(failure("missing"));
  await render(resource, false);
  await click("+ New chat");
  await click("Check result");
  expect(localStorage.getItem("deckhand:launch:computer:installation:source:1")).toBeNull();
  await click("+ New chat");
  expect(commands.launch.mock.calls[1]![0].input.operationKey).not.toBe(
    commands.launch.mock.calls[0]![0].input.operationKey,
  );
});
it("opens the workspace code review skill in a dedicated session using chat defaults", async () => {
  await act(async () =>
    root.render(
      <SessionLauncher
        environmentId={EnvironmentId.make("computer")}
        installationID="installation"
        resource={resource}
        enabled
        compact
        editReviewSkill
        autoOpen
      />,
    ),
  );
  expect(commands.launch).toHaveBeenCalledTimes(1);
  const input = commands.launch.mock.calls[0]![0].input;
  expect(input.title).toBe("Code Review Skill");
  expect(input.deferStart).toBe(false);
  expect(input.editReviewSkill).toBe(true);
  expect(input.objective).toContain("/fixture/app/.cinderdeck/skills/code-review/SKILL.md");
  expect(input.objective).toContain("attached Code Review Skill");
  expect(input.objective).not.toContain("Review the committed changes against");
  expect(input.modelSelection).toMatchObject({ instanceId: "codex", model: "gpt-test" });
  expect(commands.navigate).toHaveBeenCalledTimes(1);
});

it("reuses the skill session when a workspace refresh remounts its launcher before navigation settles", async () => {
  commands.launch.mockImplementation(async ({ input }) =>
    success({ ...acceptedLaunch, operationKey: input.operationKey }),
  );
  let finishNavigation!: () => void;
  commands.navigate.mockReturnValue(
    new Promise<void>((resolve) => {
      finishNavigation = resolve;
    }),
  );
  const launcher = (key: string) => (
    <SessionLauncher
      key={key}
      environmentId={environmentId}
      installationID="installation"
      resource={resource}
      enabled
      compact
      editReviewSkill
      autoOpen
    />
  );
  await act(async () => root.render(launcher("first")));
  const first = commands.launch.mock.calls[0]![0];
  expect(
    localStorage.getItem("deckhand:launch:computer:installation:source:1:code-review-skill"),
  ).not.toBeNull();
  await act(async () => root.render(launcher("refreshed")));
  expect(commands.launch).toHaveBeenCalledTimes(2);
  expect(commands.launch.mock.calls[1]![0]).toEqual(first);
  await act(async () => finishNavigation());
  expect(
    localStorage.getItem("deckhand:launch:computer:installation:source:1:code-review-skill"),
  ).toBeNull();
});
