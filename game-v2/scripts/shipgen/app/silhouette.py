# A quick symmetrical silhouette designer: click cells on a grid to paint them in a palette colour (whole cells or
# triangles), the other half mirrors itself. Left button paints (drag to sweep), right button erases. Save and open
# as JSON, export a PNG, or copy the row widths (nose to tail) as a concept outline.
# Commands (what a model can write) build on coloured placement points, out from the centre line, mirrored:
#   Block[gray,0,4,2]   a white block 4 wide and 2 high from the gray point (o: cells out from it, then w out, h down)
#   Triangle[purple,0]  a white triangle at the purple point, turned to sit flat against what is beside it
#   Turret[gray,4]      a cannon 4 cells out from the gray point
#   pythonw scripts/shipgen/app/silhouette.py        (also opened from the Shipgen window's Silhouette button)
import json
import re
import sys
from pathlib import Path

from PySide6.QtCore import QPointF, QRectF, QSize, Qt
from PySide6.QtGui import QColor, QIcon, QKeySequence, QPainter, QPen, QPixmap, QPolygonF, QShortcut
from PySide6.QtWidgets import (
    QApplication, QButtonGroup, QCheckBox, QFileDialog, QHBoxLayout, QLabel, QMainWindow, QPlainTextEdit, QPushButton, QSpinBox, QVBoxLayout, QWidget,
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
# (Which sides of a cell each shape has flat: N E S W)
FLAT = {1: {'S', 'W'}, 2: {'N', 'W'}, 3: {'N', 'E'}, 4: {'E', 'S'}}

# (Shapes: 0 a whole cell; 1-4 triangles, corners as fractions of the cell, as the ship grid names them: t1 flat on S+W ... t4 flat on E+S)
TRI = {1: [(0, 0), (0, 1), (1, 1)], 2: [(0, 0), (1, 0), (0, 1)], 3: [(0, 0), (1, 0), (1, 1)], 4: [(1, 0), (1, 1), (0, 1)]}
# (Mirrored left to right a triangle becomes its twin)
MIRROR_SHAPE = {0: 0, 1: 4, 4: 1, 2: 3, 3: 2}
SHAPE_NAMES = {0: 'whole cell', 1: 'triangle, flat on the bottom and left', 2: 'triangle, flat on the top and left',
               3: 'triangle, flat on the top and right', 4: 'triangle, flat on the bottom and right'}
BG, GRID_LINE, CENTRE = QColor('#080a0d'), QColor('#161c23'), QColor('#2f5f8c')


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
                         ('Export PNG...', self.export_png), ('Copy row widths', self.copy_widths)]:
            b = QPushButton(text)
            b.clicked.connect(fn)
            side.addWidget(b)
        side.addWidget(QLabel('Commands (one per line)'))
        self.cmds = QPlainTextEdit()
        self.cmds.setPlaceholderText('Block[gray,0,4,2]\nTriangle[purple,0]\nTriangle[brown,0]\nTurret[gray,4]')
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
        self.setCentralWidget(root)
        QShortcut(QKeySequence.Undo, self, activated=self.do_undo)
        self.resize(900, 780)
        self.update_info('Left-click paints, drag to sweep, right-click erases. The nose is at the top.')

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
                                              'components': [[r, c, k] for (r, c), k in sorted(self.comps.items())]}), encoding='utf-8')
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
