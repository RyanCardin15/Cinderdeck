#!/usr/bin/env python3
"""Installer failure-path checks; no real keychain, /Applications, or TCC changes.

Run on macOS with: python3 scripts/tests/test_local_signing.py
"""
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
IDENTITY = "Cinderdeck Local Development"
FINGERPRINT = "1234567890ABCDEF1234567890ABCDEF12345678"

MOCK = r'''
import json, os, pathlib, plistlib, sys
command = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ['SIGNING_TEST_CALLS'], 'a') as log:
    log.write(json.dumps([command] + args) + '\n')
if command == 'security':
    if args[0] == 'find-identity':
        identities = json.loads(os.environ['SIGNING_TEST_IDENTITIES'])
        for index, (fingerprint, name) in enumerate(identities, 1):
            print(f'  {index}) {fingerprint} "{name}"')
        print(f'     {len(identities)} valid identities found')
    elif args[0] == 'find-certificate':
        sys.exit(0 if os.environ.get('SIGNING_TEST_INVALID_CERT') else 44)
    else:
        sys.exit('Unexpected keychain mutation')
elif command == 'node':
    if args[0] == '-p':
        print('11.10.0')
    elif args[0] != '-e':
        output = pathlib.Path(args[args.index('--output-dir') + 1])
        shell = output / 'AgentShell.app/Contents'
        (shell / 'MacOS').mkdir(parents=True)
        executable = shell / 'MacOS/AgentShell'
        executable.write_text('#!/bin/sh\nexit 0\n')
        executable.chmod(0o755)
        with (shell / 'Info.plist').open('wb') as info:
            plistlib.dump({'CFBundleIdentifier': 'com.ryancardin.cinderdeck.agentshell', 'CFBundleExecutable': 'AgentShell'}, info)
elif command == 'npm':
    pathlib.Path('node_modules').mkdir(exist_ok=True)
elif command == 'lipo':
    print('arm64')
elif command == 'cargo':
    print('fixture cargo')
elif command == 'xcodebuild':
    if os.environ.get('SIGNING_TEST_BUILD_FAIL'):
        sys.exit(65)
    derived = pathlib.Path(args[args.index('-derivedDataPath') + 1])
    app = derived / 'Build/Products/Release/Cinderdeck.app'
    framework = app / 'Contents/Frameworks/Sparkle.framework'
    for relative in ['Versions/B/XPCServices/Installer.xpc', 'Versions/B/XPCServices/Downloader.xpc', 'Versions/B/Updater.app']:
        (framework / relative).mkdir(parents=True)
    (app / 'Contents/Resources').mkdir()
    (app / 'Contents/Resources/AppIcon.icns').write_bytes(b'fixture cinderdeck icon')
    (app / 'Contents/MacOS').mkdir()
    executable = app / 'Contents/MacOS/Cinderdeck'
    executable.write_text('#!/bin/sh\n[ -z "$SIGNING_TEST_LAUNCH_FAIL" ]\n')
    executable.chmod(0o755)
    with (app / 'Contents/Info.plist').open('wb') as info:
        plistlib.dump({'CFBundleIdentifier': os.environ.get('SIGNING_TEST_BUNDLE_ID', 'com.ryancardin.cinderdeck'), 'CFBundleExecutable': 'Cinderdeck'}, info)
elif command == 'codesign':
    if '--display' in args:
        sys.exit(0)
    if '--entitlements' in args and args[-1].endswith('/Cinderdeck.app'):
        pathlib.Path(os.environ['CINDERDECK_DERIVED_DATA_PATH'], 'signed-entitlements.plist').write_bytes(pathlib.Path(args[args.index('--entitlements') + 1]).read_bytes())
    if '--verify' in args:
        if '-R=anchor apple generic' in args:
            sys.exit(0 if os.environ.get('SIGNING_TEST_APPLE_IDENTITY') else 1)
        sys.exit(1 if os.environ.get('SIGNING_TEST_VERIFY_FAIL') else 0)
    elif '-dr' in args:
        print('designated => ' + os.environ.get('SIGNING_TEST_REQUIREMENT', 'identifier "com.ryancardin.cinderdeck" and certificate root = H"1234567890abcdef1234567890abcdef12345678"'))
    elif os.environ.get('SIGNING_TEST_SIGN_FAIL'):
        sys.exit(1)
else:
    sys.exit('Unexpected external action: ' + command)
'''


