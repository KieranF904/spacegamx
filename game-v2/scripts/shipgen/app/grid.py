# The live assembly view: reads the grid text a design comes as (whole, or still streaming) and draws it cell by cell,
# coloured by part category, with what changed since last round outlined and the power check laid over it.
import math
import re
from dataclasses import dataclass

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QBrush, QColor, QFont, QPainter, QPen, QPolygonF
from PySide6.QtWidgets import QWidget

COLOURS = {
    'core': '#e2c15c', 'generator': '#ef8a4c', 'dynamo': '#e9a95a', 'store': '#58a9df', 'conduit': '#6f97b4', 'diode': '#9b8fe0',
    'weapon': '#e0585c', 'thruster': '#4cc59b', 'tool': '#c57ad0', 'armour': '#8a939e', 'hull': '#4f5966', 'cargo': '#7d6b4c', 'other': '#5b5f66',
}
CATEGORY_NAMES = {
    'core': 'core', 'generator': 'generator', 'dynamo': 'dynamo', 'store': 'store (battery)', 'conduit': 'conduit', 'diode': 'diode (one way)',
    'weapon': 'weapon', 'thruster': 'engine', 'tool': 'tool / shield', 'armour': 'armour', 'hull': 'hull', 'cargo': 'cargo', 'other': 'other',
}

TOKEN = re.compile(r'^([A-Za-z]{2})([\^>v<])?([a-z]\d)?$')
INT = re.compile(r'^-?\d+$')
# (A tri piece's corners, fractions of the cell, by shape number: t1 flat on S+W ... t4 flat on E+S)
TRI = {'t1': [(0, 0), (0, 1), (1, 1)], 't2': [(0, 0), (1, 0), (0, 1)], 't3': [(0, 0), (1, 0), (1, 1)], 't4': [(1, 0), (1, 1), (0, 1)]}
DIRS = {'^': (0, -1), 'v': (0, 1), '>': (1, 0), '<': (-1, 0)}


@dataclass
class Cell:
    code: str
    first: bool
    facing: str | None
    shape: str | None
    token: str


def grid_lines(text: str) -> list[str]:
    """The grid lines of a design: the text between grid: and end (or the numbered rows when there is no grid: line)"""
    s = re.sub(r'<think>[\s\S]*?(</think>|$)', '', text.replace('\r', ''), flags=re.I)
    ls = s.split('\n')
    g = -1
    for i in range(len(ls) - 1, -1, -1):
        if re.match(r'^\s*[*_#]*\s*grid\s*[*_]*\s*:?\s*[*_]*\s*$', ls[i], re.I):
            g = i
            break
    body = ls[g + 1:] if g >= 0 else [l for l in ls if re.match(r'^\s*-?\d+\s+\S', l) or re.match(r'^\s*(\.\.|[A-Z]{2})\s', l)]
    out = []
    for l in body:
        if re.match(r'^\s*end\s*$', l, re.I) or re.match(r'^\s*(key|raw)\s*:', l, re.I):
            break
        out.append(l)
    return out


def parse_grid(text: str | None) -> dict[tuple[int, int], Cell]:
    cells: dict[tuple[int, int], Cell] = {}
    if not text:
        return cells
    header = None
    n = 0
    for line in grid_lines(text):
        toks = line.split()
        if not toks or re.match(r'^name\s*:', line.strip(), re.I):
            continue
        if header is None and all(INT.match(t) for t in toks) and (len(toks) > 1 or n == 0):
            header = [int(t) for t in toks]
            continue
        row, rest = n, toks
        if INT.match(toks[0]):
            row, rest = int(toks[0]), toks[1:]
        n += 1
        for i, t in enumerate(rest):
            col = header[i] if header and i < len(header) else (header[-1] + 1 + i - len(header) if header else i)
            if t == '..':
                continue
            m = TOKEN.match(t)
            if not m:
                continue
            cells[(row, col)] = Cell(m.group(1).upper(), m.group(1) == m.group(1).upper(), m.group(2), m.group(3), t)
    return cells


