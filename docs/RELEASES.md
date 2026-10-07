# Cinderdeck releases

Cinderdeck has its own release line, beginning at **1.0.0 (200)**. Its repository is `RyanCardin15/Cinderdeck`; its default branch is `main`. Upstream Snapzy tags and history are provenance, not Cinderdeck release artifacts.

GitHub Actions is disabled for this repository. Builds, checks, signing, and release publication run locally and are initiated by a maintainer. Pull requests, pushes, tags, and release commits do not automatically build or publish anything.

People install Cinderdeck once from a release (the DMG or `install.sh`). After that, Sparkle checks the signed feed daily, downloads new versions in the background, and installs them when Cinderdeck quits or when the user chooses **Restart to Update**. Removing hosted release automation leaves this in-app update flow available for manually published releases. See [UPDATES.md](UPDATES.md).

## Signing setup

Use an existing persistent code-signing identity on the release Mac. [SELF_SIGNED_CERT.md](SELF_SIGNED_CERT.md) covers local certificate creation and reuse. Developer ID signing and notarization are preferred for public distribution; self-signed builds require first-install approval in macOS. The whole-app builder requires an explicit persistent identity for Release builds.

Keep Sparkle's EdDSA private key in the maintainer's keychain or a private backup. Reuse the key whose public half is already stored in `Cinderdeck/Resources/Info.plist` as `SUPublicEDKey`. Sparkle's `generate_keys --account cinderdeck -p` prints the public key for that keychain account. For an initial setup only, `generate_keys --account cinderdeck` creates the key if it is missing. These tools come from the pinned Sparkle distribution; no private key needs to be uploaded to GitHub.

Before distribution, verify that `SUPublicEDKey` matches the signing key and that `CinderdeckSignedUpdatesEnabled` is true. Review and commit any changes to those plist values through the normal repository process. Back up the key: Keychain Access lists it as **Private key for signing Sparkle updates**. Without it, new releases cannot update copies already installed.

## Local verification

Run the checks appropriate to the changed surfaces before delivery. The repository boundary check rejects new workflow files:

```bash
python3 scripts/check-repository.py
python3 scripts/tests/test_local_signing.py
./scripts/run-tests.sh
```

Run package typechecks from `agent-runtime/` with installed dependencies:

```bash
node_modules/.bin/vp run -r --concurrency-limit 2 typecheck
```

Build the complete app with `scripts/build-unified.sh`; see [UNIFIED_APP.md](UNIFIED_APP.md) for toolchain, build, and validation requirements. Native Cinderdeck owns signing and updates for the private bundled runtime.

## Publishing a release manually

1. On an up-to-date release checkout, run `./scripts/bump-version.sh patch stable` (or choose `minor`, `major`, or `beta`). It updates the marketing version and increments the build number. Prepare the corresponding `CHANGELOG.md` entry; `scripts/generate-changelog.sh` can generate notes from commits. Review and commit the release changes. Merging them does not publish a release.
2. Build the unified Release app using `scripts/build-unified.sh --configuration Release --arch arm64 --output-dir /absolute/path/to/release-output --signing-identity 'Your Existing Code Signing Identity'`. For Developer ID distribution, set `CINDERDECK_SIGNING_TIMESTAMP=--timestamp`. Verify the complete outer app, including the bundled runtime, and manually validate the release behavior.
3. Package the app into `Cinderdeck-vVERSION.dmg`. For Developer ID distribution, notarize and staple the archive with Apple's tools. Sign the final archive with Sparkle's `sign_update` using the existing EdDSA private key. Verify the returned signature with `swift scripts/sparkle-key-tool.swift verify <archive> <edSignature> <SUPublicEDKey>` before uploading anything.
4. Create the `vVERSION` GitHub release manually, attach the signed DMG, and use the changelog entry as its release notes. Mark beta versions as pre-releases. Publication requires explicit authorization.
5. Generate release-note HTML with `scripts/changelog-to-html.py`. Prepend the signed item to `appcast.xml` with `scripts/update-appcast.sh <version> <build_number> <dmg_path> appcast.xml <ed_signature> <release_notes_html> [channel]`. Use `beta` for a beta release. Update `Casks/cinderdeck.rb` from its template with the version and DMG SHA-256 for stable releases, and update documentation stamps with `scripts/update-docs-version-stamps.sh`. Review and commit these metadata changes to `main` through the normal repository process.

Installed copies see the published feed item at their next daily check, or immediately from **Check for Updates**. `raw.githubusercontent.com` can cache `appcast.xml` for a few minutes. Release notifications are manual.

## Moving existing installs onto releases

Copies built before signed updates were configured, or with the Debug configuration, cannot update themselves. Install a published release once, from the DMG or with:

```bash
curl -fsSL https://raw.githubusercontent.com/RyanCardin15/Cinderdeck/main/install.sh | bash
```

Release builds made from source with the trusted public key also update to published releases. If their signing identity differs from the release certificate, macOS may require capture and accessibility permissions again after that first update.

## Changing the update key

Sparkle accepts an update when either its EdDSA signature matches the installed app's `SUPublicEDKey` or its code signature matches the installed app's. To rotate the key, keep the release code-signing certificate unchanged for that release, update `SUPublicEDKey` locally to the new key's public half, review and commit it, then manually publish the signed release. Never change the key and the certificate in the same release.

## Runtime policy

`CinderdeckUpdatePolicy` starts the updater only when `CinderdeckSignedUpdatesEnabled` is true, the bundle identifier is `com.ryancardin.cinderdeck` (never the Debug build), the feed is Cinderdeck's (or the local test feed of `scripts/test-update-local.sh`), and `SUPublicEDKey` is a 32-byte key other than upstream Snapzy's. Otherwise Preferences shows that the build cannot update itself and **Check for Updates** opens the releases page.
