# A quick symmetrical silhouette designer: click cells on a grid to paint them in a palette colour (whole cells or
# triangles), the other half mirrors itself. Left button paints (drag to sweep), right button erases. Save and open
# as JSON, export a PNG, or copy the row widths (nose to tail) as a concept outline.
#   pythonw scripts/shipgen/app/silhouette.py        (also opened from the Shipgen window's Silhouette button)
import json
import sys
from pathlib import Path

from PySide6.QtCore import QPointF, QRectF, QSize, Qt
from PySide6.QtGui import QColor, QIcon, QKeySequence, QPainter, QPen, QPixmap, QPolygonF, QShortcut
from PySide6.QtWidgets import (
    QApplication, QButtonGroup, QCheckBox, QFileDialog, QHBoxLayout, QLabel, QMainWindow, QPushButton, QSpinBox, QVBoxLayout, QWidget,
)

PALETTE = [
    ('hull', '#4f5966'), ('armour', '#8a939e'), ('light plate', '#c5ced8'), ('gun', '#e0585c'), ('power', '#ef8a4c'), ('store', '#58a9df'),
    ('engine', '#4cc59b'), ('core', '#e2c15c'), ('shield', '#c57ad0'), ('diode', '#9b8fe0'), ('cargo', '#7d6b4c'), ('dark', '#222a33'),
]
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
        self.undo.append(dict(self.cells))
        del self.undo[:-60]

    def do_undo(self) -> None:
        if self.undo:
            self.cells = self.undo.pop()
            self.canvas.update()
            self.update_info()

    def paint(self, cell, erase: bool) -> None:
        r, c = cell
        mid = self.w // 2
        targets = [(r, c, self.shape)]
        if self.mirror and c != mid:
            targets.append((r, self.w - 1 - c, MIRROR_SHAPE[self.shape]))
        for rr, cc, sh in targets:
            if erase:
                self.cells.pop((rr, cc), None)
            elif self.mirror and cc == mid and sh:
                # (A triangle on the centre line would not mirror onto itself: that column takes whole cells only)
                self.cells[(rr, cc)] = (self.colour, 0)
            else:
                self.cells[(rr, cc)] = (self.colour, sh)
        self.update_info()

    def clear(self) -> None:
        self.push_undo()
        self.cells.clear()
        self.canvas.update()
        self.update_info()

    def flip_v(self) -> None:
        self.push_undo()
        flip = {0: 0, 1: 2, 2: 1, 3: 4, 4: 3}
        self.cells = {(self.h - 1 - r, c): (col, flip[sh]) for (r, c), (col, sh) in self.cells.items()}
        self.canvas.update()

    def resize_grid(self) -> None:
        nw, nh = self.sw.value() | 1, self.sh.value()
        if (nw, nh) == (self.w, self.h):
            return
        self.push_undo()
        dx = (nw - self.w) // 2
        self.cells = {(r, c + dx): v for (r, c), v in self.cells.items() if 0 <= r < nh and 0 <= c + dx < nw}
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
                                              'cells': [[r, c, col, sh] for (r, c), (col, sh) in sorted(self.cells.items())]}), encoding='utf-8')
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
