import { afterEach, expect, it, vi } from "vite-plus/test";
import { isNativeSettingsCommand, NativeSettingsRequests } from "./nativeSettingsProtocol.ts";
afterEach(() => vi.useRealTimers());
const snapshot = {
  category: "capture",
  fields: [{ id: "capture.screenshot.show_cursor", value: true }],
  status: {},
};

it("accepts only known settings actions and refuses remote targets or executable commands", () => {
  expect(isNativeSettingsCommand({ action: "read", category: "capture" })).toBe(true);
  for (const input of [
    null,
    { action: "read", category: "other" },
    { action: "execute", category: "capture" },
    { action: "read", category: "capture", environment: "remote" },
    { action: "read", category: "capture", command: "rm" },
  ])
    expect(isNativeSettingsCommand(input)).toBe(false);
});
it("resolves only a correlated native reply, never pipe delivery", async () => {
  const write = vi.fn();
  const requests = new NativeSettingsRequests(write);
  const completed = vi.fn();
  const pending = requests.request({ action: "read", category: "capture" }, "one").then(completed);
  expect(write).toHaveBeenCalledOnce();
  requests.receive({ requestID: "other", settings: snapshot });
  await Promise.resolve();
  expect(completed).not.toHaveBeenCalled();
  requests.receive({ requestID: "one", settings: snapshot });
  await pending;
  expect(completed).toHaveBeenCalledWith(snapshot);
});
it("reports native save failures and refuses replies for another category", async () => {
  const requests = new NativeSettingsRequests(() => undefined);
  const failed = expect(
    requests.request({ action: "update", category: "capture" }, "one"),
  ).rejects.toThrow("Settings changed");
  requests.receive({ requestID: "one", error: "Settings changed" });
  await failed;
  const wrong = expect(
    requests.request({ action: "read", category: "capture" }, "two"),
  ).rejects.toThrow("invalid settings response");
  requests.receive({ requestID: "two", settings: { ...snapshot, category: "cloud" } });
  await wrong;
});
it("bounds pending work, timeouts and request size, and rejects on shutdown", async () => {
  vi.useFakeTimers();
  const requests = new NativeSettingsRequests(() => undefined);
  const timeout = expect(
    requests.request({ action: "read", category: "capture" }, "timeout"),
  ).rejects.toThrow("could not confirm");
  await vi.advanceTimersByTimeAsync(15001);
  await timeout;
  await expect(
    requests.request(
      { action: "update", category: "capture", payload: { value: "x".repeat(17000) } },
      "big",
    ),
  ).rejects.toThrow("too large");
  const closed = expect(
    requests.request({ action: "read", category: "capture" }, "closed"),
  ).rejects.toThrow("connection closed");
  requests.close();
  await closed;
});
