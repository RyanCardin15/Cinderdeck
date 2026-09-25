---
name: cinderdeck-review-recording
description: Investigate a Cinderdeck screen recording and its synced logs, whether the user recorded it or an agent did. Find what went wrong, look at the video frames at errors and marks, read the logs around any moment, and hand over a bundle. Use when the user says they recorded a bug or repro, asks what happened in a recording, or shares a Cinderdeck .log file, or after an agent recording finishes.
---

# Review a Cinderdeck recording

A Cinderdeck recording (a "repro") is a video plus a log. The log holds everything the chosen workspaces printed, events (services starting, crashing, workflow steps), marks, and any lines an agent added (for example `browser` or `network`). Every line is stamped `[video time  clock time]`. The goal is to explain what happened, with evidence from the video and the log.

Use the `cinderdeck` CLI (MCP equivalents in parentheses). Every command except `logs` and `dump` prints JSON.

## 1. Find the recording

```bash
cinderdeck repro list                # newest first, with verdicts, including toolbar recordings (list_repros)
cinderdeck repro list shop           # only recordings that captured workspace "shop"
```

- Every command takes a repro id or a unique prefix, and defaults to the **latest** recording. If the user describes a specific one ("the checkout one from this morning"), pick it by `title` and `recordedAt`, then pass its id every time.
- If the user gives you a `.log` file path, read it directly. Its header names the video. Use `repro list` to find the matching id for frames.
- A recording still in progress can't be dumped or exported. `cinderdeck repro status` (`repro_status`) shows it. Wait, or ask the user to stop it.

## 2. Read the summary first

```bash
cinderdeck repro show <id>           # (repro_summary)
```

Check these fields, in order:
- `verdict` and `headline`: **clean** (no errors), **errors** (error lines, nothing failed), or **failed** (a crash, a failed check or step, or a failed run).
- `summary`: distinct errors with their first video time, crashes, failed checks, and failed steps.
- `markers`: the actions and checks, with `t` in video seconds. `outcome: fail` marks are the claimed failures.
- `runs`: task and workflow runs with their status.
- The Git branch, commit, and uncommitted files of each workspace when recording started. Use them to know which code was running.
- `capture` (which window or display was recorded) and `workspaceNames` (whose logs are included). A scope of "workspace logs off" means only marks and agent-added lines are in the log.

## 3. Look at the moments that matter

```bash
cinderdeck repro frame <id> --first-error --out /tmp/first-error.jpg      # (repro_frame at=first_error)
cinderdeck repro frame <id> --at "marker:Pay,first_error,end"             # up to 6 moments
cinderdeck repro logs <id> --around first_error --span 5                  # (repro_logs around=… window=5)
cinderdeck repro logs <id> --from 0:40 --to 0:55 --level warning
cinderdeck repro logs <id> --source browser --grep "TypeError|500"
```

- Moments: seconds, `mm:ss.sss`, `first_error`, `last_error`, `start`, `end`, and `marker:<label prefix>`.
- `repro_frame` over MCP returns the images directly, with the log lines and marks just before each frame. The CLI writes JPEG files and prints their paths; open them to look.
- **Always look at a frame** before describing what was on screen. Never infer the UI state from the logs alone.
- Work backwards from the first error or failed mark. The cause is usually in the few seconds *before* it: a request, a warning, or a service restarting. Widen `--span` if nothing stands out.
- `~` lines were written just before the video started, while it was paused, or reported after it stopped (pinned to the last frame). They are context, not what was on screen.
- A `Note:` in the log header, or `detail` in the summary, says when output is missing or when there is no video.

## 4. Read the whole log when it's short

```bash
cinderdeck repro dump <id> --path    # where the .log file is
cinderdeck repro dump <id>           # print it
```

For long logs, don't print everything. Use `repro logs` with `--level warning`, `--source`, or `--grep`, and `-n` to limit lines. Over MCP, `repro_summary` returns the log file path as `logFile`.

The recording holds only what was printed while it ran. For output from before or after it, read the service's log (`cinderdeck services logs <workspace> <service> -n 200`, MCP `read_service_logs`) or a task run's output (`cinderdeck workspace logs <run-uuid>`, MCP `workspace_run_logs`; run ids are in the summary's `runs`).

## 5. Report

Give the user:
1. **What happened**: the first failure, with its video time (`0:42.180`), what the frame shows, and the log lines that explain it.
2. **Likely cause**, tied to evidence: source file and line from stack traces, the failing request, or the service that crashed. Also note the Git branch and commit, and any uncommitted files, that were running.
3. **Where to look**: the `.log` path, and `cinderdeck repro open <id>` if they want the video with synced logs in Cinderdeck's editor (`open_repro`).

If the user wants to share it:

```bash
cinderdeck repro export <id> --zip   # (export_repro zip=true) video, README, log, per-source logs, frames, diffs
```

Only delete a recording when the user asks, using the exact full id: `cinderdeck repro delete <full-id>`.

## Pitfalls

- "errors" is not "failed". Error lines can be expected noise, such as a 404 for a favicon. Say which errors matter and why.
- Clock times are local. To match another log, such as a server not run by Cinderdeck or CI output, use the clock time, not the video time.
- A marker's time is when it was added. Agents mark just *before* an action, so the change appears shortly after the marker.
