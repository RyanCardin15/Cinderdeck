// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId } from "@cinderdeck/contracts";
import type { RunsOverview } from "@cinderdeck/contracts/deckhand/runsRpc";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const commands = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  logs: vi.fn(),
  submit: vi.fn(),
  other: vi.fn(),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (key: keyof typeof commands) => commands[key],
}));
vi.mock("./runState", () => ({
  listRuns: "list",
  getRun: "get",
  runLogs: "logs",
  runDefinition: "other",
  validateRunDefinition: "other",
}));
vi.mock("./state", () => ({
  workspaceView: vi.fn(),
  submitOperation: "submit",
  inspectOperation: "other",
  recentOperations: "other",
}));
vi.mock("../lib/runtime", () => ({
  runtime: { runPromise: async () => "59b698df-2f05-4c38-9676-aa1fd3c21004" },
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: import("react").ReactNode }) => <a>{children}</a>,
  useSearch: vi.fn(),
  useNavigate: vi.fn(),
}));
vi.mock("./ProductNavigation", () => ({ ProductNavigation: () => null }));
vi.mock("./NativeWorkspaceTools", () => ({ NativeWorkspaceTools: () => null }));
vi.mock("../state/environments", () => ({
  useEnvironments: vi.fn(),
  usePrimaryEnvironmentId: vi.fn(),
}));
import { ServicesRuns } from "./ServicesRuns";
const context = { installationID: "installation", workspaceID: "lane", generation: 7 };
const overview: RunsOverview = {
  revision: "revision",
  storageError: null,
  detailAvailable: true,
  retainedRunCount: 1,
  services: [
    {
      id: "web",
      phase: "stopped",
      status: "Stopped",
      ready: false,
      detail: null,
      port: 3000,
      command: "npm run dev",
      directory: "/fixture/lane",
      dependencies: [],
      sharedFrom: null,
    },
  ],
  tasks: [
    {
      id: "lint",
      name: "Lint app",
      command: "npm run lint",
      directory: "/fixture/lane",
      requiresServices: [],
      timeout: 30,
    },
  ],
  workflows: [{ id: "verify", name: "Verify app", steps: ["lint"], cleanupServices: false }],
  runs: [
    {
      id: "saved",
      workspaceID: "lane",
      name: "Saved verification",
      definitionID: "verify",
      kind: "workflow",
      status: "succeeded",
      actor: "user",
      createdAt: "2026-10-05T00:00:00Z",
      finishedAt: "2026-10-05T00:01:00Z",
      duration: 60,
      detail: null,
      cancelAllowed: false,
      steps: [],
    },
  ],
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  localStorage.clear();
  commands.list.mockResolvedValue({ _tag: "Success", value: overview });
  commands.get.mockResolvedValue({
    _tag: "Success",
    value: { run: overview.runs[0], totalSteps: 0, nextStepOffset: null },
  });
  commands.logs.mockResolvedValue({
    _tag: "Success",
    value: [{ source: "lint", text: "All checks passed" }],
  });
  commands.submit.mockResolvedValue({
    _tag: "Success",
    value: { state: "succeeded", error: null },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
it("keeps service management separate from task definitions and run detail, with lane-scoped restart", async () => {
  await act(async () =>
    root.render(
      <ServicesRuns
        environmentId={EnvironmentId.make("computer")}
        context={context}
        panel="services"
      />,
    ),
  );
  expect(container.textContent).toContain("npm run dev");
  expect(container.textContent).not.toContain("Lint app");
  expect(container.textContent).not.toContain("Saved verification");
  expect(commands.get).not.toHaveBeenCalled();
  expect(commands.logs).not.toHaveBeenCalled();
  const restart = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Restart",
  )!;
  await act(async () => restart.click());
  expect(commands.submit.mock.calls[0]?.[0]).toMatchObject({
    environmentId: "computer",
    input: {
      ...context,
      method: "services.restart",
      arguments: { workspace: "lane", wait: true, timeout: 120 },
    },
  });
});
it("opens task and workflow definitions independently, then loads the selected run and its output", async () => {
  const render = (panel: "tasks" | "workflows" | "runs") =>
    act(async () =>
      root.render(
        <ServicesRuns
          environmentId={EnvironmentId.make("computer")}
          context={context}
          panel={panel}
          initialRunID="saved"
        />,
      ),
    );
  await render("tasks");
  expect(container.textContent).toContain("Lint app");
  expect(container.textContent).not.toContain("Verify app");
  expect(commands.get).not.toHaveBeenCalled();
  await render("workflows");
  expect(container.textContent).toContain("Verify app");
  expect(container.textContent).not.toContain("Lint app");
  await render("runs");
  expect(container.textContent).toContain("Saved verification");
  expect(container.textContent).toContain("All checks passed");
  expect(container.textContent).not.toContain("npm run dev");
  expect(commands.get).toHaveBeenCalledWith({
    environmentId: "computer",
    input: { ...context, runID: "saved", stepOffset: 0, stepLimit: 16 },
  });
});

it("waits for an in-flight service read, reports failure, and refreshes current service status on retry", async () => {
  vi.useFakeTimers();
  try {
    let finish!: (value: { _tag: string }) => void;
    commands.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () =>
      root.render(
        <ServicesRuns
          environmentId={EnvironmentId.make("computer")}
          context={context}
          panel="services"
        />,
      ),
    );
    const refresh = () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Refresh services"]')!;
    await act(async () => {
      refresh().click();
      await vi.advanceTimersByTimeAsync(450);
    });
    expect(commands.list).toHaveBeenCalledOnce();
    expect(refresh().disabled).toBe(true);
    await act(async () => {
      finish({ _tag: "Failure" });
    });
    expect(container.textContent).toContain("Could not refresh services");
    expect(refresh().disabled).toBe(false);
    commands.list.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        ...overview,
        services: [{ ...overview.services[0], phase: "ready", status: "Ready", ready: true }],
      },
    });
    await act(async () => {
      refresh().click();
      await vi.advanceTimersByTimeAsync(450);
    });
    expect(commands.list).toHaveBeenLastCalledWith({ environmentId: "computer", input: context });
    expect(container.textContent).toContain("Service status updated");
    expect(container.textContent).toContain("Ready");
    expect(container.textContent).not.toContain("Could not refresh services");
    expect(container.textContent).not.toContain("Services and run history are unavailable");
    expect(commands.submit).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
