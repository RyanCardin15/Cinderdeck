// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId } from "@cinderdeck/contracts";
import type { IntegrationView } from "@cinderdeck/contracts/deckhand/rpc";
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
  useAtomCommand: (key: "submit" | "inspect" | "recent") => commands[key],
}));
vi.mock("../lib/runtime", () => ({ runtime: { runPromise: commands.uuid } }));
import { LaneName } from "./LaneName";
let host: HTMLDivElement, root: Root;
const resource = {
  workspaceID: "lane",
  generation: 7,
  revision: "revision",
  available: true,
  workspace: {
    lane: { name: "feature/search" },
  },
} as IntegrationView["resources"][number];
const render = async (enabled = true) =>
  act(async () =>
    root.render(
      <LaneName
        environmentId={EnvironmentId.make("computer")}
        installationID="installation"
        resource={resource}
        enabled={enabled}
      />,
    ),
  );
const click = async (label: string) =>
  act(async () => {
    const button = Array.from(host.querySelectorAll("button")).find(
      (node) => node.textContent === label,
    );
    if (!button) throw new Error(`Missing ${label}`);
    button.click();
  });
const type = async (value: string) =>
  act(async () => {
    const input = host.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
beforeEach(() => {
  vi.clearAllMocks();
  commands.uuid.mockResolvedValue("rename-key");
  commands.submit.mockResolvedValue({ _tag: "Success", value: { state: "succeeded" } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
it("edits with a click and Enter, submitting the selected lane and observed name", async () => {
  await render();
  await click("feature/search");
  await type("Search polish");
  await act(async () =>
    host
      .querySelector("input")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(commands.submit).toHaveBeenCalledWith({
    environmentId: "computer",
    input: {
      operationKey: "rename-key",
      installationID: "installation",
      workspaceID: "lane",
      generation: 7,
      revision: "revision",
      method: "lane.update",
      arguments: { workspace: "lane", name: "Search polish", expectedName: "feature/search" },
    },
  });
  expect(host.textContent).toBe("Search polish");
});
it("Escape cancels and stale lanes cannot begin an edit", async () => {
  await render();
  await click("feature/search");
  await type("Discard");
  await act(async () =>
    host
      .querySelector("input")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(commands.submit).not.toHaveBeenCalled();
  expect(host.textContent).toBe("feature/search");
  await render(false);
  expect(host.querySelector("button")!.disabled).toBe(true);
});
it("reconciles an unresolved receipt without repeating the rename", async () => {
  commands.submit.mockResolvedValue({ _tag: "Success", value: { state: "running" } });
  commands.inspect.mockResolvedValue({ _tag: "Success", value: { state: "succeeded" } });
  await render();
  await click("feature/search");
  await type("Search polish");
  await click("Save");
  await click("Check rename");
  expect(commands.submit).toHaveBeenCalledTimes(1);
  expect(commands.inspect).toHaveBeenCalledWith({
    environmentId: "computer",
    input: { operationKey: "rename-key", waitMs: 25000 },
  });
  expect(host.textContent).toBe("Search polish");
});
