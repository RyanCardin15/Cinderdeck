import { describe, expect, it } from "@effect/vitest";

import { echoesUserRequest } from "./agentBrief.ts";

const request =
  "Review the Excel import data integrity PRs. Create this in a new lane so the primary checkout stays clean.";

describe("echoesUserRequest", () => {
  it("rejects the user's message regardless of case and whitespace", () => {
    expect(echoesUserRequest(`  ${request.toUpperCase()}\n`, [request])).toBe(true);
    expect(echoesUserRequest("Do it in a new lane", ["do it in a  new lane"])).toBe(true);
  });

  it("rejects a brief that is mostly the user's message", () => {
    expect(echoesUserRequest(`Continue with this task: ${request}`, [request])).toBe(true);
  });

  it("accepts the agent's own brief", () => {
    expect(
      echoesUserRequest(
        "Review PRs 412-414 for the Excel import. ExecuteValidationInParallelAsync was removed in 413; confirm row-level errors still reach the summary, then report findings.",
        [request],
      ),
    ).toBe(false);
  });

  it("accepts a long brief that only quotes the request among its own findings", () => {
    const brief = `${"Findings so far: the importer drops validation errors when batches overlap. ".repeat(3)}Original ask: ${request}`;
    expect(echoesUserRequest(brief, [request])).toBe(false);
  });

  it("does not treat a short request inside a brief as an echo", () => {
    expect(echoesUserRequest("Fix the bug in the importer's date parser.", ["fix the bug"])).toBe(
      false,
    );
  });
});
