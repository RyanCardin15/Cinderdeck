import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import * as C from "@cinderdeck/contracts/deckhand/linkedWorkRpc";
import { EnvironmentId } from "@cinderdeck/contracts";
import { useAtomCommand } from "../state/use-atom-command";
import { resolveLinkedWork } from "../deckhand/state";
import { buildThreadRouteParams } from "../threadRoutes";
const isLinkedWorkError = Schema.is(C.LinkedWorkError);
const isTarget = Schema.is(C.LinkedWorkTarget);
export const Route = createFileRoute("/_chat/linked-work")({
  validateSearch: (value: Record<string, unknown>): { target?: C.LinkedWorkTarget } => {
    const keys = Object.keys(value);
    const generation =
      typeof value.generation === "string" && /^[1-9][0-9]{0,8}$/.test(value.generation)
        ? Number(value.generation)
        : value.generation;
    const target = { ...value, generation };
    return keys.length === 6 && isTarget(target) ? { target } : {};
  },
  component: LinkedWorkDestination,
});
function LinkedWorkDestination() {
  const { target } = Route.useSearch();
  const resolve = useAtomCommand(resolveLinkedWork, { reportFailure: false });
  const navigate = useNavigate();
  const [message, setMessage] = useState("Checking this saved conversation…");
  const [attempt, setAttempt] = useState(0);
  const [resolved, setResolved] = useState<C.LinkedWorkResolution | null>(null);
  useEffect(() => {
    let active = true;
    if (!target) {
      return;
    }
    void resolve({ environmentId: EnvironmentId.make(target.environment), input: target }).then(
      (result) => {
        if (!active) return;
        if (result._tag !== "Success") {
          const cause = Cause.squash(result.cause);
          setMessage(
            isLinkedWorkError(cause)
              ? cause.message
              : "The saved conversation could not be found in this environment. Reconnect or select its workspace.",
          );
          return;
        }
        setResolved(result.value);
        if (result.value.nativeAvailable) {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams({
              environmentId: EnvironmentId.make(target.environment),
              threadId: target.thread,
            }),
            replace: true,
          });
        } else
          setMessage(
            "The workspace is unavailable or has been replaced. You can still open this saved conversation to review its history.",
          );
      },
    );
    return () => {
      active = false;
    };
  }, [target, resolve, navigate, attempt]);
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-10">
      <p className="text-xs uppercase tracking-widest text-muted-foreground">
        Cinderdeck · Linked work
      </p>
      <h1 className="text-2xl font-semibold">Return to your conversation</h1>
      <p role="status" className="text-muted-foreground">
        {message}
      </p>
      {target && !resolved ? (
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          Check connection again
        </button>
      ) : null}
      {resolved ? (
        <Link
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams({
            environmentId: EnvironmentId.make(resolved.target.environment),
            threadId: resolved.target.thread,
          })}
        >
          Open saved conversation
        </Link>
      ) : null}
      <Link to="/workspaces" search={target ? { context: target.workspace } : {}}>
        Open Workspaces
      </Link>
    </main>
  );
}
