#!/usr/bin/env python3
"""Exercise lane CLI and MCP against an isolated Debug app and real HTTP servers.

Build with scripts/stacks-verify.sh build, then run this script. Pass --inspect to
keep the fixture UI open until its printed continuation file is created. Nothing is installed globally.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
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
        (repo / ".gitignore").write_text(".env\ncache/\n")
        (repo / "server.py").write_text("""import http.server, json, os
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps(dict(cwd=os.getcwd(), port=os.environ['PORT'], api=os.environ.get('CINDERDECK_PORT_API'), url=os.environ.get('API_URL'))).encode())
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
        (repo / "teardown.py").write_text("""import os, socket
with socket.socket() as listener:
    listener.settimeout(2)
    assert listener.connect_ex(('127.0.0.1', int(os.environ['CINDERDECK_PORT_API']))) != 0
print('Teardown verified that lane services were stopped')
""")
        git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "fixture")
        (repo / ".env").write_text("SECRET=fixture\n")
        (repo / "local.config").write_text("copied fixture configuration\n")
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
env.API_URL = "{{{{url.api}}}}"
ready.port = {base_port}
ready.timeout = 10
restart = "no"
[tasks.check]
repo = "app"
cmd = "/usr/bin/python3 check.py"
requires_services = ["api"]
[workflows.verify]
steps = ["task:check"]
[tasks.install]
cmd = "test -f .env && test -f local.config && echo 'Setup verified copied configuration'"
[tasks.teardown]
cmd = "/usr/bin/python3 teardown.py"
[lanes]
copy = [".env", "local.config"]
setup = "task:install"
teardown = "task:teardown"
''')
        (stacks / "review.toml").write_text(f'''name = "Review"
root = {json.dumps(str(repo))}
[tasks.check]
cmd = "pwd"
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
                base = cli("services", "start", "shop")["workspace"]
                first = cli("lane", "create", "shop", "agent/codex-1")["workspace"]
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
                assert {"create_lane", "adopt_lane", "list_lanes", "lane_env", "run_lane_setup", "remove_lane", "release_lane", "prune_lanes", "unpin_lane"} <= names
                result = rpc("tools/call", dict(name="create_lane", arguments=dict(workspace="shop", branch="agent/claude-2")))
                assert not result["isError"], result
                assert json.loads(result["content"][0]["text"])["workspace"]["lane"], result
                second = cli("services", "status", "shop/agent/claude-2")
                parallel_actors = ("Review A", "Review B")
                with ThreadPoolExecutor(max_workers=2) as pool:
                    futures = [pool.submit(cli, "lane", "create", "shop", f"feature/parallel-{i}", actor=actor)
                               for i, actor in enumerate(parallel_actors)]
                    parallel = [future.result()["workspace"] for future in futures]
                lanes = cli("lane", "list", "shop")
                assert len(lanes) == 5
                assert len({stack["services"][0]["port"] for stack in lanes}) == 5
                for stack in (base, first, second, *parallel):
                    service = stack["services"][0]
                    assert service["ready"], stack
                    with urllib.request.urlopen(service["url"], timeout=5) as response:
                        payload = json.load(response)
                    assert int(payload["port"]) == service["port"]
                    assert Path(payload["cwd"]).resolve() == Path(service["cwd"]).resolve()
                    assert payload["url"] == service["url"], payload
                    if stack.get("lane"): assert int(payload["api"]) == service["port"]
                shared = cli("services", "start", "shop/agent/codex-1", actor="Claude Code")
                assert shared["workspace"]["services"][0]["pid"] == first["services"][0]["pid"]
                assert all("claim" not in stack for stack in lanes)
                assert git("branch", "--show-current") == "main"
                run = cli("workspace", "workflow", "shop/agent/codex-1", "verify")
                for _ in range(100):
                    run = cli("workspace", "status", run["id"])
                    if run["status"] in ("succeeded", "failed", "cancelled", "interrupted"): break
                    time.sleep(0.1)
                assert run["status"] == "succeeded", run
                assert cli("services", "status", "shop/agent/codex-1")["services"][0]["pid"] == first["services"][0]["pid"]
                blocked = cli("services", "switch", "shop", "agent/codex-1", expected=1)
                assert "already checked out" in blocked["error"]["message"], blocked
                assert cli("services", "status", "shop")["services"][0]["pid"] == base["services"][0]["pid"]
                exported = cli("lane", "env", "shop/agent/codex-1", "api")["environment"]
                assert exported["PORT"] == str(first["services"][0]["port"]), exported
                assert exported["CINDERDECK_URL_API"] == first["services"][0]["url"], exported
                assert exported["CINDERDECK_LANE"] == "agent/codex-1" and exported["COMPOSE_PROJECT_NAME"] == "shop-agent-codex-1", exported
                assert "/lanes/shop/agent-codex-1/" in first["services"][0]["cwd"], first
                external = root / "agent-own"
                git("worktree", "add", "-b", "agent/own", str(external))
                adopted = cli("lane", "adopt", "shop", "--path", str(external), "--no-start")["workspace"]
                assert adopted["laneStatus"]["adopted"] and adopted["lane"]["name"] == "agent/own", adopted
                borrowed = cli("lane", "create", "review", "agent/own", "--no-start")["workspace"]
                assert borrowed["laneStatus"]["adopted"], borrowed
                assert all(not tree["managed"] for tree in borrowed["laneStatus"]["worktrees"]), borrowed
                print("PASS: CLI and MCP created five running environments, including concurrent requests, with separate ports and worktrees, with shared agent access.", flush=True)
                print("PASS: a workflow reached its own lane server; an occupied-branch switch preserved the source process.", flush=True)
                if args.inspect:
                    print(f"Preview PID {app.pid}; fixture {root}", flush=True)
                    proceed = root / "continue"
                    print(f"Inspect the Lanes UI, then create {proceed} to finish and clean up.", flush=True)
                    deadline = time.monotonic() + 600
                    while not proceed.exists():
                        if time.monotonic() > deadline: raise TimeoutError("UI inspection exceeded ten minutes")
                        time.sleep(0.2)
                cli("lane", "release", "shop/agent/own")
                cli("lane", "remove", "review/agent/own")
                assert (external / "server.py").exists()
                print("PASS: an adopted worktree stayed external when shared with another workspace and survived both lane removals.", flush=True)
                for stack, actor in zip(parallel, parallel_actors):
                    cli("lane", "remove", stack["id"], actor=actor)
                cli("lane", "remove", "shop/agent/codex-1")
                assert cli("services", "status", "shop")["services"][0]["pid"] == base["services"][0]["pid"]
                assert cli("services", "status", "shop/agent/claude-2")["services"][0]["pid"] == second["services"][0]["pid"]
                cli("lane", "remove", "shop/agent/claude-2", actor="Claude Code")
                assert git("rev-parse", "refs/heads/agent/codex-1")
                print("PASS: setup copied configuration, teardown ran with services stopped, and removal cleaned copied files while preserving source/sibling processes and Git branches.", flush=True)
            finally:
                if mcp:
                    mcp.terminate(); mcp.wait(timeout=10)
                if app.poll() is None:
                    try:
                        snapshot = cli("services", "status")
                        for stack in snapshot["workspaces"]:
                            cli("services", "stop", stack["id"], "--force")
                    finally:
                        app.terminate()
                        try: app.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            app.kill(); app.wait(timeout=10)
                Path(env["CINDERDECK_STACKS_SOCKET"]).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
