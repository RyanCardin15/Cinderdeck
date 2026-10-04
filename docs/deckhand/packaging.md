# Package Deckhand

The desktop package uses Deckhand’s bundle ID, protocol schemes, icons, data roots and artifact filename. Source-level `@t3tools` packages and provider wire protocols retain upstream compatibility names. The original MIT license is preserved in the package and is listed alongside dependency notices in **Settings → Open source licenses**.

A local preview is useful for isolated acceptance, but it is not a signed release. Build one from the checkout with Node 24 and pnpm 11, Apple command-line tools and Rust’s native target:

```sh
pnpm install --frozen-lockfile
DECKHAND_DESKTOP_SIGNED=false DECKHAND_DESKTOP_UPDATE_REPOSITORY= \
  node scripts/build-desktop-artifact.ts --platform mac --target dir --arch arm64 \
  --build-version 0.1.0-preview.20261003.1 --output-dir /absolute/new-output
```

The command builds the current web/server/desktop source, stages runtime dependencies and the required resource monitor, and invokes electron-builder with `--publish never`. Use `--target zip` for a shareable local archive, or `dmg` for an installer image. Select `x64` or `universal` only when the corresponding Rust target and native prerequisites are installed. Preview and pull request versions are named **Deckhand (Preview)** in the package and window title, and never carry an updater feed. Local modified source is identified in About; its base commit alone does not describe the entire build.

For acceptance, launch the app executable directly with both `DECKHAND_HOME` and `DECKHAND_PROFILE_ROOT` set to new test directories. Do not copy it over an installed T3, Deckhand or Cinderdeck app. Do not use live stores. The main acceptance run must check cold startup, the actual bundled renderer/backend, independent storage, protocols, licenses and clean shutdown. Building successfully does not establish those behaviors.

Release setup still requires a Deckhand-controlled update repository/feed, the intended release version, a Developer ID signing identity and Apple notarization configuration. Feed verification, signed/notarized artifact verification, clean-machine install/update/uninstall and preserved unrelated app data are external release gates. An unsigned local build cannot satisfy them. Keep signing credentials out of source, diagnostics and build evidence. Configure only the independent `DECKHAND_DESKTOP_UPDATE_REPOSITORY`; T3’s repository is refused and ambient GitHub repository configuration is ignored.