class GridView(QWidget):
    """The ship as a grid: colours by category (legend: code -> category), changes since last round dashed, the power
    check on top (unpowered parts red, bottleneck relays ringed, each gun's sustained fire %)"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.legend: dict[str, str] = {}
        self.cells: dict[tuple[int, int], Cell] = {}
        self.prev: dict[tuple[int, int], Cell] | None = None
        self.result = None
        self.part_cells = None
        self.empty = 'waiting for the model'
        self.setMinimumSize(240, 240)

    def show_grid(self, text: str | None, prev=None) -> None:
        self.cells = parse_grid(text)
        self.prev = prev
        self.result = None
        self.part_cells = None
        self.update()

    def overlay(self, result, part_cells) -> None:
        self.result, self.part_cells = result, part_cells
        self.update()

    def clear(self, empty: str = 'waiting for the model') -> None:
        self.cells, self.prev, self.result, self.part_cells, self.empty = {}, None, None, None, empty
        self.update()

    def paintEvent(self, _e) -> None:
        g = QPainter(self)
        g.setRenderHint(QPainter.Antialiasing)
        W, H = self.width(), self.height()
        g.fillRect(0, 0, W, H, QColor('#080a0d'))
        keys = list(self.cells.keys()) + (list(self.prev.keys()) if self.prev else [])
        if not keys:
            g.setPen(QColor('#3a4552'))
            g.drawText(QRectF(0, 0, W, H), Qt.AlignCenter, self.empty)
            return
        r0, r1 = min(k[0] for k in keys), max(k[0] for k in keys)
        c0, c1 = min(k[1] for k in keys), max(k[1] for k in keys)
        rows, cols = r1 - r0 + 1, c1 - c0 + 1
        pad = 20
        s = max(4, min(56, math.floor(min((W - pad * 2) / cols, (H - pad * 2) / rows))))
        ox, oy = round((W - cols * s) / 2), round((H - rows * s) / 2)
        X = lambda c: ox + (c - c0) * s
        Y = lambda r: oy + (r - r0) * s

        g.setPen(QPen(QColor('#161c23'), 1))
        for r in range(rows + 1):
            g.drawLine(ox, oy + r * s, ox + cols * s, oy + r * s)
        for c in range(cols + 1):
            g.drawLine(ox + c * s, oy, ox + c * s, oy + rows * s)
        mono = QFont('Consolas')
        if s >= 12:
            mono.setPixelSize(9)
            g.setFont(mono)
            g.setPen(QColor('#3c4754'))
            for c in range(c0, c1 + 1):
                g.drawText(QRectF(X(c), oy - 16, s, 14), Qt.AlignCenter, str(c))
            for r in range(r0, r1 + 1):
                g.drawText(QRectF(ox - 30, Y(r), 26, s), Qt.AlignRight | Qt.AlignVCenter, str(r))

        edge = QPen(QColor('#0b0e12'), max(1, s / 14))
        for (r, c), cell in self.cells.items():
            x, y = X(c), Y(r)
            col = QColor(COLOURS.get('other' if cell.code == '##' else self.legend.get(cell.code, 'other'), COLOURS['other']))
            if not cell.first:
                col.setAlphaF(0.78)
            tri = TRI.get(cell.shape or '')
            if tri:
                g.setPen(Qt.NoPen)
                g.setBrush(QBrush(col))
                g.drawPolygon(QPolygonF([QPointF(x + a * s, y + b * s) for a, b in tri]))
            else:
                g.fillRect(QRectF(x + 0.5, y + 0.5, s - 1, s - 1), col)
                g.setPen(edge)
                other = lambda rr, cc: (lambda n: not n or n.code != cell.code or n.first)(self.cells.get((rr, cc)))
                if other(r, c + 1):
                    g.drawLine(QPointF(x + s, y), QPointF(x + s, y + s))
                if other(r + 1, c):
                    g.drawLine(QPointF(x, y + s), QPointF(x + s, y + s))
                if cell.first:
                    g.drawLine(QPointF(x, y), QPointF(x + s, y))
                    g.drawLine(QPointF(x, y), QPointF(x, y + s))
            if cell.first and s >= 14 and not tri:
                f = QFont('Consolas')
                f.setPixelSize(int(min(13, s * 0.36)))
                f.setBold(True)
                g.setFont(f)
                g.setPen(QColor('#0b0e12'))
                g.drawText(QRectF(x, y + (s * 0.08 if cell.facing else 0), s, s), Qt.AlignCenter, cell.code)
            if cell.facing in DIRS:
                dx, dy = DIRS[cell.facing]
                cx, cy, a, d = x + s / 2, y + s / 2, s * 0.16, s * 0.36
                tx, ty = cx + dx * d, cy + dy * d
                g.setPen(Qt.NoPen)
                g.setBrush(QColor('#0b0e12'))
                g.drawPolygon(QPolygonF([
                    QPointF(tx + dx * a, ty + dy * a),
                    QPointF(tx - dy * a - dx * a * 0.3, ty + dx * a - dy * a * 0.3),
                    QPointF(tx + dy * a - dx * a * 0.3, ty - dx * a - dy * a * 0.3),
                ]))

        # What changed since last round
        if self.prev is not None:
            pen = QPen(QColor('#ffd866'), 1.5, Qt.DashLine)
            g.setPen(pen)
            g.setBrush(Qt.NoBrush)
            for k in set(self.cells) | set(self.prev):
                a = self.cells.get(k)
                p = self.prev.get(k)
                if (a.token if a else None) == (p.token if p else None):
                    continue
                g.drawRect(QRectF(X(k[1]) + 1.5, Y(k[0]) + 1.5, s - 3, s - 3))

        # The power check
        res = self.result
        if res:
            pc = self.part_cells or {}
            power = res.get('power')
            if power:
                for u in power.get('unpowered', []):
                    for r, c in pc.get(str(u['uid']), [[u['row'], u['col']]]):
                        g.fillRect(QRectF(X(c), Y(r), s, s), QColor(239, 80, 80, 115))
                        g.setPen(QPen(QColor('#ff5b5b'), 2))
                        g.setBrush(Qt.NoBrush)
                        g.drawRect(QRectF(X(c) + 1, Y(r) + 1, s - 2, s - 2))
                for bn in power.get('bottlenecks', []):
                    cs = pc.get(str(bn['uid']), [[bn['row'], bn['col']]])
                    cr = sum(x[0] for x in cs) / len(cs)
                    cc = sum(x[1] for x in cs) / len(cs)
                    rad = s * (0.55 + 0.35 * math.sqrt(len(cs)))
                    g.setPen(QPen(QColor('#f0b64e'), 2))
                    g.setBrush(Qt.NoBrush)
                    g.drawEllipse(QPointF(X(cc) + s / 2, Y(cr) + s / 2), rad, rad)
                f = QFont('Consolas')
                f.setPixelSize(int(max(9, min(11, s * 0.3))))
                f.setBold(True)
                g.setFont(f)
                for w in power.get('weapons', []):
                    pct = round(w.get('pctLong', w.get('pct', 0)))
                    x, y = X(w['col']) + s / 2, Y(w['row']) - 1
                    box = QRectF(x - 18, y - 7, 36, 13)
                    g.fillRect(box, QColor(8, 10, 13, 216))
                    g.setPen(QColor('#5fd39a' if pct >= 95 else '#f0b64e' if pct >= 50 else '#ef6b6b'))
                    g.drawText(box, Qt.AlignCenter, f'{pct}%')
            for e in res.get('errors', []):
                r = e.get('row', (e.get('part') or {}).get('row'))
                c = e.get('col', (e.get('part') or {}).get('col'))
                if r is None or c is None:
                    continue
                g.setPen(QPen(QColor('#ff5b5b'), 2))
                g.drawLine(QPointF(X(c) + 3, Y(r) + 3), QPointF(X(c) + s - 3, Y(r) + s - 3))
                g.drawLine(QPointF(X(c) + s - 3, Y(r) + 3), QPointF(X(c) + 3, Y(r) + s - 3))
