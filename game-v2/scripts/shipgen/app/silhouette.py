# A quick symmetrical silhouette designer: click cells on a grid to paint them in a palette colour (whole cells or
# triangles), the other half mirrors itself. Left button paints (drag to sweep), right button erases. Save and open
# as JSON, export a PNG, or copy the row widths (nose to tail) as a concept outline.
# Commands (what a model can write) build on coloured placement points, out from the centre line, mirrored:
#   Block[gray,0,4,2]   a white block 4 wide and 2 high from the gray point (o: cells out from it, then w out, h down)
#   Triangle[purple,0]  a white triangle at the purple point, turned to sit flat against what is beside it
#   Turret[gray,4]      a cannon 4 cells out from the gray point
# Or from scratch, in grid coordinates for the right half (x=0 the centre column, y=0 the nose row; the grid becomes
# 21 x 32 and is cleared first), checked against the rules the design prompt gives:
#   Block[11,0,2,10]    a block whose top-left cell is y=11, x=0, 2 wide and 10 high
#   Turret[15,5]        a cannon at y=15, x=5
# Or a lettered ASCII grid of the right half (asciigrid.py): row numbers, then '.' empty, A B C ... parts, T turrets.
# Each part gets its own colour and the panel lists the rules broken. Copy grid writes the drawing back out in that
# format (a letter per colour), to start a prompt from; Copy pieces writes it as Block[y,x,w,h] / Turret[y,x].
# Ask a model (Ollama or LM Studio, localllm.py): write what to change and Send. The prompt (prompts/ascii/edit.txt, read
# fresh each time so it can be tuned while the window is open) carries the current grid and key; the reply, a lettered
# grid, replaces the drawing (Ctrl+Z steps back). A reply that breaks the rules goes back with the problems, up to
# Retries times. Every prompt and reply is kept in out/silhouettes/ai.
#   pythonw scripts/shipgen/app/silhouette.py   or  npm run silhouette   (the Shipgen window's Silhouette button opens it
#   as its own process too)
import json
import re
import sys
import threading
import time
from pathlib import Path

import asciigrid
import localllm
from PySide6.QtCore import QObject, QPointF, QRectF, QSettings, QSize, Qt, Signal
from PySide6.QtGui import QColor, QIcon, QKeySequence, QPainter, QPen, QPixmap, QPolygonF, QShortcut, QTextCursor
from PySide6.QtWidgets import (
    QApplication, QButtonGroup, QCheckBox, QComboBox, QDoubleSpinBox, QFileDialog, QHBoxLayout, QLabel, QMainWindow, QPlainTextEdit, QPushButton,
    QSpinBox, QTabWidget, QVBoxLayout, QWidget,
)

PALETTE = [
    ('hull', '#4f5966'), ('armour', '#8a939e'), ('light plate', '#c5ced8'), ('gun', '#e0585c'), ('power', '#ef8a4c'), ('store', '#58a9df'),
    ('engine', '#4cc59b'), ('core', '#e2c15c'), ('shield', '#c57ad0'), ('diode', '#9b8fe0'), ('cargo', '#7d6b4c'), ('dark', '#222a33'),
]
# (The names a command may give a palette colour, by index)
COLOUR_NAMES = {
    'darkgray': 0, 'darkgrey': 0, 'slate': 0, 'hull': 0, 'gray': 1, 'grey': 1, 'armour': 1, 'armor': 1, 'white': 2, 'lightgray': 2, 'lightgrey': 2,
    'red': 3, 'gun': 3, 'orange': 4, 'power': 4, 'blue': 5, 'store': 5, 'green': 6, 'engine': 6, 'yellow': 7, 'gold': 7, 'core': 7,
    'purple': 8, 'pink': 8, 'magenta': 8, 'shield': 8, 'violet': 9, 'lavender': 9, 'diode': 9, 'brown': 10, 'cargo': 10, 'black': 11, 'dark': 11,
}
WHITE, GUN = 2, 3
# (The colours an ASCII grid's parts take, A first)
PART_COLOURS = [2, 5, 6, 4, 8, 7, 9, 10, 1, 0]
# (Which sides of a cell each shape has flat: N E S W)
FLAT = {1: {'S', 'W'}, 2: {'N', 'W'}, 3: {'N', 'E'}, 4: {'E', 'S'}}

# (Shapes: 0 a whole cell; 1-4 triangles, corners as fractions of the cell, as the ship grid names them: t1 flat on S+W ... t4 flat on E+S)
TRI = {1: [(0, 0), (0, 1), (1, 1)], 2: [(0, 0), (1, 0), (0, 1)], 3: [(0, 0), (1, 0), (1, 1)], 4: [(1, 0), (1, 1), (0, 1)]}
# (Mirrored left to right a triangle becomes its twin)
MIRROR_SHAPE = {0: 0, 1: 4, 4: 1, 2: 3, 3: 2}
SHAPE_NAMES = {0: 'whole cell', 1: 'triangle, flat on the bottom and left', 2: 'triangle, flat on the top and left',
               3: 'triangle, flat on the top and right', 4: 'triangle, flat on the bottom and right'}
BG, GRID_LINE, CENTRE = QColor('#080a0d'), QColor('#161c23'), QColor('#2f5f8c')
EDIT_PROMPT = Path(__file__).resolve().parents[1] / 'prompts' / 'ascii' / 'edit.txt'
LETTERS = 'ABCDEFGHIJKLMNOPQRSUVWXYZ'


class Bridge(QObject):
    """Carries a model's reply from its thread to the window"""
    token = Signal(str, str)
    done = Signal(dict)
    failed = Signal(str)
    models = Signal(list, list)


