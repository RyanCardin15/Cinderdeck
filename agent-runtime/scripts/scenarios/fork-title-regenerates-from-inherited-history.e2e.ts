import { expect } from "e2e";

import { test, WEB } from "./cinderdeck.ts";

// Scenarios title with a Codex command that always fails, so reaching it is the fixed behavior;
// the bug refused first with "This thread has no messages to title yet."
test(
  "Regenerate title on a fresh fork reaches the title model with the inherited history",
  WEB,
  async ({ cinderdeck, app, screen }) => {
    const project = await cinderdeck.project("demo");
    const thread = await cinderdeck.thread({ project, title: "Earlier work", messages: ["first"] });
    await cinderdeck.open(thread);

    await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible();
    await screen.getByRole("button", "Fork from this response").first().tap();
    const forkActions = screen.getByRole("button", "Thread actions for Earlier work fork");
    await expect(forkActions).toBeVisible();

    await forkActions.tap();
    await screen.getByRole("menuitem", "Regenerate title").tap();
    await expect(screen.getByText("Failed to regenerate thread title")).toBeVisible();
    await app.screenshot("regenerate-result");
    await expect(screen.getByText("Codex CLI command", { exact: false })).toBeVisible();
  },
);
