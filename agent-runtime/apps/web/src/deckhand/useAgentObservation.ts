import { useState } from "react";
import type { EnvironmentId } from "@cinderdeck/contracts";
import { useEnvironment } from "../state/environments";

/** Cached rows stay historical until the reconnected transport delivers a new value. */
export function useAgentObservation(
  environmentId: EnvironmentId | null,
  scope: string,
  value: unknown,
) {
  const environment = useEnvironment(environmentId);
  const connected = environment?.connection.phase === "connected";
  const key = JSON.stringify([environmentId, scope]);
  const [previous, setPrevious] = useState(() => ({ key, value, waiting: !connected }));
  // Adjust only this hook's own previous-render checkpoint. This prevents a
  // cached Success from becoming current during the reconnect render itself.
  if (previous.key !== key) setPrevious({ key, value, waiting: !connected });
  else if (!connected && (!previous.waiting || previous.value !== value))
    setPrevious({ key, value, waiting: true });
  else if (connected && previous.waiting && previous.value !== value)
    setPrevious({ key, value: null, waiting: false });
  const awaitingFreshValue = previous.key === key && previous.waiting && previous.value === value;
  return {
    stale: !connected || awaitingFreshValue,
    reconnecting:
      environment?.connection.phase === "connecting" ||
      environment?.connection.phase === "reconnecting" ||
      (connected && awaitingFreshValue),
  };
}
