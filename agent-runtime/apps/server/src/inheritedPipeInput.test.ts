// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeURL from "node:url";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@cinderdeck/shared/hostProcess";
import { openInheritedPipeInput } from "./inheritedPipeInput.ts";

const platform = HostProcessPlatform.defaultValue();
const fixture = NodeURL.fileURLToPath(
  new URL("./testing/desktopPipeShutdown.fixture.mjs", import.meta.url),
);
class ChildLifecycleFailed extends Schema.TaggedError<ChildLifecycleFailed>()(
  "ChildLifecycleFailed",
  { cause: Schema.Defect() },
) {}
const within = <A>(promise: Promise<A>, timeoutMs: number) =>
  Effect.tryPromise({
    try: () => promise,
    catch: (cause) => new ChildLifecycleFailed({ cause }),
  }).pipe(Effect.timeout(timeoutMs));

it("leaves regular file ownership and the Windows fallback to the existing file stream", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "deckhand-pipe-file-"));
  const file = NodePath.join(directory, "input.ndjson");
  NodeFS.writeFileSync(file, "regular file\n");
  const fd = NodeFS.openSync(file, "r");
  try {
    expect(openInheritedPipeInput(fd, platform)).toBeUndefined();
    expect(openInheritedPipeInput(fd, "win32")).toBeUndefined();
    expect(NodeFS.readFileSync(fd, "utf8")).toBe("regular file\n");
    expect(NodeFS.fstatSync(fd).isFile()).toBe(true);
  } finally {
    NodeFS.closeSync(fd);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
  expect(() => NodeFS.fstatSync(fd)).toThrow();
});

it.live.skipIf(platform === "win32")(
  "reaps and restarts a gracefully stopped receiver while parent pipe writers remain open",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "deckhand-pipe-shutdown-")),
      ),
      (directory) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 2; attempt++) {
            const child = NodeChildProcess.spawn(
              process.execPath,
              [fixture, directory, attempt === 1 ? "eof" : "open"],
              { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] },
            );
            let errors = "";
            child.stderr?.on("data", (chunk) => {
              errors += String(chunk);
            });
            const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
              (resolve, reject) => {
                child.once("error", reject);
                child.once("exit", (code, signal) => resolve({ code, signal }));
              },
            );
            yield* Effect.acquireUseRelease(
              Effect.succeed(child),
              () =>
                Effect.gen(function* () {
                  const ready = new Promise<void>((resolve, reject) => {
                    let output = "";
                    child.stdout?.on("data", (chunk) => {
                      output += String(chunk);
                      if (output.includes("ready\n")) resolve();
                    });
                    child.once("error", reject);
                    child.once("exit", () =>
                      reject(new Error(`Child exited before ready: ${errors}`)),
                    );
                  });
                  const bootstrap = child.stdio[3];
                  const telemetry = child.stdio[4];
                  if (
                    !(bootstrap instanceof NodeStream.Writable) ||
                    !(telemetry instanceof NodeStream.Writable)
                  )
                    throw new Error("Missing task-owned inherited pipe writers");
                  // Keep parent writers open, as the desktop does while awaiting exit.
                  bootstrap.write('{"mode":"desktop"}\n');
                  telemetry.write('{"version":1,"type":"desktopTelemetry');
                  telemetry.write('Hello","electronPid":123}\n');
                  yield* within(ready, 5_000);
                  if (attempt === 1) {
                    const ended = new Promise<void>((resolve) => {
                      child.stdout?.on("data", (chunk) => {
                        if (String(chunk).includes("eof observed\n")) resolve();
                      });
                    });
                    telemetry.end();
                    yield* within(ended, 2_000);
                  }
                  const startedAt = performance.now();
                  expect(child.kill("SIGTERM")).toBe(true);
                  expect(yield* within(exited, 2_000)).toEqual({ code: 130, signal: null });
                  const gracefulExitMs = performance.now() - startedAt;
                  expect(gracefulExitMs).toBeLessThan(2_000);
                  yield* Effect.logInfo("Inherited pipe graceful shutdown", {
                    attempt,
                    gracefulExitMs,
                    parentBootstrapWriterOpen: true,
                    parentTelemetryWriterOpen: attempt === 0,
                  });
                  expect(NodeFS.readFileSync(NodePath.join(directory, "cleanup.txt"), "utf8")).toBe(
                    "cleanup complete\n".repeat(attempt + 1),
                  );
                }),
              () =>
                Effect.gen(function* () {
                  // Only reaps this fixture's captured process if a regression leaves it alive.
                  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
                  child.stdio[3]?.destroy();
                  child.stdio[4]?.destroy();
                  yield* within(exited, 2_000);
                }),
            );
          }
        }),
      (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    ),
  15_000,
);
