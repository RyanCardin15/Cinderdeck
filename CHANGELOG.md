# Cinderdeck changelog

## Unreleased

- Add repros: screen recordings that capture workspace service and task output on the video timeline, with markers for service lifecycle, workflow steps, and checks, plus the Git state when recording starts. Captured output redacts Keychain secret values.
- Show the synchronized log panel and error and marker ticks in the video editor (⇧⌘L). Clicking a line seeks the video, and output after the playhead is dimmed.
- Add Workspaces → Repros to record the screen or a task or workflow run, and to review verdicts, errors, and markers.
- Let agents record and inspect repros through new MCP tools (`start_repro_recording`, `mark_repro`, `repro_frame`, `repro_logs`, and more) and `cinderdeck repro`, including frames returned as images and a failing exit status for scripted test runs.
- Export repros as folders or zip archives with a Markdown summary, merged timeline, per-source logs, frames at failures, and uncommitted diffs.

## 1.0.0 — 2026-09-23

- Establish Cinderdeck as an independent native macOS development application, forked from Snapzy.
- Configure arbitrary project folders and commands as stacks, with service dependencies, readiness checks, logs, ports, crash recovery, and Git workflows.
- Control stacks through the native app, `cinderdeck` CLI, or local MCP server, with agent ownership and advisory claims.
- Retain local clipboard text history and Snapzy’s capture, recording, annotation, OCR, and editing tools.
- Introduce a new icon, menu-bar glyph, app identity, project structure, documentation, and release paths.
- Copy data from the customized Snapzy build on first Release launch while preserving originals and existing Cinderdeck data.
- Isolate updates from upstream Snapzy. Automatic updates require Cinderdeck’s own signing key and release feed.

This is build 200. Earlier Snapzy releases are recorded in the [original upstream changelog](docs/upstream/CHANGELOG.md), with source history and license credit preserved.
