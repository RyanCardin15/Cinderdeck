# Cinderdeck releases

Cinderdeck has its own release line, beginning at **1.0.0 (200)**. Its repository is `RyanCardin15/Cinderdeck`; its default branch is `main`. Upstream Snapzy tags and history are provenance, not Cinderdeck release artifacts.

## Current distribution state

Build from source using [BUILD.md](BUILD.md). The repository starts with an empty `appcast.xml`. There is no inherited Snapzy DMG, cask checksum, notarization ticket, or Sparkle signing key. `install.sh` targets only Cinderdeck releases and reports when no release exists.

## Release pipeline

The preparation workflow changes the version, updates the changelog, and opens a `release/v…` pull request against `main`. Merging a release pull request triggers the publishing workflow. The rebrand PR itself is not a release trigger.

Before publishing, configure the repository’s own signing certificate, Apple team, notarization credentials, and Sparkle signing secret according to `.github/workflows/release-publish.yml`. Keep credentials in GitHub secrets. The workflow validates signing, builds `Cinderdeck.app`, packages `Cinderdeck-vVERSION.dmg`, and uploads release artifacts. Notarization must be confirmed by that run; do not imply that a development build is notarized.

Stable releases generate `Casks/cinderdeck.rb` from `Casks/cinderdeck.rb.template` with the actual version and SHA-256. Until that happens the template is not an installable Homebrew cask. Do not install upstream Snapzy’s cask expecting Cinderdeck features.

## Enabling in-app updates

1. Generate a **new Cinderdeck** Sparkle EdDSA key pair using Sparkle’s tools. Store the private key securely in release secrets.
2. Put the matching public key in `SUPublicEDKey` in `Cinderdeck/Resources/Info.plist`.
3. Keep `SUFeedURL` set to `https://raw.githubusercontent.com/RyanCardin15/Cinderdeck/main/appcast.xml` and publish a verified, signed Cinderdeck update there.
4. Set `CinderdeckSignedUpdatesEnabled` to true after validating the complete update flow.
5. Verify a signed older Cinderdeck app updates to the new one with user data and macOS permissions intact.

The runtime policy requires the Cinderdeck feed, a public key, and the explicit enable flag; it rejects the old Snapzy public key. With updates unconfigured, the updater does not start and manual checks open Cinderdeck’s release page. Automatic checks/download controls remain disabled.

The optional release notification workflow uses only explicitly configured repository secrets. No notification is sent by a local build or rename.
