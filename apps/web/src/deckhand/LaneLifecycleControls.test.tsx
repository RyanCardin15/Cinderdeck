// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId } from "@t3tools/contracts";
import type { IntegrationView, OperationRecord } from "@t3tools/contracts/deckhand/rpc";
import type {
  IntegrationOperationInput,
  IntegrationOperationReceipt,
} from "@t3tools/contracts/deckhand/integration";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({
  submit: vi.fn(),
  inspect: vi.fn(),
  recent: vi.fn(),
  uuid: vi.fn(),
}));
vi.mock("./state", () => ({
  submitOperation: "submit",
  inspectOperation: "inspect",
  recentOperations: "recent",
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: "submit" | "inspect" | "recent") => commands[command],
}));
vi.mock("../lib/runtime", () => ({ runtime: { runPromise: commands.uuid } }));
import { LaneLifecycleControls } from "./LaneLifecycleControls";

const environmentId = EnvironmentId.make("computer");
const capabilities = [
  "operations.lane.setup",
  "operations.lane.release",
  "operations.lane.remove",
  "operations.receipts",
  "operations.receipts.wait",
];
const resource = (id = "lane-a", generation = 7): IntegrationView["resources"][number] => ({
  workspaceID: id,
  generation,
  revision: `${id}-revision`,
  available: true,
  workspace: {
    id,
    name: "Project",
    file: `/fixture/${id}.toml`,
    state: "ready",
    definitionChanged: false,
    issues: [],
    services: [],
    repos: [],
    lane: {
      sourceStackID: "primary",
      name: id === "lane-a" ? "Retry" : "Review",
      directory: `/fixture/${id}`,
      createdAt: "2026-10-04T00:00:00Z",
      ports: {},
    },
  },
});
const input = (
  method: IntegrationOperationInput["method"] = "lane.setup",
): IntegrationOperationInput => ({
  operationKey: "saved-key",
  installationID: "installation",
  workspaceID: "lane-a",
  generation: 7,
  revision: "lane-a-revision",
  method,
  arguments: { workspace: "lane-a" },
});
const receipt = (
  request: IntegrationOperationInput,
  state: IntegrationOperationReceipt["state"] = "succeeded",
  result: IntegrationOperationReceipt["result"] = undefined,
): IntegrationOperationReceipt => ({
  id: "receipt",
  operationKey: request.operationKey,
  argumentHash: "a".repeat(64),
  workspaceID: request.workspaceID,
  generation: request.generation,
  method: request.method,
  state,
  createdAt: "2026-10-04T00:00:00Z",
  updatedAt: "2026-10-04T00:00:00Z",
  ...(result ? { result } : {}),
});
const record = (
  request = input(),
  saved: IntegrationOperationReceipt | null = null,
): OperationRecord => ({
  input: request,
  receipt: saved,
  refused: false,
  error: null,
  createdAt: "2026-10-04T00:00:00Z",
});
let host: HTMLDivElement;
let root: Root;
let props: Parameters<typeof LaneLifecycleControls>[0];
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  commands.uuid.mockResolvedValue("new-key");
  commands.recent.mockResolvedValue({ _tag: "Success", value: [] });
  commands.submit.mockImplementation(
    async ({ input: request }: { input: IntegrationOperationInput }) => ({
      _tag: "Success",
      value: receipt(
        request,
        "succeeded",
        request.method === "lane.setup"
          ? { setup: { status: "succeeded", updatedAt: "2026-10-04T00:00:00Z" } }
          : { released: request.workspaceID },
      ),
    }),
  );
  commands.inspect.mockResolvedValue({ _tag: "Failure" });
  props = {
    environmentId,
    installationID: "installation",
    resource: resource(),
    capabilities,
    enabled: true,
    onPending: vi.fn(),
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const render = async () => {
  await act(async () => root.render(<LaneLifecycleControls {...props} />));
};
const button = (text: string) => {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!found) throw new Error(`Button not found: ${text}`);
  return found;
};
const click = async (text: string) => {
  await act(async () => button(text).click());
};
const change = async (selector: string) => {
  await act(async () => (host.querySelector(selector) as HTMLInputElement).click());
};

it("pins setup to the exact selected lane and reports a failed setup even when the receipt succeeded", async () => {
  commands.submit.mockImplementation(
    async ({ input: request }: { input: IntegrationOperationInput }) => ({
      _tag: "Success",
      value: receipt(request, "succeeded", {
        setup: {
          status: "failed",
          detail: "Dependency check failed",
          updatedAt: "2026-10-04T00:00:00Z",
        },
      }),
    }),
  );
  await render();
  await click("Run setup");
  expect(commands.submit).toHaveBeenCalledWith({
    environmentId,
    input: { ...input(), operationKey: "new-key" },
  });
  expect(host.textContent).toContain("Setup failed");
  expect(host.textContent).toContain("Dependency check failed");
  expect(host.textContent).not.toContain("Setup succeeded");
  expect(props.onPending).toHaveBeenLastCalledWith(false);
});

