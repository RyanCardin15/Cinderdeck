// @effect-diagnostics globalTimers:off -- Correlated native requests have bounded deadlines and settle on shutdown.
import * as Schema from "effect/Schema";
import {
  SnapShotSource,
  type AppContextCommand,
  type AppContextCapture,
  type RecentAppTargets,
} from "@cinderdeck/contracts";
const isSnapShotSource = Schema.is(SnapShotSource);

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export function isAppContextCommand(value: unknown): value is AppContextCommand {
  return (
    object(value) &&
    (value.action === "list"
      ? Object.keys(value).length === 1
      : value.action === "capture" &&
        Object.keys(value).length === 2 &&
        typeof value.targetID === "string" &&
        uuid.test(value.targetID))
  );
}
const validIcon = (value: unknown) =>
  value === undefined ||
  (typeof value === "string" &&
    value.length < 100_000 &&
    /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value));
const validText = (value: unknown, limit: number) =>
  typeof value === "string" && value.length <= limit;
function isTargets(value: unknown): value is RecentAppTargets {
  return (
    object(value) &&
    typeof value.screenRecording === "boolean" &&
    typeof value.accessibility === "boolean" &&
    Array.isArray(value.targets) &&
    value.targets.length <= 16 &&
    value.targets.every(
      (target) =>
        object(target) &&
        typeof target.id === "string" &&
        uuid.test(target.id) &&
        validText(target.appName, 255) &&
        validText(target.bundleID, 255) &&
        validText(target.windowTitle, 1000) &&
        typeof target.recent === "boolean" &&
        validIcon(target.iconDataURL) &&
        (target.tabTitle === undefined || validText(target.tabTitle, 1000)) &&
        (target.tabURL === undefined ||
          (validText(target.tabURL, 4096) && /^https?:\/\//i.test(target.tabURL as string))),
    )
  );
}
function isCapture(value: unknown): value is AppContextCapture {
  return (
    object(value) &&
    typeof value.data === "string" &&
    value.data.length > 0 &&
    value.data.length < 2_700_000 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value.data) &&
    value.mimeType === "image/jpeg" &&
    isSnapShotSource(value.source)
  );
}

/** The renderer receives data, never native file paths or executable authority. */
export class AppContextRequests {
  private pending = new Map<
    string,
    {
      action: AppContextCommand["action"];
      resolve: (value: RecentAppTargets | AppContextCapture) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly write: (line: string) => void;
  constructor(write: (line: string) => void) {
    this.write = write;
  }
  request(
    command: AppContextCommand,
    requestID: string,
  ): Promise<RecentAppTargets | AppContextCapture> {
    if (
      !isAppContextCommand(command) ||
      !uuid.test(requestID) ||
      this.pending.has(requestID) ||
      this.pending.size >= 8
    )
      return Promise.reject(new Error("App context is busy or unavailable."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(requestID, "App context timed out. Open the + menu again."),
        20_000,
      );
      this.pending.set(requestID, { action: command.action, resolve, reject, timer });
      try {
        this.write(
          "CINDERDECK_RUNTIME_APP_CONTEXT " + JSON.stringify({ requestID, ...command }) + "\n",
        );
      } catch {
        this.fail(requestID, "The native app context connection closed.");
      }
    });
  }
  receive(value: Record<string, unknown>): void {
    if (typeof value.requestID !== "string") return;
    const request = this.pending.get(value.requestID);
    if (!request) return;
    if (typeof value.error === "string") {
      this.fail(value.requestID, value.error.slice(0, 1000));
      return;
    }
    if (!(request.action === "list" ? isTargets(value.appContext) : isCapture(value.appContext))) {
      this.fail(value.requestID, "Cinderdeck returned invalid app context.");
      return;
    }
    clearTimeout(request.timer);
    this.pending.delete(value.requestID);
    request.resolve(value.appContext as RecentAppTargets | AppContextCapture);
  }
  private fail(id: string, message: string): void {
    const request = this.pending.get(id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(id);
    request.reject(new Error(message));
  }
  close(): void {
    for (const id of this.pending.keys())
      this.fail(id, "The native app context connection closed.");
  }
}
