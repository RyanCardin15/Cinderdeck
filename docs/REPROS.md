# Recordings with workspace logs

When you record your screen with a workspace selected and running, Cinderdeck saves a **log file next to the video** with everything those workspaces printed. Every line is stamped with its **position in the video** and the clock time it was written. When something goes wrong at 0:42 in the video, look at `[00:42.000 …]` in the log.

Nothing changes for plain videos. Recordings capture no logs until you pick a workspace in the recording toolbar. If nothing is running, you also get a normal video.

In the CLI and MCP tools, a recording with logs is called a **repro**.

## Recording

**Record the way you already do.** Use the recording toolbar, the shortcut, or the menu bar. When the toolbar appears, the **Workspace** picker, next to the microphone and audio controls, shows whose logs will be saved. It starts at **None**, so a recording is a plain video until you pick a workspace. Hover over it for a one-line description, such as "Logs from Shop are saved with the video." Click it to choose:

| Choice | What gets saved |
| --- | --- |
| **None** (default) | Just the video |
| **A workspace** | Logs from that workspace, and nothing else, including output that starts while you record |
| **All running workspaces** | Logs from every workspace that has a service or task running, including ones that start while you record |

Your choice is remembered for the next recording, like the microphone choice. To capture several specific workspaces, pick them in **Preferences → Capture → Recording → Workspace logs**, where the picker then shows "2 workspaces". The same choice is at the top of **Workspaces → Recordings**.

While recording, the recording bar shows a **logs** indicator with a live line count and a red error count. Hover over it to see which workspaces are being saved. **Click it to mark the moment**, for example "the bug happened here". A `▶ Marked` line appears in the log at that exact video time.

When you stop, a short confirmation shows how many lines were saved and from which workspaces, with **Show Log** and **Copy Log**.

**One click from Workspaces.** **Workspaces → Recordings → Record with Logs** records the main display right away and saves only that workspace's logs. Its menu can also record a workflow or task run: recording starts, the run starts, each step is marked, and recording stops about 1.5 seconds after the run ends. Agents can record too; see [Agents](#agents).

Recordings started from Workspaces or by an agent show floating controls at the top of the screen with who is recording, elapsed time, line and error counts, and **Pause**, **Mark**, and **Stop**. Cinderdeck's own windows are left out of every recording. The menu bar stop item and the recording shortcut also stop these recordings. Agent recordings stop automatically after five minutes unless the agent asks for a different limit, up to one hour.

## The log file

The log file is named after the video (`Screen Recording 10.32.mov` → `Screen Recording 10.32.log`) and saved in the same folder. `.log` files open in Console by default, which handles very large logs, and any editor or `grep` works too.

```text
Cinderdeck workspace log
========================
Video:      Screen Recording 10.32.mov
Recorded:   2026-09-24 10:32:11 PDT · 1m 12s
Captured:   Shop and Billing (all running workspaces)
Result:     Failed — 1 crash · 4 error lines · 2 warnings

Sources
  shop/api        812 lines, 3 errors
  shop/web        120 lines
  billing/api     272 lines, 1 error, 2 warnings
  Docs            running, but printed nothing during the recording

How to read this file
  [video time  clock time]  source  message
  …
------------------------------------------------------------------------------
[00:00.000  10:32:10.912] ~ shop/api     listening on :4000
[00:04.210  10:32:16.446] ▶ api ready
[00:12.001  10:32:24.237]   shop/api     ERROR  Error: payment declined
[00:12.480  10:32:24.716] ▶ Marked  (You)
[00:31.002  10:32:43.238] ▶ billing/api crashed — Exited with status 1  [FAIL]
```

- **Video time** (`00:12.001`) is the position in the video. Seek there to see what was on screen.
- **Clock time** is local time, for matching against other logs, such as a browser console or a server you did not start with Cinderdeck.
- **Sources** are `service` names when one workspace was captured, and `workspace/service` when several were. The header lists every workspace that was included, including running ones that printed nothing, so you know nothing was missed.
- `ERROR` and `WARN` flag lines that look like errors or warnings. `▶` lines are events: services starting, becoming ready, or crashing, workflow steps, and your marks.
- `~` marks output from up to three seconds before the video started, or written while it was paused. It is kept for context and pinned to the nearest recorded moment.

