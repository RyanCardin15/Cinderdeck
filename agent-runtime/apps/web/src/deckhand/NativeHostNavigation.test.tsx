// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { NativeHostRoute } from "@cinderdeck/contracts";

const boundary = vi.hoisted(() => ({
  environment: null as string | null,
  navigate: vi.fn(),
  listener: null as ((route: NativeHostRoute) => void) | null,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => boundary.navigate }));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => boundary.environment }));
import { NativeHostNavigation } from "./NativeHostNavigation";

it("opens native settings in the unified page even before the environment connects", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.desktopBridge = {
    onNativeHostRoute: (listener) => {
      boundary.listener = listener;
      return () => {
        boundary.listener = null;
      };
    },
  } as NonNullable<Window["desktopBridge"]>;
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<NativeHostNavigation />));
    for (const [category, to, hash] of [
      ["general", "/settings/general", "native-general"],
      ["github", "/settings/source-control", "native-github"],
      ["shortcuts", "/settings/keybindings", "native-shortcuts"],
      ["dictation", "/settings/dictation", "native-dictation"],
      ["capture", "/settings/capture", "native-capture"],
    ]) {
      await act(async () => boundary.listener!({ section: `settings:${category}` }));
      expect(boundary.navigate).toHaveBeenLastCalledWith({ to, hash, search: {} });
    }
    await act(async () =>
      boundary.listener!({ section: "settings:workspace", workspaceID: "alpha" }),
    );
    expect(boundary.navigate).toHaveBeenLastCalledWith({
      to: "/settings/workspaces",
      hash: "native-workspace",
      search: { workspace: "alpha" },
    });
    await act(async () =>
      boundary.listener!({ section: "settings:workspace-delete", workspaceID: "alpha" }),
    );
    expect(boundary.navigate).toHaveBeenLastCalledWith({
      to: "/settings/workspaces",
      hash: "native-workspace",
      search: { workspace: "alpha", workspaceAction: "delete" },
    });
    await act(async () =>
      boundary.listener!({ section: "settings:workspace-configuration", workspaceID: "alpha" }),
    );
    expect(boundary.navigate).toHaveBeenLastCalledWith({
      to: "/settings/workspaces",
      hash: "native-workspace",
      search: { workspace: "alpha", workspaceAction: "configuration" },
    });
  } finally {
    await act(async () => root.unmount());
  }
});

afterEach(() => {
  boundary.navigate.mockClear();
  boundary.environment = null;
  boundary.listener = null;
  delete window.desktopBridge;
  vi.unstubAllGlobals();
});

it("opens the overview by default after the native computer becomes available, retaining explicit lane routes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.desktopBridge = {
    onNativeHostRoute: (listener) => {
      boundary.listener = listener;
      return () => {
        boundary.listener = null;
      };
    },
  } as NonNullable<Window["desktopBridge"]>;
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<NativeHostNavigation />));
    await act(async () => boundary.listener!({}));
    expect(boundary.navigate).not.toHaveBeenCalled();
    boundary.environment = "local-owner";
    await act(async () => root.render(<NativeHostNavigation />));
    expect(boundary.navigate).toHaveBeenLastCalledWith({
      to: "/workspaces",
      search: { environment: "local-owner", tab: "overview" },
    });
    await act(async () => boundary.listener!({ workspaceID: "lane" }));
    expect(boundary.navigate).toHaveBeenLastCalledWith({
      to: "/workspaces",
      search: { environment: "local-owner", context: "lane", tab: "services" },
    });
    // Native lane creation routes to the new lane's overview, not its services.
    await act(async () => boundary.listener!({ workspaceID: "new-lane", section: "overview" }));
    expect(boundary.navigate).toHaveBeenLastCalledWith({
      to: "/workspaces",
      search: { environment: "local-owner", context: "new-lane", tab: "overview" },
    });
    await act(async () => boundary.listener!({ workspaceID: "lane", section: "recordings" }));
    expect(boundary.navigate).toHaveBeenLastCalledWith({
      to: "/workspaces",
      search: { environment: "local-owner", context: "lane", tab: "recordings" },
    });
    await act(async () =>
      boundary.listener!({ workspaceID: "workspace", section: "code-review-skill" }),
    );
    expect(boundary.navigate).toHaveBeenLastCalledWith({
      to: "/workspaces",
      search: {
        environment: "local-owner",
        context: "workspace",
        tab: "agents",
        editReviewSkill: true,
      },
    });
  } finally {
    await act(async () => root.unmount());
  }
  expect(boundary.listener).toBeNull();
});
