// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { NativeSettingsSnapshot } from "@cinderdeck/contracts";

vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => ({ status: "idle" }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("../components/settings/settingsLayout", () => ({
  SettingsSection: ({ children, title }: { children: ReactNode; title: string }) => (
    <section>
      <h3>{title}</h3>
      {children}
    </section>
  ),
  SettingsRow: ({ title, control }: { title: string; control: ReactNode }) => (
    <div>
      {title}
      {control}
    </div>
  ),
}));
import { NativeWorkspaceSettings } from "./NativeWorkspaceSettings";

const initial: NativeSettingsSnapshot = {
  category: "workspaces",
  fields: [],
  status: {
    workspace: "alpha",
    name: "Alpha",
    folders: "[]",
    files: "[]",
    source: 'name = "Alpha"',
    revision: "revision-1",
    review: "Review this project",
    reviewRevision: "review-1",
  },
};
afterEach(() => {
  delete window.desktopBridge;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
function mount(command: (input: unknown) => Promise<NativeSettingsSnapshot>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.desktopBridge = { nativeSettings: command } as NonNullable<Window["desktopBridge"]>;
  const container = document.createElement("div");
  document.body.append(container);
  return { container, root: createRoot(container) };
}
function button(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent === label,
  )!;
}
function edit(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("saves the exact workspace and observed revision, with native confirmation", async () => {
  let confirm: (value: NativeSettingsSnapshot) => void = () => undefined;
  const command = vi
    .fn()
    .mockResolvedValueOnce(initial)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
  const { container, root } = mount(command);
  try {
    await act(async () => root.render(<NativeWorkspaceSettings workspace="alpha" />));
    expect(command).toHaveBeenCalledWith({
      category: "workspaces",
      action: "workspace-read",
      payload: { workspace: "alpha" },
    });
    await act(async () =>
      edit(container.querySelector<HTMLInputElement>('[aria-label="Workspace name"]')!, "Renamed"),
    );
    await act(async () => button(container, "Save workspace").click());
    expect(command).toHaveBeenLastCalledWith({
      category: "workspaces",
      action: "workspace-save",
      payload: {
        workspace: "alpha",
        revision: "revision-1",
        name: "Renamed",
        folders: [],
        files: [],
      },
    });
    expect(container.textContent).not.toContain("Workspace saved.");
    await act(async () =>
      confirm({
        ...initial,
        status: { ...initial.status, name: "Renamed", revision: "revision-2" },
      }),
    );
    expect(container.textContent).toContain("Workspace saved.");
  } finally {
    await act(async () => root.unmount());
  }
});

it("retains edits when native lifecycle validation refuses a save", async () => {
  const command = vi
    .fn()
    .mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(new Error("Stop services before saving."));
  const { container, root } = mount(command);
  try {
    await act(async () => root.render(<NativeWorkspaceSettings workspace="alpha" />));
    await act(async () =>
      edit(container.querySelector<HTMLInputElement>('[aria-label="Workspace name"]')!, "Renamed"),
    );
    await act(async () => button(container, "Save workspace").click());
    expect(container.textContent).toContain("Stop services before saving.");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Workspace name"]')?.value).toBe(
      "Renamed",
    );
    await act(async () => button(container, "Discard").click());
    expect(container.querySelector<HTMLInputElement>('[aria-label="Workspace name"]')?.value).toBe(
      "Alpha",
    );
  } finally {
    await act(async () => root.unmount());
  }
});

it("opens deletion confirmation without deleting until the named action is clicked", async () => {
  const command = vi.fn().mockResolvedValue(initial);
  const { container, root } = mount(command);
  try {
    await act(async () => root.render(<NativeWorkspaceSettings workspace="alpha" deleting />));
    expect(command).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Project folders and files remain on disk");
    await act(async () => button(container, "Remove workspace").click());
    expect(command).toHaveBeenLastCalledWith({
      category: "workspaces",
      action: "workspace-delete",
      payload: { workspace: "alpha", revision: "revision-1" },
    });
  } finally {
    await act(async () => root.unmount());
  }
});
