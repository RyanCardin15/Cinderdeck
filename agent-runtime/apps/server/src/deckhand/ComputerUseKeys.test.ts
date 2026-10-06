import { describe, expect, it } from "vite-plus/test";
import { parseKeyChord } from "./ComputerUseKeys.ts";

describe("parseKeyChord", () => {
  it("maps X keysym chords to macOS key codes and modifiers", () => {
    expect(parseKeyChord("Return")).toEqual({ keyCode: 36, modifiers: [] });
    expect(parseKeyChord("super+s")).toEqual({ keyCode: 1, modifiers: ["command"] });
    expect(parseKeyChord("Control_L+Shift_L+period")).toEqual({
      keyCode: 47,
      modifiers: ["control", "shift"],
    });
    expect(parseKeyChord(" cmd + Page_Down ")).toEqual({ keyCode: 121, modifiers: ["command"] });
    expect(parseKeyChord("KP_0")).toEqual({ keyCode: 82, modifiers: [] });
    expect(parseKeyChord("F12")).toEqual({ keyCode: 111, modifiers: [] });
  });

  it("adds Shift for uppercase letters and shifted symbols", () => {
    expect(parseKeyChord("A")).toEqual({ keyCode: 0, modifiers: ["shift"] });
    expect(parseKeyChord("greater")).toEqual({ keyCode: 47, modifiers: ["shift"] });
    expect(parseKeyChord("super+question")).toEqual({
      keyCode: 44,
      modifiers: ["command", "shift"],
    });
  });

  it("treats a bare or trailing plus as the plus key", () => {
    expect(parseKeyChord("+")).toEqual({ keyCode: 24, modifiers: ["shift"] });
    expect(parseKeyChord("super++")).toEqual({ keyCode: 24, modifiers: ["command", "shift"] });
  });

  it("types characters outside the layout only without modifiers", () => {
    expect(parseKeyChord("é")).toEqual({ text: "é", modifiers: [] });
    expect(parseKeyChord("super+é")).toBeNull();
  });

  it("rejects unknown names, lone modifiers and empty segments", () => {
    expect(parseKeyChord("Hyper_L+a")).toBeNull();
    expect(parseKeyChord("shift")).toBeNull();
    expect(parseKeyChord("super+")).toBeNull();
    expect(parseKeyChord("notakey")).toBeNull();
  });
});
