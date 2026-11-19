import * as NodeReadline from "node:readline";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The native host passes Node stdin and stdout pipes.
import type * as NodeStream from "node:stream";
import * as Electron from "electron";
import type { CapturedPromptFile, CapturePromptSettingsUpdate } from "@cinderdeck/contracts";
import { parsePromptCapture, readPromptCapture, type PromptCaptureGrant } from "./capturePrompt.ts";
import { CapturePromptSettingsRequests } from "./capturePromptSettings.ts";

// Only the bundled runtime inherits this pipe. EOF also covers an unexpected parent exit.
export function connectCinderdeckHost(
  input: NodeStream.Readable,
  output: NodeStream.Writable,
  app: Pick<Electron.App, "quit" | "hide">,
) {
  let closing = false;
  let dispatch: ((command: string) => void) | undefined;
  let pendingActivate = false;
  let pendingSettings = false;
  let capture: PromptCaptureGrant | null = null;
  const captureSettings = new CapturePromptSettingsRequests((line) => {
    output.write(line);
  });
  function close() {
    if (closing) return;
    closing = true;
    captureSettings.close();
    app.quit();
  }

  const lines = NodeReadline.createInterface({ input });
  lines.on("close", close);
  lines.on("line", (line) => {
    if (Buffer.byteLength(line) > 16_384) return;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (!value || typeof value !== "object") return;
    const command = value.type;
    if (command === "capture-prompt") {
      const grant = parsePromptCapture(value);
      if (grant) {
        capture = grant;
        dispatch?.("capture-prompt");
      }
      return;
    }
    if (command === "capture-prompt-settings") {
      captureSettings.receive(value);
      return;
    }
    if (command === "quit") close();
    if (command === "hide") app.hide();
    if (command !== "activate" && command !== "settings-open") return;
    if (dispatch) dispatch(command);
    else if (command === "activate") pendingActivate = true;
    else pendingSettings = true;
  });

  return {
    async takeCapture(): Promise<CapturedPromptFile | null> {
      const grant = capture;
      if (!grant) return null;
      capture = null;
      try {
        return { source: grant.preview, bytes: await readPromptCapture(grant) };
      } catch (error) {
        return {
          source: grant.preview,
          error: error instanceof Error ? error.message : "The capture could not be opened.",
        };
      }
    },
    captureSettings: (update?: CapturePromptSettingsUpdate) => captureSettings.request(update),
    requestQuit() {
      if (closing) return false;
      output.write("CINDERDECK_RUNTIME_QUIT_REQUEST\n");
      return true;
    },
    ready(handler: (command: string) => void) {
      dispatch = handler;
      if (pendingActivate) handler("activate");
      if (pendingSettings) handler("settings-open");
      if (capture) handler("capture-prompt");
      output.write("CINDERDECK_RUNTIME_READY\n");
    },
  };
}

export const cinderdeckHost =
  process.env.CINDERDECK_NATIVE_HOST === "1"
    ? connectCinderdeckHost(process.stdin, process.stdout, Electron.app)
    : null;
