import { expect } from "e2e";

import { test, WEB } from "./cinderdeck.ts";

test(
  "A seeded thread opens by its link and shows its history",
  WEB,
  async ({ cinderdeck, app, screen }) => {
    const project = await cinderdeck.project("demo");
    const thread = await cinderdeck.thread({
      project,
      title: "Earlier work",
      messages: ["first", "second"],
    });
    await cinderdeck.open(thread);

    await expect(screen.getByText("second fixture turn complete", { exact: false })).toBeVisible();
    await app.screenshot("thread");
  },
);
