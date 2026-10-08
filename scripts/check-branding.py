#!/usr/bin/env python3
"""Reject upstream product branding while preserving narrowly defined compatibility data."""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
BRAND = re.compile(r"\bT3\s+Code\b|\bT3Code\b|[>\"\x27]T3[<\"\x27]|\bt3\s+(?:serve|connect|pair|service|update|app|project)\b|@t3tools/|\bcom\.t3tools\b|\b(?:[\w-]+\.)*t3\.(?:codes|gg)\b|\bpingdotgg/t3code\b", re.I)
BARE_BRAND = re.compile(r"\bT3\b")
# These are data and API identifiers, never product labels. Limit exceptions to tokens,
# rather than excluding the source files that also contain user-facing strings.
COMPATIBILITY = re.compile(
    r"https://t3\.codes/schema/t3\.json|t3\.json|t3code-client\.db|\bt3code-(?:dev|preview)\b|(?<![A-Za-z0-9])\.t3code\b|(?<![A-Za-z0-9])\.t3\b|\bT3CODE_[A-Z0-9_]+\b|\bt3code(?::[\w:.-]*|\.(?:preferences(?:\.fallback)?|connections(?:\.[\w-]+)?|connection-catalog\.v1|cloud\.(?:relay-access-tokens|dpop-proof-key)|agent-awareness\.(?:device-id|registration)|recent-thread-shortcuts|diffFileTreeOpen|fileExplorerOpen|renderMarkdown|renderBrowserFile|renderTable|pullRequestFileTreeOpen)|://)|"
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
    "agent-runtime/apps/server/src/pullRequest/gitHubPullRequestJson.ts": ("pingdotgg/t3code", "source measurement attribution"),
    "agent-runtime/apps/server/src/terminal/NodePtyAdapter.ts": ("pingdotgg/t3code", "source contribution attribution"),
    "agent-runtime/scripts/lib/deckhand-distribution.ts": ("T3CODE", "refused vendor environment names"),
}


def exemption(path: str, line: str) -> str | None:
    if path == "agent-runtime/packages/client-runtime/src/errors/transport.ts" and line.strip() == r"/Unable to connect to the (?:Cinderdeck|T3) server WebSocket\./i,":
        return "historical server error compatibility pattern"
    if path == "Cinderdeck/Services/Stacks/Agents/StackControlProtocol.swift" and line.strip() == 'let appNames: Set<String> = ["deckhand", "t3", "t3 code"]':
        return "historical client names"
    if path == "CinderdeckTests/Services/Stacks/StackControlTests.swift" and line.strip() == 'for name in ["Deckhand", "T3", "T3 Code", "Cinderdeck"] {':
        return "historical client names"
    if path == "agent-runtime/apps/desktop/src/preview/BrowserSession.test.ts" and 'T3Code(Alpha)/0.0.33 Chrome/146.0.7680.216 Electron/41.5.0 Safari/537.36' in line:
        return "historical user-agent compatibility fixture"
    if path in LEGAL_FILES or "Copyright " in line or re.match(r"\s*s\.author\s*=", line):
        return "legal attribution"
    if path in LEGAL_LINES and line.strip() == LEGAL_LINES[path]:
        return "legal attribution"
    if path in CHECK_FILES:
        return "branding enforcement literals"
    if path.startswith("agent-runtime/apps/server/src/orchestration-v2/testkit/fixtures/") and Path(path).suffix in {".json", ".ndjson", ".jsonl", ".ts"}:
        return "provider protocol fixture"
    if "/_generated/" in path and path.startswith(("agent-runtime/packages/effect-acp/", "agent-runtime/packages/effect-codex-app-server/")):
        return "provider protocol schema"
    if path.startswith("agent-runtime/native/libghostty-vt/") or "/Vendor/libghostty/" in path:
        return "third-party terminal source"
    return None


def violations(path: str, content: str) -> list[tuple[int, str]]:
    findings = []
    for number, line in enumerate(content.splitlines(), 1):
        if exemption(path, line):
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
        if BRAND.search(candidate) or BARE_BRAND.search(candidate):
            findings.append((number, line.strip()[:200]))
    return findings


def path_violations(path: str) -> bool:
    if "/_generated/" in path or "/testkit/fixtures/" in path or "/Vendor/" in path:
        return False
    if path.startswith("agent-runtime/apps/mobile/modules/"):
        module = path.split("/")[4]
        if module in NATIVE_MODULES:
            return False  # Expo/Fabric module and native ABI source paths.
    if path.startswith("agent-runtime/apps/mobile/src/native/"):
        return False  # Native module import wrappers preserve their registered names.
    return bool(re.search(r"(?:T3Code|t3code|@t3tools|(?:^|/)t3-)", path, re.I))


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
