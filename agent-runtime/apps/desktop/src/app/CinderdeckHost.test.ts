// @effect-diagnostics-next-line nodeBuiltinImport:off -- The native host passes Node stdin and stdout pipes.
import * as NodeStream from "node:stream";
import { expect, it, vi } from "vite-plus/test";
import { connectCinderdeckHost } from "./CinderdeckHost.ts";

vi.mock("electron", () => ({ app: {} }));

it("delivers queued window actions and waits for the parent to approve quitting", () => {
  const input = new NodeStream.PassThrough();
  const output = new NodeStream.PassThrough();
  const app = { quit: vi.fn(), hide: vi.fn() };
  const host = connectCinderdeckHost(input, output, app);
  const dispatch = vi.fn();

  input.write('{"type":"activate"}\n{"type":"settings-open"}\n');
  host.ready(dispatch);
  expect(dispatch.mock.calls).toEqual([["activate"], ["settings-open"]]);
  expect(output.read().toString()).toBe("CINDERDECK_RUNTIME_READY\n");
  expect(host.requestQuit()).toBe(true);
  expect(output.read().toString()).toBe("CINDERDECK_RUNTIME_QUIT_REQUEST\n");
  expect(app.quit).not.toHaveBeenCalled();
  input.write('{"type":"hide"}\n{"type":"quit"}\n');
  expect(app.hide).toHaveBeenCalledOnce();
  expect(app.quit).toHaveBeenCalledOnce();
  expect(host.requestQuit()).toBe(false);
  input.end();
});

it("quits if the parent exits before the desktop window is ready", async () => {
  const input = new NodeStream.PassThrough();
  const app = { quit: vi.fn(), hide: vi.fn() };
  connectCinderdeckHost(input, new NodeStream.PassThrough(), app);
  const ended = new Promise<void>((resolve) => input.once("end", resolve));
  input.end();
  await ended;
  expect(app.quit).toHaveBeenCalledOnce();
});
