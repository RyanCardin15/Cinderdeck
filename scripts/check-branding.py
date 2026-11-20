#!/usr/bin/env python3
"""Reject upstream product branding while preserving narrowly defined compatibility data."""
from pathlib import Path
import re
import json
import argparse
from collections import Counter
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
BRAND = re.compile(r"\bt3dotgg\b|\bt3chat\b|\bt3code\b|\bT3\s+Code\b|\bT3Code\b|[>\"\x27]T3[<\"\x27]|\bt3\s+(?:serve|connect|pair|service|update|app|project)\b|@t3tools/|\bcom\.t3tools\b|\b(?:[\w-]+\.)*t3\.(?:codes|gg)\b|\bpingdotgg/t3code\b", re.I)
BARE_BRAND = re.compile(r"\bT3\b", re.I)
INTERNAL_BRAND = re.compile(r"\bT3_CODE_[A-Z][A-Z0-9_]*\b|\b(?:T3|t3)[A-Z][a-z][A-Za-z0-9_]*\b|\bt3_[a-z0-9_]+\b")
TEMPORARY_BRAND = re.compile(r"(?:\bprefix\s*:\s*|\btmpdir\(\)\s*,\s*)[\"'`]\.?t3-", re.I)
# Display identities cannot borrow exceptions for legacy schemes and storage prefixes.
DISPLAY_IDENTITY = re.compile(
    r"(?:[\"']?(?:appName|productName|displayName|CFBundleDisplayName|CFBundleName)[\"']?\s*[:=]\s*[\"'`])(?:t3(?:[-_ ]?code)?(?:[-_](?:dev|preview))?)(?=[\"'`])",
    re.I,
)
# Plist values may span lines and legacy scheme exceptions must not hide bundle names.
PLIST_DISPLAY_IDENTITY = re.compile(
    r"<key>\s*(?:CFBundleDisplayName|CFBundleName|CFBundleExecutable)\s*</key>\s*"
    r"<string>\s*t3(?:[-_ ]?code)?(?:[-_](?:dev|preview))?\s*</string>",
    re.I,
)
# Exact native registration names and wrappers outside their ABI source folders.
NATIVE_REFERENCES = re.compile(r"\b(?:t3_highlights_[a-z_]+|HybridT3Highlights|HybridT3HighlightsSpec|T3Highlights|T3HighlightsNative|T3HighlightsNativeAutolinking|T3HighlightsPackage|T3SourceText|T3SourceTextCls|T3SourceTextComponentDescriptor|T3SourceTextComponentName|T3SourceTextEllipsizeMode|T3SourceTextEventEmitter|T3SourceTextManager|T3SourceTextNativeComponent|T3SourceTextNativeComponent_h|T3SourceTextOutsideTapCoordinator|T3SourceTextOutsideTapCoordinatorForWindow|T3SourceTextOutsideTapCoordinatorKey|T3SourceTextOutsideTapTarget|T3SourceTextProps|T3SourceTextRun|T3SourceTextRunCls|T3SourceTextRunComponentDescriptor|T3SourceTextRunComponentName|T3SourceTextRunEventEmitter|T3SourceTextRunFontStyle|T3SourceTextRunFontWeight|T3SourceTextRunManager|T3SourceTextRunNativeComponent|T3SourceTextRunNativeComponent_h|T3SourceTextRunProps|T3SourceTextRunShadowNode|T3SourceTextRunSpec_registerComponentDescriptorsFromCodegen|T3SourceTextRunState|T3SourceTextRunTextAlign|T3SourceTextRunTextDecorationLine|T3SourceTextRunTextDecorationStyle|T3SourceTextShadowNode|T3SourceTextSpec|T3SourceTextSpec_registerComponentDescriptorsFromCodegen|T3SourceTextStateReal|T3SourceTextView|T3VoiceTranscription|T3VoiceTranscriptionModule|T3WebSocket|T3WebSocketModule|T3ChipIcons|T3AgentNotifications|T3ComposerEditor|T3KeyboardCommands|T3NativeControls|T3NativeFilePresentation|T3NativePresentation|T3NativeVideoPresentation|T3ReviewDiffSurface|T3ReviewDiffView|T3SelectableMarkdownText|T3ShowcaseReadyScene|T3ShowcaseScene|T3TerminalNative|T3TerminalSurface|T3WidgetExpiry)\b")
# These are data and API identifiers, never product labels. Limit exceptions to tokens,
# rather than excluding the source files that also contain user-facing strings.
COMPATIBILITY = re.compile(
    r"\brun-t3\.(?:sh|next)\b|\bt3code\.(?:permission-update\.v1|voice\.audio-grant\.v1|diffHideTestFiles|fileExplorerWidth|fileTreeExpandedDirectories|preparedServerCache)\b|\bt3code-certificate-approvals\.json\b|\bt3code-v2\b|\bt3/notifications/(?:shortcuts|keydown|open-image)\b|\bt3code[-/][0-9a-f-]{8,}\b|\bt3_(?:boot_service_unit|service_launcher_context)\b|\bt3_(?:queue|pending_request)_(?=\$)|\bt3_code_(?=[\x22\x27])|\bT3Runtime\b|\bt3\.\d+[a-zA-Z0-9.-]*|\bt3_(?:dev_session|session|guest)[a-zA-Z0-9_]*\b|\bt3_code_(?:runtime|orchestration|tools|direct)[a-zA-Z0-9_]*\b|\bt3_(?:rpc|orchestration|provider|server|runs|run|git|terminal|webhook|secret|process_group)_[a-z_]+\b|\bt3_run\b|\bt3_child\b|\bt3_(?:thread|project|preview)_\*|\bt3_write_pty\b|\bt3chat-link(?:-requests)?\b|\bt3_(?:kind|relay|subscription_widget_enabled)\b|\bt3_code_instructions\b|\b(?:t3Home|t3SessionLoadReady|t3MintCredential)\b|/\.well-known/t3/environment|urn:t3:params:oauth:token-type:environment-bootstrap|app\.t3\.context-fragment|\bt3CodeRange\b|refs/t3/|\bt3\.pullRequests\.(?:detail|list|preferences)|\bt3\.backgroundActivity\.clientId|\bt3:chatgpt-sharing-welcome:v1|\bt3:paste-as-text|\bt3\.(?:settle_probe|flush_extension_errors)|\$t3:jsonrpc:|\bt3\.client\.surface|https://t3\.codes/schema/t3\.json|t3\.json|t3code-client\.db|\bt3code-(?:dev|preview)\b|(?<![A-Za-z0-9])\.t3code\b|(?<![A-Za-z0-9])\.t3\b|\bT3CODE_[A-Z0-9_]+\b|\bt3code(?::[\w:.-]*|\.(?:preferences(?:\.fallback)?|connections(?:\.[\w-]+)?|connection-catalog\.v1|cloud\.(?:relay-access-tokens|dpop-proof-key)|agent-awareness\.(?:device-id|registration)|recent-thread-shortcuts|diffFileTreeOpen|fileExplorerOpen|renderMarkdown|renderBrowserFile|renderTable|pullRequestFileTreeOpen)|://)|"
    r"\bpersist:t3code-preview(?:-profile)?-?|\bt3code-preview-ephemeral-|"
    r"\bt3(?:[-_]code|[-_]chat-(?:light|dark))\b|"
    r"(?:--|data-|font-|var\(--)?t3-[a-z][a-z0-9-]*|\bT3_ACP_[A-Z_]+\b",
    re.I,
)
# Exact registered MCP method names remain wire-compatible; ordinary t3_* symbols do not.
WIRE_IDENTIFIERS = re.compile(r"\bt3_(?:theme_read|theme_set|pending_request|queue|attachment_discard|attachment_prepare_upload|background_wait|context|environment_link|environment_links|environment_preferences_update|environment_read|environment_unlink|pending_request_list|pending_request_read|pending_request_respond|preview_close|preview_list|project_clone|project_create|project_delete|project_list|project_read|project_update|queue_cancel|queue_edit|queue_list|queue_promote_to_steer|queue_read|queue_reorder|thread_configuration|thread_configure|thread_fork|thread_interrupt|thread_launch|thread_list|thread_merge_back|thread_organize|thread_read|thread_search|thread_send|thread_send_attachments|thread_start|thread_transfer|thread_transfers|thread_update|thread_wait|workflow_stop|worktree_handoff|worktree_list|worktree_status)\b")
LEGAL_FILES = {"LICENSE", "NOTICE", "agent-runtime/LICENSE", "Cinderdeck/Resources/ThirdPartyNotices.txt", "agent-runtime/THIRD_PARTY_NOTICES.md", "agent-runtime/THIRD_PARTY_LICENSES.md", "agent-runtime/third-party-licenses.config.json"}
LEGAL_LINES = {
    "agent-runtime/upstream-integration.json": '"upstreamRepository": "https://github.com/pingdotgg/t3code",',
    "agent-runtime/README.md": "The runtime incorporates MIT-licensed source originally from T3 Code. Its [original license](LICENSE), copyright notices, and bundled third-party acknowledgments are preserved.",
    "agent-runtime/third-party-licenses.config.json": '"name": "T3 Code upstream source",',
}
LEGAL_LINES['agent-runtime/apps/mobile/modules/t3-composer-editor/ios/T3ComposerEditor.podspec'] = "s.author         = 'T3 Tools'"
LEGAL_LINES['agent-runtime/apps/mobile/modules/t3-markdown-text/T3MarkdownText.podspec'] = 's.author = { "T3 Tools" => "hello@t3tools.com" }'
LEGAL_LINES['agent-runtime/apps/mobile/modules/t3-native-controls/ios/T3NativeControls.podspec'] = "s.author         = 'T3 Tools'"
LEGAL_LINES['agent-runtime/apps/mobile/modules/t3-review-diff/T3ReviewDiffNative.podspec'] = "s.author = { 'T3 Tools' => 'hello@t3tools.com' }"
LEGAL_LINES['agent-runtime/apps/mobile/modules/t3-terminal/T3TerminalNative.podspec'] = "s.author = { 'T3 Tools' => 'hello@t3tools.com' }"

