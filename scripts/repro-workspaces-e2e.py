#!/usr/bin/env python3
"""Record with some of several running workspaces and check only those reach the recording.

Runs an isolated Debug app (CINDERDECK_STACKS_PREVIEW_ROOT) with three workspaces whose
services print continuously, then records through the CLI, MCP, and a task run with
different workspace choices. Each recording must hold the chosen workspaces' output and
nothing from the others: in its sources, its workspaces, its log file, and `repro list`.

The Debug app needs Screen Recording permission. Build it with a persistent identity so
the permission survives rebuilds, for example:

  xcodebuild build -project Cinderdeck.xcodeproj -scheme Cinderdeck -configuration Debug \
    -derivedDataPath .build/repro-e2e/derived CODE_SIGN_IDENTITY="Cinderdeck Local Development" \
    CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=

Pass --inspect to keep the app open (Workspaces → Recordings) until the printed file exists.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

WORKSPACES = ["alpha", "beta", "gamma"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, default=Path(__file__).resolve().parents[1] / ".build/repro-e2e/derived/Build/Products/Debug/Cinderdeck Debug.app/Contents/MacOS/Cinderdeck")
    parser.add_argument("--inspect", action="store_true")
    args = parser.parse_args()
    binary = str(args.binary.resolve())
    with tempfile.TemporaryDirectory(prefix="cinderdeck-repro-ws-") as temporary:
        root = Path(temporary)
        stacks = root / "stacks"
        stacks.mkdir()
        env = dict(os.environ, CINDERDECK_STACKS_PREVIEW_ROOT=str(root), CINDERDECK_STACKS_SOCKET=f"/tmp/cinderdeck-repro-ws-{os.getpid()}.sock")

        def cli(*arguments, actor="Codex", expected=0, timeout=120):
            result = subprocess.run([binary, *arguments, "--json", "--as", actor, "--session", "repro-ws-e2e"], env=env, text=True, capture_output=True, timeout=timeout)
            assert result.returncode == expected, (arguments, result.returncode, result.stdout, result.stderr)
            return json.loads(result.stdout if expected == 0 else result.stderr)

        for name in WORKSPACES:
            project = root / name
            project.mkdir()
            # Unbuffered so every line reaches Cinderdeck as it is printed.
            (project / "talk.py").write_text(f"""import time
n = 0
while True:
    n += 1
    print('{name}-service line ' + str(n), flush=True)
    if n % 10 == 0: print('ERROR {name}-service failure ' + str(n), flush=True)
    time.sleep(0.1)
