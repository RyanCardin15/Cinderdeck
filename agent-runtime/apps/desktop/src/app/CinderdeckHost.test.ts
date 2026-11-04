// @effect-diagnostics-next-line nodeBuiltinImport:off -- The native host passes Node stdin and stdout pipes.
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { expect, it, vi } from "vite-plus/test";
import { connectCinderdeckHost } from "./CinderdeckHost.ts";

vi.mock("electron", () => ({ app: {} }));

it("delivers queued window actions and waits for the parent to approve quitting", () => {
  const input = new PassThrough();
  const output = new PassThrough();
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
  const input = new PassThrough();
  const app = { quit: vi.fn(), hide: vi.fn() };
  connectCinderdeckHost(input, new PassThrough(), app);
  const ended = once(input, "end");
  input.end();
  await ended;
  expect(app.quit).toHaveBeenCalledOnce();
});
