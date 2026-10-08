import { assert, describe, it } from "@effect/vitest";

import {
  CINDERDECK_ORCHESTRATION_INSTRUCTIONS,
  cinderdeckAcpPromptWithInstructions,
  cinderdeckOrchestrationPromptForFirstRun,
  cinderdeckOrchestrationSystemPrompt,
} from "./CinderdeckOrchestrationInstructions.ts";

describe("Cinderdeck orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(CINDERDECK_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(CINDERDECK_ORCHESTRATION_INSTRUCTIONS, "ordinary top-level Cinderdeck conversations");
    assert.include(CINDERDECK_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(CINDERDECK_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(CINDERDECK_ORCHESTRATION_INSTRUCTIONS, "call `delegate_task` again");
    assert.include(
      CINDERDECK_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `t3_thread_send` on `childThreadId`",
    );
  });

  it("names the injected Cinderdeck MCP server consistently for lazy direct calls without renaming wire tool IDs", () => {
    assert.include(CINDERDECK_ORCHESTRATION_INSTRUCTIONS, "The `deckhand` MCP server");
    assert.include(
      CINDERDECK_ORCHESTRATION_INSTRUCTIONS,
      "tools.mcp__deckhand__orchestrator_capabilities({})",
    );
    assert.notInclude(CINDERDECK_ORCHESTRATION_INSTRUCTIONS, "mcp__t3_code__");
    assert.include(CINDERDECK_ORCHESTRATION_INSTRUCTIONS, "`t3_thread_launch`");
  });
  it("documents structured schedules instead of JSON strings", () => {
    assert.include(CINDERDECK_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(CINDERDECK_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(CINDERDECK_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = cinderdeckOrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasT3Mcp: true,
    });

    assert.include(injected, "<t3_code_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      cinderdeckOrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasT3Mcp: true }),
      prompt,
    );
    assert.equal(
      cinderdeckOrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasT3Mcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the Cinderdeck MCP server is attached", () => {
    assert.equal(cinderdeckOrchestrationSystemPrompt(false), undefined);
    assert.equal(cinderdeckOrchestrationSystemPrompt(true), CINDERDECK_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = cinderdeckAcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasT3Mcp: true },
    });

    assert.include(injected, "Cinderdeck interaction mode: Default");
    assert.include(injected, "Cinderdeck collaborative browser");
    assert.include(injected, "Cinderdeck orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasT3Mcp: true } as const;

    assert.equal(
      cinderdeckAcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      cinderdeckAcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "Cinderdeck interaction mode: Plan",
    );
    const withoutMcp = cinderdeckAcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: false },
    });
    assert.include(withoutMcp, "Cinderdeck interaction mode: Default");
    assert.notInclude(withoutMcp, "Cinderdeck collaborative browser");
    assert.notInclude(withoutMcp, "Cinderdeck orchestration");
  });
});
