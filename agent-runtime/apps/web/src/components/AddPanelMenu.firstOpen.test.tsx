// @vitest-environment jsdom
import { act, lazy, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import type { ScopedThreadRef } from "@cinderdeck/contracts";
import { AddPanelMenu, RightPanelTabs, type AddPanelMenuProps } from "./RightPanelTabs";
import { RightPanelSheet } from "./RightPanelSheet";
import { usePanelPresence } from "../panelAnimations";
import {
  selectThreadRightPanelState,
  selectActiveRightPanelSurface,
  useRightPanelStore,
} from "../rightPanelStore";
vi.mock("../browser/browserDefaults", () => ({
  useBrowserDefaults: () => ({ profiles: [{ id: "default", name: "Default" }] }),
}));
const threadRef = { environmentId: "test-mac", threadId: "test-chat" } as ScopedThreadRef;
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.getAnimations = () => [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
  vi.unstubAllGlobals();
});
const noAction = () => {};
const panelMenu: AddPanelMenuProps = {
  onAddExternalApp: () => useRightPanelStore.getState().openExternalApp(threadRef, null),
  onAddBrowser: () => useRightPanelStore.getState().openBrowser(threadRef, "first-browser"),
  onAddBrowserInProfile: noAction,
  onAddTerminal: () => useRightPanelStore.getState().openTerminal(threadRef, "first-terminal"),
  onAddFiles: noAction,
  onAddDiff: noAction,
  onAddDevice: noAction,
  onAddPullRequest: noAction,
  onAddPullRequests: noAction,
  browserAvailable: true,
  terminalAvailable: true,
  diffAvailable: true,
  filesAvailable: true,
  deviceAvailable: true,
  pullRequestAvailable: false,
  pullRequestsAvailable: false,
};
it.each([
  { sheet: false, label: "External app" },
  { sheet: true, label: "External app" },
  { sheet: false, label: "Browser" },
  { sheet: true, label: "Browser" },
])("opens $label as the first panel, sheet=$sheet", async ({ sheet, label }) => {
  let finish!: () => void;
  const Panel = lazy(
    () =>
      new Promise<{ default: () => React.JSX.Element }>((resolve) => {
        finish = () => resolve({ default: () => <div>First panel ready</div> });
      }),
  );
  function Harness() {
    const state = useRightPanelStore((s) => selectThreadRightPanelState(s.byThreadKey, threadRef));
    const activeSurface = useRightPanelStore((s) =>
      selectActiveRightPanelSurface(s.byThreadKey, threadRef),
    );
    const presence = usePanelPresence(
      state.isOpen,
      { activeSurface, surfaces: state.surfaces },
      false,
      "test",
      0,
    );
    const panel = presence.present ? (
      <RightPanelTabs
        {...panelMenu}
        mode={sheet ? "sheet" : "inline"}
        open={state.isOpen}
        surfaces={presence.value?.surfaces ?? []}
        activeSurfaceId={presence.value?.activeSurface?.id ?? null}
        environmentId={threadRef.environmentId}
        pendingSurfaceIds={new Set()}
        previewSessions={{}}
        desktopByTabId={{}}
        terminalLabelsById={new Map()}
        onActivate={noAction}
        onCloseSurface={noAction}
        onCloseOtherSurfaces={noAction}
        onCloseSurfacesToRight={noAction}
        onCloseAllSurfaces={noAction}
        onCopyFilePath={noAction}
      >
        <Suspense fallback={<div>Loading panel</div>}>
          <Panel />
        </Suspense>
      </RightPanelTabs>
    ) : null;
    return (
      <>
        <AddPanelMenu {...panelMenu} />
        {sheet && presence.present ? (
          <RightPanelSheet
            animationDurationMs={0}
            open={state.isOpen}
            onClose={() => useRightPanelStore.getState().close(threadRef)}
          >
            {panel}
          </RightPanelSheet>
        ) : (
          panel
        )}
      </>
    );
  }
  await act(async () => root.render(<Harness />));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Add panel surface"]')!.click(),
  );
  const choice = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
    el.textContent?.startsWith(label),
  )!;
  await act(async () => choice.click());
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).isOpen,
  ).toBe(true);
  expect(document.body.textContent).toContain("Loading panel");
  await act(async () => finish());
  expect(document.body.textContent).toContain("First panel ready");
});
