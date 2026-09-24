# Cinderdeck releases

Cinderdeck has its own release line, beginning at **1.0.0 (200)**. Its repository is `RyanCardin15/Cinderdeck`; its default branch is `main`. Upstream Snapzy tags and history are provenance, not Cinderdeck release artifacts.

People install Cinderdeck once from a release (the DMG or `install.sh`). After that, Sparkle keeps it current: it checks the signed feed daily, downloads new versions in the background, and installs them when Cinderdeck quits or when the user chooses **Restart to Update**. See [UPDATES.md](UPDATES.md) for the in-app flow.

## One-time setup

Releases refuse to publish until update signing is configured, because a release that cannot verify updates would strand every copy installed from it.

On your Mac, with the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`), run:

```bash
./scripts/setup-release-signing.sh
```

The script:

1. Creates Cinderdeck's Sparkle EdDSA key in your login keychain (keychain account `cinderdeck`), or reuses it. The private key goes straight to the `SPARKLE_PRIVATE_KEY` Actions secret and is never printed.
2. Writes the matching public key to `SUPublicEDKey` in `Cinderdeck/Resources/Info.plist` and sets `CinderdeckSignedUpdatesEnabled` to true.
3. If the repository has no code-signing secret, creates the **Cinderdeck Self-Signed** certificate and uploads `SELF_SIGNED_CERT_P12` and `SELF_SIGNED_CERT_PASSWORD`. It leaves existing `DEVELOPER_ID_P12` or `SELF_SIGNED_CERT_P12` secrets alone.

Commit the Info.plist change and merge it to `main`. Then back up the key: Keychain Access lists it as **Private key for signing Sparkle updates**. Without it, new releases cannot update copies already installed. If the Info.plist already trusts a different key, the script stops instead of replacing it; see [Changing the update key](#changing-the-update-key).

Code signing options, best first:

| Secrets | Result |
|---|---|
| `DEVELOPER_ID_P12`, `DEVELOPER_ID_PASSWORD` (+ `APPLE_ID`, `APPLE_ID_PASSWORD`, `APPLE_TEAM_ID` to notarize) | No Gatekeeper warning; library validation stays on. Requires the Apple Developer Program. |
| `SELF_SIGNED_CERT_P12`, `SELF_SIGNED_CERT_PASSWORD` | macOS asks users to approve the first install from a browser download (System Settings → Privacy & Security → Open Anyway). Updates and permissions carry over afterwards. |
| `ALLOW_ADHOC_RELEASE=true` | Not recommended: permissions may reset on every update. |

The repository setting **Allow GitHub Actions to create and approve pull requests** must be on for the prepare workflow to open release pull requests.

## Publishing a release

1. Run **Actions → Release Prepare** (or `gh workflow run release-prepare.yml -f version_type=patch -f channel=stable`). A push to `main` whose commit message starts with `release(patch):`, `release(minor):`, or `release(major):` (with `-beta` for a beta, such as `release(patch-beta):`) does the same. The first release must be stable, because beta numbering is based on existing tags.
2. The workflow bumps the version and build number, adds a `CHANGELOG.md` entry, and opens a `release/v…` pull request. The first release's notes start at the Cinderdeck fork point rather than Snapzy's history.
3. Merge that pull request. **Release Publish** then:
   - checks that `SPARKLE_PRIVATE_KEY` matches `SUPublicEDKey` and that signed updates are on, before building anything;
   - builds, signs Sparkle's helpers and the app with hardened runtime (library validation is disabled only for signing identities without an Apple Team ID, as in `scripts/install-local.sh`), and confirms the signed app launches;
   - packages `Cinderdeck-vVERSION.dmg`, notarizes it when Developer ID credentials exist, signs it with EdDSA, and confirms the signature matches the key in the app;
   - publishes the GitHub release, prepends the item to `appcast.xml` (tagged `beta` for pre-releases), updates `Casks/cinderdeck.rb` for stable releases, and pushes those changes to `main`.

Installed copies see the update at their next daily check, or immediately from **Check for Updates**. `raw.githubusercontent.com` can cache `appcast.xml` for a few minutes.

## Moving existing installs onto releases

Copies built from source before signed updates were configured, or with the Debug configuration, cannot update themselves. Install the first release once, from the DMG or with:

```bash
curl -fsSL https://raw.githubusercontent.com/RyanCardin15/Cinderdeck/main/install.sh | bash
```

Release builds made from source after the setup commit trust the same key, so they also update to published releases. Their signing identity differs from the release certificate, so macOS asks for capture and accessibility permissions again after that first update.

## Changing the update key

Sparkle accepts an update when either its EdDSA signature matches the installed app's `SUPublicEDKey` or its code signature matches the installed app's. To rotate the key, keep the release code-signing certificate unchanged for that release, run `./scripts/setup-release-signing.sh --replace-key` with the new key, and publish. Never change the key and the certificate in the same release.

## Runtime policy

`CinderdeckUpdatePolicy` starts the updater only when `CinderdeckSignedUpdatesEnabled` is true, the bundle identifier is `com.ryancardin.cinderdeck` (never the Debug build), the feed is Cinderdeck's (or the local test feed of `scripts/test-update-local.sh`), and `SUPublicEDKey` is a 32-byte key other than upstream Snapzy's. Otherwise Preferences shows that the build cannot update itself and **Check for Updates** opens the releases page.

The optional release notification workflow uses only explicitly configured repository secrets. No notification is sent by a local build or rename.
