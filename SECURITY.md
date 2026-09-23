# Cinderdeck security

Report vulnerabilities privately using [GitHub private vulnerability reporting](https://github.com/RyanCardin15/Cinderdeck/security/advisories/new). Include the affected version, a reproduction, and impact. This independent fork is maintained by [Ryan Cardin](https://github.com/RyanCardin15); do not route Cinderdeck-specific reports to the original Snapzy maintainer.

## Local execution and data

Cinderdeck is an unsandboxed native macOS app. Stack commands run with your user account’s privileges. Review imported definitions before starting them; importing a definition does not start it. Dependencies, environment variables, and ports are under your control. The supervisor tracks owned process groups so normal stop operations target the processes it launched.

The local control socket is restricted to the current user. CLI and MCP controls can start and stop configured commands and change Git state. Agent names are attribution, not authentication. Claims are advisory coordination and can be explicitly overridden. Grant access only to agents you trust with your development environment.

History, clipboard text, configuration, and logs stay on your Mac. Clipboard collection is opt-in and has retention limits. Logs can contain whatever your commands print; avoid printing secrets. Keychain references supply secrets to services at launch; Cinderdeck’s migration does not export or log them.

## Permissions and signing

Hardened Runtime is enabled and library validation stays on. Screen Recording, Microphone, Camera, and Accessibility permissions are requested through macOS when needed. Stacks do not require capture permissions. Cinderdeck’s new bundle identity has its own permission grants.

Source builds use the signing identity you configure. A development or ad-hoc build is not a notarized public release. Distribution signing and notarization must be verified for each release; see [release setup](docs/RELEASES.md).

## Optional network features

Configured service commands may use the network. Cinderdeck also supports Git operations, user-initiated uploads to your chosen cloud storage, Google Drive OAuth, and optional custom OCR endpoints/model downloads. Built-in OCR runs locally. Custom OCR sends the selected capture to the endpoint you choose. Cinderdeck has no account service or telemetry collector.

Cloud and OCR credentials are stored in the macOS Keychain. Existing Snapzy Keychain identifiers remain for compatibility. Cloud credential export is an explicit, encrypted export with a user-provided passphrase. Configuration exports do not include secret values.

## Updates

Automatic updates are disabled until Cinderdeck’s own signed feed is configured. The app rejects upstream Snapzy’s feed and signing key. Manual update checks open Cinderdeck’s releases. A new release must use the matching Cinderdeck EdDSA key and the expected bundle identity.

## Contributors

Preserve process ownership checks, socket permissions, Keychain boundaries, and explicit user choices. Never commit credentials, private keys, local history databases, or personal stack definitions. Keep the original [Snapzy license](LICENSE) and [attribution](NOTICE) with redistributed source and binaries.
