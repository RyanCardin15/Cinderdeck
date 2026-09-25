#!/usr/bin/env python3
"""CLI/MCP lifecycle parity against a throwaway Debug app; never changes installed workspaces."""
import argparse
import json
import os
from pathlib import Path
import select
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=Path(__file__).resolve().parents[1] /
                        ".build/agent-verify/derived/Build/Products/Debug/Cinderdeck Debug.app/Contents/MacOS/Cinderdeck")
    binary = str(parser.parse_args().binary.resolve())
    with tempfile.TemporaryDirectory(prefix="cinderdeck-agent-controls-") as temporary:
        root = Path(temporary)
        project = root / "project"
        project.mkdir()
        (root / "stacks").mkdir()
        (project / "keep.txt").write_text("Project files must survive workspace removal.\n")
        for args in [("init", "-b", "main"), ("add", "."),
                     ("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "fixture")]:
            subprocess.run(["git", *args], cwd=project, check=True, capture_output=True)
        env = dict(os.environ, CINDERDECK_STACKS_PREVIEW_ROOT=str(root),
                   CINDERDECK_STACKS_SOCKET=f"/tmp/cinderdeck-agent-controls-{os.getpid()}.sock",
                   CINDERDECK_AGENT="Control Test", CINDERDECK_AGENT_SESSION="e2e")

        def cli(*args, expected=0):
            result = subprocess.run([binary, *args], env=env, text=True, capture_output=True, timeout=90)
            assert result.returncode == expected, (args, result.returncode, result.stdout, result.stderr)
            return json.loads(result.stdout if expected == 0 else result.stderr)

        with (root / "app.log").open("w") as log:
            app = subprocess.Popen([binary], env=env, stdout=log, stderr=log)
            mcp = None
            try:
                for _ in range(200):
                    if Path(env["CINDERDECK_STACKS_SOCKET"]).exists():
                        break
                    assert app.poll() is None, (root / "app.log").read_text()
                    time.sleep(0.1)
                else:
                    raise AssertionError("Preview control socket did not start")
                mcp = subprocess.Popen([binary, "mcp"], env=env, text=True, stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=log)
                request_id = 0

                def rpc(method, params):
                    nonlocal request_id
                    request_id += 1
                    mcp.stdin.write(json.dumps(dict(jsonrpc="2.0", id=request_id, method=method, params=params)) + "\n")
                    mcp.stdin.flush()
                    assert select.select([mcp.stdout], [], [], 90)[0], "MCP response timed out"
                    result = json.loads(mcp.stdout.readline())
                    assert result.get("id") == request_id and "error" not in result, result
                    return result["result"]

                def tool(name, **arguments):
                    result = rpc("tools/call", dict(name=name, arguments=arguments))
                    assert not result.get("isError"), result
                    return json.loads(result["content"][0]["text"])

                rpc("initialize", dict(protocolVersion="2025-11-25", clientInfo=dict(name="e2e", version="1")))
                catalog = rpc("tools/list", {})["tools"]
                assert cli("tools") == catalog
                assert cli("tools", "save_workspace")["inputSchema"]["additionalProperties"] is False
                cli("workspace", "create", "--name", "Fixture", "--folder", str(project), "--id", "fixture")
                cli("workspace", "save-service", "fixture", "worker", "--data", '{"cmd":"sleep 300","autostart":false}')
                tool("save_workspace_task", workspace="fixture", task="check", cmd="echo checked")
                cli("workspace", "save-workflow", "fixture", "verify", "--data", '{"steps":["task:check"]}')
                definition = tool("workspace_definition", workspace="fixture")
                cli("workspace", "edit", "fixture", "--name", "Updated fixture")
                stale = cli("call", "save_workspace", "--arguments", json.dumps(dict(workspace="fixture", source=definition["source"],
                                                                                   revision=definition["revision"])), expected=1)
                assert stale["error"]["code"] == "stale_definition", stale
                definition = cli("workspace", "definition", "fixture")
                source = definition["source"] + '\n[lanes]\nfrom = "main"\nenv.MODE = "default"\n'
                file = root / "edit.toml"
                file.write_text(source)
                cli("workspace", "save", "fixture", "--file", str(file), "--revision", definition["revision"])
                assert tool("workspace_definition", workspace="fixture")["source"] == source
                malformed = cli("call", "save_workspace_service", "--arguments",
                                '{"workspace":"fixture","service":"worker","autostart":"false"}', expected=1)
                assert malformed["error"]["code"] == "invalid_params", malformed
                invalid_mcp = rpc("tools/call", dict(name="update_lane", arguments=dict(workspace="fixture", unknown=True)))
                assert invalid_mcp["isError"], invalid_mcp
                print(f"PASS: CLI and MCP share {len(catalog)} schemas; workspace creation, component edits, full saves and stale/type validation.", flush=True)

                lane = tool("create_lane", workspace="fixture", branch="agent/original", start=False, setup=False)["workspace"]
                cli("lane", "edit", lane["id"], "--name", "review", "--env", "MODE=review")
                updated = cli("workspace", "show", "fixture/review")["workspace"]
                assert updated["id"] == lane["id"]
                for key in ["directory", "ports", "slug"]:
                    assert updated["lane"][key] == lane["lane"][key], key
                assert updated["lane"]["environment"] == {"MODE": "review"}
                tool("update_lane", workspace=lane["id"], env={})
                assert cli("workspace", "show", lane["id"])["workspace"]["lane"]["environment"] == {}
                assert cli("workspace", "remove", "fixture", expected=1)["error"]["code"] == "in_use"
                cli("lane", "remove", lane["id"], "--json")
                assert (project / "keep.txt").exists()
                print("PASS: lane rename/environment edits retain identity, folders and ports; workspace removal refuses remaining lanes.", flush=True)

                run = cli("workspace", "workflow", "fixture", "verify")
                assert cli("workspace", "wait", run["id"])["run"]["status"] == "succeeded"
                assert tool("workspace_run_logs", run=run["id"])["lines"]
                tool("delete_workspace_item", workspace="fixture", kind="workflow", id="verify")
                cli("workspace", "delete-item", "fixture", "task", "check")
                args_file = root / "delete.json"
                args_file.write_text(json.dumps(dict(workspace="fixture")))
                assert cli("call", "delete_workspace", "--file", str(args_file))["removed"] == "fixture"
                assert (project / "keep.txt").exists() and (project / ".git").exists()
                assert cli("workspace", "runs", "fixture")[0]["id"] == run["id"]
                assert not (root / "stacks" / "fixture.toml").exists()
                assert cli("workspace", "list") == []
                print("PASS: run/wait/logs and component removal work across transports; workspace removal keeps the project, Git history and saved run.", flush=True)
            finally:
                if mcp:
                    mcp.terminate()
                    mcp.wait(timeout=10)
                if app.poll() is None:
                    app.terminate()
                    try:
                        app.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        app.kill()
                        app.wait(timeout=10)
                Path(env["CINDERDECK_STACKS_SOCKET"]).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
