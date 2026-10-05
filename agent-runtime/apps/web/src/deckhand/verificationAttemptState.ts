import {
  ATTEMPT_METHODS,
  type VerificationAttempt,
} from "@cinderdeck/contracts/deckhand/verificationAttemptsRpc";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@cinderdeck/client-runtime/state/runtime";
import { Atom } from "effect/unstable/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
export const previewAttempt = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:verificationAttempt:preview",
  tag: ATTEMPT_METHODS.preview,
});
export const startAttempt = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:verificationAttempt:start",
  tag: ATTEMPT_METHODS.start,
});
export const getAttempt = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:verificationAttempt:get",
  tag: ATTEMPT_METHODS.get,
});
export const listAttempts = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:verificationAttempt:list",
  tag: ATTEMPT_METHODS.list,
});
export const advanceAttempt = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:verificationAttempt:advance",
  tag: ATTEMPT_METHODS.advance,
});

// Only mounted while an existing saved action needs reconciliation. A departed
// environment/attempt releases its read instead of queuing stale GET commands.
const attemptStatusQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "deckhand:verificationAttempt:pending",
  tag: ATTEMPT_METHODS.get,
  staleTimeMs: 0,
  idleTtlMs: 0,
});
// Refresh only after the previous exact GET settles. The generic interval
// forces a refresh even while waiting, which can interrupt a slow native read.
const observedAttemptQuery = Atom.family((source: ReturnType<typeof attemptStatusQuery>) =>
  Atom.make((get) => {
    const result = get(source);
    if (result._tag !== "Initial" && !result.waiting) {
      const timer = setTimeout(() => get.refresh(source), 3000);
      get.addFinalizer(() => clearTimeout(timer));
    }
    return result;
  }).pipe(Atom.setIdleTTL(0)),
);
export const pendingAttemptView: typeof attemptStatusQuery = (target) =>
  observedAttemptQuery(attemptStatusQuery(target));
export const needsAttemptObservation = (
  attempt: Pick<VerificationAttempt, "phase" | "pendingAction">,
) =>
  !["completed", "cancelled"].includes(attempt.phase) &&
  (attempt.pendingAction !== null ||
    ["preparing", "launching", "checking", "finalizing", "unknown"].includes(attempt.phase));
