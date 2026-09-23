# Cinderdeck Stacks implementation

Cinderdeck supports arbitrary local projects and commands, with optional Git repositories. Stack definitions, ordered service startup, readiness checks, ports, owned process groups, crash recovery, persistent runs, Git switching, live logs, CLI control, and MCP are implemented.

The original delivery and its 193-test/live-UI evidence are preserved in the [historical Snapzy record](upstream/STACKS_IMPLEMENTATION.md). The subsequent CLI/MCP delivery passed 201 targeted tests and an isolated end-to-end control test.

The Cinderdeck rename extends verification to app identity, data migration, URL compatibility, configuration paths, Keychain access, and update isolation. See [MIGRATION.md](MIGRATION.md), [BUILD.md](BUILD.md), and the rebrand pull request for its final results.

Personal definitions, local history, credentials, and build artifacts are never committed.
