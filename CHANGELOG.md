# Cinderdeck changelog

## [1.0.0] - 2026-09-23

- Establish Cinderdeck as an independent native macOS development application, forked from Snapzy.
- Configure arbitrary project folders and commands as stacks, with service dependencies, readiness checks, logs, ports, crash recovery, and Git workflows.
- Control stacks through the native app, `cinderdeck` CLI, or local MCP server, with agent ownership and advisory claims.
- Retain local clipboard text history and Snapzy’s capture, recording, annotation, OCR, and editing tools.
- Introduce a new icon, menu-bar glyph, app identity, project structure, documentation, and release paths.
- Copy data from the customized Snapzy build on first Release launch while preserving originals and existing Cinderdeck data.
- Isolate updates from upstream Snapzy. Automatic updates require Cinderdeck’s own signing key and release feed.

This is build 200. Earlier Snapzy releases are recorded in the [original upstream changelog](docs/upstream/CHANGELOG.md), with source history and license credit preserved.
