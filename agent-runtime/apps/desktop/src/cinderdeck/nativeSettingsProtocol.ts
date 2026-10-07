// @effect-diagnostics globalTimers:off -- The inherited pipe needs cancellable request deadlines and settles on replies or shutdown.
import type { NativeSettingsCommand, NativeSettingsSnapshot } from "@cinderdeck/contracts";

const categories = new Set([
  "general",
  "appearance",
  "capture",
  "recording",
  "annotate",
  "quickAccess",
  "menuBar",
  "history",
  "shortcuts",
  "permissions",
  "dictation",
  "cloud",
  "github",
  "updates",
  "advanced",
  "workspaces",
  "about",
]);
const actions = new Set([
  "read",
  "update",
  "permission",
  "choose-export-folder",
  "check-updates",
  "install-update",
  "github-refresh",
  "github-host",
  "github-sign-in",
  "github-cancel",
  "cloud-save",
  "cloud-unlock",
  "cloud-clear",
  "cloud-protection",
  "ocr-key",
  "dictation-key",
  "dictation-test",
  "dictation-stop",
  "config-export",
  "config-import",
  "config-open",
  "config-restore",
  "config-grant",
  "workspace-read",
  "workspace-save",
  "workspace-pick-folder",
  "workspace-pick-file",
  "workspace-review-save",
  "workspace-delete",
  "menu-icon-import",
  "menu-icon-remove",
  "menu-reset",
  "history-open",
  "history-clear",
  "clipboard-clear",
  "config-sync",
  "logs-open",
  "ocr-test",
  "notification-allow",
  "notification-open",
  "shortcuts-reset",
  "cloud-export",
  "cloud-import",
]);
export function isNativeSettingsCommand(value: unknown): value is NativeSettingsCommand {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.action === "string" &&
    actions.has(input.action) &&
    typeof input.category === "string" &&
    categories.has(input.category) &&
    Object.keys(input).every((key) => ["action", "category", "payload"].includes(key)) &&
    (input.payload === undefined ||
      (typeof input.payload === "object" &&
        input.payload !== null &&
        !Array.isArray(input.payload)))
  );
}

/** Bounded, correlated replies. A delivered mutation is never reported as saved. */
export class NativeSettingsRequests {
  private readonly pending = new Map<
    string,
    {
      category: string;
      resolve: (value: NativeSettingsSnapshot) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly write: (message: string) => void;
  constructor(write: (message: string) => void) {
    this.write = write;
  }
  request(command: NativeSettingsCommand, requestID: string): Promise<NativeSettingsSnapshot> {
    const line = "CINDERDECK_RUNTIME_SETTINGS " + JSON.stringify({ requestID, ...command }) + "\n";
    if (
      new TextEncoder().encode(line).length >
      (command.action.startsWith("workspace-") ? 131_072 : 16_384)
    )
      return Promise.reject(
        new Error("Settings request is too large. Save fewer changes at a time."),
      );
    if (this.pending.size >= 16 || this.pending.has(requestID))
      return Promise.reject(new Error("Settings is busy. Try again shortly."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(requestID);
          reject(
            new Error(
              "Cinderdeck could not confirm this settings request. Reload to check the saved values.",
            ),
          );
        },
        command.action === "cloud-save" ||
          command.action === "choose-export-folder" ||
          command.action.startsWith("config-") ||
          command.action.startsWith("workspace-pick-") ||
          command.action === "cloud-export" ||
          command.action === "cloud-import" ||
          command.action === "menu-icon-import" ||
          command.action.endsWith("-clear")
          ? 180_000
          : 15_000,
      );
      this.pending.set(requestID, { category: command.category, resolve, reject, timer });
      try {
        this.write(line);
      } catch {
        this.finish(requestID, new Error("The native settings connection is unavailable."));
      }
    });
  }
  receive(value: Record<string, unknown>): void {
    if (typeof value.requestID !== "string" || !this.pending.has(value.requestID)) return;
    const pending = this.pending.get(value.requestID)!;
    if (typeof value.error === "string") {
      this.finish(value.requestID, new Error(value.error));
      return;
    }
    const snapshot = value.settings as NativeSettingsSnapshot | undefined;
    if (
      !snapshot ||
      snapshot.category !== pending.category ||
      !Array.isArray(snapshot.fields) ||
      typeof snapshot.status !== "object" ||
      snapshot.status === null ||
      Array.isArray(snapshot.status) ||
      !Object.values(snapshot.status).every(
        (status) => typeof status === "string" || typeof status === "boolean",
      ) ||
      !snapshot.fields.every(
        (field) =>
          typeof field === "object" &&
          field !== null &&
          typeof field.id === "string" &&
          (typeof field.value === "string" ||
            typeof field.value === "boolean" ||
            (typeof field.value === "number" && Number.isFinite(field.value)) ||
            (Array.isArray(field.value) &&
              field.value.every((item: unknown) => typeof item === "string"))) &&
          (field.options === undefined ||
            (Array.isArray(field.options) &&
              field.options.every((item: unknown) => typeof item === "string"))) &&
          (field.optionLabels === undefined ||
            (typeof field.optionLabels === "object" &&
              field.optionLabels !== null &&
              !Array.isArray(field.optionLabels) &&
              Object.values(field.optionLabels).every((label) => typeof label === "string"))),
      )
    ) {
      this.finish(value.requestID, new Error("Cinderdeck returned an invalid settings response."));
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(value.requestID);
    pending.resolve(snapshot);
  }
  private finish(id: string, error: Error): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.reject(error);
  }
  close(): void {
    for (const id of this.pending.keys())
      this.finish(id, new Error("The native settings connection closed."));
  }
}
