import { useState } from "react";

/** Keep navigation chrome while the next selection loads, never across computers.
 * Retained data is presentation-only; callers must disable its context actions.
 */
export function useNavigationSnapshot<T>(scope: string | null, value: T | null, pending: boolean) {
  const [previous, setPrevious] = useState({ scope, value });
  const retained = scope !== null && scope === previous.scope && value === null && pending;
  const visible = retained ? previous.value : value;
  if (previous.scope !== scope || previous.value !== visible) {
    setPrevious({ scope, value: visible });
  }
  return { value: visible, retained: retained && visible !== null };
}
