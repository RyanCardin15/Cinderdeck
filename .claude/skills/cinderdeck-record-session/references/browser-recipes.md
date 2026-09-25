# Browser recipes

## Open a new, dedicated browser window

Open the window, let the page load, then find it with `cinderdeck repro windows` and record it by id. The examples use `http://localhost:3000`; for a worktree lane use its own URL from `cinderdeck lane env <workspace>/<branch> --export` (`CINDERDECK_URL_<SERVICE>`), since lanes run on assigned ports. The recording follows the window if it moves, but set its size up front, because the video keeps the size from the start.

**Google Chrome in a separate instance.** A fresh profile keeps it away from the user's tabs:

```bash
PROFILE="$(mktemp -d)/chrome-rec"
open -na "Google Chrome" --args --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check \
  --new-window --window-size=1440,900 --window-position=80,60 "http://localhost:3000"
sleep 3                                   # the title becomes the page title once it loads
cinderdeck repro windows localhost:3000   # take the id of the new window (order 0 is frontmost)
cinderdeck repro start --window-id <id> --title "…" --max 180
```

- If the user has a Chrome window on the same page, compare `pid`, `frame`, and `order` in the listing to tell them apart. The instance you just opened is normally frontmost.
- When you're done, quit only the instance you started. Find it by its unique `--user-data-dir`, for example `pkill -f "$PROFILE"`. Never quit the user's browser.

**Safari:**

```bash
open -a Safari "http://localhost:3000" && sleep 3
cinderdeck repro windows Safari
cinderdeck repro start --window-id <id> --title "…" --max 180
```

## Automation browsers (headed)

| Driver | Make sure | Console and network readers |
| --- | --- | --- |
| Playwright MCP | not started with `--headless`; call `browser_resize` **before** recording | `browser_console_messages`, `browser_network_requests` |
| Playwright or Puppeteer script | `headless: false`, a fixed `viewport` | `page.on('console')`, `page.on('response')` (see below) |
| Claude in Chrome | the tab you drive is the active tab in a visible window | `read_console_messages`, `read_network_requests` |
| Claude desktop built-in browser pane | it lives inside the Claude app window | use `--display main`: recording the Claude window would include the chat |

Order of operations: open or navigate → resize → wait for load → `repro windows` → `repro start --window-id` → for each action: `repro mark`, act, read the console, `repro append` → `repro stop`.

## Browser console in interactive sessions

Interactive drivers read console and network output on demand, not as a stream. After each important action, read what's new and append it:

```bash
cinderdeck repro append "[error] Uncaught TypeError: price is undefined (cart.js:42)" --source browser
cinderdeck repro append "POST http://localhost:3000/api/pay → 500" --source network --level error
```

Append only new messages, not the whole console each time. Keep the original text, so `grep` finds it later.

## Getting any other log onto the timeline

Pipe the log into `repro append`. Each line is stamped when it arrives, and the command runs until its input ends or the recording stops:

```bash
tail -n 0 -F /tmp/app.log | cinderdeck repro append --source app &
docker logs -f --since 0s api 2>&1 | cinderdeck repro append --source api &
xcrun simctl spawn booted log stream --style compact | cinderdeck repro append --source ios &
```

Stop these pipes (`kill %1` or `kill $!`) after `repro stop`.

## Scripted run with console and network logs

This is the most complete recording: a headed browser script run as a workspace task, so its stdout becomes part of the log. `browser-session.mjs`:

```js
import { chromium } from 'playwright';

// Inside a workspace task, CINDERDECK_URL_<SERVICE> is the right URL in the original checkout and in every lane.
const base = process.env.BASE_URL ?? process.env.CINDERDECK_URL_WEB ?? 'http://localhost:3000';
const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on('console', m => console.log(`[browser:${m.type()}] ${m.text()}`));
page.on('pageerror', e => console.error(`[browser] Error: ${e.message}`));
page.on('requestfailed', r => console.error(`[network] Error: ${r.method()} ${r.url()} ${r.failure()?.errorText}`));
page.on('response', r => { if (r.status() >= 400) console.log(`[network] ${r.request().method()} ${r.url()} ${r.status()}`); });

const step = async (label, fn) => { console.log(`[step] ${label}`); await fn(); };
try {
  await step('Open cart', () => page.goto(`${base}/cart`));
  await step('Click Pay', () => page.getByRole('button', { name: 'Pay' }).click());
  await step('Confirmation visible', () => page.getByText('Order confirmed').waitFor({ timeout: 10_000 }));
  await page.waitForTimeout(1000);        // keep the result on screen
} catch (e) {
  console.error(`[step] FAIL ${e.message}`);
  process.exitCode = 1;                   // a failed run makes the repro verdict Failed
} finally {
  await browser.close();
}
```

The workspace task, plus an optional workflow that starts the app first. Ask the user before you change their workspace. With the Cinderdeck MCP server, add them with `save_workspace_task` (`task: "browser-session"`, `cmd`, `repo`, `requires_services`, `timeout`) and `save_workspace_workflow` (`workflow: "e2e"`, `steps`), which validate the definition and start nothing. Otherwise add this to the workspace file (`cinderdeck services where` shows the folder), then run `cinderdeck services validate <file>`:

```toml
[tasks.browser-session]
cmd = "node scripts/browser-session.mjs"
repo = "web"
requires_services = ["web"]
timeout = 300

[workflows.e2e]
steps = ["start:web", "task:browser-session"]
```

```bash
cinderdeck repro run shop browser-session --title "Checkout flow" --wait
cinderdeck repro frame --at first_error,end
```

To record the same flow on a worktree lane, pass the lane as the workspace: `cinderdeck repro run shop/agent/codex-1 browser-session --wait`. The task runs in the lane's folder, and `CINDERDECK_URL_WEB` points at the lane's `web`.

To run it headless in CI, set `headless: true` and use `cinderdeck workspace task shop browser-session --wait` instead of `repro run`. You get the logs but no Cinderdeck video.