""")
            (stacks / f"{name}.toml").write_text(f'''name = "{name.capitalize()}"
root = {json.dumps(str(project))}
shell = "/bin/sh"
[services.talk]
cmd = "/usr/bin/python3 -u talk.py"
restart = "no"
[tasks.check]
cmd = "/bin/sh -c 'for i in 1 2 3 4 5; do echo {name}-task step $i; sleep 0.3; done'"
''')

        def assert_only(repro_id, expected, label):
            """Sources, workspaces, list filters, and the log file hold only `expected`."""
            others = [name for name in WORKSPACES if name not in expected]
            show = cli("repro", "show", repro_id)
            assert show["status"] == "ready", (label, show["status"], show.get("detail"))
            captured = {source["workspace"] for source in show["sources"] if source["kind"] != "external"}
            assert captured == set(expected), (label, "sources", captured, show["sources"])
            workspaces = {workspace["id"] for workspace in show["workspaces"]}
            assert workspaces == set(expected), (label, "workspaces", workspaces)
            log = (Path(show["folder"]) / "recording.log").read_text()
            for name in expected:
                assert f"{name}-" in log, (label, f"missing {name} output", log[:2000])
            for name in others:
                assert f"{name}-" not in log, (label, f"{name} output leaked", [line for line in log.splitlines() if f"{name}-" in line][:5])
                listed = {item["repro"] for item in cli("repro", "list", name)}
                assert repro_id not in listed, (label, f"listed under {name}")
            for name in expected:
                assert repro_id in {item["repro"] for item in cli("repro", "list", name)}, (label, f"not listed under {name}")
            lines = {source["workspace"]: source["lines"] for source in show["sources"]}
            print(f"PASS {label}: captured {sorted(expected)} ({lines}); nothing from {others}", flush=True)
            return show

        def record(label, *arguments):
            started = cli("repro", "start", "--title", label, "--max", "30", *arguments)
            time.sleep(3)
            cli("repro", "stop", started["repro"], timeout=240)
            return started["repro"]

        with (root / "app.log").open("w") as log:
            app = subprocess.Popen([binary], env=env, stdout=log, stderr=log)
            mcp = None
            try:
                for _ in range(200):
                    if Path(env["CINDERDECK_STACKS_SOCKET"]).exists(): break
                    assert app.poll() is None, (root / "app.log").read_text()
                    time.sleep(0.1)
                else: raise AssertionError("Preview control socket did not start")
                for name in WORKSPACES:
                    cli("services", "start", name)
                time.sleep(1)
                running = {stack["id"] for stack in cli("services", "status")["workspaces"] if any(service.get("pid") for service in stack["services"])}
                assert running == set(WORKSPACES), running

                assert_only(record("two of three", "--workspace", "alpha", "--workspace", "gamma"), ["alpha", "gamma"], "CLI --workspace alpha --workspace gamma")
                assert_only(record("comma list", "--workspace", "beta,gamma"), ["beta", "gamma"], "CLI --workspace beta,gamma")
                assert_only(record("one", "--workspace", "beta"), ["beta"], "CLI --workspace beta")

                run = cli("repro", "run", "alpha", "check", "--workspace", "beta", "--wait", "--max", "60", timeout=240)
                show = assert_only(run["repro"], ["alpha", "beta"], "CLI repro run alpha check --workspace beta")
                assert any(source["kind"] == "task" and source["workspace"] == "alpha" for source in show["sources"]), show["sources"]

                mcp = subprocess.Popen([binary, "mcp"], env=dict(env, CINDERDECK_AGENT="Claude Code", CINDERDECK_AGENT_SESSION="repro-ws-e2e"), text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log)
                request_id = 0

                def call(name, arguments):
                    nonlocal request_id
                    request_id += 1
                    mcp.stdin.write(json.dumps(dict(jsonrpc="2.0", id=request_id, method="tools/call", params=dict(name=name, arguments=arguments))) + "\n")
                    mcp.stdin.flush()
                    result = json.loads(mcp.stdout.readline())
                    assert "error" not in result and not result["result"]["isError"], result
                    return json.loads(result["result"]["content"][0]["text"])

                request_id += 1
                mcp.stdin.write(json.dumps(dict(jsonrpc="2.0", id=request_id, method="initialize", params=dict(protocolVersion="2025-06-18", clientInfo=dict(name="claude-code", version="test")))) + "\n")
                mcp.stdin.flush(); mcp.stdout.readline()
                started = call("start_repro_recording", dict(title="MCP workspace plus workspaces", workspace="gamma", workspaces=["alpha"], max_seconds=30))
                time.sleep(3)
                call("stop_repro_recording", dict(repro=started["repro"]))
                assert_only(started["repro"], ["alpha", "gamma"], "MCP workspace=gamma + workspaces=[alpha] combine")

                # The toolbar's scope, set the way the Workspace popover sets it.
                scope = cli("repro", "scope", "alpha", "gamma")
                assert scope["mode"] == "selected" and sorted(scope["workspaces"]) == ["alpha", "gamma"], scope
                assert sorted(cli("repro", "scope")["workspaces"]) == ["alpha", "gamma"]
                print("PASS toolbar scope: selected alpha and gamma", flush=True)

                if args.inspect:
                    proceed = root / "continue"
                    print(f"Preview PID {app.pid}. Inspect Workspaces → Recordings, then: touch {proceed}", flush=True)
                    deadline = time.monotonic() + 900
                    while not proceed.exists():
                        if time.monotonic() > deadline: raise TimeoutError("Inspection exceeded fifteen minutes")
                        time.sleep(0.2)
            finally:
                if mcp:
                    mcp.terminate(); mcp.wait(timeout=10)
                if app.poll() is None:
                    try:
                        for name in WORKSPACES:
                            cli("services", "stop", name, "--force")
                    finally:
                        app.terminate()
                        try: app.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            app.kill(); app.wait(timeout=10)
                Path(env["CINDERDECK_STACKS_SOCKET"]).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
