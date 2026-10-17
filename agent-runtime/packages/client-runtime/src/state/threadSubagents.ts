/**
 * The subagent roster for one turn, and the compact label the mobile composer
 * pill renders for it.
 *
 * Includes the current run and agents still working from previous turns.
 * This stays a pure fold over the v2 projection runs and subagents.
 */
import * as DateTime from "effect/DateTime";
import type {
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
} from "@cinderdeck/contracts";
import { copySorted } from "@cinderdeck/shared/Array";

import { isActiveSubagentStatus, isTerminalSubagentStatus } from "./subagentRuntime.ts";
import { resolveActiveThreadRun } from "./threadWorkflows.ts";

type Projection = OrchestrationV2ThreadProjection;
type Subagent = OrchestrationV2Subagent;
type RunId = Projection["runs"][number]["id"];

export interface ThreadTurnSubagents {
  /** The run the roster belongs to: the active one, else the most recent one that spawned agents. */
  readonly runId: RunId | null;
  readonly turnActive: boolean;
  /** Spawn order: startedAt, falling back to updatedAt for agents that never started. */
  readonly subagents: ReadonlyArray<Subagent>;
  readonly liveCount: number;
  readonly settledCount: number;
}

export interface SubagentPillSegment {
  readonly label: string;
  readonly accessibilityLabel: string;
}

function orderKey(subagent: Subagent): number {
  return DateTime.toEpochMillis(subagent.startedAt ?? subagent.updatedAt);
}

/**
 * The agents behind the thread's agents pill and sheet: every agent of the active run (or, once
 * the thread is idle, of the run the most recently updated agent belongs to), plus any agent
 * still working from another run. A background agent outlives the turn that launched it, and the
 * Waiting strip counts it, so the pill has to count it and the sheet has to reach it too. Agents
 * of rolled-back runs stay out, as they do from the strip.
 */
export function deriveThreadTurnSubagents(
  projection: Pick<Projection, "runs" | "subagents">,
): ThreadTurnSubagents | null {
  const rolledBackRunIds = new Set(
    projection.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
  );
  const eligible = projection.subagents.filter(
    (subagent) => subagent.runId === null || !rolledBackRunIds.has(subagent.runId),
  );
  const [first] = eligible;
  if (first === undefined) return null;
  const activeRun = resolveActiveThreadRun(projection);
  const latestUpdated = eligible.reduce(
    (latest, subagent) =>
      DateTime.toEpochMillis(subagent.updatedAt) > DateTime.toEpochMillis(latest.updatedAt)
        ? subagent
        : latest,
    first,
  );
  const runId = activeRun?.id ?? latestUpdated.runId;
  const subagents = copySorted(
    eligible.filter(
      (subagent) => subagent.runId === runId || isActiveSubagentStatus(subagent.status),
    ),
    (left, right) => orderKey(left) - orderKey(right) || left.id.localeCompare(right.id),
  );
  if (subagents.length === 0) return null;

  let liveCount = 0;
  let settledCount = 0;
  for (const subagent of subagents) {
    if (isActiveSubagentStatus(subagent.status)) liveCount += 1;
    else if (isTerminalSubagentStatus(subagent.status)) settledCount += 1;
  }
  return { runId, turnActive: activeRun !== null, subagents, liveCount, settledCount };
}

/**
 * What the pill's agents segment says, or null while it should stay hidden.
 * The segment is for work in flight: once the turn settles it goes away
 * rather than leaving a stale count above the composer.
 */
export function resolveSubagentPillSegment(
  turn: ThreadTurnSubagents | null,
): SubagentPillSegment | null {
  if (turn === null) return null;
  if (!turn.turnActive && turn.liveCount === 0) return null;
  const total = turn.subagents.length;
  if (turn.liveCount > 0) {
    return {
      label: `${turn.liveCount}/${total}`,
      accessibilityLabel: `${turn.liveCount} of ${total} agents working`,
    };
  }
  return {
    label: `${total} done`,
    accessibilityLabel: `${total} ${total === 1 ? "agent" : "agents"} done`,
  };
}
