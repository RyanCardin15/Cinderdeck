// @vitest-environment jsdom
import { beforeEach, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@cinderdeck/contracts";
import { resolveChatModes, useChatDefaultsStore } from "./chatDefaults";
const machine = EnvironmentId.make("machine");
beforeEach(() => {
  localStorage.clear();
  useChatDefaultsStore.setState({ preferences: {}, lastModes: {}, repositories: {} });
});
it("remembers every permissions mode independently for each machine", () => {
  for (const runtimeMode of [
    "full-access",
    "approval-required",
    "auto",
    "auto-accept-edits",
  ] as const) {
    useChatDefaultsStore
      .getState()
      .rememberModes(machine, { runtimeMode, interactionMode: "plan" });
    expect(resolveChatModes(machine, "approval-required", true)).toEqual({
      runtimeMode,
      interactionMode: "plan",
    });
    expect(resolveChatModes(EnvironmentId.make("other"), "approval-required", true)).toEqual({
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
  }
});
it("uses configured modes when memory is off and respects disabled Plan mode", () => {
  useChatDefaultsStore
    .getState()
    .rememberModes(machine, { runtimeMode: "full-access", interactionMode: "plan" });
  useChatDefaultsStore
    .getState()
    .setPreferences(machine, { rememberModes: false, interactionMode: "default" });
  expect(resolveChatModes(machine, "approval-required", true)).toEqual({
    runtimeMode: "approval-required",
    interactionMode: "default",
  });
  useChatDefaultsStore.getState().setPreferences(machine, { interactionMode: "plan" });
  expect(resolveChatModes(machine, "approval-required", true).interactionMode).toBe("plan");
  expect(resolveChatModes(machine, "approval-required", false).interactionMode).toBe("default");
});
it("restores choices from storage after a reload", async () => {
  useChatDefaultsStore
    .getState()
    .rememberModes(machine, { runtimeMode: "auto", interactionMode: "plan" });
  useChatDefaultsStore.getState().rememberRepository("workspace-scope", "api");
  const persisted = localStorage.getItem("deckhand:chat-defaults")!;
  useChatDefaultsStore.setState({ preferences: {}, lastModes: {}, repositories: {} });
  localStorage.setItem("deckhand:chat-defaults", persisted);
  await useChatDefaultsStore.persist.rehydrate();
  expect(resolveChatModes(machine, "full-access", true)).toEqual({
    runtimeMode: "auto",
    interactionMode: "plan",
  });
  expect(useChatDefaultsStore.getState().repositories["workspace-scope"]).toBe("api");
});
