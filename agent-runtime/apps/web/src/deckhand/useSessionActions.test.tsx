// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId, type ContextMenuItem } from "@cinderdeck/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

const boundary = vi.hoisted(() => ({
  menu: vi.fn(),
  navigate: vi.fn(),
  highlight: vi.fn(),
  actions: { archiveThread: vi.fn(), deleteThread: vi.fn() },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => boundary.navigate }));
vi.mock("../hooks/useThreadActions", () => ({ useThreadActions: () => boundary.actions }));
vi.mock("../hooks/useSettings", () => ({ useClientSettings: () => false }));
vi.mock("../hooks/useThreadSessionTerminal", () => ({
  useThreadSessionTerminal: () => ({ canOpen: () => false }),
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({ contextMenu: { show: boundary.menu } }),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  readEnvironmentSupportsPinning: () => false,
}));
vi.mock("../state/threads", () => ({ threadEnvironment: { updateMetadata: null } }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
import { useSessionActions } from "./useSessionActions";

function SessionMenu() {
  const { showMenu } = useSessionActions(EnvironmentId.make("local"));
  return (
    <button
      onClick={() =>
        void showMenu(
          { binding: { threadId: "session" }, title: "A session", archived: false },
          { x: 1, y: 2 },
          false,
          { onHighlight: boundary.highlight },
        )
      }
    >
      Menu
    </button>
  );
}
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("offers session highlights while disconnected without performing a thread mutation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  boundary.menu.mockResolvedValue("highlight-color");
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<SessionMenu />));
    await act(async () => container.querySelector("button")!.click());
    const items = boundary.menu.mock.calls[0]![0] as ContextMenuItem[];
    expect(items.find((item) => item.id === "highlight-color")).toEqual({
      id: "highlight-color",
      label: "Highlight color…",
      icon: "palette",
    });
    expect(items.find((item) => item.id === "rename")?.disabled).toBe(true);
    expect(boundary.highlight).toHaveBeenCalledOnce();
    expect(boundary.actions.archiveThread).not.toHaveBeenCalled();
    expect(boundary.actions.deleteThread).not.toHaveBeenCalled();
    expect(boundary.navigate).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