it("defaults removal to preserved worktrees and requires explicit choices for managed and ignored file deletion", async () => {
  await render();
  await click("Remove lane…");
  expect((host.querySelector('input[type="radio"]') as HTMLInputElement).checked).toBe(true);
  await click("Remove Retry");
  expect(commands.submit.mock.calls[0]?.[0].input).toEqual({
    ...input("lane.release"),
    operationKey: "new-key",
  });
  await click("Done");
  commands.uuid.mockResolvedValue("delete-key");
  await click("Remove lane…");
  const radios = host.querySelectorAll('input[type="radio"]');
  await act(async () => (radios[1] as HTMLInputElement).click());
  expect((host.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
  await change('input[type="checkbox"]');
  await click("Remove Retry");
  expect(commands.submit.mock.calls[1]?.[0].input).toEqual({
    ...input("lane.remove"),
    operationKey: "delete-key",
    arguments: { workspace: "lane-a", discard_ignored: true },
  });
  expect(host.textContent).toContain("Lane removed from Cinderdeck");
  expect(
    commands.submit.mock.calls.every(
      ([call]) =>
        !call.input.arguments.force &&
        !call.input.arguments.delete_logs &&
        !call.input.arguments.force_teardown,
    ),
  ).toBe(true);
});

it("never admits stale, unsupported, changed-definition or primary-checkout lifecycle actions", async () => {
  props = { ...props, enabled: false };
  await render();
  await click("Run setup");
  expect(button("Remove lane…").disabled).toBe(true);
  props = { ...props, enabled: true, capabilities: ["operations.receipts"] };
  await render();
  expect(button("Run setup").disabled).toBe(true);
  props = {
    ...props,
    capabilities,
    resource: { ...resource(), workspace: { ...resource().workspace!, definitionChanged: true } },
  };
  await render();
  expect(button("Run setup").disabled).toBe(true);
  props = {
    ...props,
    resource: {
      ...resource(),
      workspace: {
        id: "lane-a",
        name: "Project",
        file: "/fixture/primary.toml",
        state: "ready",
        definitionChanged: false,
        issues: [],
        services: [],
        repos: [],
      },
    },
  };
  await render();
  expect(button("Run setup").disabled).toBe(true);
  expect(host.textContent).toContain("Select a named lane");
  expect(commands.submit).not.toHaveBeenCalled();
});

it("recovers the original receipt after a lost reply without resubmitting or changing its scope", async () => {
  commands.submit.mockResolvedValue({ _tag: "Failure" });
  await render();
  await click("Run setup");
  expect(host.textContent).toContain("Setup outcome unknown");
  expect(button("Run setup").disabled).toBe(true);
  const original = commands.submit.mock.calls[0]?.[0].input as IntegrationOperationInput;
  props = {
    ...props,
    enabled: false,
    resource: { ...resource("lane-a", 8), revision: "new-revision" },
  };
  commands.inspect.mockResolvedValue({
    _tag: "Success",
    value: receipt(original, "succeeded", {
      setup: { status: "succeeded", updatedAt: "2026-10-04T00:00:00Z" },
    }),
  });
  await render();
  expect(host.textContent).not.toContain("Send saved request");
  await click("Check result");
  expect(commands.inspect).toHaveBeenCalledWith({
    environmentId,
    input: { operationKey: "new-key", waitMs: 25000 },
  });
  expect(commands.submit).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Setup succeeded");
});

it("restores a saved request from the server journal and preserves an authoritative dirty refusal", async () => {
  const original = input("lane.remove");
  commands.recent.mockResolvedValue({
    _tag: "Success",
    value: [record(input("services.start")), record(original)],
  });
  await render();
  expect(host.textContent).toContain("Lane removal outcome unknown");
  expect(commands.submit).not.toHaveBeenCalled();
  commands.inspect.mockResolvedValue({
    _tag: "Success",
    value: {
      ...receipt(original, "failed"),
      error: { code: "dirty", message: "The worktree has changed source files." },
    },
  });
  await click("Check result");
  expect(host.textContent).toContain("Lane removal failed");
  expect(host.textContent).toContain("The worktree has changed source files.");
  expect(props.onPending).toHaveBeenLastCalledWith(false);
});

it("keeps a late lane-A result out of lane B and restores it when the user returns", async () => {
  let resolve!: (value: { _tag: "Success"; value: IntegrationOperationReceipt }) => void;
  commands.submit.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render();
  await click("Run setup");
  const original = commands.submit.mock.calls[0]?.[0].input as IntegrationOperationInput;
  props = { ...props, resource: resource("lane-b") };
  await render();
  await act(async () =>
    resolve({
      _tag: "Success",
      value: receipt(original, "succeeded", {
        setup: {
          status: "failed",
          detail: "Retry lane check failed",
          updatedAt: "2026-10-04T00:00:00Z",
        },
      }),
    }),
  );
  expect(host.textContent).not.toContain("Retry lane check failed");
  expect(button("Run setup").disabled).toBe(false);
  props = { ...props, resource: resource() };
  await render();
  expect(host.textContent).toContain("Retry lane check failed");
  expect(commands.submit).toHaveBeenCalledTimes(1);
});
