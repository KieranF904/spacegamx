# Shipgen as a desktop app: the page (scripts/shipgen/ui) in its own window (pywebview, Edge WebView2), with the page
# server started behind it when it isn't running already, and stopped again when the window closes (only if this
# started it). LM Studio may chat (LMSTUDIO_CHAT=1). Run with pythonw for no console:
#   pythonw scripts/shipgen/desktop/shipgen_app.pyw        (needs: pip install pywebview)
# The server's output goes to scripts/shipgen/out/server.log.
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import webview

PORT = int(os.environ.get('SHIPGEN_PORT', '5320'))
URL = f'http://127.0.0.1:{PORT}/'
ROOT = Path(__file__).resolve().parents[3]  # game-v2
LOG = ROOT / 'scripts' / 'shipgen' / 'out' / 'server.log'


def up() -> bool:
    try:
        with urllib.request.urlopen(URL + 'api/roles', timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def real_pythonw() -> str | None:
    """The first pythonw on PATH that is a real install: the Store's WindowsApps aliases can't be started from inside a
    Store Python process (spawn EPERM), and the renderer starts one for its GL worker"""
    for d in os.environ.get('PATH', '').split(os.pathsep):
        if 'WindowsApps' in d:
            continue
        p = shutil.which('pythonw', path=d)
        if p:
            return p
    return None


def start_server() -> subprocess.Popen:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, 'LMSTUDIO_CHAT': '1'}
    py = real_pythonw()
    if py:
        env['PYTHON'] = py
    log = open(LOG, 'a', encoding='utf-8')
    log.write(f'\n--- {time.strftime("%Y-%m-%d %H:%M:%S")} started by the desktop app ---\n')
    log.flush()
    # (npx is a .cmd on Windows: through the shell, no console window)
    return subprocess.Popen(f'npx tsx scripts/shipgen/server.ts --port {PORT}', cwd=ROOT, env=env, shell=True,
                            stdout=log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)


def stop_server(p: subprocess.Popen) -> None:
    # (The whole tree: cmd, npx, tsx and node; nothing else is touched)
    subprocess.run(['taskkill', '/PID', str(p.pid), '/T', '/F'], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)


def main() -> None:
    server = None
    if not up():
        server = start_server()
        for _ in range(120):
            if up() or server.poll() is not None:
                break
            time.sleep(0.5)
    if not up():
        if server:
            stop_server(server)
        webview.create_window('Shipgen', html=f'<body style="background:#0b0e12;color:#cfd8e1;font:14px system-ui;padding:24px">'
                              f'<h3>The shipgen server did not start.</h3><p>See {LOG}</p></body>', width=700, height=240)
        webview.start()
        sys.exit(1)
    webview.create_window('Shipgen', URL, width=1600, height=1000, min_size=(900, 600), background_color='#0b0e12')
    try:
        webview.start(private_mode=False)
    finally:
        if server:
            stop_server(server)


if __name__ == '__main__':
    main()
