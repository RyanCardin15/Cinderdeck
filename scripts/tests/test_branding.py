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

    def test_compatibility_tokens_do_not_exempt_other_copy(self):
        self.assertEqual(branding.violations("agent-runtime/packages/client-runtime/src/store.ts", 'const key = "t3code:renderer-state:v8";'), [])
        self.assertTrue(branding.violations("agent-runtime/packages/client-runtime/src/store.ts", 'const key = "t3code:renderer-state:v8"; const label = "T3 Code";'))

    def test_paths_and_identities_cannot_hide_as_storage_keys(self):
        self.assertTrue(branding.path_violations("agent-runtime/apps/web/src/T3CodePanel.tsx"))
        self.assertFalse(branding.path_violations("agent-runtime/apps/mobile/modules/t3-terminal/ios/T3TerminalNative.swift"))
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

    def test_preserves_original_notices_and_recorded_protocol_data(self):
        self.assertEqual(branding.violations("agent-runtime/LICENSE", "Copyright (c) 2026 T3 Tools Inc."), [])
        self.assertEqual(branding.violations("agent-runtime/apps/server/src/orchestration-v2/testkit/fixtures/simple/codex_transcript.ndjson", '{"input":"T3 Code"}'), [])
        self.assertTrue(branding.violations("agent-runtime/apps/server/src/NewService.ts", 'const label = "T3 Code"'))

    def test_oauth_exception_does_not_allow_new_labels(self):
        path = "agent-runtime/apps/server/src/provider/acp/GrokAcpSupport.ts"
        self.assertEqual(branding.violations(path, 'const CINDERDECK_OAUTH_REFERRER = "t3code";'), [])
        self.assertTrue(branding.violations(path, 'const label = "T3 Code";'))
        self.assertTrue(branding.violations(path, 'const label = "t3code";'))


if __name__ == "__main__":
    unittest.main()
