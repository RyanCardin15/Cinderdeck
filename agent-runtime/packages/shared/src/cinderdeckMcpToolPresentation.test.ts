import { describe, expect, it } from "vite-plus/test";

import { CINDERDECK_MCP_TOOL_NAMES, resolveCinderdeckMcpToolPresentation } from "./cinderdeckMcpToolPresentation.ts";

describe("resolveCinderdeckMcpToolPresentation", () => {
  it("recognizes every Cinderdeck tool across provider prefixes and completion suffixes", () => {
    for (const tool of CINDERDECK_MCP_TOOL_NAMES) {
      const presentation = resolveCinderdeckMcpToolPresentation(tool);
      for (const prefix of [
        "mcp__t3code__",
        "cinderdeck.",
        "mcp__t3-code__",
        "mcp__t3_code__",
        "mcp__t3code__",
        "Cinderdeck-code.",
        "t3_code/",
        "deckhand:",
        "mcp__deckhand__",
        "mcp_t3-code_",
        "Cinderdeck ",
        "t3-code · ",
      ]) {
        expect(resolveCinderdeckMcpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveCinderdeckMcpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });
  it("pretty prints Claude and Cursor Cinderdeck MCP tool names", () => {
    expect(resolveCinderdeckMcpToolPresentation("mcp__t3-code__t3_thread_read")).toEqual({
      displayName: "Read a Cinderdeck thread",
      logo: "t3-code",
    });
  });

  it("pretty prints Codex Cinderdeck MCP tool names", () => {
    expect(resolveCinderdeckMcpToolPresentation("t3-code.create_threads")).toEqual({
      displayName: "Create Cinderdeck threads",
      logo: "t3-code",
    });
  });

  it("pretty prints thread metadata updates", () => {
    expect(resolveCinderdeckMcpToolPresentation("mcp__t3-code__t3_thread_update")).toEqual({
      displayName: "Update Cinderdeck thread metadata",
      logo: "t3-code",
    });
  });

  it("pretty prints bare Cinderdeck MCP toolkit names", () => {
    expect(resolveCinderdeckMcpToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "t3-code",
    });
  });

  it("pretty prints worktree Cinderdeck MCP tool names", () => {
    expect(resolveCinderdeckMcpToolPresentation("mcp__t3-code__t3_worktree_handoff")).toEqual({
      displayName: "Hand off thread to a git worktree",
      logo: "t3-code",
    });
    expect(resolveCinderdeckMcpToolPresentation("t3-code.t3_worktree_status")).toEqual({
      displayName: "Get thread worktree status",
      logo: "t3-code",
    });
  });

  it("pretty prints preview Cinderdeck MCP tool names", () => {
    expect(resolveCinderdeckMcpToolPresentation("Cinderdeck-code.preview_open")).toEqual({
      displayName: "Open a page in the preview browser",
      logo: "t3-code",
    });
    expect(resolveCinderdeckMcpToolPresentation("mcp__t3-code__preview_status")).toEqual({
      displayName: "Get preview browser status",
      logo: "t3-code",
    });
  });

  it("matches the separator variants ACP registry agents emit", () => {
    for (const name of [
      "mcp_t3-code_delegate_task",
      "t3_code:delegate_task",
      "cinderdeck/delegate_task",
      "t3-code delegate_task",
      "Cinderdeck delegate_task",
      "t3-code__delegate_task",
    ]) {
      expect(resolveCinderdeckMcpToolPresentation(name)?.displayName).toBe("Delegate a child task");
    }
  });

  it("recognizes exact lane pull request reads across current and historical namespaces without branding foreign servers", () => {
    expect(CINDERDECK_MCP_TOOL_NAMES.has("deckhand_context_pull_requests")).toBe(true);
    for (const prefix of ["deckhand.", "mcp__deckhand__", "mcp__t3-code__"]) {
      expect(resolveCinderdeckMcpToolPresentation(`${prefix}deckhand_context_pull_requests`)).toEqual({
        displayName: "Read lane pull requests",
        logo: "t3-code",
      });
    }
    expect(resolveCinderdeckMcpToolPresentation("mcp__github__deckhand_context_pull_requests")).toBeNull();
  });
  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveCinderdeckMcpToolPresentation("mcp__github__search_issues")).toBeNull();
    expect(resolveCinderdeckMcpToolPresentation("t3-code.not_a_real_tool")).toBeNull();
    expect(resolveCinderdeckMcpToolPresentation("cinderdeck.not_a_real_tool")).toBeNull();
  });
});
