# Local Sparkle Update Testing

> Cinderdeck’s automatic updates are disabled until its own signed feed is configured. Manual checks open GitHub releases. The updater architecture below applies after that setup; see [RELEASES.md](RELEASES.md).

Test the full Sparkle in-app update flow locally before pushing releases. This validates that code signing configurations work correctly with Sparkle's XPC installer in sandboxed mode.

> [!IMPORTANT]
> The release workflow signs with `codesign` which does **not** substitute Xcode build variables like `$(PRODUCT_BUNDLE_IDENTIFIER)`. All signing scripts pre-process the entitlements file with `sed` to substitute the actual bundle ID. Without this, Sparkle's XPC mach-lookup connections fail with error 4005.

## Prerequisites

1. **Self-signed certificate** in your login keychain:
   ```bash
   # Generate if missing
   ./scripts/create-signing-cert.sh
   ```

2. **Sparkle EdDSA private key** file (same key used in `SPARKLE_PRIVATE_KEY` GitHub secret):
   ```bash
   export SPARKLE_PRIVATE_KEY_FILE=~/path/to/sparkle_private_key.pem
   ```

3. **Built Sparkle artifacts** (the `sign_update` binary):
   - Build the project once in Xcode (`Cmd+B`) to populate SPM artifacts
   - The script auto-discovers `sign_update` from `build/*/SourcePackages/artifacts/`

## How It Works

The script creates a simulated update scenario:

```
 ┌────────────────────┐     appcast.xml      ┌───────────────────────┐
 │  Installed v99.0.0 │ ──── checks ───────► │  Local HTTP :8089     │
 │  /Applications/    │                      │  ├── appcast.xml      │
 │  Cinderdeck.app        │ ◄── downloads ────── │  └── Cinderdeck-test.dmg  │
 └────────────────────┘     v99.0.1 DMG      └───────────────────────┘
```

1. Builds an Xcode archive (reused across runs)
2. Creates **v1** (99.0.0) — patches `Info.plist`, signs, installs to `/Applications`
3. Creates **v2** (99.0.1) — patches `Info.plist`, signs, creates DMG
4. Signs DMG with Sparkle EdDSA key
5. Generates `appcast.xml` pointing to `http://localhost:8089/Cinderdeck-test.dmg`
6. Starts a local HTTP server on port 8089

## Signing Modes

| Mode | Sparkle helpers | Main app | Purpose |
|---|---|---|---|
| `test-current` | Self-signed cert | Self-signed cert | Reproduce error 4005 |
| `test-hybrid` | Ad-hoc (`-`) | Self-signed cert | Validate hybrid fix |
| `test-channel` | Ad-hoc (`-`) | Self-signed cert | Validate stable/beta channel filtering |

"Sparkle helpers" = `Installer.xpc`, `Downloader.xpc`, `Autoupdate`, `Updater.app`, `Sparkle.framework`

## Usage

### Test current signing (reproduce error 4005)

```bash
export SPARKLE_PRIVATE_KEY_FILE=~/path/to/sparkle_private_key.pem
./scripts/test-update-local.sh test-current
```

1. Wait for build + server start
2. Open Cinderdeck from `/Applications`
3. Menu bar → Preferences → About → **Check for Updates**
4. **Expected**: Error 4005 — "remote port connection was invalidated"
5. `Ctrl+C` to stop server

### Test hybrid signing (validate fix)

```bash
./scripts/test-update-local.sh test-hybrid
```

1. Wait for build + server start
2. Open Cinderdeck from `/Applications`
3. Menu bar → Preferences → About → **Check for Updates**
4. **Expected**: Update downloads and installs — app relaunches as v99.0.1
5. `Ctrl+C` to stop server

### Test update channels (stable vs beta)

```bash
./scripts/test-update-local.sh test-channel
```

Serves an appcast with two items: stable `99.0.1` (untagged) and beta `99.0.2-beta.1` (`<sparkle:channel>beta</sparkle:channel>`, higher build number). Installed app is `99.0.0`.

**Scenario A — stable channel (default):**

1. `defaults delete com.ryancardin.cinderdeck updates.channel` (or leave unset)
2. Open Cinderdeck → About → **Check for Updates**
3. **Expected**: offered `99.0.1` — never `99.0.2-beta.1`

**Scenario B — beta channel:**

1. In **About → Update Channel** select **Beta** (or `defaults write com.ryancardin.cinderdeck updates.channel -string beta`)
2. **Check for Updates**
3. **Expected**: offered `99.0.2-beta.1`; the diagnostics log shows `Allowed channels: [beta]` (stable checks log `Allowed channels: [] (stable)`)

Teardown: `defaults delete com.ryancardin.cinderdeck updates.channel` (also done by `clean`).

### Clean up

```bash
./scripts/test-update-local.sh clean
```

Removes `/tmp/test-sparkle-update/` and resets the `updates.channel` preference. Does **not** remove `/Applications/Cinderdeck.app` — re-install from a release DMG or use `test-tcc-local.sh` to restore.

## Notes

- Test versions (`99.0.0`, `99.0.1`) avoid conflicts with real releases
- First run builds the archive (~2-5 min); subsequent runs reuse it
- The feed URL in v1's `Info.plist` is patched to `http://localhost:8089/appcast.xml`
- Server runs on port 8089 to avoid collisions with common dev servers
- Archive is stored at `/tmp/test-sparkle-update/archive/` — delete to force rebuild

## Related

- [Self-signed certificate setup](SELF_SIGNED_CERT.md)
- [Release workflow](RELEASES.md)
- `scripts/test-tcc-local.sh` — TCC permission persistence testing (separate concern)
