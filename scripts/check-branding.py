#!/usr/bin/env python3
"""Reject upstream product branding while preserving narrowly defined compatibility data."""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
BRAND = re.compile(r"\bt3dotgg\b|\bt3chat\b|\bT3\s+Code\b|\bT3Code\b|[>\"\x27]T3[<\"\x27]|\bt3\s+(?:serve|connect|pair|service|update|app|project)\b|@t3tools/|\bcom\.t3tools\b|\b(?:[\w-]+\.)*t3\.(?:codes|gg)\b|\bpingdotgg/t3code\b", re.I)
BARE_BRAND = re.compile(r"\bT3\b", re.I)
INTERNAL_BRAND = re.compile(r"\b(?:T3|t3)[A-Z][a-z][A-Za-z0-9_]*\b")
TEMPORARY_BRAND = re.compile(r"(?:\bprefix\s*:\s*|\btmpdir\(\)\s*,\s*)[\"'`]\.?t3-", re.I)
# Exact native registration names and wrappers outside their ABI source folders.
NATIVE_REFERENCES = re.compile(r"\b(?:T3AgentNotifications|T3ComposerEditor|T3KeyboardCommands|T3NativeControls|T3NativeFilePresentation|T3NativePresentation|T3NativeVideoPresentation|T3ReviewDiffSurface|T3ReviewDiffView|T3SelectableMarkdownText|T3ShowcaseReadyScene|T3ShowcaseScene|T3TerminalNative|T3TerminalSurface|T3WidgetExpiry)\b")
# These are data and API identifiers, never product labels. Limit exceptions to tokens,
# rather than excluding the source files that also contain user-facing strings.
COMPATIBILITY = re.compile(
    r"\b(?:t3Home|t3SessionLoadReady|t3MintCredential)\b|/\.well-known/t3/environment|urn:t3:params:oauth:token-type:environment-bootstrap|app\.t3\.context-fragment|\bt3CodeRange\b|refs/t3/|\bt3\.pullRequests\.(?:detail|list|preferences)|\bt3\.backgroundActivity\.clientId|\bt3:chatgpt-sharing-welcome:v1|\bt3:paste-as-text|\bt3\.(?:settle_probe|flush_extension_errors)|\$t3:jsonrpc:|\bt3\.client\.surface|https://t3\.codes/schema/t3\.json|t3\.json|t3code-client\.db|\bt3code-(?:dev|preview)\b|(?<![A-Za-z0-9])\.t3code\b|(?<![A-Za-z0-9])\.t3\b|\bT3CODE_[A-Z0-9_]+\b|\bt3code(?::[\w:.-]*|\.(?:preferences(?:\.fallback)?|connections(?:\.[\w-]+)?|connection-catalog\.v1|cloud\.(?:relay-access-tokens|dpop-proof-key)|agent-awareness\.(?:device-id|registration)|recent-thread-shortcuts|diffFileTreeOpen|fileExplorerOpen|renderMarkdown|renderBrowserFile|renderTable|pullRequestFileTreeOpen)|://)|"
    r"\bpersist:t3code-preview(?:-profile)?-?|\bt3code-preview-ephemeral-|"
    r"\bt3(?:[-_]code|_[a-z][a-z0-9_]*|[-_]chat-(?:light|dark))\b|"
    r"(?:--|data-|font-|var\(--)?t3-[a-z][a-z0-9-]*|\bT3_ACP_[A-Z_]+\b",
    re.I,
)
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

CHECK_FILES = {"scripts/check-branding.py", "scripts/tests/test_branding.py", "scripts/check-repository.py"}
NATIVE_MODULES = {"t3-agent-notifications", "t3-composer-editor", "t3-keyboard-commands", "t3-markdown-text", "t3-native-controls", "t3-review-diff", "t3-terminal", "t3-widget-expiry", "t3-subscription-widget"}


TOKEN_EXCEPTIONS = {
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
    if path.startswith(("agent-runtime/native/libghostty-vt/", "agent-runtime/apps/mobile/modules/t3-terminal/Vendor/libghostty/")):
        return "third-party terminal source"
    return None


def violations(path: str, content: str) -> list[tuple[int, str]]:
    findings = []
    lines = content.splitlines()
    for number, line in enumerate(lines, 1):
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
        candidate = COMPATIBILITY.sub("", line)
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
            candidate = re.sub(r"T3(?:AgentNotifications|ComposerEditor|KeyboardCommands|MarkdownText|Markdown|ReviewDiff|Terminal|NativeControls)[A-Za-z0-9_]*", "", candidate)
        # Documentation links must retain registered native module filenames.
        internal_candidate = re.sub(r"(?<=/ios/)T3Native(?:VideoPresentation|FilePresentation|Presentation)(?=\.swift)", "", candidate)
        native_source = path.startswith(("agent-runtime/apps/mobile/modules/", "agent-runtime/apps/mobile/src/native/"))
        if path.startswith("agent-runtime/apps/mobile/") or path in {"agent-runtime/vite.config.ts", "agent-runtime/scripts/mobile-showcase.ts"}:
            internal_candidate = NATIVE_REFERENCES.sub("", internal_candidate)
        if BRAND.search(candidate) or BARE_BRAND.search(candidate) or (not native_source and INTERNAL_BRAND.search(internal_candidate)):
            findings.append((number, line.strip()[:200]))
    return findings

# Exact existing Expo/Fabric ABI source filenames, not entire native directories.
NATIVE_ABI_FILENAMES = {
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


def path_violations(path: str) -> bool:
    if path.startswith("agent-runtime/apps/server/src/orchestration-v2/testkit/fixtures/"):
        return False
    if path.startswith(("agent-runtime/packages/effect-acp/src/_generated/", "agent-runtime/packages/effect-codex-app-server/src/_generated/")):
        return False
    if path.startswith(("agent-runtime/native/libghostty-vt/", "agent-runtime/apps/mobile/modules/t3-terminal/Vendor/libghostty/")):
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


def main() -> int:
    result = subprocess.run(["git", "-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT, check=True, capture_output=True)
    errors = []
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
        errors.extend(f"{relative}:{number}: {line}" for number, line in violations(relative, content))
    if errors:
        print("Removable upstream branding remains:\n" + "\n".join(errors), file=sys.stderr)
        return 1
    print(f"Cinderdeck branding verified across {len(files)} tracked and candidate files.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
