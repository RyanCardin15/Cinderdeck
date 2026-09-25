# Cinderdeck changelog

## [Unreleased]

- Rework worktree lanes so they work beyond single-port services:
  - Write `{{port.api}}`, `{{url.api}}`, `{{lane.slug}}`, `{{repo.app}}` and `{{url.backend:api}}` in commands, environment values and readiness URLs. They resolve for the original checkout and for each lane, so a lane's frontend no longer calls the original checkout's API. A literal `localhost:<port>` pointing at another service is now a warning.
  - Every service with a port gets `PORT`, `CINDERDECK_PORT_<SERVICE>` and `CINDERDECK_URL_<SERVICE>` in the original checkout too. Lanes also get `CINDERDECK_LANE_SLUG`, `CINDERDECK_LANE_DIR` and a per-lane `COMPOSE_PROJECT_NAME`. Services without a port no longer get one in lanes.
  - Add a `[lanes]` table: `from`, `copy` and `link` for `.env` files, `setup` and `teardown` tasks or workflows, lane-only `env`, `dir`, and `hosts` for per-lane `*.localhost` hostnames.
  - Mark services or repositories `lane = "shared"` so lanes use the original checkout's database or backend, or `lane = "off"` to leave them out. Depend on another workspace's service with `depends_on = ["backend:api"]`; lanes use its lane on the same branch.
  - Add named ports (`ports.hmr = 24678`, `ready.port = "hmr"`) and task ports, assigned in blocks of ten per lane.
  - Lanes now follow their workspace definition instead of a saved copy. Lanes from 1.1 load pinned; Unpin makes them follow.
  - Track branches that only exist on a remote instead of creating an unrelated branch from `HEAD`, and start new branches at `--from`.
  - Adopt worktrees agents created with `cinderdeck lane adopt` or `adopt_lane`; Cinderdeck never deletes them. Workspaces that share a repository share its worktree.
  - Remove lanes that contain `node_modules` or build output after confirming, with sizes listed, and keep branches, adopted worktrees and shared worktrees. Add `lane release`, merged-lane detection and `lane prune`, and delete removed lanes' logs after 14 days.
  - Queue simultaneous lane creation instead of failing, and warn when a service listens on a different port than it was assigned.
  - Put lane worktrees in `~/.cinderdeck/lanes/<workspace>/<lane>/<repository>` (Settings → Workspaces → Lane worktrees) and refuse a lanes folder inside a repository.
  - Add the `cinderdeck-parallel-lanes` agent skill, and teach the recording skill to record lanes on their own URLs. `workspace_guide` now explains templates and `[lanes]`.
  - Add `cinderdeck lane env --export` and MCP `lane_env` for a lane's ports and URLs, plus `run_lane_setup`, `release_lane`, `prune_lanes` and `unpin_lane`. Stopping a service that lanes use asks first.
- Pick several workspaces in the recording toolbar's Workspace picker. It now stays open while you tick workspaces, shows which are running, and has All and None shortcuts. `cinderdeck repro run <ws> <task> --workspace api` and MCP `workspaces` with `task` or `workflow` also capture other workspaces during a run, `--workspace` can be repeated, and `workspace` plus `workspaces` now combine instead of one replacing the other.
- Add a Drag to an agent card to Workspaces → Recordings. It drags the recording's README, stamped log, frames at the first error, failures and the end, and uncommitted diffs, so a terminal agent gets their paths and a chat app gets the files. Hold ⌥ to add the video, or use Copy Files to paste them. Video-less exports now give the saved video's path.
- Add a Saved tab to the history panel with Favorites and groups you name, holding captures and copied text together. Right-click any capture or copied text and choose Add to Favorites or Add to Group, or use the star on text cards. Return copies saved text and closes the panel, ready to paste.
- Keep saved captures and text through history cleanup. They are skipped by the capture age and count limits and the clipboard's 30-day and 500-item limits, and Clear Text History keeps them.
- Lay out the compact history header side by side so the filter pills no longer cover the open, pin, and close buttons.
- Rename the MCP tools from Stacks to Workspaces terminology: `list_workspaces`, `start_services`, `stop_services`, `restart_services`, `read_service_logs`, `claim_workspace`, `release_workspace`, `workspace_guide`, `validate_workspace`, and `reload_workspaces`. Tools take a `workspace` argument, and the old `*_stack` tool names are removed.
- Let agents create workspaces and add, change, or delete services, tasks, and workflows through MCP, with the same validation as the Workspaces forms. `save_workspace_task` can move a stopped service to Tasks.
- Add `wait_for_workspace_run`, which waits for a task or workflow and returns the failing step's output; `repro_recording_scope`; and `open_workspace`.
- Run MCP tool calls concurrently, answer pings during long waits, honor cancellation, negotiate the protocol version, and reject unknown arguments. Results are compact JSON, and stopping services no longer reports a timeout while a slow stop finishes.
- Rename the `cinderdeck stacks` CLI command to `cinderdeck services`, and name workspaces `workspaces` in `state.json` and CLI JSON output.
- Keep the last output of recordings that stop right after it happens. Output is read slightly after it is written, and lines read in the 1.5 seconds after the stop were dropped, which lost the error an agent had just triggered. They are now kept and pinned to the last frame.
- Keep log lines and marks that agents send in parallel with `stop_repro_recording`. They were rejected or lost while the recording was being saved. Lines and marks sent up to 2 minutes after the stop now go to that repro's saved log, and `add_repro_logs`, `mark_repro`, and `repro append`/`mark` take `repro` to add to any saved one.
- Hold the last frame of a recording until it stops. A screen that stopped changing ended the video early, so the log ran past the end of the video.
- Place every line and mark with the first frame's capture time and the video's final length, including ones added before the first frame arrived.
- Save the log when a recording produces no video, instead of discarding it, and say why in the result and the log file.
- Note output that a service printed faster than it could be captured, in the log file and at the gap.
- Export bundles contain only the frames at the first error, each failure, and the end, listed in README.md. Per-source logs are stamped like `recording.log`, and `repro.json` no longer contains paths from the recording Mac.
- `repro append` streaming from a pipe ends cleanly when the recording stops.
- Mark the moment screen capture stops on its own, for example when the recorded window closes, with a `Screen capture stopped` event.
- `repro_logs` with `around`, and the output returned with `repro_frame`, keep the lines nearest that moment when there are more than the limit. They kept the earliest lines, which could leave out the error being asked about.
- Agents starting a recording wait for a toolbar recording that just stopped to finish saving, instead of failing with "Repro capture could not start".

