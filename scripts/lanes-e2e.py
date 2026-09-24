#!/usr/bin/env python3
"""Exercise lane CLI and MCP against an isolated Debug app and real HTTP servers.

Build with scripts/stacks-verify.sh build, then run this script. Pass --inspect to
keep the fixture UI open until its printed continuation file is created. Nothing is installed globally.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, default=Path(__file__).resolve().parents[1] / ".build/agent-verify/derived/Build/Products/Debug/Cinderdeck Debug.app/Contents/MacOS/Cinderdeck")
    parser.add_argument("--inspect", action="store_true")
    args = parser.parse_args()
    binary = str(args.binary.resolve())
    with tempfile.TemporaryDirectory(prefix="cinderdeck-lanes-") as temporary:
        root = Path(temporary)
        repo, stacks = root / "shop", root / "stacks"
        repo.mkdir(); stacks.mkdir()
        env = dict(os.environ, CINDERDECK_STACKS_PREVIEW_ROOT=str(root), CINDERDECK_STACKS_SOCKET=f"/tmp/cinderdeck-lanes-{os.getpid()}.sock")

        def git(*arguments):
            return subprocess.check_output(["/usr/bin/git", *arguments], cwd=repo, text=True, stderr=subprocess.STDOUT).strip()

        def cli(*arguments, actor="Codex", expected=0):
            result = subprocess.run([binary, *arguments, "--json", "--as", actor, "--session", "lane-e2e"], env=env, text=True, capture_output=True, timeout=90)
            assert result.returncode == expected, (arguments, result.returncode, result.stdout, result.stderr)
            return json.loads(result.stdout if expected == 0 else result.stderr)

        git("init", "-b", "main")
        git("config", "user.name", "Cinderdeck Fixture")
        git("config", "user.email", "fixture@example.test")
        (repo / "server.py").write_text("""import http.server, json, os
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps(dict(cwd=os.getcwd(), port=os.environ['PORT'], api=os.environ.get('CINDERDECK_PORT_API'))).encode())
http.server.HTTPServer(('127.0.0.1', int(os.environ['PORT'])), Handler).serve_forever()
""")
        (repo / "check.py").write_text("""import json, os, pathlib, urllib.request
port = os.environ['CINDERDECK_PORT_API']
with urllib.request.urlopen('http://127.0.0.1:' + port, timeout=5) as response:
    body = json.load(response)
