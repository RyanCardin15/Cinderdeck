import { afterEach, expect, it, vi } from "vite-plus/test";
import { AppContextRequests, isAppContextCommand } from "./appContextProtocol.ts";
const id = "12345678-1234-1234-1234-123456789012";
const other = "12345678-1234-1234-1234-123456789013";
const targets = {
  targets: [
    { id, appName: "Fixture", bundleID: "test.fixture", windowTitle: "Example", recent: true },
  ],
  accessibility: true,
  screenRecording: true,
};
const capture = {
  data: "aW1n",
  mimeType: "image/jpeg",
  source: {
    kind: "snap-shot",
    capturedAt: "2026-10-15T01:00:00Z",
    appName: "Fixture",
    windowTitle: "Example",
  },
};
afterEach(() => vi.useRealTimers());
it("accepts only opaque target IDs and refuses arbitrary apps, commands and paths", () => {
  expect(isAppContextCommand({ action: "list" })).toBe(true);
  expect(isAppContextCommand({ action: "capture", targetID: id })).toBe(true);
  for (const value of [
    null,
    { action: "list", app: "other" },
    { action: "capture", targetID: "/tmp/image" },
    { action: "capture", targetID: id, command: "open" },
  ])
    expect(isAppContextCommand(value)).toBe(false);
});
it("waits for the matching native reply and validates the requested result kind", async () => {
  const write = vi.fn();
  const requests = new AppContextRequests(write);
  const completed = vi.fn();
  const pending = requests.request({ action: "list" }, id).then(completed);
  requests.receive({ requestID: other, appContext: targets });
  await Promise.resolve();
  expect(completed).not.toHaveBeenCalled();
  requests.receive({ requestID: id, appContext: targets });
  await pending;
  expect(completed).toHaveBeenCalledWith(targets);
  const wrong = expect(
    requests.request({ action: "capture", targetID: id }, other),
  ).rejects.toThrow("invalid app context");
  requests.receive({ requestID: other, appContext: targets });
  await wrong;
});
it("validates captured image/source data and reports native permission errors", async () => {
  const requests = new AppContextRequests(() => undefined);
  const pending = requests.request({ action: "capture", targetID: id }, id);
  requests.receive({ requestID: id, appContext: capture });
  await expect(pending).resolves.toEqual(capture);
  const failed = expect(
    requests.request({ action: "capture", targetID: id }, other),
  ).rejects.toThrow("Allow Screen Recording");
  requests.receive({ requestID: other, error: "Allow Screen Recording" });
  await failed;
  const malformed = expect(
    requests.request({ action: "capture", targetID: id }, id),
  ).rejects.toThrow("invalid app context");
  requests.receive({ requestID: id, appContext: { ...capture, source: { kind: "snap-shot" } } });
  await malformed;
});
it("bounds deadlines and rejects pending requests on disconnect", async () => {
  vi.useFakeTimers();
  const requests = new AppContextRequests(() => undefined);
  const timeout = expect(requests.request({ action: "list" }, id)).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(20_001);
  await timeout;
  const closed = expect(requests.request({ action: "list" }, id)).rejects.toThrow(
    "connection closed",
  );
  requests.close();
  await closed;
});
