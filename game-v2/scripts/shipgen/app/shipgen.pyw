# Shipgen: the ship generator as a desktop app. The window is Python (Qt); the generator's engine (the TypeScript loop on
# the game's own ship code) runs as its child process, and the renderer starts with it and stops with it.
#   pythonw scripts/shipgen/app/shipgen.pyw        (needs: pip install PySide6; Node.js on PATH)
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from PySide6.QtCore import QTimer  # noqa: E402
from PySide6.QtWidgets import QApplication, QMessageBox  # noqa: E402

from engine import Engine  # noqa: E402
from window import MainWindow  # noqa: E402


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName('Shipgen')
    engine = Engine()
    err = engine.start()
    if err:
        QMessageBox.critical(None, 'Shipgen', err)
        return 1
    w = MainWindow(engine)
    geo = w.prefs.value('geometry')
    if geo:
        w.restoreGeometry(geo)
    else:
        w.resize(1600, 1000)
    w.show()
    w.boot()
    # (SHIPGEN_SHOT=<file>: a picture of the window after a few seconds, for checking a change without a person looking)
    shot = os.environ.get('SHIPGEN_SHOT')
    if shot:
        QTimer.singleShot(int(os.environ.get('SHIPGEN_SHOT_MS', '9000')), lambda: w.grab().save(shot))
    code = app.exec()
    engine.close()
    return code


if __name__ == '__main__':
    sys.exit(main())
