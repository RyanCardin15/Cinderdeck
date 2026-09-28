#!/usr/bin/env python3
"""Measure the real control API using disposable preview workspaces and services."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import socket
import statistics
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--services", type=int, default=16)
    parser.add_argument("--samples", type=int, default=20)
    args = parser.parse_args()
    if not 1 <= args.services <= 64 or args.samples < 1:
        parser.error("Use 1–64 services and at least one sample")
    binary = args.binary.resolve()
    info = binary.parent.parent / "Info.plist"
    if not info.is_file() or plistlib.loads(info.read_bytes()).get("CFBundleIdentifier") != "com.ryancardin.cinderdeck.debug":
        parser.error("This fixture requires a Cinderdeck Debug.app binary with the isolated preview harness")
    with tempfile.TemporaryDirectory(prefix="cinderdeck-perf-") as temporary:
        root = Path(temporary)
        (root / "stacks").mkdir()
        # A finite, deterministic burst followed by an idle service, with no network or repo access.
        definition = f'name = "Performance fixture"\nroot = {json.dumps(str(root))}\nshell = "/bin/sh"\n'
        for index in range(args.services):
            command = f"awk 'BEGIN {{ for (i=0; i<5000; i++) print \"service-{index} line \" i; print \"READY\" }}'; exec sleep 300"
            definition += f'\n[services.s{index:02}]\ncmd = {json.dumps(command)}\nready.log = "READY"\nautostart = false\n'
        (root / "stacks" / "fixture.toml").write_text(definition)
        env = dict(os.environ, CINDERDECK_STACKS_PREVIEW_ROOT=str(root),
                   CINDERDECK_STACKS_SOCKET=f"/tmp/cinderdeck-perf-{os.getpid()}.sock")
        connection = None
        stream = None
        request_id = 0

        def call(method, **params):
            nonlocal request_id
            request_id += 1
            message = dict(id=request_id, method=method, params=params,
                           client=dict(name="Performance benchmark", session="fixture"))
            stream.write(json.dumps(message).encode() + b"\n")
            stream.flush()
            response = json.loads(stream.readline())
            assert response["id"] == request_id and not response.get("error"), response
            return response["result"]

        with (root / "app.log").open("w") as log:
            app = subprocess.Popen([str(binary)], env=env, stdout=log, stderr=log)
            try:
                for _ in range(300):
                    if Path(env["CINDERDECK_STACKS_SOCKET"]).exists():
                        break
                    assert app.poll() is None, (root / "app.log").read_text()
                    time.sleep(0.1)
                connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                connection.settimeout(90)
                connection.connect(env["CINDERDECK_STACKS_SOCKET"])
                stream = connection.makefile("rwb")
                started = call("services.start", workspace="fixture", wait=True,
                               services=[f"s{index:02}" for index in range(args.services)])
                assert all(service["ready"] for service in started["workspace"]["services"]), started
                # Wait for the complete burst to land, instead of timing log ingestion.
                for _ in range(100):
                    result = call("logs", workspace="fixture", service=f"s{args.services - 1:02}", lines=1)
                    if result["lines"] and result["lines"][-1]["text"] == "READY":
                        break
                    time.sleep(0.1)
                else:
                    raise AssertionError(f"Fixture output did not settle: {result}")
                results = {"services": args.services, "buffered_lines": args.services * 5000,
                           "configuration": "Debug", "samples": args.samples, "workloads": {}}
                cursor = time.time() + 1
                for name, method, params in [
                    ("ping", "ping", {}),
                    ("recent_200", "logs", dict(workspace="fixture", lines=200)),
                    ("unchanged_poll", "logs", dict(workspace="fixture", after=cursor, lines=200)),
                    ("workspace_list", "workspace.list", dict(detail=True)),
                ]:
                    samples = []
                    for _ in range(args.samples):
                        start = time.perf_counter()
                        result = call(method, **params)
                        samples.append((time.perf_counter() - start) * 1000)
                        if name == "recent_200":
                            assert len(result["lines"]) == 200
                        if name == "unchanged_poll":
                            assert not result["lines"]
                    ordered = sorted(samples)
                    results["workloads"][name] = dict(median_ms=statistics.median(samples),
                        p95_ms=ordered[min(len(ordered) - 1, int(len(ordered) * .95))],
                        response_bytes=len(json.dumps(result).encode()))
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(json.dumps(results, indent=2) + "\n")
                print(json.dumps(results, indent=2), flush=True)
            finally:
                try:
                    if stream and app.poll() is None:
                        call("services.stop", workspace="fixture", wait=True)
                finally:
                    if stream:
                        stream.close()
                    if connection:
                        connection.close()
                    app.terminate()
                    try:
                        app.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        app.kill()
                        app.wait(timeout=10)
                    Path(env["CINDERDECK_STACKS_SOCKET"]).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
