---
name: cinderdeck-record-session
description: Record a browser or app session on macOS with Cinderdeck. You get a video with every action marked, plus workspace logs and browser console output on the same timeline. Use when asked to record, screen-capture, or make a repro or video of a bug, UI flow, or end-to-end test, or to prove that a change works in the browser. Covers an existing window, a new browser window, an automation browser (Playwright, Puppeteer, Claude in Chrome), the whole display, and headless browsers. Covers recording with selected workspaces or with no workspace logs.
---

# Record a session with Cinderdeck

Cinderdeck records the screen and saves a log next to the video. The log holds everything the chosen workspaces' services and tasks printed, plus any lines you add, such as the browser console. Every line is stamped with its **video time**. You drive the app and mark each action. Then you read the verdict, look at frames, and hand the user a bundle.

Use the `cinderdeck` CLI. It works the same in Claude Code, Codex, Cursor, and any shell. If the `cinderdeck` MCP server is connected, the tools map one to one:

| CLI | MCP |
| --- | --- |
| `repro status` | `repro_status` |
| `workspace list` | `list_workspaces` |
| `repro windows` | `list_repro_windows` |
| `repro start` | `start_repro_recording` |
| `repro mark` | `mark_repro` |
| `repro append` | `add_repro_logs` |
| `repro stop` / `cancel` | `stop_repro_recording` / `cancel_repro_recording` |
| `repro run <ws> <task> --wait` | `start_repro_recording` with `workspace` + `task` (or `workflow`), then `wait_for_repro` |
| `repro frame` / `logs` / `export` | `repro_frame` / `repro_logs` / `export_repro` |
| `workspace task <ws> <task> --wait` | `run_workspace_task`, then `wait_for_workspace_run` |

Every command prints JSON unless noted. To investigate a recording afterwards, including one the user made, use the `cinderdeck-review-recording` skill.

## 0. Preflight (every time)

```bash
cinderdeck repro status        # must show "recording": false. Only one recording at a time
cinderdeck workspace list      # workspace ids, if you need logs (MCP list_workspaces)
```

- `cinderdeck: command not found`: the app or its CLI link is missing. Ask the user to install Cinderdeck.
- `Could not list windows` or `needs Screen Recording permission`: tell the user to grant **Cinderdeck** access in System Settings → Privacy & Security → Screen & System Audio Recording, then relaunch Cinderdeck. You cannot grant this yourself. Do not retry in a loop.
- `busy`: someone else is recording. Do not cancel their recording. Wait, or ask the user.
- `repro status` also shows which workspaces the user's own toolbar recordings capture. That setting is theirs: change it (`repro scope`, MCP `repro_recording_scope`) only when they ask. It does not affect your recordings.
- `Unknown command "windows"` or `Unknown option --window-id`: the installed Cinderdeck is older than this skill. Fall back to `--window "<title>"` and to putting console output in mark `--detail`.

## 1. Choose the capture target

