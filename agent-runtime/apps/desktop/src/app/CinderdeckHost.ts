import * as NodeReadline from "node:readline";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The native host passes Node stdin and stdout pipes.
import type * as NodeStream from "node:stream";
import * as Electron from "electron";

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
  function close() {
    if (closing) return;
    closing = true;
    app.quit();
  }

  const lines = NodeReadline.createInterface({ input });
  lines.on("close", close);
  lines.on("line", (line) => {
    let command: unknown;
    try {
      command = JSON.parse(line)?.type;
    } catch {
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
    requestQuit() {
      if (closing) return false;
      output.write("CINDERDECK_RUNTIME_QUIT_REQUEST\n");
      return true;
    },
    ready(handler: (command: string) => void) {
      dispatch = handler;
      if (pendingActivate) handler("activate");
      if (pendingSettings) handler("settings-open");
      output.write("CINDERDECK_RUNTIME_READY\n");
    },
  };
}

export const cinderdeckHost =
  process.env.CINDERDECK_NATIVE_HOST === "1"
    ? connectCinderdeckHost(process.stdin, process.stdout, Electron.app)
    : null;
