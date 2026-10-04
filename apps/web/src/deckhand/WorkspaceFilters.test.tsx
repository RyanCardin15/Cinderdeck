// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { WorkspaceFilters } from "./WorkspaceFilters";
import {
  defaultWorkspaceFilters,
  selectWorkspaceContexts,
  type WorkspaceFilterValue,
  type WorkspaceResource,
} from "./workspaceContextFilters";
const resources: ReadonlyArray<WorkspaceResource> = ["payments", "account"].map((id) => ({
  workspaceID: id,
  generation: 1,
  available: true,
  revision: "r1",
  workspace: {
    id,
    name: id,
    file: `/fixture/${id}`,
    state: "stopped",
    definitionChanged: false,
    issues: [],
    services: [],
    repos: [],
  },
}));
const summaries = resources.map((item) => ({
  workspaceID: item.workspaceID,
  generation: 1,
  total: 0,
  sessions: [],
}));
let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.unstubAllGlobals();
});
function Harness({
  disconnected = false,
  rows = resources,
}: {
  disconnected?: boolean;
  rows?: ReadonlyArray<WorkspaceResource>;
}) {
  const [value, setValue] = useState<WorkspaceFilterValue>({ ...defaultWorkspaceFilters });
  const options = { nativeUnavailable: disconnected, agentsUnavailable: disconnected };
  const result = selectWorkspaceContexts(rows, summaries, value, options);
  return (
    <>
      <WorkspaceFilters
        {...options}
        value={value}
        onChange={setValue}
        resources={rows}
        summaries={summaries}
        totalContextCount={500}
      />
      <ul aria-label="Visible contexts">
        {result.resources.map((item) => (
          <li key={item.workspaceID}>{item.workspaceID}</li>
        ))}
      </ul>
      <p>Selected inspector: account</p>
    </>
  );
}
it("filters a bounded page through its accessible search, reports no match honestly, and clears without changing selection", async () => {
  await act(async () => root.render(<Harness />));
  const label = [...element.querySelectorAll("label")].find((item) =>
    item.textContent?.startsWith("Search"),
  )!;
  const input = document.getElementById(label.htmlFor) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "payments",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(element.querySelector("ul")?.textContent).toBe("payments");
  expect(element.textContent).toContain("1 matching context on this loaded page");
  expect(element.textContent).toContain("500");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "absent",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(element.querySelector("ul")?.textContent).toBe("");
  expect(element.textContent).toContain("No loaded contexts match");
  await act(async () => {
    (element.querySelector("button") as HTMLButtonElement).click();
  });
  expect(element.querySelectorAll("li")).toHaveLength(2);
  expect(element.textContent).toContain("Selected inspector: account");
});
it("distinguishes an empty connected page from unavailable current data", async () => {
  await act(async () => root.render(<Harness rows={[]} />));
  expect(element.textContent).toContain("No contexts are loaded on this page");
  await act(async () => root.render(<Harness rows={[]} disconnected />));
  expect(element.textContent).toContain("Connection unavailable");
  expect(element.textContent).not.toContain("No contexts are loaded");
  expect(element.textContent).toContain("current matches cannot be confirmed");
});