def shape_poly(shape: int, x: float, y: float, s: float) -> QPolygonF:
    pts = TRI[shape] if shape else [(0, 0), (1, 0), (1, 1), (0, 1)]
    return QPolygonF([QPointF(x + a * s, y + b * s) for a, b in pts])


class Canvas(QWidget):
    def __init__(self, owner: 'Designer'):
        super().__init__()
        self.o = owner
        self.setMinimumSize(360, 480)
        self.setMouseTracking(True)
        self.hover: tuple[int, int] | None = None

    def geometry_of(self):
        W, H = self.o.w, self.o.h
        s = max(6, min((self.width() - 20) / W, (self.height() - 20) / H))
        return s, (self.width() - s * W) / 2, (self.height() - s * H) / 2

    def cell_at(self, pos):
        s, ox, oy = self.geometry_of()
        c, r = int((pos.x() - ox) // s), int((pos.y() - oy) // s)
        return (r, c) if 0 <= r < self.o.h and 0 <= c < self.o.w else None

    def paintEvent(self, _e):
        g = QPainter(self)
        g.setRenderHint(QPainter.Antialiasing)
        g.fillRect(self.rect(), BG)
        s, ox, oy = self.geometry_of()
        W, H = self.o.w, self.o.h
        g.setPen(QPen(GRID_LINE, 1))
        for r in range(H + 1):
            g.drawLine(QPointF(ox, oy + r * s), QPointF(ox + W * s, oy + r * s))
        for c in range(W + 1):
            g.drawLine(QPointF(ox + c * s, oy), QPointF(ox + c * s, oy + H * s))
        mid = W // 2
        g.fillRect(QRectF(ox + mid * s, oy, s, H * s), QColor(47, 95, 140, 40))
        g.setPen(QPen(CENTRE, 1, Qt.DashLine))
        g.drawLine(QPointF(ox + (mid + 0.5) * s, oy - 4), QPointF(ox + (mid + 0.5) * s, oy + H * s + 4))
        g.setPen(Qt.NoPen)
        for r in range(H):
            for c in range(W):
                cell = self.o.cells.get((r, c))
                if cell:
                    g.setBrush(QColor(PALETTE[cell[0]][1]))
                    g.drawPolygon(shape_poly(cell[1], ox + c * s, oy + r * s, s))
        for (r, c), k in self.o.comps.items():
            if k == 'turret':
                cx, cy = ox + (c + 0.5) * s, oy + (r + 0.5) * s
                g.setBrush(QColor('#0b0e12'))
                g.drawEllipse(QPointF(cx, cy), s * 0.3, s * 0.3)
                g.setBrush(QColor('#f0f3f6'))
                g.drawRect(QRectF(cx - s * 0.07, cy - s * 0.48, s * 0.14, s * 0.4))
                g.drawEllipse(QPointF(cx, cy), s * 0.16, s * 0.16)
        if self.hover and self.o.tool_ok(self.hover):
            r, c = self.hover
            g.setBrush(QColor(255, 255, 255, 70))
            g.drawPolygon(shape_poly(self.o.shape if not self.o.erasing else 0, ox + c * s, oy + r * s, s))

    def _apply(self, e):
        cell = self.cell_at(e.position())
        self.hover = cell
        if cell and (e.buttons() & (Qt.LeftButton | Qt.RightButton)):
            self.o.paint(cell, erase=bool(e.buttons() & Qt.RightButton) or self.o.erasing)
        self.update()

    def mousePressEvent(self, e):
        self.o.push_undo()
        self._apply(e)

    def mouseMoveEvent(self, e):
        self._apply(e)

    def leaveEvent(self, _e):
        self.hover = None
        self.update()


class Designer(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle('Silhouette designer')
        self.w, self.h = 15, 24
        self.cells: dict[tuple[int, int], tuple[int, int]] = {}
        # (Components on cells: 'turret')
        self.comps: dict[tuple[int, int], str] = {}
        self.colour = 0
        self.shape = 0
        self.erasing = False
        self.mirror = True
        self.undo: list[dict] = []
        # (Part letters, kept across model edits so a part keeps its colour: letter -> (palette index, name))
        self.legend: dict[str, tuple[int, str]] = {}
        self.models: list[dict] = []
        self.busy = False
        self.stop_flag = False
        self.prefs = QSettings('shipgen', 'silhouette')
        self.bridge = Bridge()
        self.bridge.token.connect(self.on_token)
        self.bridge.done.connect(self.on_reply)
        self.bridge.failed.connect(self.on_fail)
        self.bridge.models.connect(self.on_models)
        self.canvas = Canvas(self)
        self.dir = Path(__file__).resolve().parents[1] / 'out' / 'silhouettes'
        self.setStyleSheet("""
            * { font-family: 'Segoe UI'; font-size: 13px; }
            QMainWindow, QWidget { background: #0b0e12; color: #cfd8e1; }
            QPushButton { background: #171d24; border: 1px solid #232c36; border-radius: 4px; padding: 5px 10px; }
            QPushButton:hover { border-color: #6cb8ff; }
            QPushButton:checked { border: 2px solid #ffffff; }
            QSpinBox { background: #0e1217; border: 1px solid #232c36; border-radius: 4px; padding: 3px; }
            QLabel#small { color: #7c8896; font-size: 11px; }
        """)
        root = QWidget()
        lay = QHBoxLayout(root)
        lay.addWidget(self.canvas, 1)
        side = QVBoxLayout()
        lay.addLayout(side)
        side.addWidget(QLabel('Colour'))
        self.swatches = QButtonGroup(self)
        row = None
        for i, (name, hexa) in enumerate(PALETTE):
            if i % 4 == 0:
                row = QHBoxLayout()
                side.addLayout(row)
            b = QPushButton()
            b.setCheckable(True)
            b.setFixedSize(46, 34)
            b.setToolTip(name)
            b.setStyleSheet(f'QPushButton {{ background: {hexa}; border: 1px solid #232c36; }} QPushButton:checked {{ border: 3px solid #ffffff; }}')
            self.swatches.addButton(b, i)
            row.addWidget(b)
        self.swatches.button(0).setChecked(True)
        self.swatches.idClicked.connect(self.pick_colour)
        side.addWidget(QLabel('Shape'))
        self.shapes = QButtonGroup(self)
        row = QHBoxLayout()
        side.addLayout(row)
        for i in range(5):
            b = QPushButton()
            b.setCheckable(True)
            b.setFixedSize(46, 46)
            b.setToolTip(SHAPE_NAMES[i])
            b.setIcon(self.shape_icon(i))
            b.setIconSize(QSize(30, 30))
            self.shapes.addButton(b, i)
            row.addWidget(b)
        self.shapes.button(0).setChecked(True)
        self.shapes.idClicked.connect(self.pick_shape)
        self.eraser = QPushButton('Eraser')
        self.eraser.setCheckable(True)
        self.eraser.setToolTip('Or right-click a cell to erase it')
        self.eraser.toggled.connect(lambda on: setattr(self, 'erasing', on))
        side.addWidget(self.eraser)
        self.mirror_box = QCheckBox('Mirror left to right')
        self.mirror_box.setChecked(True)
        self.mirror_box.toggled.connect(lambda on: setattr(self, 'mirror', on))
        side.addWidget(self.mirror_box)
        size = QHBoxLayout()
        size.addWidget(QLabel('Width'))
        self.sw = QSpinBox()
        self.sw.setRange(5, 41)
        self.sw.setSingleStep(2)
        self.sw.setValue(self.w)
        self.sw.setToolTip('Odd: the middle column is the centre line')
        self.sw.editingFinished.connect(self.resize_grid)
        size.addWidget(self.sw)
        size.addWidget(QLabel('Rows'))
        self.sh = QSpinBox()
        self.sh.setRange(4, 60)
        self.sh.setValue(self.h)
        self.sh.editingFinished.connect(self.resize_grid)
        size.addWidget(self.sh)
        side.addLayout(size)
        for text, fn in [('Undo  (Ctrl+Z)', self.do_undo), ('Clear', self.clear), ('Flip top to bottom', self.flip_v), ('Save...', self.save), ('Open...', self.open),
                         ('Export PNG...', self.export_png), ('Copy row widths', self.copy_widths), ('Copy grid', self.copy_grid), ('Copy pieces', self.copy_pieces)]:
            b = QPushButton(text)
            b.clicked.connect(fn)
            side.addWidget(b)
        side.addWidget(QLabel('Commands (one per line)'))
        self.cmds = QPlainTextEdit()
        self.cmds.setPlaceholderText('Paste a lettered grid (right half):\n 6   A  A  .  .\n 7   A  B  B  .\n 8   T  B  .  .\n\nOr from scratch (y,x; x=0 centre):\nBlock[11,0,2,10]\nTurret[15,5]\n\nOr from coloured points:\nBlock[gray,0,4,2]\nTurret[gray,4]')
        self.cmds.setMaximumHeight(120)
        self.cmds.setStyleSheet('background:#0e1217;border:1px solid #232c36;border-radius:4px;font-family:Consolas;')
        side.addWidget(self.cmds)
        apply = QPushButton('Apply commands')
        apply.clicked.connect(lambda: self.apply_commands(self.cmds.toPlainText()))
        side.addWidget(apply)
        self.info = QLabel('', objectName='small')
        self.info.setWordWrap(True)
        self.info.setMinimumWidth(190)
        side.addWidget(self.info)
        side.addStretch(1)
        lay.addLayout(self.ai_panel())
        self.setCentralWidget(root)
        QShortcut(QKeySequence.Undo, self, activated=self.do_undo)
        QShortcut(QKeySequence('Ctrl+Return'), self, activated=self.ask)
        self.resize(1320, 820)
        self.refresh_models()
        self.update_info('Left-click paints, drag to sweep, right-click erases. The nose is at the top.')

    # ---- asking a model
    def ai_panel(self) -> QVBoxLayout:
        col = QVBoxLayout()
        col.addWidget(QLabel('Ask a model'))
        row = QHBoxLayout()
        self.model_box = QComboBox()
        self.model_box.setMinimumWidth(300)
        self.model_box.currentIndexChanged.connect(lambda _i: self.prefs.setValue('model', self.model_box.currentData() or ''))
        row.addWidget(self.model_box, 1)
        again = QPushButton('Refresh')
        again.setToolTip('List the models on Ollama and LM Studio again (listing never loads one)')
        again.clicked.connect(self.refresh_models)
        row.addWidget(again)
        col.addLayout(row)
        self.instruction = QPlainTextEdit()
        self.instruction.setPlaceholderText('What to change, e.g.\nMake the wings swept back and 2 rows thinner.\nAdd two tail fins at the back of the hull.\n\nOn an empty grid: describe a ship to draw.')
        self.instruction.setMaximumHeight(130)
        self.instruction.setStyleSheet('background:#0e1217;border:1px solid #232c36;border-radius:4px;')
        col.addWidget(self.instruction)
        opts = QHBoxLayout()
        opts.addWidget(QLabel('Temperature'))
        self.temp = QDoubleSpinBox()
        self.temp.setRange(0, 2)
        self.temp.setSingleStep(0.1)
        self.temp.setValue(float(self.prefs.value('temperature', 0.3)))
        opts.addWidget(self.temp)
        opts.addWidget(QLabel('Retries'))
        self.retries = QSpinBox()
        self.retries.setRange(0, 5)
        self.retries.setValue(int(self.prefs.value('retries', 2)))
        self.retries.setToolTip('A reply that breaks a rule goes back with the problems, this many times at most')
        opts.addWidget(self.retries)
        self.think = QCheckBox('Let it think')
        self.think.setToolTip('Reasoning models: think before answering (slower)')
        opts.addWidget(self.think)
        opts.addStretch(1)
        col.addLayout(opts)
        btns = QHBoxLayout()
        self.send = QPushButton('Send  (Ctrl+Enter)')
        self.send.clicked.connect(self.ask)
        btns.addWidget(self.send)
        self.stop_btn = QPushButton('Stop')
        self.stop_btn.setEnabled(False)
        self.stop_btn.clicked.connect(lambda: setattr(self, 'stop_flag', True))
        btns.addWidget(self.stop_btn)
        col.addLayout(btns)
        self.ai_status = QLabel('', objectName='small')
        self.ai_status.setWordWrap(True)
        col.addWidget(self.ai_status)
        self.talk = QTabWidget()
        self.reply_view, self.prompt_view = QPlainTextEdit(), QPlainTextEdit()
        for v, name in ((self.reply_view, 'Reply'), (self.prompt_view, 'Prompt')):
            v.setReadOnly(True)
            v.setStyleSheet('background:#0e1217;border:1px solid #232c36;font-family:Consolas;font-size:12px;')
            self.talk.addTab(v, name)
        col.addWidget(self.talk, 1)
        return col

    def refresh_models(self) -> None:
        self.ai_status.setText('Listing models...')
        threading.Thread(target=lambda: self.bridge.models.emit(*localllm.list_models()), daemon=True).start()

    def on_models(self, models: list, notes: list) -> None:
        self.models = models
        want = self.model_box.currentData() or self.prefs.value('model', '')
        self.model_box.blockSignals(True)
        self.model_box.clear()
        for m in models:
            self.model_box.addItem(m['label'], m['id'])
        i = self.model_box.findData(want)
        self.model_box.setCurrentIndex(max(i, 0))
        self.model_box.blockSignals(False)
        self.ai_status.setText(f'{len(models)} models.' + (' ' + ' '.join(notes) if notes else ''))

    def build_prompt(self, instruction: str) -> str:
        parts, turrets, names = self.half_grid()
        key = '\n'.join(f'{sym} = {n}' for sym, n in names.items()) or '(no parts yet)'
        fill = {'key': key, 'grid': asciigrid.render(parts, turrets), 'instruction': instruction.strip(),
                'last_col': str(len(parts[0]) - 1), 'last_row': str(len(parts) - 1)}
        text = EDIT_PROMPT.read_text(encoding='utf-8')
        for k, v in fill.items():
            text = text.replace('{{' + k + '}}', v)
        return text

    def ask(self) -> None:
        if self.busy:
            return
        model = next((m for m in self.models if m['id'] == self.model_box.currentData()), None)
        if not model:
            self.ai_status.setText('No model chosen. Start Ollama or LM Studio, then Refresh.')
            return
        if not self.instruction.toPlainText().strip():
            self.ai_status.setText('Write what to change first.')
            return
        self.prefs.setValue('temperature', self.temp.value())
        self.prefs.setValue('retries', self.retries.value())
        prompt = self.build_prompt(self.instruction.toPlainText())
        self.job = {'model': model, 'messages': [{'role': 'user', 'content': prompt}], 'attempt': 1,
                    'size': (self.w - self.w // 2, self.h), 'stamp': time.strftime('%Y%m%d-%H%M%S')}
        self.prompt_view.setPlainText(prompt)
        self.run_job()

    def run_job(self) -> None:
        j = self.job
        self.busy, self.stop_flag = True, False
        self.send.setEnabled(False)
        self.stop_btn.setEnabled(True)
        self.reply_view.clear()
        self.talk.setCurrentWidget(self.reply_view)
        j.update(t0=time.time(), chars=0, thinking=0)
        self.save_log(f'{j["attempt"]}-prompt', j['messages'][-1]['content'])
        temp = self.temp.value() + 0.1 * (j['attempt'] - 1)
        think = self.think.isChecked()

        def go():
            try:
                out = localllm.chat(j['model'], j['messages'], lambda d, k: self.bridge.token.emit(d, k), lambda: self.stop_flag, temperature=temp, think=think)
                self.bridge.done.emit(out)
            except localllm.Stopped:
                self.bridge.failed.emit('Stopped.')
            except Exception as e:
                self.bridge.failed.emit(f'{type(e).__name__}: {e}')
        threading.Thread(target=go, daemon=True).start()
        self.ai_status.setText(f'Asking {j["model"]["name"]} (try {j["attempt"]})... a model that is not loaded yet takes a while to start.')

    def on_token(self, d: str, kind: str) -> None:
        j = self.job
        if kind == 'content':
            j['chars'] += len(d)
            self.reply_view.moveCursor(QTextCursor.End)
            self.reply_view.insertPlainText(d)
        else:
            j['thinking'] += len(d)
        secs = time.time() - j['t0']
        self.ai_status.setText(f'{j["model"]["name"]}, try {j["attempt"]}: {secs:.0f} s, {j["chars"]} characters'
                               + (f', thinking {j["thinking"]} characters' if j['thinking'] else ''))

    def on_fail(self, why: str) -> None:
        self.end_job()
        self.ai_status.setText(why)

    def end_job(self) -> None:
        self.busy = False
        self.send.setEnabled(True)
        self.stop_btn.setEnabled(False)

    def on_reply(self, out: dict) -> None:
        j = self.job
        text = out['text']
        self.save_log(f'{j["attempt"]}-reply', text + (f'\n\n--- thinking ---\n{out["thinking"]}' if out['thinking'] else ''))
        secs = time.time() - j['t0']
        speed = f', {out["output_tokens"] / secs:.1f} tokens/s' if out.get('output_tokens') and secs > 0 else ''
        cut = ' The reply was cut off (it hit the length limit).' if out.get('stop_reason') in ('length', 'max_tokens') else ''
        problems = self.apply_ascii(text, size=j['size'])
        head = f'Try {j["attempt"]}: {secs:.0f} s{speed}.{cut}'
        if problems and j['attempt'] <= self.retries.value():
            j['messages'] += [{'role': 'assistant', 'content': text}, {'role': 'user', 'content':
                              'YOUR ANSWER HAD PROBLEMS:\n' + '\n'.join(f'- {p}' for p in problems)
                              + '\nAnswer again with the full grid and key, fixing these. No other text.'}]
            j['attempt'] += 1
            self.run_job()
            self.ai_status.setText(f'{head} {len(problems)} problems; asking again.')
            return
        self.end_job()
        self.ai_status.setText(f'{head} ' + ('Every rule kept.' if not problems else f'{len(problems)} problems left (see the left panel).'))

    def save_log(self, name: str, text: str) -> None:
        d = self.dir / 'ai'
        d.mkdir(parents=True, exist_ok=True)
        (d / f'{self.job["stamp"]}-{name}.txt').write_text(text, encoding='utf-8')

    @staticmethod
    def shape_icon(shape: int) -> QIcon:
        pm = QPixmap(30, 30)
        pm.fill(Qt.transparent)
        g = QPainter(pm)
        g.setRenderHint(QPainter.Antialiasing)
        g.setBrush(QColor('#cfd8e1'))
        g.setPen(Qt.NoPen)
        g.drawPolygon(shape_poly(shape, 2, 2, 26))
        g.end()
        return QIcon(pm)

    def pick_colour(self, i: int) -> None:
        self.colour = i
        self.eraser.setChecked(False)

    def pick_shape(self, i: int) -> None:
        self.shape = i
        self.eraser.setChecked(False)

    def tool_ok(self, cell) -> bool:
        return True

    def update_info(self, extra: str = '') -> None:
        n = len(self.cells)
        self.info.setText(f'{n} cells, {self.w} x {self.h}.\n{extra}'.strip())

    # ---- painting
    def push_undo(self) -> None:
        self.undo.append((dict(self.cells), dict(self.comps)))
        del self.undo[:-60]

    def do_undo(self) -> None:
        if self.undo:
            self.cells, self.comps = self.undo.pop()
            self.canvas.update()
            self.update_info()

    def paint(self, cell, erase: bool) -> None:
        r, c = cell
        mid = self.w // 2
        targets = [(r, c, self.shape)]
        if self.mirror and c != mid:
            targets.append((r, self.w - 1 - c, MIRROR_SHAPE[self.shape]))
        for rr, cc, sh in targets:
            self.comps.pop((rr, cc), None)
            if erase:
                self.cells.pop((rr, cc), None)
            elif self.mirror and cc == mid and sh:
                # (A triangle on the centre line would not mirror onto itself: that column takes whole cells only)
                self.cells[(rr, cc)] = (self.colour, 0)
            else:
                self.cells[(rr, cc)] = (self.colour, sh)
        self.update_info()

    # ---- commands
    def anchor(self, points: dict[int, list[tuple[int, int]]], colour: int) -> tuple[int, int, int] | None:
        """The placement point of a colour on one side, and which way is out from the centre line (+1 right, -1 left)"""
        mid = self.w // 2
        cells = points.get(colour, [])
        side = sorted((rc for rc in cells if rc[1] > mid), key=lambda rc: (rc[0], rc[1])) or sorted((rc for rc in cells if rc[1] < mid), key=lambda rc: (rc[0], -rc[1]))
        if side:
            r, c = side[0]
            return r, c, 1 if c > mid else -1
        centre = [rc for rc in cells if rc[1] == mid]
        return (centre[0][0], mid, 1) if centre else None

    def apply_commands(self, text: str) -> list[str]:
        """Block[colour,o,w,h], Triangle[colour,o] (also Triange), Turret[colour,o]: built out from each colour's placement
        point, away from the centre line, mirrored. Points are read before any command runs, so a block may cover them.
        Triangles go last, each turned to sit flat against what is next to it. Returns the problems, one per bad line"""
        if asciigrid.looks_like_grid(text):
            return self.apply_ascii(text)
        first = next((l for l in text.splitlines() if l.strip() and not l.strip().startswith('#')), '')
        m0 = re.match(r'^\s*\w+\s*\[\s*(-?\d+)\s*,', first)
        if m0:
            return self.apply_grid_commands(text)
        self.push_undo()
        points: dict[int, list[tuple[int, int]]] = {}
        for rc, (col, _sh) in self.cells.items():
            points.setdefault(col, []).append(rc)
        problems, triangles = [], []
        saved = (self.colour, self.shape, self.erasing, self.mirror)
        self.erasing, self.mirror = False, True
        for n, raw in enumerate(text.splitlines(), 1):
            line = raw.strip()
            if not line or line.startswith('#'):
                continue
            m = re.match(r'^(\w+)\s*\[\s*([^\]]*)\]\s*$', line)
            if not m:
                problems.append(f'line {n}: write Name[colour,...]: "{line}"')
                continue
            kind, args = m.group(1).lower(), [a.strip() for a in m.group(2).split(',')]
            colour = COLOUR_NAMES.get(args[0].lower().replace(' ', '').replace('_', '')) if args else None
            if colour is None:
                problems.append(f'line {n}: no colour "{args[0] if args else ""}" (try: {", ".join(sorted({k for k in COLOUR_NAMES if len(k) < 8}))})')
                continue
            a = self.anchor(points, colour)
            if not a:
                problems.append(f'line {n}: there is no {args[0]} point on the grid')
                continue
            try:
                nums = [int(x) for x in args[1:]]
            except ValueError:
                problems.append(f'line {n}: the numbers must be whole numbers')
                continue
            r, c, out = a
            o = nums[0] if nums else 0
            if kind == 'block':
                w = nums[1] if len(nums) > 1 else 1
                h = nums[2] if len(nums) > 2 else 1
                if w < 1 or h < 1:
                    problems.append(f'line {n}: a block is at least 1 by 1')
                    continue
                self.colour, self.shape = WHITE, 0
                for dy in range(h):
                    for dx in range(w):
                        cell = (r + dy, c + out * (o + dx))
                        if self.inside(cell):
                            self.paint(cell, False)
            elif kind in ('triangle', 'triange', 'tri'):
                triangles.append((r, c + out * o, out))
            elif kind in ('turret', 'cannon', 'gun'):
                cell = (r, c + out * o)
                if self.inside(cell):
                    self.colour, self.shape = GUN, 0
                    self.paint(cell, False)
                    self.comps[cell] = 'turret'
                    if cell[1] != self.w // 2:
                        self.comps[(cell[0], self.w - 1 - cell[1])] = 'turret'
            else:
                problems.append(f'line {n}: no piece "{m.group(1)}" (Block, Triangle, Turret)')
        for r, c, out in triangles:
            if self.inside((r, c)):
                self.colour, self.shape = WHITE, self.turn(r, c, out)
                self.paint((r, c), False)
        self.colour, self.shape, self.erasing, self.mirror = saved
        self.canvas.update()
        self.update_info('Applied.' if not problems else '\n'.join(problems))
        return problems

    def apply_ascii(self, text: str, size: tuple[int, int] | None = None) -> list[str]:
        """A lettered grid of the right half, mirrored (21 wide for 11 columns), cleared first. Each part letter keeps
        its colour from the legend (a new letter takes an unused one); T is a turret on its cell. Given a size (half
        width, rows) the reply must fit it. Returns what it could not read and the rules broken"""
        g = asciigrid.parse(text, *(size or (0, 0)))
        if not g['parts']:
            self.update_info('\n'.join(g['problems']))
            return g['problems']
        self.push_undo()
        parts, turrets = g['parts'], g['turrets']
        self.w, self.h = 2 * len(parts[0]) - 1, len(parts)
        self.sw.setValue(self.w)
        self.sh.setValue(self.h)
        self.cells.clear()
        self.comps.clear()
        mid = self.w // 2
        letters = list(dict.fromkeys(r[0] for r in asciigrid.rectangles(parts)))
        for s in letters:
            used = {col for col, _n in self.legend.values()}
            col = self.legend[s][0] if s in self.legend else next((c for c in PART_COLOURS if c not in used), PART_COLOURS[len(self.legend) % len(PART_COLOURS)])
            self.legend[s] = (col, g['names'].get(s) or (self.legend[s][1] if s in self.legend else f'part {s}'))
        colour_of = {s: self.legend[s][0] for s in letters}
        for y, row in enumerate(parts):
            for x, sym in enumerate(row):
                if sym != asciigrid.EMPTY:
                    for c in {mid + x, mid - x}:
                        self.cells[(y, c)] = (colour_of[sym], 0)
        for y, x in turrets:
            for c in {mid + x, mid - x}:
                self.cells[(y, c)] = (GUN, 0)
                self.comps[(y, c)] = 'turret'
        problems = g['problems'] + asciigrid.check(parts, turrets, g['names'])
        key = ', '.join(f'{s} {self.legend[s][1]}' for s in letters)
        self.canvas.update()
        self.update_info(f'Grid read: {len(letters)} parts ({key}), {len(turrets)} turrets a side.\n'
                         + ('\n'.join(problems) if problems else 'Every rule kept.'))
        return problems

    def half_grid(self) -> tuple[list[list[str]], set[tuple[int, int]], dict[str, str]]:
        """The drawing's right half as a lettered grid: a letter per colour (A first, in the order the colours appear
        from the nose down), turrets as T. A colour already in the legend keeps its letter and name; a new one is named
        after its palette colour and added"""
        mid = self.w // 2
        letters: dict[int, str] = {col: s for s, (col, _n) in self.legend.items()}
        parts = [[asciigrid.EMPTY] * (self.w - mid) for _ in range(self.h)]
        turrets = set()
        for (r, c), (col, _sh) in sorted(self.cells.items()):
            if c < mid:
                continue
            if self.comps.get((r, c)) == 'turret':
                turrets.add((r, c - mid))
                continue
            if col not in letters:
                letters[col] = next((s for s in LETTERS if s not in self.legend), '#')
                self.legend[letters[col]] = (col, PALETTE[col][0])
            parts[r][c - mid] = letters[col]
        asciigrid.under_turrets(parts, turrets)
        shown = {s for row in parts for s in row}
        return parts, turrets, {s: n for s, (_c, n) in sorted(self.legend.items()) if s in shown}

    def copy_grid(self) -> None:
        parts, turrets, names = self.half_grid()
        QApplication.clipboard().setText(asciigrid.render(parts, turrets))
        key = '\n'.join(f'{sym} = {n}' for sym, n in names.items())
        self.update_info(f'Copied the right half as a lettered grid ({len(parts[0])} columns, {len(parts)} rows).\n{key}')

    def copy_pieces(self) -> None:
        parts, turrets, names = self.half_grid()
        text = asciigrid.pieces(parts, turrets, names)
        QApplication.clipboard().setText(text)
        self.update_info(f'Copied {text.count("[")} pieces (Block[y,x,w,h], Turret[y,x]; right half, x=0 the centre column).')

    # (The from-scratch format: right half, x=0 the centre column, y=0 the nose row)
    GRID_W, GRID_H = 11, 32

    def apply_grid_commands(self, text: str) -> list[str]:
        """Block[y,x,w,h], Turret[y,x], Triangle[y,x] on an empty 21 x 32 grid (11 columns a half), mirrored. Returns the
        problems: lines it could not read, and the design rules broken (it still draws what it can)"""
        self.push_undo()
        W, H = self.GRID_W, self.GRID_H
        if (self.w, self.h) != (2 * W - 1, H):
            self.w, self.h = 2 * W - 1, H
            self.sw.setValue(self.w)
            self.sh.setValue(self.h)
        self.cells.clear()
        self.comps.clear()
        mid = self.w // 2
        problems, blocks, turrets, triangles = [], [], [], []
        for n, raw in enumerate(text.splitlines(), 1):
            line = raw.strip()
            if not line or line.startswith('#'):
                continue
            m = re.match(r'^(\w+)\s*\[\s*([^\]]*)\]\s*$', line)
            if not m:
                problems.append(f'line {n}: write Name[y,x,...]: "{line}"')
                continue
            kind = m.group(1).lower()
            try:
                nums = [int(a) for a in m.group(2).split(',')]
            except ValueError:
                problems.append(f'line {n}: whole numbers only: "{line}"')
                continue
            if kind == 'block' and len(nums) == 4:
                blocks.append((n, *nums))
            elif kind in ('turret', 'cannon', 'gun') and len(nums) == 2:
                turrets.append((n, *nums))
            elif kind in ('triangle', 'triange', 'tri') and len(nums) == 2:
                triangles.append((n, *nums))
            else:
                problems.append(f'line {n}: write Block[y,x,w,h], Turret[y,x] or Triangle[y,x]: "{line}"')
        # (Blocks: drawn, and each one's cells kept for the rules)
        owner: dict[tuple[int, int], int] = {}
        saved = (self.colour, self.shape, self.erasing, self.mirror)
        self.erasing, self.mirror = False, True
        for n, y, x, w, h in blocks:
            if w < 1 or h < 1:
                problems.append(f'line {n}: a block is at least 1 by 1')
                continue
            if x < 0 or y < 0 or x + w > W or y + h > H:
                problems.append(f'line {n}: rule 6: outside y=0..{H - 1}, x=0..{W - 1}')
            for yy in range(y, y + h):
                for xx in range(x, x + w):
                    if not (0 <= yy < H and 0 <= xx < W):
                        continue
                    if (yy, xx) in owner:
                        problems.append(f'line {n}: rule 2: overlaps line {owner[(yy, xx)]} at y={yy}, x={xx}')
                    owner[(yy, xx)] = n
                    self.colour, self.shape = WHITE, 0
                    self.paint((yy, mid + xx), False)
        for n, y, x in triangles:
            if not (0 <= y < H and 0 <= x < W):
                problems.append(f'line {n}: rule 6: outside the grid')
                continue
            self.colour, self.shape = WHITE, self.turn(y, mid + x, 1)
            self.paint((y, mid + x), False)
        for n, y, x in turrets:
            if (y, x) not in owner:
                problems.append(f'line {n}: a turret goes on a block cell; y={y}, x={x} is empty')
            if not (0 <= y < H and 0 <= x < W):
                continue
            self.colour, self.shape = GUN, 0
            self.paint((y, mid + x), False)
            self.comps[(y, mid + x)] = 'turret'
            if x:
                self.comps[(y, mid - x)] = 'turret'
        self.colour, self.shape, self.erasing, self.mirror = saved
        problems += self.grid_rules(owner, blocks)
        self.canvas.update()
        n_ok = len(blocks) + len(turrets) + len(triangles)
        self.update_info(f'{n_ok} pieces placed.' + ('\n' + '\n'.join(problems) if problems else '\nEvery rule kept.'))
        return problems

    @staticmethod
    def grid_rules(owner: dict[tuple[int, int], int], blocks: list) -> list[str]:
        """Rules 1, 3 and 5 of the design prompt, on the right half's cells"""
        out = []
        if not owner:
            return ['nothing was placed']
        # 1: the centre column one unbroken run
        ys = sorted(y for (y, x) in owner if x == 0)
        if not ys:
            out.append('rule 1: the centre column (x=0) is empty')
        elif ys[-1] - ys[0] + 1 != len(ys):
            gaps = [y for y in range(ys[0], ys[-1] + 1) if (y, 0) not in owner]
            out.append(f'rule 1: the centre column has a gap at y={",".join(map(str, gaps[:6]))}')
        # 3: one connected shape (through the cells, across blocks)
        seen, todo = set(), [next(iter(owner))]
        while todo:
            c = todo.pop()
            if c in seen:
                continue
            seen.add(c)
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nb = (c[0] + dy, c[1] + dx)
                if nb in owner and nb not in seen:
                    todo.append(nb)
        apart = sorted({owner[c] for c in owner if c not in seen})
        if apart:
            out.append(f'rule 3: not joined to the rest: line{"s" if len(apart) > 1 else ""} {", ".join(map(str, apart))}')
        # 5: moving out, a column at most 2 rows shorter than the one inside it
        height = lambda x: sum(1 for (y, xx) in owner if xx == x)
        xs = sorted({x for (_y, x) in owner})
        for x in xs:
            if x > 0 and height(x) < height(x - 1) - 2:
                rows = 'row' if height(x) == 1 else 'rows'
                out.append(f'rule 5: column x={x} has {height(x)} {rows}, more than 2 fewer than x={x - 1} ({height(x - 1)})')
        return out

    def inside(self, cell) -> bool:
        return 0 <= cell[0] < self.h and 0 <= cell[1] < self.w

    def turn(self, r: int, c: int, out: int) -> int:
        """The triangle that sits flat against the most filled neighbours (the cell itself ignored), towards the centre first"""
        def filled(rr, cc):
            v = self.cells.get((rr, cc))
            return v is not None and v[0] in (WHITE,) and v[1] == 0
        near = {'N': filled(r - 1, c), 'S': filled(r + 1, c), 'E': filled(r, c + 1), 'W': filled(r, c - 1)}
        inward = 'W' if out > 0 else 'E'
        best = max(FLAT, key=lambda k: (sum(near[d] for d in FLAT[k]), inward in FLAT[k] and near[inward], 'S' in FLAT[k]))
        return best

    def clear(self) -> None:
        self.push_undo()
        self.cells.clear()
        self.comps.clear()
        self.legend.clear()
        self.canvas.update()
        self.update_info()

    def flip_v(self) -> None:
        self.push_undo()
        flip = {0: 0, 1: 2, 2: 1, 3: 4, 4: 3}
        self.cells = {(self.h - 1 - r, c): (col, flip[sh]) for (r, c), (col, sh) in self.cells.items()}
        self.comps = {(self.h - 1 - r, c): v for (r, c), v in self.comps.items()}
        self.canvas.update()

    def resize_grid(self) -> None:
        nw, nh = self.sw.value() | 1, self.sh.value()
        if (nw, nh) == (self.w, self.h):
            return
        self.push_undo()
        dx = (nw - self.w) // 2
        self.cells = {(r, c + dx): v for (r, c), v in self.cells.items() if 0 <= r < nh and 0 <= c + dx < nw}
        self.comps = {(r, c + dx): v for (r, c), v in self.comps.items() if 0 <= r < nh and 0 <= c + dx < nw}
        self.w, self.h = nw, nh
        self.sw.setValue(nw)
        self.canvas.update()
        self.update_info()

    # ---- files and output
    def widths(self) -> list[int]:
        out = []
        for r in range(self.h):
            cs = [c for (rr, c) in self.cells if rr == r]
            out.append(max(cs) - min(cs) + 1 if cs else 0)
        first = next((i for i, w in enumerate(out) if w), 0)
        last = max((i for i, w in enumerate(out) if w), default=-1)
        return out[first:last + 1]

    def copy_widths(self) -> None:
        w = self.widths()
        QApplication.clipboard().setText(','.join(str(x) for x in w))
        self.update_info(f'Copied {len(w)} row widths, nose to tail:\n{",".join(str(x) for x in w)}')

    def save(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        path, _ = QFileDialog.getSaveFileName(self, 'Save silhouette', str(self.dir / 'silhouette.json'), 'Silhouette (*.json)')
        if path:
            Path(path).write_text(json.dumps({'width': self.w, 'height': self.h, 'palette': PALETTE,
                                              'cells': [[r, c, col, sh] for (r, c), (col, sh) in sorted(self.cells.items())],
                                              'components': [[r, c, k] for (r, c), k in sorted(self.comps.items())],
                                              'legend': [[s, col, n] for s, (col, n) in sorted(self.legend.items())]}), encoding='utf-8')
            self.update_info(f'Saved {Path(path).name}')

    def open(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        path, _ = QFileDialog.getOpenFileName(self, 'Open silhouette', str(self.dir), 'Silhouette (*.json)')
        if not path:
            return
        d = json.loads(Path(path).read_text(encoding='utf-8'))
        self.push_undo()
        self.w, self.h = int(d['width']) | 1, int(d['height'])
        self.sw.setValue(self.w)
        self.sh.setValue(self.h)
        self.cells = {(r, c): (min(col, len(PALETTE) - 1), sh) for r, c, col, sh in d['cells']}
        self.comps = {(r, c): k for r, c, k in d.get('components', [])}
        self.legend = {s: (col, n) for s, col, n in d.get('legend', [])}
        self.canvas.update()
        self.update_info(f'Opened {Path(path).name}')

    def export_png(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        path, _ = QFileDialog.getSaveFileName(self, 'Export picture', str(self.dir / 'silhouette.png'), 'Picture (*.png)')
        if path:
            self.canvas.grab().save(path)
            self.update_info(f'Exported {Path(path).name}')


def main() -> int:
    app = QApplication(sys.argv)
    w = Designer()
    w.show()
    return app.exec()


if __name__ == '__main__':
    sys.exit(main())