| Situation | Target |
| --- | --- |
| A browser or app window that is already open | that window, by id |
| You need a clean browser window | open a new one (see the [browser recipes](references/browser-recipes.md)), wait until it loads, then record it by id |
| Playwright MCP, Puppeteer, or a Playwright script, run **headed** | the automation window, by id (app is often `Chromium` or `Google Chrome for Testing`) |
| Claude in Chrome, or the user's own Chrome | the window of the tab you drive, by id |
| Several apps or windows, or a window that will appear after recording starts | a display: `--display main` (default) or `--display 2` |
| A workspace task or workflow that launches the browser itself | `cinderdeck repro run …` (step 6) |
| A **headless** browser | nothing to record; see [Headless browsers](#headless-browsers) |

**Record windows by id:**

```bash
cinderdeck repro windows localhost        # filters by app or title text; order 0 is frontmost
# → {"windows":[{"id":4312,"app":"Google Chrome","title":"Checkout – localhost:3000","order":0,"display":1,…}]}
cinderdeck repro start --window-id 4312 --title "Checkout with saved card" --max 180
```

- The recording **follows the window** if it moves or resizes. The video keeps the size from the start, and a resized window is scaled to fit it.
- The recording includes the window's **app**: its menus, `<select>` dropdowns, autofill popups, and sheets. Windows of other apps that pass over it are left out.
- The window must be **visible on the current Space**, not minimized. Cinderdeck's own windows never appear.
- Window ids change when a window is closed and reopened. List the windows again after you open or close a window.
- `--window "<text>"` also works. It matches the exact app name, then the exact title, then text contained in either. It takes the frontmost match, so `--window Chrome` can pick the wrong window. Prefer `--window-id`.

## 2. Choose the logs (workspace scope)

| User wants | Flag (CLI) | MCP |
| --- | --- | --- |
| One workspace | `--workspace shop` | `workspace: "shop"` |
| Several workspaces | `--workspace shop,billing` | `workspaces: ["shop", "billing"]` |
| Everything running (default) | nothing | nothing |
| **No workspace logs** (plain video) | `--no-logs` | `logs: false` |

With `--no-logs`, workspace output is not recorded, but your marks and `repro append` lines still are. If the user said "no workspace" or "just the video", use it.

**Recording a worktree lane** (a branch running beside the original checkout; see the `cinderdeck-parallel-lanes` skill): pass the lane as the workspace, `--workspace shop/agent/codex-1`, and add the original workspace too (`--workspace shop/agent/codex-1,shop`) when the lane uses its shared services such as a database. Open the **lane's** URL, not the port in the definition: take it from `cinderdeck lane list shop --json` (each service's `url`) or `cinderdeck lane env shop/agent/codex-1 --export` (`CINDERDECK_URL_<SERVICE>`). With `[lanes] hosts = true` the URL is `http://<lane>.<workspace>.localhost:<port>`, so filter `repro windows` by the lane name or port instead of `localhost`.

## 3. Record, and mark every action

```bash
cinderdeck repro start --window-id 4312 --workspace shop --title "Checkout with saved card" \
  --max 180 --note "Steps: open cart, pay with saved card"
```

- Always pass `--title` and a `--max` sized to the task. The default is 300 s and the limit is 3600 s. Recording stops by itself at the limit.
- The user sees floating controls with Pause, Mark, and Stop, and can stop you at any time.
- Wait about 1 second after `start` before the first action, so the first frames are recorded.

**Mark *before* each action**, so the marker lands on the frame just before the change. Mark again after each check:

```bash
cinderdeck repro mark "Click 'Pay'"
#   …perform the click with your browser tool…
cinderdeck repro mark "Order confirmation visible" --pass
cinderdeck repro mark "Total shows \$42.00" --fail --detail "Shows \$0.00"
```

- A plain mark is one step or action. Use `--pass` or `--fail` for a check. Any `--fail` makes the verdict **Failed**.
- Use one mark per user-visible action: navigate, click, type, submit, wait. Keep labels short and imperative. Put what you observed in `--detail`.
- Wait for network activity to settle, or for the element to appear, before you mark the result, so the frame shows the outcome.

## 4. Put browser output on the timeline

Cinderdeck captures workspace output by itself. Browser output reaches the log only if you add it:

```bash
cinderdeck repro append "Uncaught TypeError: price is undefined (cart.js:42)" --source browser
cinderdeck repro append "POST /api/pay 500" --source network --level error
some-command | cinderdeck repro append --source app      # streams each line until input ends
```

- After each important action, read the console and failed requests with your browser tool. Examples: Playwright MCP `browser_console_messages` and `browser_network_requests`; Claude in Chrome `read_console_messages` and `read_network_requests`. Then append what's new. Use `--source browser` for console output and `--source network` for requests.
- The level is detected from the text: `Error`, `TypeError`, and HTTP 5xx lines become errors, and HTTP 4xx lines become warnings. Errors count toward the verdict. Pass `--level` to override the detected level.
- Lines are stamped when they arrive. Append right after reading them, so they stay close to the action that caused them.
- MCP: `add_repro_logs` with `lines: [...]` or `text`, plus `source` and `level`.
- Read the console one last time and append it **before** you stop. A call that races the stop, or comes up to 2 minutes after it, still lands in that recording's log (the result says `"late": true`), but lines without a time are then placed at the end of the video. After that, pass `--repro <id>` (MCP `repro`).