@unittest.skipUnless(sys.platform == 'darwin', 'macOS shell and PlistBuddy required')
class LocalSigningTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cinderdeck signing tests ')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.calls_file = self.directory / 'calls.jsonl'
        self.bin = self.directory / 'bin'
        self.bin.mkdir()
        for name in ['security', 'xcodebuild', 'codesign', 'tccutil', 'open', 'node', 'npm', 'cargo', 'lipo']:
            executable = self.bin / name
            executable.write_text(f'#!{sys.executable}\n' + MOCK)
            executable.chmod(0o755)
        self.keychain = self.directory / 'test.keychain-db'
        self.keychain.touch()
        # Use a private copy so build-only test artifacts cannot touch the real repo.
        (self.directory / 'scripts').mkdir()
        (self.directory / 'Cinderdeck').mkdir()
        for name in ['install-local.sh', 'create-signing-cert.sh', 'build-unified.sh', 'runtime-build-env.sh']:
            shutil.copy2(ROOT / 'scripts' / name, self.directory / 'scripts' / name)
        shutil.copy2(ROOT / 'Cinderdeck/Cinderdeck.entitlements', self.directory / 'Cinderdeck/Cinderdeck.entitlements')
        runtime = self.directory / 'agent-runtime'
        (runtime / 'scripts').mkdir(parents=True)
        (runtime / 'scripts/build-desktop-artifact.ts').touch()
        (runtime / 'package.json').write_text('{"packageManager":"pnpm@11.10.0"}')
        self.env = dict(os.environ)
        self.env.update({
            'PATH': str(self.bin) + os.pathsep + os.environ['PATH'],
            'CINDERDECK_SIGNING_KEYCHAIN': str(self.keychain),
            'CINDERDECK_NODE_BINARY': str(self.bin / 'node'),
            'CINDERDECK_SIGNING_IDENTITY': IDENTITY,
            'CINDERDECK_DERIVED_DATA_PATH': str(self.directory / 'derived data'),
            'SIGNING_TEST_CALLS': str(self.calls_file),
            'SIGNING_TEST_IDENTITIES': json.dumps([[FINGERPRINT, IDENTITY]]),
        })

    def run_installer(self, *arguments):
        return subprocess.run(
            [str(self.directory / 'scripts/install-local.sh'), '--build-only', *arguments],
            env=self.env, text=True, capture_output=True,
        )

    def calls(self):
        if not self.calls_file.exists():
            return []
        return [json.loads(line) for line in self.calls_file.read_text().splitlines()]

    def assert_no_install_side_effects(self):
        self.assertFalse(any(call[0] in ['open', 'tccutil'] for call in self.calls()))

    def test_reuses_identity_and_signs_nested_code_by_fingerprint(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('Reusing code-signing identity', result.stdout)
        signatures = [call for call in self.calls() if call[0] == 'codesign' and '--sign' in call]
        self.assertGreaterEqual(len(signatures), 6)
        self.assertTrue(any(call[-1].endswith('/AgentShell.app') for call in signatures))
        for call in signatures:
            self.assertEqual(call[call.index('--sign') + 1], FINGERPRINT)
        self.assertTrue(signatures[-1][-1].endswith('/Cinderdeck.app'))
        # Locate the final delivery independently of its staging directory.
        shell = next((self.directory / 'derived data').glob('unified.*/Cinderdeck.app/Contents/Resources/AgentShell.app/Contents'))
        info = plistlib.loads((shell / 'Info.plist').read_bytes())
        self.assertEqual(info['CFBundleName'], 'AgentShell')
        self.assertEqual(info['CFBundleDisplayName'], 'Cinderdeck')
        self.assertEqual(info['CFBundleExecutable'], 'AgentShell')
        self.assertEqual((shell / 'Resources' / info['CFBundleIconFile']).read_bytes(), b'fixture cinderdeck icon')
        entitlements = plistlib.loads((self.directory / 'derived data/signed-entitlements.plist').read_bytes())
        self.assertTrue(entitlements['com.apple.security.cs.disable-library-validation'])
        self.assert_no_install_side_effects()

    def test_apple_identity_keeps_library_validation_enabled(self):
        self.env['SIGNING_TEST_APPLE_IDENTITY'] = '1'
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        entitlements = plistlib.loads((self.directory / 'derived data/signed-entitlements.plist').read_bytes())
        self.assertNotIn('com.apple.security.cs.disable-library-validation', entitlements)

    def test_rejects_ad_hoc_before_build(self):
        self.env['CINDERDECK_SIGNING_IDENTITY'] = '-'
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_build_only_cannot_reset_permissions(self):
        self.assertNotEqual(self.run_installer('--reset-permissions').returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_rejects_missing_custom_identity_without_generating_one(self):
        self.env['CINDERDECK_SIGNING_IDENTITY'] = 'Missing'
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertEqual([call[0] for call in self.calls()], ['security'])

    def test_rejects_duplicate_identity_names(self):
        self.env['SIGNING_TEST_IDENTITIES'] = json.dumps([
            [FINGERPRINT, IDENTITY], ['A' * 40, IDENTITY],
        ])
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertFalse(any(call[0] == 'xcodebuild' for call in self.calls()))

    def test_accepts_explicit_fingerprint_among_duplicate_names(self):
        self.env['CINDERDECK_SIGNING_IDENTITY'] = FINGERPRINT.lower()
        self.env['SIGNING_TEST_IDENTITIES'] = json.dumps([
            [FINGERPRINT, IDENTITY], ['A' * 40, IDENTITY],
        ])
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_does_not_replace_invalid_existing_certificate(self):
        self.env['SIGNING_TEST_IDENTITIES'] = '[]'
        self.env['SIGNING_TEST_INVALID_CERT'] = '1'
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('refusing to replace', result.stderr)
        self.assertFalse(any(call[0] == 'xcodebuild' for call in self.calls()))

    def test_build_failure_stops_before_signing(self):
        self.env['SIGNING_TEST_BUILD_FAIL'] = '1'
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertFalse(any(call[0] == 'codesign' for call in self.calls()))
        self.assert_no_install_side_effects()

    def test_wrong_bundle_identifier_stops_before_signing(self):
        self.env['SIGNING_TEST_BUNDLE_ID'] = 'com.ryancardin.cinderdeck.debug'
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertFalse(any(call[0] == 'codesign' for call in self.calls()))

    def test_signing_failure_is_fatal(self):
        self.env['SIGNING_TEST_SIGN_FAIL'] = '1'
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assert_no_install_side_effects()

    def test_signature_verification_failure_is_fatal(self):
        self.env['SIGNING_TEST_VERIFY_FAIL'] = '1'
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assert_no_install_side_effects()

    def test_launch_failure_is_fatal(self):
        self.env['SIGNING_TEST_LAUNCH_FAIL'] = '1'
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assert_no_install_side_effects()

    def test_cdhash_requirement_is_rejected(self):
        self.env['SIGNING_TEST_REQUIREMENT'] = 'cdhash H"0123456789abcdef"'
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assert_no_install_side_effects()

    def run_cleanup(self, *, installed=True, archive_failure=False):
        staging = self.directory / 'staging'
        previous = staging / 'previous.app'
        previous.mkdir(parents=True)
        (previous / 'saved-binary').write_bytes(b'previous installation')
        destination = self.directory / 'Cinderdeck.app'
        if installed:
            destination.mkdir()
            (destination / 'new-binary').write_bytes(b'new installation')
        script = (ROOT / 'scripts/install-local.sh').read_text()
        cleanup = script[script.index('cleanup() {'):script.index('trap cleanup EXIT')]
        env = dict(os.environ, STAGING_DIR=str(staging), INSTALL_PATH=str(destination),
                   APP_PATH=str(self.directory / 'build.app'), LSREGISTER='/usr/bin/true')
        prefix = 'ditto() { return 1; }\n' if archive_failure else ''
        result = subprocess.run(['bash', '-c', 'set -euo pipefail\n' + prefix + cleanup + '\ncleanup'],
                                env=env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return staging, destination

    def test_successful_install_keeps_archive_instead_of_registered_app_backup(self):
        staging, destination = self.run_cleanup()
        self.assertFalse((staging / 'previous.app').exists())
        with zipfile.ZipFile(staging / 'previous.app.zip') as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(archive.read('previous.app/saved-binary'), b'previous installation')
        self.assertEqual((destination / 'new-binary').read_bytes(), b'new installation')

    def test_archive_failure_preserves_previous_installation(self):
        staging, destination = self.run_cleanup(archive_failure=True)
        self.assertEqual((staging / 'previous.app/saved-binary').read_bytes(), b'previous installation')
        self.assertEqual((destination / 'new-binary').read_bytes(), b'new installation')

    def test_failed_replacement_restores_previous_installation(self):
        staging, destination = self.run_cleanup(installed=False)
        self.assertEqual((destination / 'saved-binary').read_bytes(), b'previous installation')
        self.assertFalse(staging.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
