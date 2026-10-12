import { GitCommandError } from "@cinderdeck/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

interface Command {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
}
interface Policy {
  readonly managed: boolean;
  readonly lifecycle: <A, E, R>(
    operation: string,
    cwd: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | GitCommandError, R>;
  readonly createdCheckout: <A, E, R>(
    cwd: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | GitCommandError, R>;
  readonly execute: <A, E, R>(
    input: Command,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | GitCommandError, R>;
  readonly rollback: <A, E, R>(
    cwd: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | GitCommandError, R>;
  readonly restore: <A, E, R>(
    cwd: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | GitCommandError, R>;
  readonly capture: <A, E, R>(
    cwd: string,
    index: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}
// The upstream drivers remain reusable without a Cinderdeck database. The server
// installs layerLive before constructing either driver or per-connection layers.
export class GitMutationPolicy extends Context.Reference<Policy>("t3/deckhand/GitMutationPolicy", {
  defaultValue: () => ({
    managed: false,
    lifecycle: (_, __, effect) => effect,
    createdCheckout: (_, effect) => effect,
    execute: (_, effect) => effect,
    restore: (_, effect) => effect,
    rollback: (_, effect) => effect,
    capture: (_, __, effect) => effect,
  }),
}) {}
// Git uses its own repository locks. Sessions do not reserve checkouts or require
// native ownership approval for commits, branch changes, worktrees or checkpoints.
export const layer = Layer.succeed(GitMutationPolicy, {
  managed: false,
  lifecycle: (_, __, effect) => effect,
  createdCheckout: (_, effect) => effect,
  execute: (_, effect) => effect,
  restore: (_, effect) => effect,
  rollback: (_, effect) => effect,
  capture: (_, __, effect) => effect,
});
export const layerLive = layer;
