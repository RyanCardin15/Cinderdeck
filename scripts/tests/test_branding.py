import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("branding", Path(__file__).parents[1] / "check-branding.py")
branding = importlib.util.module_from_spec(spec)
spec.loader.exec_module(branding)


class BrandingTests(unittest.TestCase):
    def test_rejects_product_labels_urls_and_package_identity(self):
        for value in ('<h1>T3 Code</h1>', '<strong>T3</strong>', '"T3Code"', '"@t3tools/web"', '"https://app.t3.codes"'):
            self.assertTrue(branding.violations("agent-runtime/apps/web/src/NewPanel.tsx", value), value)

    def test_rejects_ordinary_symbols_and_paths(self):
        self.assertTrue(branding.violations("agent-runtime/apps/mobile/scripts/new.mts", 'name: "T3DeviceStream"'))
        self.assertTrue(branding.path_violations("agent-runtime/apps/web/src/T3PreviewPanel.tsx"))
        self.assertEqual(branding.violations("agent-runtime/apps/mobile/src/features/terminal/nativeTerminalModule.ts", 'const name = "T3TerminalSurface";'), [])
        self.assertTrue(branding.violations("agent-runtime/apps/mobile/src/features/terminal/nativeTerminalModule.ts", 'const name = "T3TerminalSurface"; const brand = "T3DeviceStream";'))

    def test_native_paths_only_exempt_registered_filenames(self):
        for path in (
            "agent-runtime/apps/mobile/modules/t3-terminal/ios/T3Promo.swift",
            "agent-runtime/apps/mobile/src/native/T3Promo.tsx",
            "agent-runtime/apps/mobile/modules/t3-terminal/t3-promo/T3TerminalNative.podspec",
            "agent-runtime/apps/mobile/modules/t3-new-product/index.ts",
        ):
            self.assertTrue(branding.path_violations(path), path)
        self.assertFalse(branding.path_violations(
            "agent-runtime/apps/mobile/src/native/T3ComposerEditor.ios.tsx"))

    def test_protocol_and_vendor_path_exemptions_stay_in_their_owned_roots(self):
        for path in (
            "agent-runtime/apps/web/src/_generated/T3Panel.tsx",
            "agent-runtime/apps/web/src/testkit/fixtures/T3Panel.tsx",
            "agent-runtime/apps/desktop/src/Vendor/T3Panel.ts",
            "agent-runtime/apps/web/src/Vendor/libghostty/T3Panel.tsx",
            "agent-runtime/packages/effect-acp/tools/_generated/T3Panel.ts",
        ):
            self.assertTrue(branding.path_violations(path), path)
        for path in (
            "agent-runtime/packages/effect-acp/src/_generated/T3Protocol.ts",
            "agent-runtime/packages/effect-codex-app-server/src/_generated/T3Protocol.ts",
            "agent-runtime/apps/server/src/orchestration-v2/testkit/fixtures/T3Transcript.json",
            "agent-runtime/native/libghostty-vt/T3Original.h",
        ):
            self.assertFalse(branding.path_violations(path), path)

    def test_parser_benchmark_comments_do_not_exempt_upstream_branding(self):
        path = "agent-runtime/apps/server/src/pullRequest/gitHubPullRequestJson.ts"
        self.assertTrue(branding.violations(path, "// Measured against pingdotgg/t3code"))
        self.assertTrue(branding.violations(path, 'const upstream = "https://github.com/pingdotgg/t3code";'))

    def test_user_agent_fixture_does_not_exempt_adjacent_branding(self):
        path = "agent-runtime/apps/desktop/src/preview/BrowserSession.test.ts"
        fixture = '"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) T3Code(Alpha)/0.0.33 Chrome/146.0.7680.216 Electron/41.5.0 Safari/537.36";'
        self.assertEqual(branding.violations(path, fixture), [])
        self.assertTrue(branding.violations(path, fixture + ' const brand = "T3 Code";'))

    def test_compatibility_tokens_do_not_exempt_other_copy(self):
        self.assertEqual(branding.violations("agent-runtime/packages/client-runtime/src/store.ts", 'const key = "t3code:renderer-state:v8";'), [])
        self.assertTrue(branding.violations("agent-runtime/packages/client-runtime/src/store.ts", 'const key = "t3code:renderer-state:v8"; const label = "T3 Code";'))

    def test_paths_and_identities_cannot_hide_as_storage_keys(self):
        self.assertTrue(branding.path_violations("agent-runtime/apps/web/src/T3CodePanel.tsx"))
        self.assertFalse(branding.path_violations("agent-runtime/apps/mobile/modules/t3-terminal/ios/T3TerminalModule.swift"))
        self.assertTrue(branding.violations("agent-runtime/apps/web/src/NewPanel.tsx", '"https://github.com/example/t3code.git"'))
        self.assertTrue(branding.violations("agent-runtime/apps/mobile/app.config.ts", '"com.t3tools.mobile"'))

    def test_credential_exception_is_only_for_the_persisted_owner(self):
        path = "agent-runtime/packages/contracts/src/providerSetup.ts"
        self.assertEqual(branding.violations(path, 'credentialOwner: Schema.Literals(["provider", "t3"]),'), [])
        self.assertTrue(branding.violations(path, 'const label = "t3";'))

    def test_native_abi_does_not_exempt_product_copy(self):
        path = "agent-runtime/apps/mobile/modules/t3-terminal/ios/T3TerminalNative.swift"
        self.assertEqual(branding.violations(path, 'class T3TerminalNative {}'), [])
        self.assertTrue(branding.violations(path, 'let label = "T3 Code"'))

    def test_lowercase_identifiers_help_and_demo_urls_are_rejected(self):
        for text in ('const t3 = {};', 'const t3Panel = {};', '"t3dotgg/fleet"', '"t3chat"', '"Run t3 theme set"', '"https://demo.t3.sh"'):
            self.assertTrue(branding.violations("agent-runtime/apps/web/src/NewPanel.tsx", text))

    def test_protocol_tokens_and_exact_legacy_lines_do_not_exempt_adjacent_branding(self):
        path = "agent-runtime/packages/contracts/src/environmentHttp.ts"
        self.assertEqual(branding.violations(path, '"/.well-known/t3/environment"'), [])
        self.assertTrue(branding.violations(path, '"/.well-known/t3/environment"; const t3 = {};'))
        path = "agent-runtime/apps/server/src/cli/launcher.ts"
        line = 'const shimPath = path.join(directory, "t3.cmd");'
        self.assertEqual(branding.violations(path, line), [])
        self.assertTrue(branding.violations(path, line + ' const brand = "t3";'))

    def test_legal_looking_text_cannot_hide_product_copy(self):
        path = "agent-runtime/apps/web/src/NewPanel.tsx"
        self.assertTrue(branding.violations(path, 'const label = "Copyright T3 Code";'))
        podspec = "agent-runtime/apps/mobile/modules/t3-terminal/T3TerminalNative.podspec"
        notice = "s.author = { 'T3 Tools' => 'hello@t3tools.com' }"
        self.assertEqual(branding.violations(podspec, notice), [])
        self.assertTrue(branding.violations(podspec, notice + '; label = "T3 Code"'))
        self.assertTrue(branding.violations(podspec, 's.author = "T3 Code"'))

    def test_preserves_original_notices_and_recorded_protocol_data(self):
        self.assertEqual(branding.violations("agent-runtime/LICENSE", "Copyright (c) 2026 T3 Tools Inc."), [])
        self.assertEqual(branding.violations("agent-runtime/apps/server/src/orchestration-v2/testkit/fixtures/simple/codex_transcript.ndjson", '{"input":"T3 Code"}'), [])
        self.assertTrue(branding.violations("agent-runtime/apps/server/src/NewService.ts", 'const label = "T3 Code"'))

    def test_replay_exception_is_only_the_original_identity_comparison(self):
        path = "agent-runtime/packages/effect-codex-app-server/src/replay.ts"
        line = 'const legacyClient = clientInfo.name === "T3 Code" && clientInfo.title === "T3 Code";'
        self.assertEqual(branding.violations(path, line), [])
        self.assertTrue(branding.violations(path, 'const label = "T3 Code";'))
        self.assertTrue(branding.violations(path, line + ' const label = "T3 Code";'))

    def test_source_attribution_fixture_does_not_allow_other_vendor_urls(self):
        path = "agent-runtime/scripts/lib/third-party-licenses.test.ts"
        self.assertEqual(branding.violations(path, '"https://github.com/Yash-Singh1/ghostty/tree/t3code/custom-io-ordered-feed",'), [])
        self.assertTrue(branding.violations(path, '"https://github.com/pingdotgg/t3code",'))
        self.assertTrue(branding.violations(path, 'const label = "T3 Code";'))

    def test_oauth_exception_does_not_allow_new_labels(self):
        path = "agent-runtime/apps/server/src/provider/acp/GrokAcpSupport.ts"
        self.assertEqual(branding.violations(path, 'const CINDERDECK_OAUTH_REFERRER = "t3code";'), [])
        self.assertTrue(branding.violations(path, 'const label = "T3 Code";'))
        self.assertTrue(branding.violations(path, 'const label = "t3code";'))


if __name__ == "__main__":
    unittest.main()
