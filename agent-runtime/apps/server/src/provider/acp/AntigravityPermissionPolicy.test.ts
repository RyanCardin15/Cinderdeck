import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  antigravityRuntimeModeAdjustments,
  withAntigravityPermissionPolicy,
} from "./AntigravityPermissionPolicy.ts";

function runtime(allowed: string[] | undefined) {
  const selections: string[] = [];
  return {
    selections,
    runtime: withAntigravityPermissionPolicy({
      getModeState: Effect.sync(() =>
        allowed === undefined
          ? undefined
          : {
              currentModeId: allowed[0] ?? "",
              availableModes: allowed.map((id) => ({ id, name: id })),
            },
      ),
      setMode: (mode: string) =>
        Effect.sync(() => {
          selections.push(mode);
          return {};
        }),
    }),
  };
}

describe("Antigravity native permission requirements", () => {
  it.effect("uses a permitted, more restrictive mode and rereads changing requirements", () =>
    Effect.gen(function* () {
      const allowed = ["default", "auto_edit"];
      const test = runtime(allowed);
      yield* test.runtime.setMode("yolo");
      allowed.pop();
      yield* test.runtime.setMode("yolo");
      expect(test.selections).toEqual(["auto_edit", "default"]);
    }),
  );

  it.effect.each([["yolo"], []])("never broadens helper or supervised access for %s", (allowed) =>
    Effect.gen(function* () {
      const test = runtime(allowed);
      const error = yield* test.runtime.setMode("default").pipe(Effect.flip);
      expect(error.message).toContain("permission policy does not allow");
      expect(test.selections).toEqual([]);
    }),
  );

  it.effect("preserves native validation when the CLI does not advertise modes", () =>
    Effect.gen(function* () {
      const test = runtime(undefined);
      yield* test.runtime.setMode("default");
      expect(test.selections).toEqual(["default"]);
    }),
  );

  it("reports effective restrictions and clears them when the provider restores modes", () => {
    const modes = { currentModeId: "default", availableModes: [{ id: "default", name: "Ask" }] };
    const adjustments = antigravityRuntimeModeAdjustments(modes);
    expect(adjustments.map((entry) => entry.mode)).toEqual(["auto-accept-edits", "full-access"]);
    expect(
      adjustments.every(
        (entry) => entry.source === "provider" && entry.description.includes("ask for approval"),
      ),
    ).toBe(true);
    expect(
      antigravityRuntimeModeAdjustments({
        ...modes,
        availableModes: ["default", "auto_edit", "yolo"].map((id) => ({ id, name: id })),
      }),
    ).toEqual([]);
  });
});
