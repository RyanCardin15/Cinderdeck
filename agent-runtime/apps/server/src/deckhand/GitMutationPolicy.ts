import { GitCommandError } from "@cinderdeck/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as WorkspaceBackend from "./WorkspaceBackend.ts";
import * as CheckoutMutations from "./CheckoutMutations.ts";

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
interface MutationAuthority {
  readonly input: CheckoutMutations.MutationInput;
  readonly isActive: () => boolean;
}
const Authorized = Context.Reference<ReadonlyArray<MutationAuthority>>(
  "t3/deckhand/GitMutationAuthorization",
  { defaultValue: () => [] },
);
const Capture = Context.Reference<{ readonly cwd: string; readonly index: string } | null>(
  "t3/deckhand/GitCheckpointCapture",
  { defaultValue: () => null },
);

const commandArgs = (args: ReadonlyArray<string>) => {
  let offset = 0;
  let gitDirectory: string | undefined;
  let invalid = false;
  while (args[offset]?.startsWith("-")) {
    const arg = args[offset];
    if (arg === "-c" && args[offset + 1]?.includes("=")) {
      if (/^(?:core\.(?:worktree|bare)|extensions\.worktreeConfig)=/i.test(args[offset + 1]!))
        invalid = true;
      offset += 2;
    } else if (arg === "--git-dir" && args[offset + 1]) {
      gitDirectory = args[offset + 1];
      offset += 2;
    } else if (["--no-pager", "--literal-pathspecs"].includes(arg!)) offset++;
    else {
      invalid = true;
      break;
    }
  }
  return { args: args.slice(offset), gitDirectory, invalid };
};
const readOnly = (args: ReadonlyArray<string>): boolean => {
  const [command, ...tail] = args;
  if (
    [
      "status",
      "diff",
      "log",
      "show",
      "rev-parse",
      "rev-list",
      "ls-files",
      "ls-tree",
      "ls-remote",
      "cat-file",
      "check-ignore",
      "check-attr",
      "for-each-ref",
      "merge-base",
      "name-rev",
      "describe",
      "show-ref",
    ].includes(command ?? "")
  )
    return true;
  if (tail.length === 1 && ["-h", "--help"].includes(tail[0]!)) return true;
  if (command === "symbolic-ref")
    return (
      !tail.includes("--delete") &&
      !tail.includes("-d") &&
      tail.filter((arg) => !arg.startsWith("-")).length === 1
    );
  if (command === "tag")
    return (
      tail.length === 0 ||
      ((tail.includes("--list") || tail.includes("-l")) &&
        !tail.includes("--delete") &&
        !tail.includes("-d"))
    );
  if (command === "config")
    return (
      !tail.some((arg) =>
        [
          "--add",
          "--replace-all",
          "--unset",
          "--unset-all",
          "--rename-section",
          "--remove-section",
          "--edit",
          "-e",
        ].includes(arg),
      ) &&
      (tail.some((arg) =>
        ["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l"].includes(arg),
      ) ||
        tail.filter((arg) => !arg.startsWith("-")).length === 1)
    );
  if (command === "branch")
    return (
      !tail.some((arg) =>
        /^(?:-[dDmMcC]|--(?:delete|move|copy|set-upstream-to|unset-upstream))/.test(arg),
      ) &&
      (tail.length === 0 ||
        tail.includes("--show-current") ||
        ((tail.includes("--list") ||
          tail.includes("-l") ||
          tail.includes("-a") ||
          tail.includes("-r")) &&
          !tail.some((arg) =>
            /^(?:-[dDmMcC]|--(?:delete|move|copy|set-upstream-to|unset-upstream))/.test(arg),
          )))
    );
  if (command === "remote")
    return (
      tail.length === 0 ||
      (tail.length === 1 && ["-v", "--verbose"].includes(tail[0]!)) ||
      ["get-url", "show"].includes(tail[0] === "-v" ? (tail[1] ?? "") : (tail[0] ?? ""))
    );
  if (command === "worktree") return tail[0] === "list";
  if (command === "stash") return ["list", "show"].includes(tail[0] ?? "");
  if (command === "submodule") return tail[0] === "status";
  if (command === "sparse-checkout") return tail[0] === "check-rules" || tail[0] === "list";
  return false;
};
const make = Effect.gen(function* () {
  const mutations = yield* CheckoutMutations.CheckoutMutations;
  const run: Policy["execute"] = (input, effect) =>
    Effect.gen(function* () {
      const parsed = commandArgs(input.args);
      const args = parsed.args;
      const [command, ...tail] = args;
      const capture = yield* Capture;
      // This authority is installed only around the driver's actual capture. A
      // command's operation label alone never exempts a working-tree mutation.
      const privateCapture =
        capture?.cwd === input.cwd &&
        ((["read-tree", "add", "write-tree"].includes(command ?? "") &&
          input.env?.GIT_INDEX_FILE === capture.index &&
          !tail.includes("-u")) ||
          command === "commit-tree" ||
          (command === "update-ref" &&
            /^refs\/t3\/(?:checkpoints|orchestration-v2\/checkpoints)\//.test(tail[0] ?? "") &&
            tail.length === 2));
      if (parsed.invalid)
        return yield* new GitCommandError({
          operation: input.operation,
          command: "git",
          cwd: input.cwd,
          detail: "Git checkout selection could not be verified.",
        });
      if (readOnly(args) || privateCapture) return yield* effect;
      if (input.env?.GIT_DIR || input.env?.GIT_WORK_TREE || input.env?.GIT_COMMON_DIR)
        return yield* new GitCommandError({
          operation: input.operation,
          command: "git",
          cwd: input.cwd,
          detail: "Checkout mutation requires the checkout's own Git metadata.",
        });
      const mutation: CheckoutMutations.MutationInput = {
        cwd: input.cwd,
        sharedRefs:
          ![
            "add",
            "restore",
            "clean",
            "read-tree",
            "write-tree",
            "checkout-index",
            "apply",
          ].includes(command ?? "") && !(command === "reset" && tail.includes("--")),
        worktreeLifecycle: command === "worktree",
        ...(parsed.gitDirectory === undefined ? {} : { gitDirectory: parsed.gitDirectory }),
      };
      return yield* guarded(mutation, input.operation, effect);
    });
  const guarded = <A, E, R>(
    input: CheckoutMutations.MutationInput,
    operation: string,
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const authorized = yield* Authorized;
      if (
        authorized.some(
          (authority) =>
            authority.isActive() &&
            authority.input.cwd === input.cwd &&
            (!input.sharedRefs || authority.input.sharedRefs) &&
            (!input.worktreeLifecycle || authority.input.worktreeLifecycle),
        )
      )
        return yield* effect;
      let active = true;
      const authority = { input, isActive: () => active };
      return yield* mutations
        .run(
          input,
          effect.pipe(
            Effect.provideService(Authorized, [...authorized, authority]),
            // A child can inherit FiberRefs and outlive this effect. Its inherited
            // authority must expire when the operation ends.
            Effect.onExit(() =>
              Effect.sync(() => {
                active = false;
              }),
            ),
          ),
        )
        .pipe(
          Effect.catchIf(Schema.is(CheckoutMutations.CheckoutMutationError), (error) =>
            Effect.fail(
              new GitCommandError({
                operation,
                command: "git",
                cwd: input.cwd,
                detail:
                  error.reason === "native_lifecycle"
                    ? "Manage this checkout's worktrees through its Cinderdeck workspace."
                    : "Checkout ownership could not be verified. Refresh its workspace connection before changing Git or restoring files.",
              }),
            ),
          ),
        );
    });
  return {
    managed: true,
    lifecycle: (operation, cwd, effect) =>
      guarded({ cwd, sharedRefs: true, worktreeLifecycle: true }, operation, effect),
    createdCheckout: (cwd, effect) =>
      Effect.gen(function* () {
        const authorized = yield* Authorized;
        const lifecycle = authorized.findLast(
          (authority) => authority.isActive() && authority.input.worktreeLifecycle,
        );
        return yield* mutations
          .includeCheckout(
            cwd,
            effect.pipe(
              Effect.provideService(Authorized, [
                ...authorized,
                {
                  input: { cwd, sharedRefs: true, worktreeLifecycle: true },
                  isActive: () => lifecycle?.isActive() ?? false,
                },
              ]),
            ),
          )
          .pipe(
            Effect.catchIf(Schema.is(CheckoutMutations.CheckoutMutationError), (error) =>
              Effect.fail(
                new GitCommandError({
                  operation: "GitVcsDriver.createWorktree.includeCheckout",
                  command: "git",
                  cwd,
                  detail:
                    "Identity of the new worktree could not be verified. Its files were kept for recovery.",
                }),
              ),
            ),
          );
      }),
    execute: run,
    rollback: (cwd, effect) =>
      guarded({ cwd, sharedRefs: true }, "orchestrationV2.checkpointRollback.execute", effect),
    restore: (cwd, effect) =>
      guarded({ cwd, sharedRefs: false }, "GitVcsDriver.checkpoints.restoreCheckpoint", effect),
    capture: (cwd, index, effect) => effect.pipe(Effect.provideService(Capture, { cwd, index })),
  } satisfies Policy;
});
export const layer = Layer.effect(GitMutationPolicy, make);
export const layerLive = layer.pipe(
  Layer.provide(CheckoutMutations.layer.pipe(Layer.provide(WorkspaceBackend.layerLive))),
);