## [1.1.0] - 2026-09-24

- Run branches side by side in Git worktree lanes, with separate service ports, logs, and agent claims. Create and manage lanes from the native Lanes view, `cinderdeck lane`, or MCP; services use `PORT` and `CINDERDECK_PORT_<SERVICE>` for their assigned ports.
- Run finite tasks and ordered workflows alongside long-running services in Workspaces, with saved results and logs. Lane tasks and workflows run inside their own working folders.
- Update Cinderdeck automatically. Installed releases check for new versions daily, download them in the background, and install them when Cinderdeck quits.
- Check for, download, and install updates from Preferences → About and General → Updates, with progress shown in place, Restart to Update for a downloaded update, and Cancel or Try Again when needed. The menu bar shows Update Available or Restart to Update, and the Preferences sidebar marks a waiting update.
- Save a `.log` file next to screen recordings with the output of your running workspaces. Every line is stamped with its video position and clock time, and the file includes service events, workflow steps, and Git state. Keychain secret values are redacted.
- Choose which workspaces a recording captures from the new logs button on the recording toolbar: all running workspaces, selected ones, or none for a plain video. The choice is also in Preferences and Workspaces → Recordings.
- Show a live logs indicator while recording (click it to mark the moment), and a confirmation with Show Log and Copy Log afterwards.
- Keep the log file with the video when a temporary recording is saved from Quick Access.
- Add Workspaces → Recordings to record the screen or a task or workflow run with logs, and to find past recordings, their log files, errors, and events.
- Add a Logs menu and an optional synchronized log panel (⇧⌘L) to the video editor.
- Let agents record and inspect repros through new MCP tools (`start_repro_recording`, `mark_repro`, `repro_frame`, `repro_logs`, and more) and `cinderdeck repro`, including `repro dump`, `repro scope`, frames returned as images, and a failing exit status for scripted test runs.
- Export recordings as folders or zip archives with the video, log file, Markdown summary, per-source logs, frames at failures, and uncommitted diffs.

## [1.0.0] - 2026-09-23

- Establish Cinderdeck as an independent native macOS development application, forked from Snapzy.
- Configure arbitrary project folders and commands as stacks, with service dependencies, readiness checks, logs, ports, crash recovery, and Git workflows.
- Control stacks through the native app, `cinderdeck` CLI, or local MCP server, with agent ownership and advisory claims.
- Retain local clipboard text history and Snapzy’s capture, recording, annotation, OCR, and editing tools.
- Introduce a new icon, menu-bar glyph, app identity, project structure, documentation, and release paths.
- Copy data from the customized Snapzy build on first Release launch while preserving originals and existing Cinderdeck data.
- Isolate updates from upstream Snapzy. Automatic updates require Cinderdeck’s own signing key and release feed.

This is build 200. Earlier Snapzy releases are recorded in the [original upstream changelog](docs/upstream/CHANGELOG.md), with source history and license credit preserved.
