import type { ThreadId } from "@cinderdeck/contracts";
import * as Effect from "effect/Effect";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

// Agents tend to forward the user's request verbatim as the prompt for a new
// lane or thread. That request still says "do this in a new lane", so the
// receiving turn creates another lane, which forwards it again. A brief must
// be the agent's own description of the work, not the user's message.
const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

const RECENT_USER_MESSAGES = 3;
// Short requests are only rejected when repeated exactly; a long request
// embedded in a brief is rejected when it makes up most of that brief.
const EMBEDDED_REQUEST_MIN_LENGTH = 40;

export const echoesUserRequest = (brief: string, userMessages: ReadonlyArray<string>): boolean => {
  const candidate = normalize(brief);
  if (!candidate) return false;
  return userMessages.some((message) => {
    const request = normalize(message);
    if (!request) return false;
    return (
      candidate === request ||
      (request.length >= EMBEDDED_REQUEST_MIN_LENGTH &&
        candidate.includes(request) &&
        request.length * 2 >= candidate.length)
    );
  });
};

export const echoedBriefMessage = (field: string) =>
  `${field} repeats the user's message. Write your own self-contained brief of the work to do there: the goal, relevant findings and constraints, and what done looks like. Leave out any request to create a lane, worktree or thread; that part is already handled.`;

/** Whether `brief` repeats one of the calling thread's latest user messages. */
export const briefEchoesCaller = (
  threads: ThreadManagementService.ThreadManagementService["Service"],
  threadId: ThreadId,
  brief: string,
) =>
  threads.getThreadRecords(threadId, ["messages"], { messageRoles: ["user"] }).pipe(
    Effect.map((records) =>
      echoesUserRequest(
        brief,
        records.messages
          .filter((message) => message.createdBy !== "agent")
          .slice(-RECENT_USER_MESSAGES)
          .map((message) => message.text),
      ),
    ),
    // The check guards against a prompt loop; an unreadable history must not
    // block a handoff or launch the rest of the request already validated.
    Effect.orElseSucceed(() => false),
  );
