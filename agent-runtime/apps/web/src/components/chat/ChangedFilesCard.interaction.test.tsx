// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RunId } from "@cinderdeck/contracts";
import { expect, it, vi } from "vite-plus/test";
import { ChangedFilesCard } from "./ChangedFilesTree";

it("folds the session diff summary while retaining folder expansion and its independent diff action", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const openDiff = vi.fn();
  try {
    await act(async () =>
      root.render(
        <ChangedFilesCard
          runId={RunId.make("run")}
          files={[{ path: "src/app.ts", kind: "modified", additions: 2, deletions: 1 }]}
          allDirectoriesExpanded={false}
          resolvedTheme="light"
          onToggleAllDirectories={() => {}}
          onOpenTurnDiff={openDiff}
        />,
      ),
    );
    const trigger = element.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await act(async () =>
      element.querySelector<HTMLButtonElement>('[aria-label="Open diff"]')!.click(),
    );
    expect(openDiff).toHaveBeenCalledWith("run", "src/app.ts");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const folder = element.querySelector<HTMLButtonElement>(
      "button[data-scroll-anchor-ignore][aria-expanded]",
    )!;
    await act(async () => folder.click());
    expect(folder.getAttribute("aria-expanded")).toBe("true");
    await act(async () => trigger.click());
    await act(async () => trigger.click());
    expect(folder.getAttribute("aria-expanded")).toBe("true");
    expect(element.textContent).toContain("app.ts");
  } finally {
    await act(async () => root.unmount());
    element.remove();
    vi.unstubAllGlobals();
  }
});
