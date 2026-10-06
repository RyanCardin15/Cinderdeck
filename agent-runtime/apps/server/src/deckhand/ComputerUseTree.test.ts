import { describe, expect, it } from "vite-plus/test";
import {
  diffTree,
  formatNode,
  formatTree,
  snapshotTree,
  type ComputerNode,
} from "./ComputerUseTree.ts";

const window: ComputerNode = { id: 1, parent: 0, depth: 0, role: "AXWindow", title: "Book1" };
const name: ComputerNode = {
  id: 2,
  parent: 1,
  depth: 1,
  role: "AXTextField",
  description: "Name",
  value: "",
  focused: true,
};
const save: ComputerNode = {
  id: 3,
  parent: 1,
  depth: 1,
  role: "AXButton",
  title: "Save",
  identifier: "_NS:42",
  actions: ["Show Menu"],
};

describe("formatTree", () => {
  it("prints indexed, indented lines with readable roles and useful details only", () => {
    expect(formatTree([window, name, save])).toBe(
      [
        '1 window "Book1"',
        '  2 text field "Name", Value: "", focused',
        '  3 button "Save", Secondary Actions: Show Menu',
      ].join("\n"),
    );
    expect(
      formatNode({
        id: 9,
        parent: 0,
        depth: 0,
        role: "AXButton",
        subrole: "AXCloseButton",
        title: "Close",
        description: "Close window",
        identifier: "close-button",
        disabled: true,
        expanded: false,
      }),
    ).toBe(
      '9 button (close button) "Close", Description: "Close window", ID: close-button, disabled, collapsed',
    );
  });
});

describe("diffTree", () => {
  it("needs a previous read before it can diff", () => {
    expect(diffTree(undefined, [window])).toBeNull();
  });

  it("lists changed, added and removed elements by their stable index", () => {
    const previous = snapshotTree([window, name, save]);
    const typed = { ...name, value: "Quarterly" };
    const dialog: ComputerNode = { id: 4, parent: 1, depth: 1, role: "AXSheet", title: "Saved" };
    const diff = diffTree(previous, [window, typed, dialog]);
    expect(diff?.changes).toBe(3);
    expect(diff?.text.split("\n")).toEqual([
      "Changes since the previous state (unchanged elements keep their indexes):",
      '~ 2 text field "Name", Value: "Quarterly", focused',
      '+ 4 sheet "Saved"',
      '- 3 button "Save", Secondary Actions: Show Menu',
      "(1 elements unchanged)",
    ]);
  });

  it("reports an unchanged window plainly", () => {
    const nodes = [window, name, save];
    expect(diffTree(snapshotTree(nodes), nodes)).toEqual({
      text: "No changes since the previous state.",
      changes: 0,
    });
  });

  it("falls back to a full tree when most of the window changed", () => {
    const before = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      parent: 0,
      depth: 0,
      role: "AXStaticText",
      value: `old ${index}`,
    }));
    const after = before.map((node) => ({ ...node, value: node.value.replace("old", "new") }));
    expect(diffTree(snapshotTree(before), after)).toBeNull();
  });
});