**Where it goes:**

- **Next to the video**, whenever the video is saved to a folder. If you record with auto-save off, the video waits in a temporary folder until you save it from Quick Access. The log file is written beside it the moment you do. An existing file with the same name is never replaced; Cinderdeck uses `<name> (workspace logs).log` instead.
- **In the Recordings library**, always, as `recording.log`. **Show Log** and **Copy Log** use the copy next to the video when it exists.
- Turn off **Save the log file next to the video** in Preferences to keep logs only in the library.

## Finding logs later

- **Workspaces → Recordings** lists every recording that saved this workspace's logs (switch to **All workspaces** to see all of them). Each one shows where its log file is, with **Show Log File**, **Copy Log**, and **Open Video**. It also shows a timeline of marks and events, the distinct errors, and the services and repositories at the start of recording. Clicking a mark or error opens the video at that moment.
- **In the video editor**, a **Logs** button appears for videos that have logs, with Show Log File, Copy Log, the log panel (⇧⌘L), and Export. The editor finds the logs even if you renamed or moved the video.
- **In a terminal**: `cinderdeck repro dump` prints the latest recording's log file, and `cinderdeck repro dump --path` prints its path.

### The log panel (optional)

If you prefer to read logs next to the video, open the log panel from **Logs → Show Log Panel** (⇧⌘L). It lists output and events in video order and dims lines after the playhead. Click a line to jump the video there, and use the chevrons to step through errors. You can filter by level, source, or text. The timeline shows red ticks for errors, orange ticks for warnings, and flags for events.

### Verdicts

| Verdict | Meaning |
| --- | --- |
| **Clean** | No error output, crashes, failed checks, or failed runs |
| **Errors** | Error lines appeared, but nothing crashed or failed |
| **Failed** | A service crashed, a check failed, or a recorded run failed |

Error lines are recognized from common patterns: `Error`, `TypeError`, `Exception`, `panic`, `Traceback`, `ECONNREFUSED`, test failures such as `FAIL`, failure symbols, and HTTP 5xx responses. Warnings include deprecations, timeouts, retries, and HTTP 4xx responses. Summaries such as "0 errors" or "0 failed" are not counted, and neither are words in the path of a successful request, such as `GET /api/errors 200`.

## What is saved

- **Output** from the chosen workspaces' services and tasks, with ANSI color removed. Up to 250,000 lines are saved per recording; beyond that, lines are counted but not saved.
- **Events**: service starting, ready, readiness failing, crashed, and stopped; runs starting and finishing; each workflow step with its exit status and duration; and your marks, plus checks added by agents.
- **Workspace state when recording started**: service status, commands, and ports; each repository's branch, commit, ahead and behind counts, uncommitted files, and the uncommitted diff (up to 2 MB).
- **Environment variable names** set by the workspace. Values are never stored.
- **Secrets are redacted.** Keychain secret values that appear in output are replaced with `[secret NAME]` before anything is written.

A line's video time comes from when Cinderdeck reads it, which is usually within a tenth of a second of when it was written.

### Storage

The library is `~/Library/Application Support/Cinderdeck/Stacks/Repros/<id>/` (Debug builds use `Stacks-Debug`). Each folder contains `recording.log`, `session.json`, `lines.jsonl` (one JSON object per line, with `t` in video seconds and `at` in epoch seconds), `git/*.diff`, and extracted `frames/`. Recordings started from Workspaces or by agents also keep their video there. Videos from regular recordings stay where your recording settings save them.

Deleting a recording from Workspaces removes its library folder. A video saved elsewhere, and the log file next to it, are kept. If Cinderdeck quits while recording, the recording is marked **Failed** and the output captured so far is kept.

### Export bundle

**Export Bundle…** writes `<title>-<date>/`, and agents and the CLI write it to `~/Downloads/Cinderdeck Repros/` by default:

| File | Contents |
| --- | --- |
| `recording.mp4` / `.mov` | The video |
| `recording.log` | The log file described above |
| `README.md` | Verdict, headline, events, distinct errors, output around the first error, runs, services, Git state, and sources |
| `logs/<source>.log` | One file per service or task |
| `repro.json`, `summary.json` | Full metadata and the machine-readable summary |
| `frames/` | Frames at the first error and at each failure |
| `git/` | Uncommitted diffs from when recording started |

