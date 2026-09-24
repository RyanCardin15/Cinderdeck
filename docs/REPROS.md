# Repros: recordings with synchronized logs

A **repro** is a screen recording together with everything your workspace printed while it was recorded. Every service and task log line is placed on the video's timeline, so scrubbing the video scrolls the logs, and clicking a log line jumps the video to that moment. Service starts, crashes, workflow steps, and your own markers appear on the timeline too.

Use repros to:

- **Report a bug** with the video, the exact output behind it, and the Git state it happened on.
- **Debug** by seeing what the API logged at the second the UI broke.
- **Test end to end with agents.** An agent records the screen, drives the app, marks each step as passed or failed, then reads the frames and logs itself.

## Recording

There are three ways to record, and all three produce the same kind of repro.

**Any screen recording.** Record the way you already do (toolbar, shortcut, or menu bar). If workspace services or tasks produce output while you record, that output is attached automatically. Recordings with no workspace output are left as plain videos. Turn this off in **Preferences → Workspaces → Attach workspace logs to screen recordings**.

**Workspaces → Repros → Record repro.** Records the main display right away and captures only this workspace's output. The menu can also record a workflow or task: recording starts, the run starts, each step becomes a marker, and recording stops about 1.5 seconds after the run ends. **Record an area or window…** opens the regular recording toolbar.

