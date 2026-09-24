# Cinderdeck changelog

## [1.1.0] - 2026-09-24

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