Pass `--zip` (CLI) or `zip: true` (MCP) to create an archive instead of a folder.

## Agents

Repros are available through the same MCP server and CLI as Workspaces. Reload the tool list in connected clients. Every recording shows the floating controls, so the person at the Mac can see it and stop it.

### Agent skills

Two skills teach Claude Code, Codex, Cursor, and other agents to use recordings well:

| Skill | Use |
| --- | --- |
| [`cinderdeck-record-session`](../skills/cinderdeck-record-session/SKILL.md) | Record a browser or app session: pick the window, a new window, an automation browser, or a display; choose workspace logs or none; mark each action; add browser console output; review the result. Explains why headless browsers can't be recorded and what to do instead. |
| [`cinderdeck-review-recording`](../skills/cinderdeck-review-recording/SKILL.md) | Investigate a recording, yours or the user's: verdict, frames at errors and marks, logs around a moment, and an export. |

In a clone of this repository, agents find them automatically: Claude Code reads `.claude/skills/`, Codex reads `.agents/skills/`, and Cursor reads both. To use them in your other projects, link them into your user skills folders:

```sh
mkdir -p ~/.claude/skills ~/.agents/skills
for skill in "$PWD"/skills/*/; do
  ln -s "${skill%/}" ~/.claude/skills/   # Claude Code
  ln -s "${skill%/}" ~/.agents/skills/   # Codex and Cursor
done
```

`skills/` is the source. After editing a skill there, run `scripts/sync-agent-skills.sh` to update the copies; CI checks that they match.

### MCP tools

| Tool | Purpose |
| --- | --- |
| `list_repro_windows` | Windows that can be recorded, frontmost first, with `id`, app, title, frame, display, and pid. Optional `query` filters by app or title. |
| `start_repro_recording` | Start recording. Optional: `title`, `workspace`/`workspaces` to scope output or `logs: false` for none, `window_id` (from `list_repro_windows`), `window` (app name or title), or `display`, `max_seconds`, `system_audio`, `note`. Pass `workspace` with `task` or `workflow` to record a run. |
| `mark_repro` | Add a marker now. `outcome: pass`/`fail` records a check; failed checks make the verdict **Failed**. |
| `add_repro_logs` | Add your own lines to the log now, such as browser console messages or failed requests, under a `source` name. Lines that look like errors count toward the verdict. |
| `stop_repro_recording` | Stop and save. Returns the verdict, headline, errors with timestamps, markers, runs, and `logFile`, the path of the log file. Calling it again returns the saved repro. |
| `wait_for_repro` | Wait for a recording that stops itself, such as a recorded run. |
| `cancel_repro_recording` | Stop and discard. |
| `repro_status` | Live elapsed time and line, error, and marker counts. |
| `list_repros` | Recent repros with verdicts, including recordings people made. |
| `repro_summary` | Full result, including Git state and per-source counts. |
| `repro_logs` | Output filtered by `around` + `window`, `from`/`to`, `source`, `level`, `grep`, and `lines`. |
| `repro_frame` | The video frame at `at`, returned as an image with the output and markers just before it. Defaults to the first error, or the last frame when there are no errors. `times` returns up to six frames. |
| `export_repro` | Write the export bundle (`destination`, `zip`, `video`). |
| `open_repro` | Open the repro in the video editor for the user. |
| `delete_repro` | Delete a repro. Requires the exact id. |

**Recording a window.** Pick it by `window_id` from `list_repro_windows`; `window` matches an app name or title and takes the frontmost match. The recording follows the window if it moves or resizes, keeping the video size from the start. It includes the window's app, so menus, dropdowns, and sheets appear, while other apps' windows passing over it do not. A window must be visible to be recorded, so a headless browser can't be; run it headed.

**Choosing logs.** By default an agent recording captures every running workspace. Pass `workspace` or `workspaces` to narrow it, or `logs: false` for a plain video. With `logs: false`, markers and lines from `add_repro_logs` are still saved.

