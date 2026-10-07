import {
  EnvironmentAuthorizationError,
  type AuthEnvironmentScope,
  type AuthSessionId,
} from "@cinderdeck/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { SessionStore } from "./SessionStore.ts";

export const authorizeSessionScope = <A, E, R>(
  sessions: SessionStore["Service"],
  sessionId: AuthSessionId,
  requiredScope: AuthEnvironmentScope,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | EnvironmentAuthorizationError, R> => {
  const denied = () =>
    new EnvironmentAuthorizationError({
      message: `The authenticated session is inactive or missing required scope: ${requiredScope}.`,
      requiredScope,
    });
  return sessions.getActive(sessionId).pipe(
    Effect.mapError(denied),
    Effect.flatMap((active): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
      Option.isSome(active) && active.value.scopes.includes(requiredScope)
        ? effect
        : Effect.fail(denied()),
    ),
  );
};

/** Subscribe first, then check persistence: a revoke during upgrade cannot be missed.
 * Interrupt the complete transport scope, including streams and pending handlers.
 * Connected expiry/renewal semantics remain those of SessionStore.getActive.
 */
export const withActiveWebSocketSession = <A, E, R>(
  sessions: SessionStore["Service"],
  sessionId: AuthSessionId,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* sessions.subscribeChanges;
      const active = yield* sessions
        .getActive(sessionId)
        .pipe(Effect.catch(() => Effect.interrupt));
      if (Option.isNone(active)) return yield* Effect.interrupt;
      const revoked = Stream.fromSubscription(changes).pipe(
        Stream.filter(
          (change) => change.type === "clientRemoved" && change.sessionId === sessionId,
        ),
        Stream.runHead,
        Effect.andThen(Effect.interrupt),
      );
      return yield* effect.pipe(Effect.raceFirst(revoked));
    }),
  );
