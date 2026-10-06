# Cinderdeck agent runtime

The embedded agent, chat, terminal, and Chromium preview runtime for the Cinderdeck super app. This source is maintained in the same repository as the native macOS host. Install, build, sign, and update the complete Cinderdeck app; the runtime is a private child bundle.

See [the product README](../README.md), [build and architecture](../docs/UNIFIED_APP.md), and [contributor guidance](AGENTS.md). `apps/mobile` contains the companion client.

From this directory, install the pinned workspace dependencies with `pnpm install --frozen-lockfile`. For isolated web/server development, run `node scripts/dev-runner.ts dev --home-dir /absolute/path/to/disposable-state`. Build the complete app from the repository root with `./scripts/build-unified.sh --output-dir /absolute/path/to/fresh-output --configuration Debug --arch arm64`.

Provider CLIs must be installed and authenticated separately. Native Cinderdeck owns services, lanes, operational logs, recordings, permissions, and whole-app updates. Internal `deckhand` paths and persisted protocol keys remain compatibility details.

The runtime incorporates MIT-licensed source originally from T3 Code. Its [original license](LICENSE), copyright notices, and bundled third-party acknowledgments are preserved.
