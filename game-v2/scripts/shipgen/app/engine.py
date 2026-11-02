# The engine (scripts/shipgen/engine/main.ts) as a child process: JSON lines over its stdin/stdout. Calls get a callback
# with (result, error); everything else it sends (run and watch events, their ends, the renderer's state) comes out of
# the `message` signal. Closing asks it to quit (it stops any run and the renderer it started), then kills it if it hangs.
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Callable

from PySide6.QtCore import QObject, QProcess, QProcessEnvironment, Signal

ROOT = Path(__file__).resolve().parents[3]  # game-v2
MAIN = ROOT / 'scripts' / 'shipgen' / 'engine' / 'main.ts'
# (tsx, the TypeScript loader, from any of the game's packages that has it)
LOADERS = [ROOT / d / 'node_modules' / 'tsx' / 'dist' / 'loader.mjs' for d in ('server', 'client', 'server-browser', 'site', 'common', '.')]


def real_pythonw() -> str | None:
    """A pythonw that is a real install, for the renderer's GL worker: this one if it is, else the first on PATH (the
    Store's WindowsApps aliases can't be started from inside another process's package)"""
    here = Path(sys.executable).with_name('pythonw.exe')
    if here.exists() and 'WindowsApps' not in str(here):
        return str(here)
    for d in os.environ.get('PATH', '').split(os.pathsep):
        if 'WindowsApps' in d:
            continue
        p = shutil.which('pythonw', path=d)
        if p:
            return p
    return None


class Engine(QObject):
    message = Signal(dict)
    died = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.proc = QProcess(self)
        self.pending: dict[int, Callable] = {}
        self.rid = 0
        self.buf = b''
        self.err_tail: list[str] = []
        self.closing = False
        self.proc.readyReadStandardOutput.connect(self._read)
        self.proc.readyReadStandardError.connect(self._read_err)
        self.proc.finished.connect(self._finished)

    def start(self) -> str | None:
        """Starts the engine; an error in words when it can't"""
        node = shutil.which('node')
        if not node:
            return 'Node.js is not on PATH: the engine needs it'
        loader = next((p for p in LOADERS if p.exists()), None)
        if not loader:
            return 'tsx is not installed in any of the game\'s packages (run npm install in server/)'
        env = QProcessEnvironment.systemEnvironment()
        env.insert('LMSTUDIO_CHAT', '1')
        env.insert('NODE_NO_WARNINGS', '1')
        py = real_pythonw()
        if py:
            env.insert('PYTHON', py)
        self.proc.setProcessEnvironment(env)
        self.proc.setWorkingDirectory(str(ROOT))
        self.proc.start(node, ['--import', loader.as_uri(), str(MAIN)])
        if not self.proc.waitForStarted(10000):
            return f'the engine did not start: {self.proc.errorString()}'
        return None

    def call(self, cmd: str, args: dict | None = None, cb: Callable | None = None) -> None:
        self.rid += 1
        if cb:
            self.pending[self.rid] = cb
        line = json.dumps({'rid': self.rid, 'cmd': cmd, 'args': args or {}}) + '\n'
        self.proc.write(line.encode('utf-8'))

    def _read(self) -> None:
        self.buf += bytes(self.proc.readAllStandardOutput())
        while b'\n' in self.buf:
            line, self.buf = self.buf.split(b'\n', 1)
            if not line.strip():
                continue
            try:
                m = json.loads(line)
            except ValueError:
                continue
            rid = m.get('rid')
            if rid is not None and 'ok' in m:
                cb = self.pending.pop(rid, None)
                if cb:
                    cb(m.get('result'), None if m['ok'] else m.get('error', 'failed'))
            else:
                self.message.emit(m)

    def _read_err(self) -> None:
        text = bytes(self.proc.readAllStandardError()).decode('utf-8', 'replace')
        for ln in text.splitlines():
            if ln.strip():
                self.err_tail = (self.err_tail + [ln])[-40:]

    def _finished(self, code, _status) -> None:
        if not self.closing:
            self.died.emit(f'the engine stopped (exit {code}): ' + ' | '.join(self.err_tail[-4:]))

    def close(self) -> None:
        """Asks the engine to quit (it stops the run and the renderer it started); kills it after 15 s"""
        if self.proc.state() == QProcess.NotRunning:
            return
        self.closing = True
        self.call('quit')
        self.proc.closeWriteChannel()
        if not self.proc.waitForFinished(15000):
            subprocess.run(['taskkill', '/PID', str(self.proc.processId()), '/T', '/F'], capture_output=True,
                           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            self.proc.waitForFinished(3000)
