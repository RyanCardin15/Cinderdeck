import { expect } from "e2e";

import { test, WEB } from "./cinderdeck.ts";

test(
  "Tab moves from the add-project Git URL field to its submit button",
  WEB,
  async ({ cinderdeck, app, screen, browser }) => {
    await cinderdeck.project("demo");
    await cinderdeck.open();

    await screen.getByRole("button", "Add project").tap();
    await screen.getByText("Git URL").tap();
    await screen.getByRole("combobox").fill("https://github.com/RyanCardin15/Cinderdeck.git");
    const submit = screen.getByRole("button", "Continue (Enter)");
    await expect(submit).toBeEnabled();

    await browser.keyboard.press("Tab");
    await app.screenshot("after-tab");
    await expect(submit).toBeFocused();
  },
);
