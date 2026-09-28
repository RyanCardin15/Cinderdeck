#!/usr/bin/env python3
"""Exercise real headless Chrome capture through the isolated app's CLI and MCP.

Requires macOS and Google Chrome. No Screen Recording permission, Node, or Playwright.
Keeps video, log, frame, and ZIP evidence in --output (default .build/headless-e2e).
Never connects to the user's normal Cinderdeck socket or browser profile.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import select
import shlex
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import zipfile


def wait_for(check, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.1)
    raise AssertionError("Timed out waiting for condition")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, default=Path('.build/development/Build/Products/Debug/Cinderdeck Debug.app/Contents/MacOS/Cinderdeck'))
    parser.add_argument('--playwright', type=Path, help='Optional installed playwright package directory to verify a real driver task')
    parser.add_argument('--stress-seconds', type=int, default=2, help='1080p animation duration, 2–300 seconds (default 2)')
    parser.add_argument('--output', type=Path, default=Path('.build/headless-e2e'))
    args = parser.parse_args()
    if not 2 <= args.stress_seconds <= 300:
        parser.error('--stress-seconds must be between 2 and 300')
    binary = str(args.binary.resolve())
    root = args.output.resolve() / str(int(time.time()))
    root.mkdir(parents=True)
    (root / 'stacks').mkdir()
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    server = root / 'server.py'
    server.write_text('''from http.server import HTTPServer, BaseHTTPRequestHandler
import sys
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  if self.path.startswith('/failure'):
   self.send_response(503); self.end_headers(); self.wfile.write(b'expected fixture failure'); return
  if self.path == '/favicon.ico':
   self.send_response(204); self.end_headers(); return
  self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers()
  self.wfile.write(b"""<!doctype html><title>Headless recording proof</title>
  <style>body{font:28px system-ui;padding:60px;background:#102938;color:#fff}button{padding:16px;font-size:24px}#receipt{color:#93e4b1}</style>
  <h1>Cinderdeck headless recording</h1><p id='receipt' data-testid='receipt'>Ready for checkout</p>
  <button id='pay' data-testid='pay' onclick="document.getElementById('receipt').textContent='Receipt confirmed';console.log('receipt-confirmed');fetch('/failure?secret=not-in-network-log')">Pay</button>
  <script>console.log('fixture-loaded')</script>""")
 def log_message(self, fmt, *args): print('fixture-server ' + (fmt % args), flush=True)
HTTPServer(('127.0.0.1', int(sys.argv[1])), Handler).serve_forever()
''')
    python = sys.executable
    (root / 'stacks' / 'fixture.toml').write_text(f'''name = "Browser fixture"
root = {json.dumps(str(root))}
shell = "/bin/sh"
[services.web]
cmd = {json.dumps(shlex.join([python, '-u', str(server), str(port)]))}
port = {port}
ready.port = {port}
restart = "no"
[tasks.check]
cmd = "test -n \\"$CINDERDECK_BROWSER_ENDPOINT\\" && test -n \\"$CINDERDECK_BROWSER_PAGE_ID\\" && echo browser-task-connected && sleep 1"
''')
    if args.playwright:
        driver = root / 'driver.mjs'
        # Exercise the shipped recipe, adapting only its dependency and fixture text.
        recipes = Path(__file__).resolve().parent.parent / 'skills/cinderdeck-record-session/references/browser-recipes.md'
        recipe = recipes.read_text().split('## Headless Playwright task with video and synchronized logs', 1)[1].split('```js\n', 1)[1].split('```', 1)[0]
        recipe = recipe.replace("from 'playwright'", 'from ' + json.dumps(str(args.playwright.resolve() / 'index.mjs')))
        recipe = recipe.replace("getByText('Receipt'", "getByText('Receipt confirmed'")
        driver.write_text(recipe)
        with (root / 'stacks' / 'fixture.toml').open('a') as config:
            config.write('\n[tasks.playwright]\ncmd = ' + json.dumps(shlex.join(['node', str(driver)])) + '\n')
    env = dict(os.environ, CINDERDECK_STACKS_PREVIEW_ROOT=str(root), CINDERDECK_STACKS_SOCKET=f'/tmp/cinderdeck-browser-test-{os.getpid()}.sock')

    def cli(*arguments, expected=0, timeout=120):
        result = subprocess.run([binary, *arguments, '--json', '--as', 'Browser E2E', '--session', 'headless-e2e'], env=env, text=True, capture_output=True, timeout=timeout)
        assert result.returncode == expected, (arguments, result.returncode, result.stdout, result.stderr)
        return json.loads(result.stdout if expected == 0 else result.stderr)

    def tool(name, arguments=None):
        return cli('call', name, '--arguments', json.dumps(arguments or {}))

    evidence = []
    mcp = external = launcher = None
    pid = None
    with (root / 'app.log').open('w') as log:
        try:
            launcher = subprocess.Popen([binary], env=env, stdout=log, stderr=log)
            wait_for(lambda: Path(env['CINDERDECK_STACKS_SOCKET']).exists())
            pid = int(cli('services', 'ping')['pid'])
            assert pid == launcher.pid, 'Refusing to test a different app instance'
            cli('services', 'start', 'fixture')
            cli('repro', 'start', '--headless', url, '--workspace', 'fixture', '--title', 'Headless checkout proof', '--max', '40')
            status = cli('repro', 'status')
            endpoint = status['browser']['endpoint']
            busy = cli('repro', 'start', '--headless', 'about:blank', expected=1)
            assert busy['error']['code'] == 'busy'
            assert cli('repro', 'status')['active']['repro'] == status['active']['repro']
            def read_title():
                value = cli('repro', 'browser', '--evaluate', 'document.title', '--no-screenshot')['result']
                return value == 'Headless recording proof'
            wait_for(read_title)
            live = cli('repro', 'browser', '--out', str(root / 'before.jpg'))
            assert live['page']['title'] == 'Headless recording proof'
            # Execute the skill's actual bounded-wait example against delayed UI.
            guide = Path(__file__).resolve().parent.parent / 'skills/cinderdeck-record-session/references/headless.md'
            readiness = guide.read_text().split('```js\n', 1)[1].split('```', 1)[0]
            cli('repro', 'browser', '--evaluate', "setTimeout(() => document.querySelector('#receipt').textContent = 'Confirmed', 200)", '--no-screenshot')
            ready = cli('repro', 'browser', '--evaluate', readiness, '--no-screenshot')
            assert ready['result']['confirmed'] is True and not ready['frames'], ready
            print('PASS skill readiness recipe waits for delayed UI without screenshots', flush=True)
            cli('repro', 'pause')
            cli('repro', 'browser', '--evaluate', "document.querySelector('#receipt').textContent = 'Changed while paused'; console.log('paused-console-context')", '--no-screenshot')
            time.sleep(0.6)
            cli('repro', 'resume')
            time.sleep(0.2)
            cli('repro', 'mark', 'Resumed page')
            time.sleep(0.2)
            cli('repro', 'mark', 'Click Pay')
            cli('repro', 'browser', '--evaluate', "document.querySelector('#pay').click()", '--out', str(root / 'after.jpg'))
            time.sleep(0.7)
            assert cli('repro', 'browser', '--evaluate', "document.querySelector('#receipt').textContent", '--no-screenshot')['result'] == 'Receipt confirmed'
            cli('repro', 'mark', 'Receipt confirmed', '--pass')
            saved = cli('repro', 'stop')
            assert saved['status'] == 'ready' and saved['verdict'] == 'errors', saved
            assert Path(saved['video']).stat().st_size > 1000
            text = Path(saved['logFile']).read_text()
            assert all(term in text for term in ['fixture-server', 'receipt-confirmed', 'HTTP 503', 'Receipt confirmed']), text
            logs = cli('repro', 'logs', saved['repro'])['lines']
            assert any(line.get('offscreen') and 'paused-console-context' in line['text'] for line in logs)
            assert all('not-in-network-log' not in line['text'] for line in logs if line['source'] == 'network')
            cli('repro', 'frame', saved['repro'], '--at', 'marker:Resumed page', '--out', str(root / 'after-resume.jpg'))
            cli('repro', 'frame', saved['repro'], '--at', 'end', '--out', str(root / 'recorded-end.jpg'))
            export = cli('repro', 'export', saved['repro'], '--zip', '--dest', str(root / 'exports'))
            with zipfile.ZipFile(export['path']) as archive:
                assert any(name.endswith('recording.mp4') for name in archive.namelist())
                assert any(name.endswith('recording.log') for name in archive.namelist())
            try:
                urllib.request.urlopen(endpoint + '/json/list', timeout=2)
                raise AssertionError('Owned browser still running after stop')
            except OSError:
                pass
            evidence.append(saved)
            print('PASS CLI capture, scoped service/browser/network logs, pause, actions, frames, export, owned cleanup', flush=True)

            mcp = subprocess.Popen([binary, 'mcp'], env=env, text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log)
            counter = 0
            def rpc(method, params):
                nonlocal counter
                counter += 1
                mcp.stdin.write(json.dumps(dict(jsonrpc='2.0', id=counter, method=method, params=params)) + '\n'); mcp.stdin.flush()
                assert select.select([mcp.stdout], [], [], 90)[0], 'MCP response timed out'
                response = json.loads(mcp.stdout.readline())
                assert 'error' not in response, response
                return response['result']
            rpc('initialize', dict(protocolVersion='2025-06-18', clientInfo=dict(name='browser-e2e', version='1')))
            def call(name, arguments=None):
                result = rpc('tools/call', dict(name=name, arguments=arguments or {}))
                assert not result.get('isError'), result
                return result['content']
            started = json.loads(call('start_repro_recording', dict(headless=url, logs=False, title='MCP headless proof', max_seconds=20))[0]['text'])
            time.sleep(1)
            content = call('repro_browser')
            assert any(block['type'] == 'image' and len(base64.b64decode(block['data'])) > 1000 for block in content)
            call('repro_browser', dict(expression="console.warn('mcp-browser-warning')", screenshot=False))
            content = call('stop_repro_recording', dict(repro=started['repro']))
            saved_mcp = json.loads(content[0]['text'])
            assert saved_mcp['status'] == 'ready' and saved_mcp['workspaces'] == []
            assert 'mcp-browser-warning' in Path(saved_mcp['logFile']).read_text()
            assert any(block['type'] == 'image' for block in call('repro_frame', dict(repro=saved_mcp['repro'], at='end')))
            evidence.append(saved_mcp)
            print('PASS MCP launch, automatic logs with workspace scope off, live and saved image content', flush=True)

            run = cli('repro', 'run', 'fixture', 'check', '--headless', 'about:blank', '--wait', '--max', '20')
            assert run['status'] == 'ready' and run['verdict'] == 'clean', run
            assert 'browser-task-connected' in Path(run['logFile']).read_text()
            evidence.append(run)
            print('PASS headless task run with transient browser endpoint/page environment and automatic stop', flush=True)

            if args.playwright:
                driven = cli('repro', 'run', 'fixture', 'playwright', '--headless', 'about:blank', '--wait', '--max', '30')
                assert driven['status'] == 'ready' and driven['verdict'] == 'errors', driven
                assert 'Receipt is visible' in Path(driven['logFile']).read_text()
                assert not any(marker.get('outcome') == 'fail' for marker in driven['markers'])
                cli('repro', 'frame', driven['repro'], '--at', 'end', '--out', str(root / 'playwright-end.jpg'))
                evidence.append(driven)
                print('PASS real Playwright task drives the existing page and disconnects without closing it', flush=True)

            # Attach to a separately owned browser, then verify stop/cancel leave it open.
            profile = root / 'external-profile'
            external = subprocess.Popen(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', '--remote-debugging-port=0', f'--user-data-dir={profile}', '--no-first-run', url], stdout=log, stderr=log)
            active_port = profile / 'DevToolsActivePort'
            wait_for(active_port.exists)
            external_endpoint = 'http://127.0.0.1:' + active_port.read_text().splitlines()[0]
            with urllib.request.urlopen(external_endpoint + '/json/list') as response:
                page_id = next(page['id'] for page in json.load(response) if page['type'] == 'page')
            urllib.request.urlopen(urllib.request.Request(external_endpoint + '/json/new?about:blank', method='PUT')).close()
            ambiguous = cli('repro', 'start', '--cdp', external_endpoint, expected=1)
            assert 'several pages' in ambiguous['error']['message']
            attached = cli('repro', 'start', '--cdp', external_endpoint, '--page-id', page_id, '--no-logs', '--title', 'Attached browser proof', '--max', '20')
            time.sleep(0.7)
            saved_attached = cli('repro', 'stop')
            assert saved_attached['status'] == 'ready' and external.poll() is None
            evidence.append(saved_attached)
            discarded = cli('repro', 'start', '--cdp', external_endpoint, '--page-id', page_id, '--no-logs', '--max', '20')
            cli('repro', 'cancel')
            assert not Path(discarded['folder']).exists() and external.poll() is None
            disconnected = cli('repro', 'start', '--cdp', external_endpoint, '--page-id', page_id, '--no-logs', '--max', '20')
            external.terminate(); external.wait(timeout=10); external = None
            wait_for(lambda: not cli('repro', 'status')['recording'])
            failed = cli('repro', 'show', disconnected['repro'])
            assert failed['verdict'] == 'failed' and Path(failed['video']).exists(), failed
            evidence.append(failed)
            print('PASS attached browser preservation, cancellation, disconnect autosave with failure verdict', flush=True)

            action_failure = cli('repro', 'start', '--headless', 'about:blank', '--no-logs')
            cli('repro', 'browser', '--evaluate', "throw new Error('fixture-action-failure')", '--no-screenshot', expected=1)
            # The generic tool CLI returns the failed verdict without interpreting it as its own exit status.
            failed_action = tool('stop_repro_recording')
            assert failed_action['verdict'] == 'failed' and 'fixture-action-failure' in Path(failed_action['logFile']).read_text()
            discarded_owned = cli('repro', 'start', '--headless', 'about:blank', '--no-logs')
            cli('repro', 'cancel')
            assert not Path(discarded_owned['folder']).exists()
            print('PASS action failures produce failed checks; owned cancellation removes artifacts', flush=True)

            stress = cli('repro', 'start', '--headless', 'about:blank', '--no-logs', '--width', '1920', '--height', '1080', '--max', str(args.stress_seconds + 15))
            rss_before = int(subprocess.check_output(['ps', '-p', str(pid), '-o', 'rss='], text=True).strip())
            animation = """new Promise(resolve => {
              const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
              document.body.replaceChildren(canvas); const ctx = canvas.getContext('2d');
              const end = performance.now() + BURST_MS; let frames = 0;
              function draw() {
                ctx.fillStyle = `hsl(${frames * 7 % 360} 60% 35%)`; ctx.fillRect(0, 0, 1920, 1080);
                ctx.fillStyle = 'white'; ctx.font = '72px sans-serif'; ctx.fillText('Headless frame ' + ++frames, 80, 150);
                if (performance.now() < end) requestAnimationFrame(draw);
                else { document.body.innerHTML = '<h1>Animation completed</h1>'; resolve(frames); }
              } draw();
            })"""
            animated = 0
            samples = []
            elapsed = 0
            while elapsed < args.stress_seconds:
                # Each Promise stays below the browser tool's ten-second deadline.
                seconds = min(4, args.stress_seconds - elapsed)
                animated += cli('repro', 'browser', '--evaluate', animation.replace('BURST_MS', str(seconds * 1000)), '--no-screenshot')['result']
                elapsed += seconds
                samples.append(dict(animationSeconds=elapsed, appRSSKB=int(subprocess.check_output(['ps', '-p', str(pid), '-o', 'rss='], text=True).strip())))
            time.sleep(0.2)
            rss_after = int(subprocess.check_output(['ps', '-p', str(pid), '-o', 'rss='], text=True).strip())
            stressed = cli('repro', 'stop')
            assert stressed['status'] == 'ready' and animated > 10
            size = Path(stressed['video']).stat().st_size
            assert 1000 < size < args.stress_seconds * 5_000_000, size
            cli('repro', 'frame', stressed['repro'], '--at', 'end', '--out', str(root / 'animation-end.jpg'))
            evidence.append(stressed)
            (root / 'performance.json').write_text(json.dumps(dict(renderedFrames=animated, duration=stressed['duration'], videoBytes=size, appRSSBeforeKB=rss_before, appRSSAfterKB=rss_after, samples=samples), indent=2))
            print(f'PASS 1080p animated capture: {animated} rendered frames, {size} video bytes, app RSS change {rss_after-rss_before} KB', flush=True)

            automatic = cli('repro', 'start', '--headless', 'about:blank', '--no-logs', '--max', '3')
            wait_for(lambda: not cli('repro', 'status')['recording'])
            timed = cli('repro', 'show', automatic['repro'])
            assert timed['status'] == 'ready' and any(m['label'] == 'Time limit reached' for m in timed['markers'])
            cli('repro', 'start', '--headless', 'about:blank', '--browser-executable', '/missing/chrome', expected=1)
            assert not cli('repro', 'status')['recording']
            print('PASS automatic duration limit and recovery after missing-browser error', flush=True)
            (root / 'evidence.json').write_text(json.dumps(evidence, indent=2))
            print(f'Evidence: {root}', flush=True)
        finally:
            if mcp:
                mcp.terminate(); mcp.wait(timeout=10)
            if external:
                external.terminate(); external.wait(timeout=10)
            if pid:
                try:
                    if cli('repro', 'status')['recording']: cli('repro', 'cancel')
                    cli('services', 'stop', 'fixture', '--force')
                finally:
                    try: os.kill(pid, signal.SIGTERM)
                    except ProcessLookupError: pass
            if launcher:
                try: launcher.wait(timeout=10)
                except subprocess.TimeoutExpired: launcher.kill(); launcher.wait(timeout=10)
            Path(env['CINDERDECK_STACKS_SOCKET']).unlink(missing_ok=True)


if __name__ == '__main__':
    main()
