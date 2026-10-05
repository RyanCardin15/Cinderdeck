import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { subprocessEnvironment } from "./SubprocessEnvironment.ts";

function sanitizeCommand(command: ChildProcess.Command): ChildProcess.Command {
  if (command._tag === "PipedCommand") {
    return sanitizeCommand(command.left).pipe(
      ChildProcess.pipeTo(sanitizeCommand(command.right), command.options),
    );
  }
  const environment =
    command.options.env === undefined || command.options.extendEnv
      ? { ...process.env, ...command.options.env }
      : command.options.env;
  return ChildProcess.make(command.command, command.args, {
    ...command.options,
    env: subprocessEnvironment(environment),
    // The final merged environment is sanitized; never inherit the credential again.
    extendEnv: false,
  });
}

/** Wrap the platform spawner once, retaining its lifecycle and pipeline behavior. */
export const layer = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const platform = yield* ChildProcessSpawner.ChildProcessSpawner;
    return ChildProcessSpawner.make((command) => platform.spawn(sanitizeCommand(command)));
  }),
);