**Agents and the CLI.** See [Agents](#agents) below.

Recordings started from Workspaces or by an agent show floating controls at the top of the screen with who is recording, elapsed time, line and error counts, and **Pause**, **Mark**, and **Stop**. Cinderdeck's own windows are excluded from these recordings, so the controls never appear in the video. The menu bar stop item and the recording shortcut also stop them. Agent recordings stop automatically after five minutes unless the agent asks for a different limit, up to one hour.

## Reviewing

Open a repro from **Workspaces → Repros**, from the floating controls after saving, or open its video in the video editor. The editor finds the repro for the video even if you renamed or moved the file.

- **Logs panel** (⇧⌘L, or the text icon in the toolbar) lists output and markers in video order. Output after the playhead is dimmed, and the line at the playhead is highlighted. With **Follow** on (the scope icon), the list scrolls during playback.
- Click any line or marker to seek to it. The chevron buttons jump to the previous or next error.
- Filter by level (All, Warnings, Errors), by source, or by text. Right-click a line to copy it or show only its source.
- The timeline shows red ticks for error lines, orange ticks for warnings, and colored flags for markers. Red flags are failures, green ones are passes or ready services, purple ones are notes and checks, and blue ones are workflow steps.
- **Export…** writes a shareable folder. **Copy summary** copies a Markdown report with the repro id for pasting into an issue or an agent.

In Workspaces, each repro shows its verdict, the headline, a clickable timeline of markers, distinct errors, services and repositories at the start of recording, and per-source line counts. Clicking a marker or error opens the video at that moment.

### Verdicts

| Verdict | Meaning |
| --- | --- |
| **Clean** | No error output, crashes, failed checks, or failed runs |
| **Errors** | Error lines appeared, but nothing crashed or failed |
| **Failed** | A service crashed, a check marker failed, or a recorded run failed |

Error lines are recognized from common patterns: `Error`, `TypeError`, `Exception`, `panic`, `Traceback`, `ECONNREFUSED`, failure symbols, and HTTP 5xx responses. Warnings include deprecations, timeouts, retries, and HTTP 4xx responses. Summaries such as “0 errors” or “0 failed” are not counted.

## What a repro contains

- **Output** from every service and task in scope, with ANSI color removed. Each line has a position on the video. Output from up to three seconds before recording started, or written while it was paused, is kept for context, pinned to the nearest recorded moment, and shown dimmed. It is not counted in error totals. A repro stores up to 250,000 lines; anything beyond that is counted but not stored.
- **Markers** for service starting, ready, readiness failing, crashed, and stopped; runs starting and finishing; each workflow step with its exit status and duration; and notes and checks added by you or an agent.
- **Workspace state when recording started**: service status, commands, and ports; each repository's branch, commit, ahead and behind counts, uncommitted files, and the uncommitted diff (up to 2 MB).
- **Environment variable names** set by the workspace. Values are never stored.
- **Secrets are redacted.** Keychain secret values that appear in output are replaced with `[secret NAME]` before anything is written.

Line positions come from when Cinderdeck reads each line, which is usually within a tenth of a second of when it was written.

### Storage

Repros are stored in `~/Library/Application Support/Cinderdeck/Stacks/Repros/<id>/` (Debug builds use `Stacks-Debug`). Each folder contains `session.json`, `lines.jsonl`, `git/*.diff`, and extracted `frames/`. Agent and Workspaces recordings also save their video in that folder. Videos from regular recordings stay where your recording settings save them.

Deleting a repro removes its folder. A video saved elsewhere is kept. If Cinderdeck quits while recording, the repro is marked **Failed** and the output captured so far is kept.

### Export bundle

**Export** writes `<title>-<date>/`. By default agents and the CLI write it to `~/Downloads/Cinderdeck Repros/`. The folder contains:

| File | Contents |
| --- | --- |
| `README.md` | Verdict, headline, marker table, distinct errors, output around the first error, runs, workspace services, Git state, and sources |
| `recording.mp4` / `.mov` | The video |
| `timeline.log` | All output and markers merged: `[01:02.345] api \| message` |
| `logs/<source>.log` | One file per service or task |
| `repro.json`, `summary.json` | Full metadata and the machine-readable summary |
| `frames/` | Frames at the first error and at each failure |
| `git/` | Uncommitted diffs from when recording started |

Pass `--zip` (CLI) or `zip: true` (MCP) to create an archive instead of a folder.

## Agents

Repros are available through the same MCP server and CLI as Workspaces. Reload the tool list in connected clients. Every recording shows the floating controls, so the person at the Mac can see it and stop it.

### MCP tools

| Tool | Purpose |
| --- | --- |
| `start_repro_recording` | Start recording. Optional: `title`, `workspace`/`workspaces` to scope output, `window` (app name or title) or `display`, `max_seconds`, `system_audio`, `note`. Pass `workspace` with `task` or `workflow` to record a run. |
| `mark_repro` | Add a marker now. `outcome: pass`/`fail` records a check; failed checks make the verdict **Failed**. |
| `stop_repro_recording` | Stop and save. Returns the verdict, headline, errors with timestamps, markers, and runs. Calling it again returns the saved repro. |
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

Times are seconds or `mm:ss.sss` on the video. You can also use `first_error`, `last_error`, `start`, `end`, or `marker:<label or id prefix>`. Repro ids can be shortened to a unique prefix, and `latest` is the default.

### A test loop

```text
start_repro_recording  title="Checkout with saved card"  workspace="shop"  window="Safari"
mark_repro  label="Open /cart"
…drive the browser…
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
cinderdeck repro start --title "Checkout" --workspace shop --window Safari --max 120
cinderdeck repro mark "Total shows \$42" --pass
cinderdeck repro mark "Pay succeeds" --fail --detail "Spinner never finished"
cinderdeck repro stop
cinderdeck repro logs --around first_error --span 5 --level warning
cinderdeck repro frame --at first_error --out ~/Desktop/failure.jpg
cinderdeck repro export --zip

# Record a workflow and exit 1 if anything failed, for scripts and CI-style loops
cinderdeck repro run shop e2e --workflow --wait
```

`repro stop`, `repro wait`, and `repro run … --wait` exit with status 1 when the verdict is **Failed**. `logs` prints readable lines; add `--json` for structured output. The other commands print JSON. Run `cinderdeck repro --help` for every option.

### Socket methods

For custom clients, the control socket exposes `repro.start`, `repro.stop`, `repro.cancel`, `repro.status`, `repro.mark`, `repro.list`, `repro.get`, `repro.logs`, `repro.frame`, `repro.wait`, `repro.export`, `repro.open`, and `repro.delete`, with the same parameters as the MCP tools. Frame responses include `imageBase64` while they fit within the 4 MB message limit. Every frame is also saved to disk, and its path is returned.

## Permissions and privacy

Recording requires Screen Recording permission for Cinderdeck. When permission is missing, agents get an error that explains where to grant it. System audio is off for agent recordings unless requested, and the microphone is never recorded. Repros stay on your Mac unless you export them.

## Verification

`CinderdeckTests/Services/Repro/ReproCoreTests.swift` covers log level classification, the video clock (first frame, pauses, stop), time parsing, queries, verdicts and summaries, the Markdown report and timeline, secret redaction, storage (including crash-truncated output), and the export bundle layout.

```sh
scripts/run-tests.sh -only-testing:CinderdeckTests/ReproCoreTests
```