## 5. Stop, inspect, and deliver

```bash
cinderdeck repro stop                 # verdict: clean | errors | failed; exits 1 when failed; status "failed" + detail if no video was saved
cinderdeck repro frame --first-error --out /tmp/first-error.jpg
cinderdeck repro frame --at "marker:Total shows,end"       # up to 6 moments, comma-separated
cinderdeck repro logs --around first_error --span 5 --level warning
cinderdeck repro dump --path          # the plain-text .log: every line stamped [video time  clock time]
cinderdeck repro export --zip         # ~/Downloads/Cinderdeck Repros/<title>-<date>.zip
```

- Stop **before** you close the browser or window you recorded. If it closes first, the video holds its last frame and a `Screen capture stopped` mark says so.
- **Look at the frames before claiming success.** `repro frame` returns images (MCP) or writes files (CLI `--out`). Check that the video shows what your marks claim.
- Time formats: seconds, `mm:ss.sss`, `first_error`, `last_error`, `start`, `end`, and `marker:<label prefix>`.
- Report to the user: verdict, headline, the export path, the `logFile` path, and the video timestamps of any failure.
- `cinderdeck repro cancel` discards a recording you started, for example after a mistake. It never touches a recording the user started.
- `cinderdeck repro open` opens the recording in Cinderdeck's editor with the logs synced to the playhead. Use it only when the user asks to see it.

## 6. The best result: a scripted browser run as a workspace task

For a fully repeatable session, run the browser script as a workspace task. Actions, browser console, network errors, and server logs then land on one timeline. Cinderdeck captures the script's stdout, turns each workflow step into a marker, and stops about 1.5 s after the run ends:

```bash
cinderdeck repro run shop browser-session --wait            # a task
cinderdeck repro run shop e2e --workflow --wait             # a workflow (start:web → task:browser-session)
```

- `repro run` records a **display**. The task opens the browser after recording has started, so leave out `--window` and `--window-id`. Use `--display N` for a display other than the main one.
- The script must run the browser **headed** and print browser events to stdout. See the [Playwright script and task](references/browser-recipes.md#scripted-run-with-console-and-network-logs).
- If the task does not exist yet, ask the user before adding it to their workspace. With the MCP server, use `save_workspace_task` and `save_workspace_workflow`: they validate the definition and start nothing.
- Exit status 1 means a service crashed, a check failed, or the run failed.

## Headless browsers

A headless browser has no window on screen, so **Cinderdeck cannot record it**. Choose one of these, in order:
1. **Run it headed.** Playwright `headless: false`. Playwright MCP runs headed unless it was started with `--headless`. Puppeteer `headless: false`. Then record its window by id, or the display.
2. **Headless is required** (no GUI session, CI): skip the Cinderdeck video. Use the browser's own recording (Playwright `recordVideo` and `tracing`). Run the script as a workspace task (`cinderdeck workspace task <ws> <task> --wait`, or MCP `run_workspace_task` then `wait_for_workspace_run`), so its output is still captured and attributed. Tell the user that this output is not synced with a Cinderdeck video.

Never report a headless session as "recorded" by Cinderdeck.

## Checklist

- [ ] `repro status` is idle, and permission errors have been handled
- [ ] The target window is open, loaded, and visible, and was chosen by id from `repro windows`
- [ ] Workspace logs match the request: `--workspace`, the default, or `--no-logs` (for a lane: the lane, plus its source when it uses shared services)
- [ ] `--title` and `--max` are set
- [ ] A mark before every action, and `--pass` or `--fail` after every check
- [ ] Browser console and network errors appended with `--source browser` and `--source network`
- [ ] Stopped, frames reviewed, and the verdict, export path, and log path reported