LEGAL_LINES['agent-runtime/apps/mobile/modules/t3-source-text/T3SourceText.podspec'] = 's.author = { "T3 Tools" => "hello@t3tools.com" }'

LEGAL_LINES['agent-runtime/apps/mobile/modules/t3-highlights/T3HighlightsNative.podspec'] = "s.author = { 'T3 Tools' => 'hello@t3tools.com' }"

LEGAL_LINES['agent-runtime/apps/mobile/modules/t3-web-socket/ios/T3WebSocket.podspec'] = "s.author = 'T3 Tools'"

LEGAL_LINES['agent-runtime/apps/mobile/modules/t3-voice-transcription/ios/T3VoiceTranscription.podspec'] = "s.author = 'T3 Tools'"

CHECK_FILES = {"scripts/check-branding.py", "scripts/tests/test_branding.py", "scripts/check-repository.py"}
NATIVE_MODULES = {"t3-agent-notifications", "t3-composer-editor", "t3-keyboard-commands", "t3-markdown-text", "t3-native-controls", "t3-review-diff", "t3-terminal", "t3-widget-expiry", "t3-subscription-widget", "t3-highlights", "t3-source-text", "t3-voice-transcription", "t3-web-socket"}


TOKEN_EXCEPTIONS = {
    'agent-runtime/packages/provider-testing/src/TestProviderHost.ts': ("t3", "persisted credential binding owner"),
    'agent-runtime/packages/provider-cursor/src/server/auth.ts': ("t3", "persisted credential binding owner"),
    'agent-runtime/packages/provider-core/src/server/providerAuthFlow.test.ts': ("t3", "persisted credential binding owner"),
    'agent-runtime/packages/provider-core/src/server/ProviderHost.ts': ("t3", "persisted credential binding owner"),
    'agent-runtime/packages/provider-core/src/server/auth.ts': ("t3", "persisted credential binding owner"),
    'agent-runtime/evals/mcp-tool-use/cases/device-manager.ndjson': ("t3dotgg", "original evaluation source attribution"),
    'agent-runtime/evals/mcp-tool-use/README.md': ("t3dotgg", "original evaluation source attribution"),
    "agent-runtime/apps/mobile/modules/t3-agent-notifications/android/src/main/java/expo/modules/t3agentnotifications/AgentNotifications.kt": ('"t3code"', "historical stored notification scheme"),
    "agent-runtime/apps/server/src/orchestration-v2/testkit/ReplayFixtureWorkspace.ts": ("t3code-test@example.com", "recorded checkout author identity"),
    "agent-runtime/apps/server/src/orchestration-v2/testkit/ThreadFork.integration.test.ts": ("t3code-test@example.com", "recorded checkout author identity"),
    "agent-runtime/apps/mobile/src/lib/appLinking.ts": ("t3code(-dev|-preview)", "legacy URI schemes"),
    "agent-runtime/apps/server/scripts/codexReplayRecordingRecords.ts": ("/home/replay-user/t3code", "recorded provider checkout"),
    "agent-runtime/apps/server/scripts/threadTitleEvaluationCases.ts": ("pingdotgg/t3code", "recorded source attribution"),
    "agent-runtime/apps/server/src/deckhand/LocalDiagnostics.ts": ("pingdotgg/t3code", "refused vendor update source"),
    "agent-runtime/apps/server/src/provider/acp/GrokAcpSupport.ts": ('"t3code"', "provider OAuth client referrer"),
    "agent-runtime/apps/server/src/provider/ProviderAuthFlow.test.ts": ('"t3"', "persisted credential binding fixture"),
    "agent-runtime/apps/server/src/provider/Layers/ProviderAuthService.test.ts": ('"t3"', "persisted credential binding fixture"),
    "agent-runtime/apps/server/src/cloud/pinnedRuntime.test.ts": ('"t3"', "historical archive layout fixture"),
    "agent-runtime/apps/server/src/cloud/selfUpdate.test.ts": ('"t3"', "historical archive layout fixture"),
    "agent-runtime/apps/server/src/serviceLauncher.test.ts": ('"t3"', "historical archive layout fixture"),
    "agent-runtime/apps/server/src/project/AgentSessionScanner.test.ts": ('"t3"', "historical sandbox directory fixture"),
    "agent-runtime/packages/shared/src/desktopAppControl.ts": ("t3code-", "local control socket compatibility"),
    "agent-runtime/packages/shared/src/desktopAppControl.test.ts": ("t3code-", "local control socket compatibility fixture"),
    "agent-runtime/apps/server/src/provider/CursorAuth.ts": ('"t3"', "persisted credential binding owner"),
    "agent-runtime/apps/server/src/provider/ProviderCredentialStore.ts": ('"t3"', "persisted credential binding owner"),
    "agent-runtime/apps/server/src/provider/Services/ProviderAuthService.ts": ('"t3"', "persisted credential binding owner"),
    "agent-runtime/packages/contracts/src/providerSetup.ts": ('"t3"', "persisted credential binding owner"),
    "agent-runtime/packages/shared/src/cinderdeckMcpToolPresentation.ts": ("t3code", "historical MCP server aliases"),
    "agent-runtime/apps/server/src/cloud/pinnedRuntime.ts": ('"t3"', "historical archive executable layout"),
    "agent-runtime/apps/server/src/serviceLauncher.ts": ('"t3"', "historical archive executable layout"),
    "agent-runtime/packages/shared/src/legacyCliLauncher.ts": ('"t3"', "historical archive executable layout"),
    "agent-runtime/apps/server/src/orchestration-v2/Orchestrator.ts": ("pingdotgg/t3code", "source issue attribution"),
    "agent-runtime/apps/server/src/terminal/NodePtyAdapter.ts": ("pingdotgg/t3code", "source contribution attribution"),
    "agent-runtime/scripts/lib/deckhand-distribution.ts": ("T3CODE", "refused vendor environment names"),
}


