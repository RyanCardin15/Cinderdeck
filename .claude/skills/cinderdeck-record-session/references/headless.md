# Headless recording for agents

Use this for a browser flow that needs no visible window. Cinderdeck must be running on macOS with Chrome, Chromium, or Edge installed. It needs neither Screen Recording permission nor Node/Playwright for its built-in page controls.

## Choose the shortest suitable path

| Need | Use |
| --- | --- |
| A few page interactions and visual checks | `repro start --headless URL`, then `repro browser` (MCP `start_repro_recording`, `repro_browser`) |
| An existing Chromium automation session | `--cdp HTTP_ENDPOINT`; pass `--page-id ID` when more than one page exists |
| A repeatable flow with robust locators, forms, or navigation | A configured Playwright task through `repro run WORKSPACE TASK --headless about:blank --wait`; see the [existing-page recipe](browser-recipes.md#headless-playwright-task-with-video-and-synchronized-logs) |
| Firefox, WebKit, native menus, or several windows | A visible-window or display recording using the main skill |

Prefer the installed MCP tools when available; the CLI has the same functionality. Check `repro_status` once before starting. List workspaces only when the requested log scope is not already known. Do not list windows or request screen permission for headless capture.

## Interactive flow

CLI example (substitute the actual URL, workspace, and observed selector):

```bash
cinderdeck repro start --headless http://localhost:3000 --workspace shop --title "Checkout" --max 120
cinderdeck repro browser
cinderdeck repro mark "Click Pay"
cinderdeck repro browser --no-screenshot --evaluate "document.querySelector('[data-testid=pay]').click()"
# Wait for the expected result, then inspect a visual checkpoint.
cinderdeck repro browser
# Mark pass only after verifying the receipt; otherwise mark fail with the observation.
cinderdeck repro mark "Receipt visible" --pass
cinderdeck repro stop
cinderdeck repro frame <repro-id> --at end --out /tmp/receipt.jpg
cinderdeck repro export <repro-id> --zip
```

Keep the `repro` id returned by start. Use it for saved frames, logs, and export instead of relying on `latest`, which can change. Stop returns `video`, `logFile`, the verdict, and error/marker times. A nonzero stop exit can mean a failed recorded check with useful saved artifacts; read its JSON before deciding recording failed.

MCP equivalents: `start_repro_recording` with `headless`, `workspace`, `title`, and `max_seconds`; `repro_browser` without arguments to inspect; `expression` to act or read a value; `url` to navigate. Set `screenshot: false` for actions and data checks. `mark_repro`, `stop_repro_recording`, `repro_frame`, and `export_repro` work as usual. Navigation begins loading but does not promise the next element is ready.

## Wait for evidence, with fewer tool calls

Start returns after writing the first video frame. A fixed startup sleep is unnecessary. Wait for the specific result the next step needs, using Playwright locators or one bounded Promise inside `repro_browser`. Avoid repeatedly requesting screenshots to poll readiness.

For example, pass this as `expression` with `screenshot: false` (CLI `--evaluate` and `--no-screenshot`), adapting the selector and expected text to the page:

```js
(async () => {
  const deadline = performance.now() + 8000;
  while (performance.now() < deadline) {
    const receipt = document.querySelector('[data-testid=receipt]');
    if (receipt?.innerText.includes('Confirmed') && receipt.getClientRects().length) {
      return { confirmed: true, text: receipt.innerText };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Visible receipt did not appear within 8 seconds');
})()
```

Expressions have a ten-second runtime limit. A rejected expression adds a failed recording check, so use a throwing wait for an actual expectation. For a tentative read that may legitimately find nothing, return a boolean or null. Full navigation can replace the JavaScript context; use Playwright for flows requiring reliable waits across navigation.

- Take screenshots at visual checkpoints: initial state when useful, the result of an important action, and a failure. Use `--no-screenshot` / `screenshot: false` for intermediate actions and small data reads. This does not pause or reduce the saved video.
- Return the few values needed for a decision, rather than a whole DOM or large object. Inspection already bounds text and controls; expression results are capped at 512 KB.
- Use an observed selector or Playwright role/label locator. Do not invent selectors or assume the first button is the intended action.
- Perform actions in order. Bundle small related reads in one expression; don't run competing navigation, click, or stop commands concurrently.
- Use the default 1280×720 viewport unless the scenario requires another size. Request a larger viewport only for layout coverage or needed detail; encoded video is limited to 1920×1080 and up to 30 fps.
- For a configured task, use `--wait` / `wait_for_repro` instead of polling status. Let Cinderdeck record the video; do not also enable Playwright video or duplicate automatically captured console/network logs.
- Review saved frames at the result and relevant errors, preferably in one request. A live screenshot alone does not prove the saved video contains the result.

## Browser ownership and scope

- `headless` launches a fresh temporary profile; Cinderdeck closes it and removes the profile after stop/cancel. Chrome, Chromium, and Edge are detected; override with `--browser-executable /absolute/path/to/chromium` (`browser_executable`).
- `cdp` takes an HTTP(S) debugging endpoint, such as `http://127.0.0.1:9222`. The browser must already have remote debugging enabled. Get page ids from `/json/list`; pass `--page-id` (`page_id`) if several actual page targets exist. Cinderdeck preserves its viewport and leaves the caller's browser open after stop/cancel.
- Start/status return `browser.endpoint` and `browser.pageId`. Automation must drive that exact page, not create another page or context. Only one page is recorded, without audio, other tabs, popups, browser chrome, or native menus.
- `--width` / `--height` (`browser_width` / `browser_height`) configure launched viewports; attached viewports are preserved. Dimensions stay fixed in the output if the page resizes.
- Workspace scope is unchanged: narrow it with `--workspace`, or use `--no-logs` / `logs: false` to omit workspace output. Browser console, uncaught exceptions, request failures, HTTP 4xx/5xx, and markers remain. Network summaries omit bodies, headers, credentials, and URL query values; console text uses existing workspace secret redaction.
- `repro pause` / `resume` (MCP `pause_repro_recording` / `resume_repro_recording`) pause the video timeline. Logs continue as offscreen context; the wall-clock maximum duration still applies.

## Recover without losing evidence

| Result | Next step |
| --- | --- |
| `busy` | Inspect status; do not stop someone else's recording. |
| `browser_missing` | Use an existing compatible executable or install Chromium; do not repeat the same failing launch. |
| Several pages / missing page id | Read `/json/list` and choose the intended page explicitly. |
| JavaScript action or readiness expectation failed | Inspect the page and relevant logs, then stop and save. Do not blindly repeat submissions or turn the failed check into a pass. |
| Browser disconnected | Read the returned repro id or status/library once; available evidence is saved automatically with a failed check. |
| Unknown `--headless` or MCP property | The running app is older than the skill. Update the app before retrying; a headed-window recording is an alternative when it fits the user's request. |

Stop before closing an attached page. Use cancel only when discarding your own attempt is intended; failures are usually worth preserving. Report the actual verdict and the saved video/log/export paths.