assert pathlib.Path(body['cwd']).resolve() == pathlib.Path.cwd().resolve()
assert body['port'] == port
print('Task verified its own lane server on port ' + port)
""")
        git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "fixture")
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0)); base_port = listener.getsockname()[1]
        (stacks / "shop.toml").write_text(f'''name = "Shop"
root = {json.dumps(str(repo))}
shell = "/bin/sh"
[repos.app]
path = "."
[services.api]
repo = "app"
cmd = "/usr/bin/python3 server.py"
port = {base_port}
env.PORT = "{base_port}"
ready.port = {base_port}
ready.timeout = 10
restart = "no"
[tasks.check]
repo = "app"
cmd = "/usr/bin/python3 check.py"
requires_services = ["api"]
[workflows.verify]
steps = ["task:check"]
''')
        with (root / "app.log").open("w") as log:
            app = subprocess.Popen([binary], env=env, stdout=log, stderr=log)
            mcp = None
            try:
                for _ in range(200):
                    if Path(env["CINDERDECK_STACKS_SOCKET"]).exists(): break
                    assert app.poll() is None, (root / "app.log").read_text()
                    time.sleep(0.1)
                else: raise AssertionError("Preview control socket did not start")
                base = cli("stacks", "start", "shop")["stack"]
                first = cli("lane", "create", "shop", "agent/codex-1")["stack"]
                mcp = subprocess.Popen([binary, "mcp"], env=dict(env, CINDERDECK_AGENT="Claude Code", CINDERDECK_AGENT_SESSION="lane-e2e"), text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log)
                request_id = 0

                def rpc(method, params):
                    nonlocal request_id
                    request_id += 1
                    mcp.stdin.write(json.dumps(dict(jsonrpc="2.0", id=request_id, method=method, params=params)) + "\n")
                    mcp.stdin.flush()
                    result = json.loads(mcp.stdout.readline())
                    assert "error" not in result, result
                    return result["result"]

                rpc("initialize", dict(protocolVersion="2025-06-18", clientInfo=dict(name="claude-code", version="test")))
                names = {tool["name"] for tool in rpc("tools/list", {})["tools"]}
                assert {"create_lane", "list_lanes", "remove_lane"} <= names
                result = rpc("tools/call", dict(name="create_lane", arguments=dict(stack="shop", branch="agent/claude-2")))
                assert not result["isError"], result
                second = json.loads(result["content"][0]["text"])["stack"]
                lanes = cli("lane", "list", "shop")
                assert len(lanes) == 3
                assert len({stack["services"][0]["port"] for stack in lanes}) == 3
                for stack in (base, first, second):
                    service = stack["services"][0]
                    assert service["ready"], stack
                    with urllib.request.urlopen(service["url"], timeout=5) as response:
                        payload = json.load(response)
                    assert int(payload["port"]) == service["port"]
                    assert Path(payload["cwd"]).resolve() == Path(service["cwd"]).resolve()
                    if stack.get("lane"): assert int(payload["api"]) == service["port"]
                denied = cli("stacks", "stop", "shop/agent/codex-1", actor="Claude Code", expected=3)
                assert denied["error"]["code"] == "claimed"
                assert git("branch", "--show-current") == "main"
                run = cli("workspace", "workflow", "shop/agent/codex-1", "verify")
                for _ in range(100):
                    run = cli("workspace", "status", run["id"])
                    if run["status"] in ("succeeded", "failed", "cancelled", "interrupted"): break
                    time.sleep(0.1)
                assert run["status"] == "succeeded", run
                assert cli("stacks", "status", "shop/agent/codex-1")["services"][0]["pid"] == first["services"][0]["pid"]
                blocked = cli("stacks", "switch", "shop", "agent/codex-1", expected=1)
                assert "already checked out" in blocked["error"]["message"], blocked
                assert cli("stacks", "status", "shop")["services"][0]["pid"] == base["services"][0]["pid"]
                print("PASS: CLI and MCP created three running environments with separate ports, worktrees and claims.", flush=True)
                print("PASS: a workflow reached its own lane server; an occupied-branch switch preserved the source process.", flush=True)
                if args.inspect:
                    print(f"Preview PID {app.pid}; fixture {root}", flush=True)
                    proceed = root / "continue"
                    print(f"Inspect the Lanes UI, then create {proceed} to finish and clean up.", flush=True)
                    deadline = time.monotonic() + 600
                    while not proceed.exists():
                        if time.monotonic() > deadline: raise TimeoutError("UI inspection exceeded ten minutes")
                        time.sleep(0.2)
                cli("lane", "remove", "shop/agent/codex-1")
                assert cli("stacks", "status", "shop")["services"][0]["pid"] == base["services"][0]["pid"]
                assert cli("stacks", "status", "shop/agent/claude-2")["services"][0]["pid"] == second["services"][0]["pid"]
                cli("lane", "remove", "shop/agent/claude-2", actor="Claude Code")
                assert git("rev-parse", "refs/heads/agent/codex-1")
                print("PASS: removal preserved the original and sibling processes and kept the Git branches.", flush=True)
            finally:
                if mcp:
                    mcp.terminate(); mcp.wait(timeout=10)
                if app.poll() is None:
                    try:
                        snapshot = cli("stacks", "status")
                        for stack in snapshot["stacks"]:
                            cli("stacks", "stop", stack["id"], "--force")
                    finally:
                        app.terminate()
                        try: app.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            app.kill(); app.wait(timeout=10)
                Path(env["CINDERDECK_STACKS_SOCKET"]).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