# Existing compatibility lines remain exact so adjacent branding still fails.
COMPATIBILITY_LINES = {
    ('agent-runtime/apps/server/src/orchestration-v2/testkit/ReplayRuntimeInstructions.ts', 'return value.slice(0, end).replaceAll("T3 Code", "Cinderdeck") + value.slice(end);'): "original provider recording display identity",
    ('agent-runtime/apps/server/src/orchestration-v2/Adapters/MuseAdapterV2.testkit.ts', 'if (isRecord(clientInfo) && clientInfo.name === "t3_code" && clientInfo.title === "T3 Code") {'): "original provider recording display identity",
    ('agent-runtime/packages/provider-acp/src/server/runtimeModel.ts', '!/^(?:t3[-_ ]?code|cinderdeck(?:[-_ ]code)?|deckhand)$/i.test(qualified[1])'): "historical archive or provider wire compatibility",
    ('agent-runtime/packages/provider-acp/src/server/runtimeModel.ts', '!/^(?:t3[-_ ]?code|cinderdeck(?:[-_ ]code)?|deckhand)$/i.test(gooseExtension));'): "historical archive or provider wire compatibility",
    ('agent-runtime/packages/provider-acp/src/server/runtimeModel.ts', '!/^(?:t3[-_ ]?code|cinderdeck(?:[-_ ]code)?|deckhand)$/i.test(metaServerId)) ||'): "historical archive or provider wire compatibility",
    ('agent-runtime/packages/provider-acp/src/server/runtimeModel.ts', '/^(?:t3[-_ ]?code|cinderdeck(?:[-_ ]code)?|deckhand)$/i.test(metaServerId) &&'): "historical archive or provider wire compatibility",
    ('agent-runtime/apps/server/src/cloud/pinnedRuntime.ts', '/^(?!\\.\\.)[^\\\\/]+[\\\\/](?:t3|cinderdeck)(?:\\.exe)?$/i.test(relative)'): "historical archive or provider wire compatibility",
    ('agent-runtime/apps/server/src/cloud/pinnedRuntime.ts', 'const launcherName = platform === "win32" ? "t3.cmd" : "t3";'): "historical archive launcher ABI",
    ('agent-runtime/packages/provider-acp/src/server/runtimeModel.ts', 'if (qualified?.[1] && qualified[2] && !/^(?:t3[-_ ]?code|cinderdeck(?:[-_ ]code)?|deckhand)$/i.test(qualified[1]))'): "historical storage, archive or provider wire compatibility",
    ('agent-runtime/packages/provider-acp/src/server/runtimeModel.ts', '(gooseExtension.length > 0 && !/^(?:t3[-_ ]?code|cinderdeck(?:[-_ ]code)?|deckhand)$/i.test(gooseExtension));'): "historical storage, archive or provider wire compatibility",
    ('agent-runtime/packages/provider-acp/src/server/runtimeModel.ts', '(metaServerId.length > 0 && !/^(?:t3[-_ ]?code|cinderdeck(?:[-_ ]code)?|deckhand)$/i.test(metaServerId)) ||'): "historical storage, archive or provider wire compatibility",
    ('agent-runtime/packages/provider-acp/src/server/runtimeModel.ts', 'if (/^(?:t3[-_ ]?code|cinderdeck(?:[-_ ]code)?|deckhand)$/i.test(metaServerId) && metaToolName.length > 0) {'): "historical storage, archive or provider wire compatibility",
    ('agent-runtime/packages/provider-acp/src/server/runtimeModel.ts', '/^(?<tool>[A-Za-z0-9][A-Za-z0-9_.-]*?)(?: \\((?:t3[-_ ]?code|cinderdeck(?:[-_ ]code)?|deckhand) MCP Server\\)(?::|$)|[-_.](?:t3[-_ ]?code|cinderdeck(?:[-_ ]code)?|deckhand)$)/i;'): "historical storage, archive or provider wire compatibility",
    ('agent-runtime/packages/provider-acp/src/server/runtimeModel.ts', '/^(?:@|mcp[-_]{1,2})?(?:t3[-_ ]?code|cinderdeck(?:[-_ ]code)?|deckhand)[-_.:/ ]{1,3}(?<tool>[A-Za-z0-9][A-Za-z0-9_.-]*)(?::.*)?$/i;'): "historical storage, archive or provider wire compatibility",
    ('agent-runtime/apps/server/src/orchestration-v2/Adapters/PiAdapterV2.testkit.ts', 'const ADAPTER_REQUEST_ID = /^(?:t3|cinderdeck)-(?:prompt-)?\\d+$/u;'): "historical storage, archive or provider wire compatibility",
    ('agent-runtime/apps/server/src/git/GitManager.ts', 'return /^(?:t3code|t3|cinderdeck)[/-]pr-\\d+[/-]/u.test(branch);'): "historical storage, archive or provider wire compatibility",
    ('agent-runtime/apps/server/src/cloud/pinnedRuntime.ts', 'return !path.isAbsolute(relative) && /^(?!\\.\\.)[^\\\\/]+[\\\\/](?:t3|cinderdeck)(?:\\.exe)?$/i.test(relative);'): "historical storage, archive or provider wire compatibility",
    ('agent-runtime/apps/desktop/src/electron/ElectronProtocol.test.ts', 'assert.equal(ElectronProtocol.getDesktopScheme(false), "t3code");'): "historical storage, archive or provider wire compatibility",
    ('agent-runtime/apps/desktop/src/app/DesktopAppIdentity.test.ts', '"/Users/alice/Library/Application Support/T3 Code (Dev)",'): "historical storage, archive or provider wire compatibility",
    ('agent-runtime/apps/desktop/src/app/DesktopAppIdentity.test.ts', 'input.legacyPathExists === true && /T3 Code \\((Alpha|Dev)\\)/.test(path),'): "historical storage, archive or provider wire compatibility",
    ('agent-runtime/apps/desktop/src/app/DesktopUserData.test.ts', 'yield* fs.makeDirectory(path.join(directory, "T3 Code (Alpha)"), { recursive: true });'): "existing storage and archive fixture identity",
    ('agent-runtime/apps/desktop/src/app/DesktopUserData.test.ts', 'it.effect.each(["t3code", "T3 Code (Alpha)"])('): "existing storage and archive fixture identity",
    ('agent-runtime/packages/ssh/src/tunnel.test.ts', 'NodeFS.writeFileSync(NodePath.join(release, "t3", "t3"), "#!/bin/sh\\necho ok\\n", {'): "existing storage and archive fixture identity",
    ('agent-runtime/apps/server/src/cliCompileCache.ts', 'const directory = NodePath.join(cacheRoot, "t3code", "compile-cache");'): "existing private profile, cache or renderer storage identity",
    ('agent-runtime/apps/desktop/src/compileCache.ts', 'const directory = NodePath.join(cacheRoot, "t3code", "compile-cache");'): "existing private profile, cache or renderer storage identity",
    ('agent-runtime/apps/desktop/src/electron/ElectronProtocol.test.ts', 'scheme: "t3code",'): "existing private profile, cache or renderer storage identity",
    ('agent-runtime/apps/desktop/src/electron/ElectronProtocol.test.ts', 'scheme: "t3code",'): "existing private profile, cache or renderer storage identity",
    ('agent-runtime/apps/desktop/src/electron/ElectronProtocol.ts', 'const DESKTOP_PRODUCTION_SCHEME = "t3code";'): "existing private profile, cache or renderer storage identity",
    ('agent-runtime/apps/desktop/src/app/DesktopLegacyLocalStorage.ts', 'const V1_PROFILE_NAMES = ["T3 Code (Alpha)", "t3code"];'): "existing private profile, cache or renderer storage identity",
    ('agent-runtime/apps/desktop/src/app/DesktopUserData.test.ts', 'yield* fs.makeDirectory(path.join(directory, "T3 Code (Alpha)"), { recursive: true });'): "existing private profile, cache or renderer storage identity",
    ('agent-runtime/apps/desktop/src/app/DesktopUserData.test.ts', 'it.effect.each(["t3code", "T3 Code (Alpha)"])('): "existing private profile, cache or renderer storage identity",
    ('agent-runtime/apps/desktop/src/app/DesktopUserData.ts', ': path.join(input.appDataDirectory, "t3code", "Local State");'): "existing private profile, cache or renderer storage identity",
    ('agent-runtime/apps/desktop/src/app/DesktopUserData.ts', ': { current: "t3code-v2", legacy: "T3 Code (Alpha)" };'): "existing private profile, cache or renderer storage identity",
    ('agent-runtime/apps/desktop/src/app/DesktopUserData.ts', '? { current: "t3code-dev", legacy: "T3 Code (Dev)" }'): "existing private profile, cache or renderer storage identity",
    ('agent-runtime/packages/ssh/src/launcherTestHarness.ts', 'NodePath.join(version, "t3"),'): "historical runtime archive layout",
    ('agent-runtime/packages/ssh/src/tunnel.ts', 'T3_ARCHIVE="t3-$T3_ARCHIVE_VERSION-$T3_PLATFORM_KEY.tar.gz"'): "historical runtime archive layout",
    ('agent-runtime/vite.config.ts', '"@t3tools/provider-core/server/IdAllocator": NodeURL.fileURLToPath('): "immutable provider fixture alias; target checked by check-repository.py",
    ('agent-runtime/vite.config.ts', '"@t3tools/shared/orchestrationV2PendingBackgroundWork": NodeURL.fileURLToPath('): "immutable provider fixture alias; target checked by check-repository.py",
    ('agent-runtime/vite.config.ts', '"@t3tools/shared/terminalOutput": NodeURL.fileURLToPath('): "immutable provider fixture alias; target checked by check-repository.py",
    ('agent-runtime/vite.config.ts', '"@t3tools/contracts": NodeURL.fileURLToPath('): "immutable provider fixture alias; target checked by check-repository.py",
    ('agent-runtime/packages/ssh/src/tunnel.test.ts', 'NodeChildProcess.execFileSync("tar", ["-czf", archive, "t3"], { cwd: release });'): "historical runtime archive fixture",
    ('agent-runtime/packages/ssh/src/tunnel.test.ts', 'NodePath.join(release, "t3", "t3"),'): "historical runtime archive fixture",
    ('agent-runtime/packages/ssh/src/tunnel.test.ts', 'NodeFS.mkdirSync(NodePath.join(release, "t3"), { recursive: true });'): "historical runtime archive fixture",
    ('agent-runtime/packages/ssh/src/tunnel.test.ts', 'const archive = `t3-${ARCHIVE.archiveVersion}-linux-x64.tar.gz`;'): "historical runtime archive fixture",
    ('agent-runtime/packages/ssh/src/tunnel.ts', 'exec "$T3_RUNTIME_DIR/t3" "$@"'): "historical runtime archive layout",
    ('agent-runtime/packages/ssh/src/tunnel.ts', 'if ! "$T3_STAGING/t3" --version >/dev/null 2>&1; then'): "historical runtime archive layout",
    ('agent-runtime/packages/ssh/src/tunnel.ts', '[ -x "$T3_RUNTIME_DIR/t3" ] && [ "$(cat "$T3_RUNTIME_DIR/.install-complete" 2>/dev/null)" = "$T3_ARCHIVE_VERSION" ]'): "historical runtime archive layout",
    ('agent-runtime/README.md', 'Build the complete application with the [Cinderdeck build guide](../docs/UNIFIED_APP.md). The complete runtime source is merged through T3 Code revision `12b9845d1c5aec2bfede36b313adfc5098a2fb93`, including the previously deferred dependency, provider and companion changes. [Source provenance and ownership adaptations](upstream-integration.json) record this snapshot; live provider and device behavior requires separate validation.'): "source provenance",
    ('agent-runtime/packages/shared/src/remote.ts', 'const APP_LINK_PROTOCOL = /^(?:cinderdeck|t3code)(?:-[a-z]+)?:$/;'): "legacy app schemes",
    ('agent-runtime/packages/shared/src/promptLinks.ts', 'const APP_SCHEME = /^(?:cinderdeck|t3code)(?:-[a-z]+)?:$/;'): "legacy app schemes",
    ('agent-runtime/packages/shared/src/cinderdeckMcpToolPresentation.ts', 'if (!/^(?:t3-code|cinderdeck-code|cinderdeck|deckhand)-/i.test(label)) return null;'): "historical MCP server aliases",
    ('agent-runtime/packages/shared/src/cinderdeckMcpToolPresentation.ts', 'const prefixed = /^(?:mcp[-_]{1,2})?(?:cinderdeck(?:[-_ ]code)?|deckhand|t3[-_ ]?code)(?:__|[-_.:/ ])(?<tool>.+)$/i.exec(label);'): "historical MCP server aliases",
    ('agent-runtime/packages/shared/src/cinderdeckMcpToolPresentation.ts', '/^(?<server>(?:cinderdeck(?:[-_]code)?|deckhand|t3[-_]?code)(?:[-_]direct)?)(?:[.:/]|\\s*·\\s*)(?<tool>.+)$/i.exec('): "historical MCP server aliases",
    ('agent-runtime/packages/shared/src/cinderdeckMcpToolPresentation.ts', 'const mcpMatch = /^mcp__(?<server>.+?)__(?<tool>.+)$/i.exec(label);'): "historical MCP server aliases",
    ('agent-runtime/scripts/lib/third-party-licenses.test.ts', '"Adapted for T3 Code.\\n\\nMIT License\\n\\nCopyright (c) 2026 Example Author\\n\\nPermission text",'): "source attribution",
    ('docs/PERFORMANCE.md', 'snapshot transport improvements from the same T3 source baseline above:'): "source attribution",
    ('docs/PERFORMANCE.md', "| Workspace navigation | T3 exposes project-scoped and exact-thread selectors. Cinderdeck's workspace session lists and both navigator containers were reading the global thread-shell array. Session lists now compose the shared project selector with exact saved/selected-thread selectors; navigator containers observe only the selected thread. Saved sessions outside current project membership, archived ancestors, remote environments, nested sub-agents and paging remain supported. |"): "source attribution",
    ('docs/PERFORMANCE.md', 'integration. It does not establish end-to-end performance parity with T3.'): "source attribution",
    ('docs/PERFORMANCE.md', '[`ddfc4a92edbdc934fede54c32f19be9ff5af1bb4`](https://github.com/pingdotgg/t3code/tree/ddfc4a92edbdc934fede54c32f19be9ff5af1bb4),'): "source attribution",
    ('docs/PERFORMANCE.md', 'Compared the current Cinderdeck working source with T3 Code commit'): "source attribution",
    ('docs/PERFORMANCE.md', '## T3 runtime comparison and integration (2026-11-01)'): "source attribution",
    ("agent-runtime/vite.config.ts", '"@t3tools/contracts": NodeURL.fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url)),'): "imports in immutable provider fixtures",
    ("agent-runtime/vite.config.ts", '"@t3tools/shared/terminalOutput": NodeURL.fileURLToPath(new URL("./packages/shared/src/terminalOutput.ts", import.meta.url)),'): "imports in immutable provider fixtures",
    ("agent-runtime/vite.config.ts", '"@t3tools/shared/orchestrationV2PendingBackgroundWork": NodeURL.fileURLToPath(new URL("./packages/shared/src/orchestrationV2PendingBackgroundWork.ts", import.meta.url)),'): "imports in immutable provider fixtures",
    ("agent-runtime/vite.config.ts", '"@t3tools/provider-core/server/IdAllocator": NodeURL.fileURLToPath(new URL("./packages/provider-core/src/server/IdAllocator.ts", import.meta.url)),'): "imports in immutable provider fixtures",
    ("agent-runtime/apps/server/tsconfig.json", '"@t3tools/contracts": ["../../packages/contracts/src/index.ts"],'): "imports in immutable provider fixtures",
    ("agent-runtime/apps/server/tsconfig.json", '"@t3tools/shared/terminalOutput": ["../../packages/shared/src/terminalOutput.ts"],'): "imports in immutable provider fixtures",
    ("agent-runtime/apps/server/tsconfig.json", '"@t3tools/shared/orchestrationV2PendingBackgroundWork": ["../../packages/shared/src/orchestrationV2PendingBackgroundWork.ts"],'): "imports in immutable provider fixtures",
    ("agent-runtime/apps/server/tsconfig.json", '"@t3tools/provider-core/server/IdAllocator": ["../../packages/provider-core/src/server/IdAllocator.ts"]'): "imports in immutable provider fixtures",
    ("agent-runtime/packages/shared/src/git.ts", 'export const LEGACY_WORKTREE_BRANCH_PREFIX = "t3code";'): "persisted worktree branch prefix",
    ("agent-runtime/packages/shared/src/git.ts", 'export const LEGACY_SHORT_WORKTREE_BRANCH_PREFIX = "t3";'): "persisted worktree branch prefix",
    ("Cinderdeck/Services/UnifiedApp/CinderdeckRuntimeController.swift", 'let runtimeDirectory = StackControlPaths.directory.appendingPathComponent("T3Runtime", isDirectory: true)'): "persisted native runtime store path",
    ("agent-runtime/patches/react-native-screens@4.28.0.patch", "+    // The t3 patch adds these iOS glass-chrome props to the native spec; they have"): "original third-party patch attribution",
    ('agent-runtime/apps/server/src/cli/launcher.ts', '* only ever sees its own path. Walk PATH for a `t3.cmd` whose target is the'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cli/launcher.ts', 'const shimPath = path.join(directory, "t3.cmd");'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cli/service.test.ts', 'baseDir: "/test/t3",'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cli/service.test.ts', 'program: ["/test/t3/runtime/versions/1.0.0/t3", "__service-launcher"],'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cli/uninstall.test.ts', 'const copy = path.join(root, "copy/t3");'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cli/uninstall.test.ts', 'const exe = path.join(versionsDir, "1.0.0/t3");'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cli/uninstall.test.ts', 'const otherExe = path.join(root, "other/runtime/versions/1.0.0/t3");'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cli/uninstall.test.ts', 'const ours = path.join(root, "bin/t3");'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cli/uninstall.test.ts', 'const theirs = path.join(root, "other/bin/t3");'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cloud/bootService.test.ts', 'Layer.succeed(HostProcessExecutablePath, "/usr/bin/t3"),'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cloud/bootService.test.ts', '`t3 v${/versions\\/([^/]+)\\//.exec(input.command)?.[1] ?? "1.2.3"}\\n`'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cloud/bootService.test.ts', 'const linuxRuntime = "/home/theo/.deckhand/runtime/versions/1.2.3/t3";'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cloud/bootService.test.ts', 'const macRuntime = "/Users/theo/.deckhand/runtime/versions/1.2.3/t3";'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cloud/bootService.test.ts', 'expect(yield* fs.readFileString(plan.unitPath)).toContain("versions/1.2.4/t3");'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cloud/bootService.test.ts', 'host: { execPath: "/usr/bin/t3" },'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cloud/bootService.test.ts', 'program: [`${baseDir}/runtime/versions/1.2.3/t3`, "__service-launcher"],'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cloud/pinnedRuntime.test.ts', 'assert.equal(paths.entryPath, path.join(paths.versionDir, "t3"));'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cloud/pinnedRuntime.test.ts', 'assert.isFalse(yield* fs.exists(path.join(paths.versionDir, "t3-runtime-archive")));'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cloud/pinnedRuntime.test.ts', 'const archiveName = `t3-${version}-linux-x64.tar.gz`;'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cloud/pinnedRuntime.test.ts', 'yield* fs.writeFileString(path.join(stagingDir, "t3"), "#!/bin/sh\\n").pipe(Effect.orDie);'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cloud/pinnedRuntime.ts', '// strip it so the executable lands at <versionDir>/t3.'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cloud/pinnedRuntime.ts', 'const PINNED_RUNTIME_ARCHIVE_FILE = "t3-runtime-archive";'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cloud/pinnedRuntime.ts', 'entryPath: path.join(versionDir, platform === "win32" ? "t3.exe" : "t3"),'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cloud/selfUpdate.test.ts', 'new Response(`${hex}  t3-1.1.0-linux-x64.tar.gz\\n`),'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/cloud/selfUpdate.test.ts', 'yield* fs.writeFileString(path.join(stagingDir, "t3"), "#!/bin/sh\\n").pipe(Effect.orDie);'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/device/AgentDeviceTarget.ts', '`t3-${key(JSON.stringify([threadId, hostId, deviceId]))}`;'): 'stable device target identifier',
    ('agent-runtime/apps/server/src/environment/ServerEnvironmentMachine.test.ts', 'machineKindFromDmi({ chassisType: "1", sysVendor: "Amazon EC2", productName: "t3.large" }),'): 'AWS instance type fixture',
    ('agent-runtime/apps/server/src/orchestration-v2/Adapters/PiAdapterV2.testkit.ts', 'const ADAPTER_REQUEST_ID = /^t3-\\d+$/u;'): 'provider RPC correlation identifier',
    ('agent-runtime/apps/server/src/orchestration-v2/Adapters/PiRpc.ts', 'const id = `t3-${nextRequestId++}`;'): 'provider RPC correlation identifier',
    ('agent-runtime/apps/server/src/provider/acp/AcpRuntimeModel.ts', '/^(?:mcp[-_]{1,2})?(?<server>cinderdeck|deckhand|t3[-_ ]?code)[-_.:/ ]{1,3}(?<tool>[A-Za-z0-9][A-Za-z0-9_.-]*)(?::.*)?$/i;'): 'historical MCP server aliases',
    ('agent-runtime/apps/server/src/provider/acp/AcpRuntimeModel.ts', '/^(?<tool>[A-Za-z0-9][A-Za-z0-9_.-]*?)(?: \\((?<server>cinderdeck|deckhand|t3[-_ ]?code) MCP Server\\)(?::|$)|[-_.](?<suffixServer>cinderdeck|deckhand|t3[-_ ]?code)$)/i;'): 'historical MCP server aliases',
    ('agent-runtime/apps/server/src/provider/acp/AcpRuntimeModel.ts', 'if (/^t3[-_ ]?code$/i.test(server)) return "t3-code";'): 'historical MCP server aliases',
    ('agent-runtime/apps/server/src/serviceLauncher.test.ts', '// A pinned runtime is an executable at <versionDir>/t3. The tests stand one up'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/serviceLauncher.test.ts', 'const entryPath = path.join(versionDir, "t3");'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/serviceLauncher.ts', 'const executableName = process.platform === "win32" ? "t3.exe" : "t3";'): 'historical archive and launcher ABI',
    ('agent-runtime/apps/server/src/vcs/GitVcsDriver.ts', '// an unclean restart can leave 0-byte files under refs/t3/** that break every'): 'persisted checkpoint namespace',
    ('agent-runtime/apps/web/index.html', '"t3-chat",'): 'historical theme and icon names',
    ('agent-runtime/apps/web/index.html', '"t3-chat": {'): 'historical theme and icon names',
    ('agent-runtime/apps/web/index.html', '"t3-chat-dark",'): 'historical theme and icon names',
    ('agent-runtime/apps/web/index.html', '"t3-chat-dark": "t3-chat",'): 'historical theme and icon names',
    ('agent-runtime/apps/web/index.html', '"t3-ember",'): 'historical theme and icon names',
    ('agent-runtime/apps/web/index.html', '"t3-ember": "ember",'): 'historical theme and icon names',
    ('agent-runtime/apps/web/index.html', '"t3-grove",'): 'historical theme and icon names',
    ('agent-runtime/apps/web/index.html', '"t3-grove": "grove",'): 'historical theme and icon names',
    ('agent-runtime/apps/web/index.html', '"t3-iris",'): 'historical theme and icon names',
    ('agent-runtime/apps/web/index.html', '"t3-iris": "iris",'): 'historical theme and icon names',
    ('agent-runtime/apps/web/index.html', '"t3-ocean",'): 'historical theme and icon names',
    ('agent-runtime/apps/web/index.html', '"t3-ocean": "ocean",'): 'historical theme and icon names',
    ('agent-runtime/apps/web/index.html', '// and every maintainer theme under a t3- prefix; keep those'): 'historical theme and icon names',
    ('agent-runtime/apps/web/index.html', 'const isLegacyT3ChatDark = storedTheme === "t3-chat-dark";'): 'historical theme and icon names',
    ('agent-runtime/apps/web/src/components/settings/ProviderInstanceCard.test.ts', '"Codex app-server provider probe failed: Cannot create Codex shadow home entry \'auth.json\' because \'/home/me/.codex-t3/work/auth.json\' already exists and is not a symlink.";'): 'historical provider shadow-home fixture',
    ('agent-runtime/apps/web/src/components/settings/ResourceTelemetryDiagnostics.tsx', 'case "unknown-t3":'): 'telemetry wire discriminator',
    ('agent-runtime/apps/web/src/pierre-icons.test.ts', '"t3-file-icon-pnpm",'): 'historical theme and icon names',
    ('agent-runtime/apps/web/src/pierre-icons.test.ts', 'Object.values(CINDERDECK_PIERRE_ICONS.byFileName).filter((name) => name.startsWith("t3-")),'): 'historical theme and icon names',
    ('agent-runtime/apps/web/src/pierre-icons.test.ts', 'assert.equal(resolvePierreIconForEntry("AGENTS.md", "file")?.name, "t3-file-icon-agents");'): 'historical theme and icon names',
    ('agent-runtime/apps/web/src/pierre-icons.test.ts', 'assert.equal(resolvePierreIconForEntry("pnpm-lock.yaml", "file")?.name, "t3-file-icon-pnpm");'): 'historical theme and icon names',
    ('agent-runtime/apps/web/src/themePalette.ts', '"t3-ember": EMBER_THEME_ID,'): 'historical theme and icon names',
    ('agent-runtime/apps/web/src/themePalette.ts', '"t3-grove": GROVE_THEME_ID,'): 'historical theme and icon names',
    ('agent-runtime/apps/web/src/themePalette.ts', '"t3-iris": IRIS_THEME_ID,'): 'historical theme and icon names',
    ('agent-runtime/apps/web/src/themePalette.ts', '"t3-ocean": OCEAN_THEME_ID,'): 'historical theme and icon names',
    ('agent-runtime/apps/web/src/themePalette.ts', '// Earlier builds shipped every maintainer theme under a t3- prefix; only the'): 'historical theme and icon names',
    ('agent-runtime/apps/web/src/themePalette.ts', 'const LEGACY_T3_CHAT_DARK_THEME_ID = "t3-chat-dark";'): 'historical theme and icon names',
    ('agent-runtime/apps/web/src/themePalette.ts', 'export const CINDERDECK_CHAT_THEME_ID = "t3-chat" as const;'): 'historical theme and icon names',
    ('agent-runtime/packages/contracts/src/resourceTelemetry.ts', '"unknown-t3",'): 'telemetry wire discriminator',
    ('agent-runtime/packages/shared/src/cinderdeckMcpToolPresentation.ts', '/^(?:mcp[-_]{1,2})?(?:cinderdeck(?:[-_ ]code)?|deckhand|t3[-_ ]?code)(?:__|[-_.:/ ])(?<tool>.+)$/i.exec('): 'historical MCP server aliases',
    ('agent-runtime/packages/shared/src/cliRelease.test.ts', '"https://mirror.example/t3/v1.2.3",'): 'historical archive and launcher ABI',
    ('agent-runtime/packages/shared/src/cliRelease.test.ts', '"t3-1.2.3-preview.20260911.4-linux-x64.tar.gz",'): 'historical archive and launcher ABI',
    ('agent-runtime/packages/shared/src/cliRelease.test.ts', '`${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,'): 'historical archive and launcher ABI',
    ('agent-runtime/packages/shared/src/cliRelease.test.ts', '`${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,'): 'historical archive and launcher ABI',
    ('agent-runtime/packages/shared/src/cliRelease.test.ts', 'expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));'): 'historical archive and launcher ABI',
    ('agent-runtime/packages/shared/src/cliRelease.test.ts', 'expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));'): 'historical archive and launcher ABI',
    ('agent-runtime/packages/shared/src/cliRelease.test.ts', 'expect(cliArchiveFileName("1.2.3", "win32-x64")).toBe("t3-1.2.3-win32-x64.zip");'): 'historical archive and launcher ABI',
    ('agent-runtime/packages/shared/src/cliRelease.test.ts', 'expect(cliReleaseDownloadBaseUrl("1.2.3", "https://mirror.example/t3/")).toBe('): 'historical archive and launcher ABI',
    ('agent-runtime/packages/shared/src/cliRelease.ts', 'return `t3-${version}-${platformKey}.${platformKey.startsWith("win32") ? "zip" : "tar.gz"}`;'): 'historical archive and launcher ABI',
    ('agent-runtime/packages/shared/src/legacyCliLauncher.test.ts', '`node_modules/@cinderdeck/t3-${hostPlatform}-${hostArch}/t3`,'): 'historical archive and launcher ABI',
    ('agent-runtime/packages/shared/src/legacyCliLauncher.test.ts', 'const entry = NodePath.join(root, "node_modules/t3/dist/bin.mjs");'): 'historical archive and launcher ABI',
    ('agent-runtime/packages/shared/src/legacyCliLauncher.ts', '* executable in the sibling `@cinderdeck/t3-<platform>-<arch>` package.'): 'historical archive and launcher ABI',
    ('agent-runtime/packages/shared/src/legacyCliLauncher.ts', 'const executable = join(dirname(require.resolve("@cinderdeck/t3-" + process.platform + "-" + process.arch + "/package.json")), executableName);'): 'historical archive and launcher ABI',
    ('agent-runtime/packages/shared/src/legacyCliLauncher.ts', 'const executableName = process.platform === "win32" ? "t3.exe" : "t3";'): 'historical archive and launcher ABI',
}


def exemption(path: str, line: str) -> str | None:
    if (path, line.strip()) in COMPATIBILITY_LINES:
        return COMPATIBILITY_LINES[(path, line.strip())]
    if path == "agent-runtime/packages/client-runtime/src/errors/transport.ts" and line.strip() == r"/Unable to connect to the (?:Cinderdeck|T3) server WebSocket\./i,":
        return "historical server error compatibility pattern"
    if path == "Cinderdeck/Services/Stacks/Agents/StackControlProtocol.swift" and line.strip() == 'let appNames: Set<String> = ["deckhand", "t3", "t3 code"]':
        return "historical client names"
    if path == "CinderdeckTests/Services/Stacks/StackControlTests.swift" and line.strip() == 'for name in ["Deckhand", "T3", "T3 Code", "Cinderdeck"] {':
        return "historical client names"
    if path == "agent-runtime/apps/desktop/src/preview/BrowserSession.test.ts" and line.strip() == '"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) T3Code(Alpha)/0.0.33 Chrome/146.0.7680.216 Electron/41.5.0 Safari/537.36";':
        return "historical user-agent compatibility fixture"
    if path == "agent-runtime/scripts/lib/third-party-licenses.test.ts" and line.strip() == '"https://github.com/Yash-Singh1/ghostty/tree/t3code/custom-io-ordered-feed",':
        return "exact bundled terminal source attribution fixture"
    if path == "agent-runtime/apps/server/src/provider/acp/GrokAcpSupport.test.ts" and line.strip() == 'GROK_OAUTH2_REFERRER: "t3code",':
        return "provider OAuth client referrer fixture"
    if path == "agent-runtime/packages/effect-codex-app-server/src/replay.ts" and line.strip() == 'const legacyClient = clientInfo.name === "T3 Code" && clientInfo.title === "T3 Code";':
        return "original provider recording client identity comparison"
    if path.startswith("agent-runtime/patches/"):
        return "original third-party dependency patch"
    if path in LEGAL_FILES:
        return "legal attribution"
    if path in LEGAL_LINES and line.strip() == LEGAL_LINES[path]:
        return "legal attribution"
    if path in CHECK_FILES:
        return "branding enforcement literals"
    if path.startswith("agent-runtime/apps/server/src/orchestration-v2/testkit/fixtures/") and Path(path).suffix in {".json", ".ndjson", ".jsonl", ".ts"}:
        return "provider protocol fixture"
    if path.startswith(("agent-runtime/packages/effect-acp/src/_generated/", "agent-runtime/packages/effect-codex-app-server/src/_generated/")):
        return "provider protocol schema"
    if path.startswith(("agent-runtime/native/libghostty-vt/", "agent-runtime/apps/mobile/modules/t3-terminal/Vendor/libghostty/", "agent-runtime/apps/mobile/modules/t3-highlights/Vendor/")):
        return "third-party terminal source"
    return None


def violations(path: str, content: str) -> list[tuple[int, str]]:
    findings = []
    for match in PLIST_DISPLAY_IDENTITY.finditer(content):
        number = content.count("\n", 0, match.start()) + 1
        line = content.splitlines()[number - 1]
        if not exemption(path, line):
            findings.append((number, "removable upstream bundle display identity"))
    lines = content.splitlines()
    for number, line in enumerate(lines, 1):
        if "t3" not in line.lower():
            continue
        if exemption(path, line):
            continue
        # Disposable directory names are not stored/wire identifiers. Check them
        # before removing compatibility tokens used elsewhere in the same file.
        context = "\n".join(lines[max(0, number - 4):number])
        if TEMPORARY_BRAND.search(line) and (
            ".test." in path or re.search(r"mkdtemp|makeTempDirectory", context)
        ):
            findings.append((number, line.strip()))
            continue
        if DISPLAY_IDENTITY.search(line):
            findings.append((number, line.strip()))
            continue
        candidate = COMPATIBILITY.sub("", line)
        candidate = re.sub(r"sha(?:256|512)-[A-Za-z0-9+/=]+", "", candidate)
        candidate = WIRE_IDENTIFIERS.sub("", candidate)
        if path in TOKEN_EXCEPTIONS:
            token, reason = TOKEN_EXCEPTIONS[path]
            allowed_context = True
            if "credential binding" in reason:
                allowed_context = bool(re.search(r"\bowner:|credentialOwner:|Schema\.Literals", line))
            elif reason == "provider OAuth client referrer":
                allowed_context = "const CINDERDECK_OAUTH_REFERRER =" in line
            elif reason == "historical MCP server aliases":
                allowed_context = line.strip() == '"t3code",' or "(?<server>" in line
            if allowed_context:
                candidate = candidate.replace(token, "")
        if path == "agent-runtime/apps/mobile/plugins/withIosCocoaPodsUuidCache.cjs":
            candidate = candidate.replace("# t3code: repair cached CocoaPods UUID allocation before SPM integration", "")
        if path.startswith("agent-runtime/apps/mobile/modules/") or path.startswith("agent-runtime/apps/mobile/src/native/"):
            candidate = NATIVE_REFERENCES.sub("", candidate)
            candidate = NATIVE_ABI_IDENTIFIERS.sub("", candidate)
        # Documentation links must retain registered native module filenames.
        internal_candidate = re.sub(r"(?<=/ios/)T3Native(?:VideoPresentation|FilePresentation|Presentation)(?=\.swift)", "", candidate)
        native_source = path.startswith(("agent-runtime/apps/mobile/modules/", "agent-runtime/apps/mobile/src/native/"))
        if path.startswith("agent-runtime/apps/mobile/") or path in {"agent-runtime/vite.config.ts", "agent-runtime/scripts/mobile-showcase.ts"}:
            internal_candidate = NATIVE_REFERENCES.sub("", internal_candidate)
            internal_candidate = NATIVE_ABI_IDENTIFIERS.sub("", internal_candidate)
        if BRAND.search(candidate) or BARE_BRAND.search(candidate) or INTERNAL_BRAND.search(internal_candidate):
            findings.append((number, line.strip()[:200]))
    return findings

# Exact existing Expo/Fabric ABI source filenames, not entire native directories.
NATIVE_ABI_FILENAMES = {
    'HybridT3Highlights.cpp',
    'HybridT3Highlights.hpp',
    'HybridT3HighlightsSpec.cpp',
    'HybridT3HighlightsSpec.hpp',
    'T3BackgroundGraceSubscriber.swift',
    'T3ChipIcons.kt',
    'T3DpopKeys.kt',
    'T3DpopKeys.swift',
    'T3DpopKeysTest.kt',
    'T3FoldPostureModule.kt',
    'T3FrostedCutoutView.swift',
    'T3Highlights.nitro.ts',
    'T3HighlightsNative+autolinking.rb',
    'T3HighlightsNative-Swift-Cxx-Bridge.cpp',
    'T3HighlightsNative-Swift-Cxx-Bridge.hpp',
    'T3HighlightsNative-Swift-Cxx-Umbrella.hpp',
    'T3HighlightsNative.podspec',
    'T3HighlightsNativeAutolinking.mm',
    'T3HighlightsNativeAutolinking.swift',
    'T3HighlightsPackage.kt',
    'T3LayoutMetricsView.swift',
    'T3MenuDismissTouchGate.swift',
    'T3NativeImageViewer.swift',
    'T3ScrollEdgeBleedView.swift',
    'T3SecretInputModule.kt',
    'T3SegmentedControlView.swift',
    'T3SidebarTabBarView.swift',
    'T3SourceText.h',
    'T3SourceText.mm',
    'T3SourceText.podspec',
    'T3SourceTextComponentDescriptor.h',
    'T3SourceTextManager.mm',
    'T3SourceTextNativeComponent.ts',
    'T3SourceTextRun.h',
    'T3SourceTextRun.mm',
    'T3SourceTextRunComponentDescriptor.h',
    'T3SourceTextRunNativeComponent.ts',
    'T3SourceTextRunShadowNode.cpp',
    'T3SourceTextRunShadowNode.h',
    'T3SourceTextShadowNode.h',
    'T3SourceTextShadowNode.mm',
    'T3VoiceTranscription.podspec',
    'T3VoiceTranscriptionModule.kt',
    'T3VoiceTranscriptionModule.swift',
    'T3WebSocket.podspec',
    'T3WebSocketModule.swift',
    'T3WorkspaceNavigationModule.kt',
    'T3WorkspaceOrientationSubscriber.swift',
    't3_chats.xml',
    't3_highlights.c',
    't3_highlights.h',
    't3_menu.xml',
    't3_new_thread.xml',
    't3_pull_requests.xml',
    't3_settings.xml',
    't3_terminal_jni.cpp',
    't3_usage.xml',

    'T3AgentNotificationsModule.kt',
    'T3ComposerEditor.android.tsx',
    'T3ComposerEditor.ios.tsx',
    'T3ComposerEditor.native.tsx',
    'T3ComposerEditor.podspec',
    'T3ComposerEditor.tsx',
    'T3ComposerEditor.types.ts',
    'T3ComposerEditorModule.kt',
    'T3ComposerEditorModule.swift',
    'T3ComposerEditorView.kt',
    'T3ComposerEditorView.swift',
    'T3ContextChip.h',
    'T3ContextChip.kt',
    'T3KeyboardCommands.android.tsx',
    'T3KeyboardCommands.ios.tsx',
    'T3KeyboardCommands.tsx',
    'T3KeyboardCommands.native.tsx',
    'T3KeyboardCommandsModule.kt',
    'T3KeyboardCommandsModule.swift',
    'T3MarkdownText.h',
    'T3MarkdownText.mm',
    'T3MarkdownText.podspec',
    'T3MarkdownTextComponentDescriptor.h',
    'T3MarkdownTextManager.mm',
    'T3MarkdownTextNativeComponent.ts',
    'T3MarkdownTextRun.h',
    'T3MarkdownTextRun.mm',
    'T3MarkdownTextRunComponentDescriptor.h',
    'T3MarkdownTextRunNativeComponent.ts',
    'T3MarkdownTextRunShadowNode.cpp',
    'T3MarkdownTextRunShadowNode.h',
    'T3MarkdownTextSelectionModule.kt',
    'T3MarkdownTextSelectionModule.ts',
    'T3MarkdownTextShadowNode.h',
    'T3MarkdownTextShadowNode.mm',
    'T3NativeControls.podspec',
    'T3NativeControlsModule.kt',
    'T3NativeControlsModule.swift',
    'T3NativeFilePresentation.swift',
    'T3NativePresentation.swift',
    'T3NativeVideoPresentation.swift',
    'T3ReviewDiffModule.kt',
    'T3ReviewDiffModule.swift',
    'T3ReviewDiffNative.podspec',
    'T3ReviewDiffView.kt',
    'T3ReviewDiffView.swift',
    'T3TerminalModule.kt',
    'T3TerminalModule.swift',
    'T3TerminalNative.podspec',
    'T3TerminalView.kt',
    'T3TerminalView.swift',
    'T3WidgetExpiryModule.kt',
}


NATIVE_ABI_IDENTIFIERS = re.compile(r"\b(?:" + "|".join(
    re.escape(name.split(".")[0]) for name in sorted(NATIVE_ABI_FILENAMES)
) + r")\b")

def path_violations(path: str) -> bool:
    if path in {"agent-runtime/t3.json", "agent-runtime/scripts/npm-launcher/t3.mjs"}:
        return False  # Existing project configuration and archive launcher filenames.
    if path.startswith("agent-runtime/apps/server/src/orchestration-v2/testkit/fixtures/"):
        return False
    if path.startswith(("agent-runtime/packages/effect-acp/src/_generated/", "agent-runtime/packages/effect-codex-app-server/src/_generated/")):
        return False
    if path.startswith(("agent-runtime/native/libghostty-vt/", "agent-runtime/apps/mobile/modules/t3-terminal/Vendor/libghostty/", "agent-runtime/apps/mobile/modules/t3-highlights/Vendor/")):
        return False
    native_abi_context = path.startswith("agent-runtime/apps/mobile/src/native/")
    if path.startswith("agent-runtime/apps/mobile/modules/"):
        parts = path.split("/")
        if parts[4] in NATIVE_MODULES:
            native_abi_context = True
            path = "/".join(parts[5:])  # Only the registered module folder is exempt.
    if native_abi_context and Path(path).name in NATIVE_ABI_FILENAMES:
        path = str(Path(path).parent)  # Keep checking any surrounding directories.
    return bool(re.search(r"(?:T3Code|t3code|@t3tools|(?:^|/)t3(?:[./-]|$))", path, re.I) or INTERNAL_BRAND.search(path))


def branding_errors(root):
    errors = []
    for file, field in [
        ("apps/desktop/package.json", "productName"),
        ("apps/web/public/manifest.webmanifest", "name"),
        ("apps/web/public/manifest.webmanifest", "short_name"),
    ]:
        if json.loads((root / file).read_text()).get(field) != "Cinderdeck":
            errors.append(f"{file} must identify the app as Cinderdeck ({field})")
    for source, target in [
        ("ios-1024.png", "assets/prod/black-ios-1024.png"),
        ("macos-1024.png", "assets/prod/black-macos-1024.png"),
        ("web-apple-touch-180.png", "apps/web/public/apple-touch-icon.png"),
        ("web-favicon.ico", "apps/web/public/favicon.ico"),
    ]:
        if (root / "assets/cinderdeck/prod" / source).read_bytes() != (root / target).read_bytes():
            errors.append(f"{target} must use Cinderdeck artwork")
    # Vector paths can spell a vendor logo without containing any searchable brand text.
    # Composer documents must use the approved native artwork, with no hidden source assets.
    approved_artwork = (ROOT / "assets/cinderdeck-icon.png").read_bytes()
    for variant in ("dev", "nightly", "prod"):
        document = root / "assets" / variant / "app-icon.icon"
        source = document / "Assets/cinderdeck.png"
        if not source.is_file() or source.read_bytes() != approved_artwork:
            errors.append(f"assets/{variant}/app-icon.icon must use approved Cinderdeck source artwork")
        assets = document / "Assets"
        if not assets.is_dir() or sorted(path.name for path in assets.iterdir()) != ["cinderdeck.png"]:
            errors.append(f"assets/{variant}/app-icon.icon contains unexpected source assets")
        data = json.loads((document / "icon.json").read_text())
        groups = data.get("groups", [])
        layers = groups[0].get("layers", []) if len(groups) == 1 else []
        if len(layers) != 1 or layers[0].get("image-name") != "cinderdeck.png" or layers[0].get("name") != "Cinderdeck":
            errors.append(f"assets/{variant}/app-icon.icon must reference only the Cinderdeck artwork layer")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report-json", type=Path, help="Write the full audit, including exemption categories")
    args = parser.parse_args()
    result = subprocess.run(["git", "-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT, check=True, capture_output=True)
    errors = branding_errors(ROOT / "agent-runtime")
    categories = Counter()
    files = sorted(set(result.stdout.decode().split("\0")) - {""})
    for relative in files:
        path = ROOT / relative
        if not path.is_file():
            continue
        if path_violations(relative):
            errors.append(f"{relative}: removable upstream path identity")
        try:
            content = path.read_text()
        except UnicodeError:
            continue
        for line in content.splitlines():
            if BRAND.search(line) or BARE_BRAND.search(line) or INTERNAL_BRAND.search(line):
                category = exemption(relative, line)
                if category:
                    categories[category] += 1
                elif COMPATIBILITY.search(line):
                    categories["contains scoped storage, wire or native compatibility tokens"] += 1
        errors.extend(f"{relative}:{number}: {line}" for number, line in violations(relative, content))
    if args.report_json:
        args.report_json.write_text(json.dumps({"files": len(files), "exceptionCategories": dict(categories), "violations": errors}, indent=2) + "\n")
    if errors:
        print(f"Removable upstream branding remains ({len(errors)} findings):\n" + "\n".join(errors[:20]), file=sys.stderr)
        if len(errors) > 20:
            print("Full findings: run with --report-json /absolute/audit.json", file=sys.stderr)
        return 1
    print(f"Cinderdeck branding verified across {len(files)} tracked and candidate files.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
