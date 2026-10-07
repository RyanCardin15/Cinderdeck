# Self-Signed Certificate Setup

Cinderdeck can use a persistent self-signed code signing certificate to preserve macOS TCC permissions (Screen Recording, Accessibility, Microphone, etc.) across local rebuilds and Sparkle updates.

## Why This Matters

macOS uses the app's **designated requirement** to recognize its signing identity. With ad-hoc signing (`codesign --sign -`), that requirement is a code hash (`cdhash`) that changes when the signed build changes. TCC grants can then stop working even while System Settings still shows them enabled. A persistent certificate yields a requirement tied to the certificate and bundle identifier instead of the build's code hash. See Apple's [code signature guide](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/AboutCS/AboutCS.html).

## Local Installs and One-Time TCC Repair

On the affected Mac, run:

```bash
./scripts/install-local.sh --reset-permissions
```

The installer runs `./scripts/create-signing-cert.sh --local` as needed. This creates **Cinderdeck Local Development** in your login keychain, trusts it only for code signing in your user account, and leaves the private key in the keychain. It does not print/export the private key. Repeated runs reuse the existing identity; they refuse to silently replace an expired, untrusted, or incomplete identity.

Self-signed builds retain hardened runtime but need the [Disable Library Validation entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.disable-library-validation) to load the bundled Sparkle framework without an Apple Team ID. The installer adds this exception only to its generated local entitlements for non-Apple identities; Apple-signed builds keep library validation enabled. It verifies signatures and runs the app's headless `stacks help` command before installing, catching dynamic-library loading failures without opening the app or requesting permissions.

After a successful verified install, `--reset-permissions` runs exactly:

```bash
tccutil reset ScreenCapture com.ryancardin.cinderdeck
tccutil reset Accessibility com.ryancardin.cinderdeck
```

Grant **Screen Recording** (called **Screen & System Audio Recording** on some macOS versions) and **Accessibility** to `/Applications/Cinderdeck.app` in System Settings, then quit and reopen Cinderdeck. These grants require user interaction. Do not reset all TCC services or the separate Debug bundle identifier.

For every subsequent local install, use:

```bash
./scripts/install-local.sh
```

This reuses the same certificate and leaves TCC grants in place. To inspect the installed identity:

```bash
codesign --verify --deep --strict /Applications/Cinderdeck.app
codesign -dr - /Applications/Cinderdeck.app
```

The designated requirement must contain a certificate or certificate anchor, rather than a bare `cdhash`. Keep the certificate **and its private key** in your keychain; recreating a certificate with the same name still changes the identity and requires another one-time re-grant. Each Mac can have its own local identity. An existing Apple-signed installation should continue using that identity via `CINDERDECK_SIGNING_IDENTITY`; see [build instructions](BUILD.md).

The capture hotkey's automatic permission flow prompts at most once per launch. Explicit permission buttons in onboarding, Preferences, and the status bar remain usable after that attempt. The guard does not reset when permission changes; capture still rechecks permission each time and resumes once access is available.

## Release Certificate Setup

### 1. Generate the Certificate

```bash
chmod +x scripts/create-signing-cert.sh
./scripts/create-signing-cert.sh
```

You'll be prompted for a password for the encrypted private-key export. This separate release mode uses the name **Cinderdeck Self-Signed**. Keep the export and its password in a private backup. If the named identity already exists, the script reuses it without generating a replacement; export it from Keychain Access if you need its P12 again.

### 2. Build and Verify Locally

Pass the exact identity to the unified builder:

```bash
./scripts/build-unified.sh --configuration Release --arch arm64 \
  --output-dir /absolute/path/to/release-output \
  --signing-identity 'Cinderdeck Self-Signed'
```

The builder verifies the outer app and its private bundled runtime. Keep the identity and its private key in the release Mac's keychain; GitHub secrets are not part of the manual release process. Follow [RELEASES.md](RELEASES.md) to package, sign the update archive, and publish.

## Local Testing

Run the installer safety tests without changing any real keychain, installation, or TCC grants:

```bash
python3 scripts/tests/test_local_signing.py
```

For normal rebuild verification, grant permissions after the first `install-local.sh` run, change/build the app again with `install-local.sh` (without the reset flag), and confirm both capture and Accessibility still work. A stable requirement is a prerequisite; actual TCC behavior must be checked interactively on the affected Mac.

The older `scripts/test-tcc-local.sh` also exercises release-style signing using **Cinderdeck Self-Signed**. It replaces the app in `/Applications` and may change its signing identity, so do not use it for routine installs:

```bash
# Step 1: Generate cert and import into login keychain
./scripts/create-signing-cert.sh

# Step 2: Build, sign with self-signed cert, install as v1
./scripts/test-tcc-local.sh build-v1
# → Open app → Grant Screen Recording + Microphone

# Step 3: Re-sign and replace (simulates Sparkle update)
./scripts/test-tcc-local.sh build-v2
# → Open app → Verify permissions are STILL granted ✅

# (Optional) Compare with ad-hoc to prove the difference
./scripts/test-tcc-local.sh compare
# → Open app → Permissions are LOST ❌
```

Clean up test artifacts when done:

```bash
./scripts/test-tcc-local.sh clean
```

## Signing Hierarchy

Choose an explicit persistent identity for the release:

1. **Developer ID** — best (Gatekeeper pass + TCC persist). Requires Apple Developer Program.
2. **Self-signed cert** — good (TCC persist, Gatekeeper warning on first install).
3. **Ad-hoc** — suitable for disposable Debug builds; refused for normal Release builds because permission identity changes between builds.

## Upgrading to Developer ID

When you enroll in Apple Developer Program:

1. Import your Developer ID certificate and private key into the release Mac's keychain.
2. Select that exact identity with `--signing-identity` and set `CINDERDECK_SIGNING_TIMESTAMP=--timestamp` when building for distribution.
3. Configure local `notarytool` credentials, then notarize and staple the release archive.
4. Users re-grant permissions **once** on the first update with the new identity

## Certificate Renewal

The default certificate is valid for 10 years. The script deliberately refuses to overwrite an existing identity. For an intentional release rotation, use a new name:

```bash
./scripts/create-signing-cert.sh "Cinderdeck Self-Signed 2036" 3650
```

Then select the new name with the unified builder's `--signing-identity` option and privately back up the new certificate and key. Changing the certificate changes the designated requirement; users must re-grant permissions once. For local renewal, create a new named identity with `--local` and select it with `CINDERDECK_SIGNING_IDENTITY` when running the installer with `--reset-permissions`.
