// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";
import { diffHeaderFilePath } from "./diffHeaderInteraction";

describe("diff header disclosure", () => {
  it("toggles from the filename or row across the viewer's shadow root", () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML =
      "<header data-diffs-header><span data-title>src/app.ts</span><span data-metadata>+2</span></header>";
    let file: string | null = null;
    host.addEventListener("click", (event) => {
      file = diffHeaderFilePath(event.composedPath());
    });
    for (const target of ["[data-title]", "[data-metadata]"]) {
      shadow
        .querySelector(target)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
      expect(file).toBe("src/app.ts");
    }
  });

  it("leaves the chevron, copy, and editor buttons to perform a single action", () => {
    const header = document.createElement("header");
    header.setAttribute("data-diffs-header", "");
    header.innerHTML = "<span data-title>src/app.ts</span><button><svg><path /></svg></button>";
    const button = header.querySelector("button")!;
    const icon = button.querySelector("path")!;
    expect(diffHeaderFilePath([icon, button, header])).toBeNull();
    expect(diffHeaderFilePath([document.createElement("pre")])).toBeNull();
  });
});