Times are seconds or `mm:ss.sss` on the video. You can also use `first_error`, `last_error`, `start`, `end`, or `marker:<label or id prefix>`. Repro ids can be shortened to a unique prefix, and `latest` is the default.

### A test loop

```text
list_repro_windows  query="localhost:3000"
start_repro_recording  title="Checkout with saved card"  workspace="shop"  window_id=4312
mark_repro  label="Open /cart"
…drive the browser…
add_repro_logs  source="browser"  lines=["Uncaught TypeError: price is undefined"]
mark_repro  label="Total shows $42.00"  outcome="pass"
mark_repro  label="Pay succeeds"  outcome="fail"  detail="Spinner never finished"
stop_repro_recording
repro_frame  at="marker:Pay succeeds"
repro_logs   around="marker:Pay succeeds"  window=5  level="warning"
export_repro zip=true
```

To record a configured test run instead:

```text
start_repro_recording  workspace="shop"  workflow="e2e"
wait_for_repro
repro_frame  times=["first_error", "end"]
```

### CLI

```sh
cinderdeck repro windows localhost:3000        # ids, apps, titles; frontmost first
cinderdeck repro start --title "Checkout" --workspace shop --window-id 4312 --max 120
cinderdeck repro mark "Total shows \$42" --pass
cinderdeck repro append "Uncaught TypeError: price is undefined" --source browser
cinderdeck repro mark "Pay succeeds" --fail --detail "Spinner never finished"
cinderdeck repro stop
cinderdeck repro logs --around first_error --span 5 --level warning
cinderdeck repro frame --at first_error --out ~/Desktop/failure.jpg
cinderdeck repro export --zip

# A plain video with no workspace output, and a log streamed in from elsewhere
cinderdeck repro start --no-logs --window Safari
tail -n 0 -F /tmp/app.log | cinderdeck repro append --source app &

# Record a workflow and exit 1 if anything failed, for scripts and CI-style loops
cinderdeck repro run shop e2e --workflow --wait
```

Two more commands help with toolbar recordings:

```sh
cinderdeck repro dump              # print the latest recording's log file (--path for its location)
cinderdeck repro scope             # which workspaces toolbar recordings save logs from
cinderdeck repro scope shop        # only Shop; also: scope running, scope off
```

`repro stop`, `repro wait`, and `repro run … --wait` exit with status 1 when the verdict is **Failed**. `logs` prints readable lines; add `--json` for structured output. The other commands print JSON. Run `cinderdeck repro --help` for every option.

### Socket methods

For custom clients, the control socket exposes `repro.windows`, `repro.start`, `repro.stop`, `repro.cancel`, `repro.status`, `repro.mark`, `repro.log`, `repro.list`, `repro.get`, `repro.logs`, `repro.dump`, `repro.scope`, `repro.frame`, `repro.wait`, `repro.export`, `repro.open`, and `repro.delete`, with the same parameters as the MCP tools. `repro.log` also accepts `lines` as objects `{text, at, level}`, where `at` is epoch seconds or ISO 8601, to place lines that were read after the fact. Frame responses include `imageBase64` while they fit within the 4 MB message limit. Every frame is also saved to disk, and its path is returned.

## Permissions and privacy

Recording requires Screen Recording permission for Cinderdeck. When permission is missing, agents get an error that explains where to grant it. System audio is off for agent recordings unless requested, and the microphone is never recorded. Recordings and their logs stay on your Mac unless you export them.

## Verification

- `ReproCoreTests` covers log level classification, the video clock (first frame, pauses, stop), the log file format, workspace choices, millisecond timestamps, queries, verdicts, reports, secret redaction, storage, and the export bundle.
- `ReproAgentAPITests` covers CLI parsing and MCP tool mapping.
- `ReproRecorderTests` runs real services and tasks through the capture engine. It covers placing lines on the video timeline, events, redaction, the log file next to the video, the workspace choice, plain videos (including for people without workspaces), discarding empty recordings, and waiting on a repro while it is being saved.

```sh
scripts/run-tests.sh -only-testing:CinderdeckTests/ReproCoreTests \
  -only-testing:CinderdeckTests/ReproAgentAPITests -only-testing:CinderdeckTests/ReproRecorderTests
```
