# The evolver's window: open a silhouette (Save... in the silhouette designer: turret markers and engine-green cells
# say where the start's guns and engines go), pick a scenario, a level and a budget, and evolve. The cheapest working
# ship is the start; from there any part the level has unlocked may go anywhere in the outline (guns only with nothing
# in front, engines with nothing behind), within the budget and the level's build points, and every ship goes through
# the game's own validator. The best so far is drawn as it changes, with its score term by term against the start.
# Parts lists the catalogue (the game's numbers); Scenarios edits scenarios.json; Notes keeps your feedback with the run.
# Every 10 generations the best ship so far is saved (out/<run>/best.json and best.png) along with the score curve.
#   --run "<scenario name>"   start evolving that scenario as soon as the window opens
#   pythonw scripts/shipgen/evolver/app.py   or   npm run evolver
import json
import sys
import threading
import time
from collections import Counter
from pathlib import Path

from PySide6.QtCore import QObject, QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QFont, QPainter, QPen
from PySide6.QtWidgets import (
    QApplication, QComboBox, QFileDialog, QHBoxLayout, QHeaderView, QLabel, QLineEdit, QMainWindow, QPlainTextEdit, QPushButton,
    QSpinBox, QSplitter, QTableWidget, QTableWidgetItem, QTabWidget, QTextBrowser, QToolTip, QVBoxLayout, QWidget,
)

from evolve import Evolver
from model import HERE, SIDES, Catalogue, Ship, Silhouette, Validator, cheapest_build
from score import METRICS, measure

OUT = HERE / 'out'
SCENARIOS = HERE / 'scenarios.json'
SAMPLE = HERE / 'samples' / 'gunship.json'
COLOURS = {
    'core': '#e2c15c', 'generator': '#ef8a4c', 'dynamo': '#e9a95a', 'store': '#58a9df', 'conduit': '#6f97b4', 'diode': '#9b8fe0',
    'weapon': '#e0585c', 'thruster': '#4cc59b', 'tool': '#c57ad0', 'armor': '#8a939e', 'hull': '#4f5966', 'cargo': '#7d6b4c', 'plating': '#a3adb8',
}
STYLE = """
* { font-family: 'Segoe UI'; font-size: 13px; }
QMainWindow, QWidget { background: #0b0e12; color: #cfd8e1; }
QPushButton { background: #171d24; border: 1px solid #232c36; border-radius: 4px; padding: 5px 10px; }
QPushButton:hover { border-color: #6cb8ff; }
QPushButton:disabled { color: #4b5560; }
QComboBox, QSpinBox, QLineEdit { background: #0e1217; border: 1px solid #232c36; border-radius: 4px; padding: 3px; }
QTextBrowser, QPlainTextEdit, QTableWidget { background: #0e1217; border: 1px solid #232c36; }
QHeaderView::section { background: #141a21; color: #7c8896; border: 0; padding: 3px; }
QTabBar::tab { background: #141a21; padding: 5px 12px; border: 1px solid #232c36; }
QTabBar::tab:selected { background: #1c2530; }
QLabel#small { color: #7c8896; font-size: 11px; }
"""


def colour_of(cat: Catalogue, pid: str) -> str:
    p = cat.parts[pid]
    if p['fn'] in COLOURS:
        return COLOURS[p['fn']]
    if p['fn'].startswith('plating'):
        return COLOURS['plating']
    return COLOURS.get(cat.role(pid), '#5b5f66')


class ShipView(QWidget):
    def __init__(self, win):
        super().__init__()
        self.win = win
        self.ship: Ship | None = None
        self.m: dict = {}
        self.setMouseTracking(True)
        self.setMinimumSize(320, 420)

    def show_ship(self, ship, m):
        self.ship, self.m = ship, m or {}
        self.update()

    def geo(self):
        s = self.ship.sil
        k = max(4, min((self.width() - 20) / s.w, (self.height() - 20) / s.h))
        return k, (self.width() - k * s.w) / 2, (self.height() - k * s.h) / 2

    def paintEvent(self, _e):
        g = QPainter(self)
        g.setRenderHint(QPainter.Antialiasing)
        g.fillRect(self.rect(), QColor('#080a0d'))
        if not self.ship:
            return
        cat, s = self.win.cat, self.ship.sil
        k, ox, oy = self.geo()
        g.setPen(QPen(QColor('#141a21'), 1))
        for r in range(s.h + 1):
            g.drawLine(QPointF(ox, oy + r * k), QPointF(ox + s.w * k, oy + r * k))
        for c in range(s.w + 1):
            g.drawLine(QPointF(ox + c * k, oy), QPointF(ox + c * k, oy + s.h * k))
        g.setPen(Qt.NoPen)
        g.setBrush(QColor('#121820'))
        for r, c in s.cells:
            g.drawRect(QRectF(ox + c * k, oy + r * k, k, k))
        full = self.ship.full()
        unfed = set()
        # (Which full-ship parts are under a quarter of their power: the measure's ids index ship.full())
        for i in self.m.get('unpowered_ids', []):
            if i < len(full):
                unfed.add(i)
        for i, p in enumerate(full):
            rect = QRectF(ox + p.x * k + 1, oy + p.y * k + 1, p.w * k - 2, p.h * k - 2)
            col = QColor(colour_of(cat, p.pid))
            g.setBrush(col)
            g.setPen(QPen(col.darker(160), 1))
            g.drawRoundedRect(rect, 2, 2)
            role = cat.role(p.pid)
            if role == 'weapon':
                g.setPen(QPen(QColor('#ffffff'), max(1.5, k * 0.12)))
                g.drawLine(QPointF(rect.center().x(), rect.center().y()), QPointF(rect.center().x(), rect.top() - k * 0.25))
            if p.facing and role == 'diode':
                # (A Diode: an arrow to its out edge)
                dr, dc = SIDES[p.facing]
                cx, cy = rect.center().x(), rect.center().y()
                g.setPen(QPen(QColor('#0b0e12'), max(1.5, k * 0.12)))
                g.drawLine(QPointF(cx - dc * k * 0.3, cy - dr * k * 0.3), QPointF(cx + dc * k * 0.35, cy + dr * k * 0.35))
            if not cat.parts[p.pid]['model'] and p.pid.split(':')[-1] != 'alloy' and k >= 12:
                g.setPen(QColor('#0b0e12'))
                g.setFont(QFont('Segoe UI', max(6, int(k * 0.32))))
                g.drawText(rect, Qt.AlignCenter, str(cat.parts[p.pid]['grade']))
            if i in unfed:
                g.setPen(QPen(QColor('#ff3b3b'), 2))
                g.drawLine(rect.topLeft(), rect.bottomRight())
                g.drawLine(rect.topRight(), rect.bottomLeft())
        g.setPen(QPen(QColor('#2f5f8c'), 1, Qt.DashLine))
        g.drawLine(QPointF(ox + (s.mid + 0.5) * k, oy - 4), QPointF(ox + (s.mid + 0.5) * k, oy + s.h * k + 4))

    def mouseMoveEvent(self, e):
        if not self.ship:
            return
        k, ox, oy = self.geo()
        c, r = int((e.position().x() - ox) // k), int((e.position().y() - oy) // k)
        full = self.ship.full()
        for i, p in enumerate(full):
            if (r, c) in p.cells():
                d = self.win.cat.parts[p.pid]
                fed = self.m.get('fed', {}).get(i)
                lines = [f"<b>{d['name']}</b> {d['mark']} {d['w']}x{d['h']}",
                         f"HP {d['hp']:.0f}, armour {d['armour']}, mass {d['mass']}, {d['cost']} credits"]
                pw = d.get('power') or {}
                if pw.get('makes'):
                    lines.append(f"makes {pw['makes']:.1f} E/s")
                if pw.get('holds'):
                    lines.append(f"holds {pw['holds']:.0f} E, gives {pw['gives']:.0f} E/s")
                if pw.get('uses'):
                    lines.append(f"uses {pw['uses']:.1f} E/s")
                if d.get('dps'):
                    lines.append(f"{d['dps']:.1f} damage/s at full power ({d.get('damageType')}, pen {d.get('pen')})")
                if d.get('thrust'):
                    lines.append(f"thrust {d['thrust']:.2f}")
                if d.get('cargo'):
                    lines.append(f"cargo {d['cargo']}")
                if fed is not None:
                    lines.append(f"gets {fed * 100:.0f}% of its power (reactors alone)")
                QToolTip.showText(e.globalPosition().toPoint(), '<br>'.join(lines), self)
                return
        QToolTip.hideText()


class Chart(QWidget):
    def __init__(self):
        super().__init__()
        self.points: list[tuple[float, float]] = []
        self.setMinimumHeight(110)

    def set(self, pts):
        self.points = list(pts)
        self.update()

    def paintEvent(self, _e):
        g = QPainter(self)
        g.setRenderHint(QPainter.Antialiasing)
        g.fillRect(self.rect(), QColor('#0e1217'))
        if len(self.points) < 2:
            g.setPen(QColor('#7c8896'))
            g.drawText(self.rect(), Qt.AlignCenter, 'Score per generation (best, and the average)')
            return
        lo = min(min(p) for p in self.points)
        hi = max(max(p) for p in self.points)
        hi = hi if hi > lo else lo + 1
        W, H, pad = self.width(), self.height(), 8
        X = lambda i: pad + (W - 2 * pad) * i / (len(self.points) - 1)
        Y = lambda v: H - pad - (H - 2 * pad) * (v - lo) / (hi - lo)
        for j, col in ((1, '#4b5a6b'), (0, '#6cb8ff')):
            g.setPen(QPen(QColor(col), 2))
            for i in range(1, len(self.points)):
                g.drawLine(QPointF(X(i - 1), Y(self.points[i - 1][j])), QPointF(X(i), Y(self.points[i][j])))
        g.setPen(QColor('#7c8896'))
        g.drawText(QRectF(pad, 2, W, 14), Qt.AlignLeft, f'{hi:.2f}')
        g.drawText(QRectF(pad, H - 16, W, 14), Qt.AlignLeft, f'{lo:.2f}')


class Bridge(QObject):
    gen = Signal(int, object, object, list)
    stopped = Signal(str)


class Window(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle('Ship evolver')
        self.setStyleSheet(STYLE)
        self.cat = Catalogue()
        self.sil: Silhouette | None = None
        self.start_ship: Ship | None = None
        self.best: tuple | None = None
        self.evolver: Evolver | None = None
        self.running = False
        self.stop_flag = False
        self.bridge = Bridge()
        self.bridge.gen.connect(self.on_gen)
        self.bridge.stopped.connect(self.on_stopped)
        root = QWidget()
        lay = QVBoxLayout(root)
        bar = QHBoxLayout()
        b = QPushButton('Open silhouette...')
        b.clicked.connect(self.open_silhouette)
        bar.addWidget(b)
        self.sil_label = QLabel('', objectName='small')
        bar.addWidget(self.sil_label)
        bar.addWidget(QLabel('Scenario'))
        self.scenario_box = QComboBox()
        self.scenario_box.currentIndexChanged.connect(self.scenario_changed)
        bar.addWidget(self.scenario_box)
        bar.addWidget(QLabel('Level'))
        self.level = QSpinBox()
        self.level.setRange(0, 99)
        self.level.setToolTip('Which parts and materials are unlocked, and the build points (data/unlocks.json)')
        self.level.editingFinished.connect(self.rebuild)
        bar.addWidget(self.level)
        bar.addWidget(QLabel('Budget'))
        self.budget = QSpinBox()
        self.budget.setRange(0, 1000000)
        self.budget.setSingleStep(500)
        self.budget.setToolTip('Credits for the whole ship (part recipe values)')
        bar.addWidget(self.budget)
        bar.addWidget(QLabel('Population'))
        self.pop = QSpinBox()
        self.pop.setRange(6, 200)
        self.pop.setValue(30)
        bar.addWidget(self.pop)
        bar.addStretch(1)
        self.go = QPushButton('Evolve')
        self.go.clicked.connect(self.start)
        bar.addWidget(self.go)
        self.stop_btn = QPushButton('Stop')
        self.stop_btn.setEnabled(False)
        self.stop_btn.clicked.connect(lambda: setattr(self, 'stop_flag', True))
        bar.addWidget(self.stop_btn)
        lay.addLayout(bar)
        split = QSplitter()
        left = QWidget()
        ll = QVBoxLayout(left)
        views = QHBoxLayout()
        self.start_view, self.best_view = ShipView(self), ShipView(self)
        for v, name in ((self.start_view, 'Start: the cheapest working ship'), (self.best_view, 'Best so far')):
            box = QVBoxLayout()
            box.addWidget(QLabel(name, objectName='small'))
            box.addWidget(v, 1)
            views.addLayout(box, 1)
        ll.addLayout(views, 1)
        ll.addWidget(QLabel("Red cross: under a quarter of its power. Arrow: a Diode's out edge. Number: Mk of hull, armour, cargo, core above Mk I. Hover a part for its numbers.", objectName='small'))
        split.addWidget(left)
        right = QTabWidget()
        run = QWidget()
        rl = QVBoxLayout(run)
        self.status = QLabel('', objectName='small')
        self.status.setWordWrap(True)
        rl.addWidget(self.status)
        self.chart = Chart()
        rl.addWidget(self.chart)
        self.report = QTextBrowser()
        rl.addWidget(self.report, 1)
        row = QHBoxLayout()
        b = QPushButton('Save best...')
        b.clicked.connect(self.save_best)
        row.addWidget(b)
        b = QPushButton('Start from best')
        b.setToolTip('Make the best ship the new start (its scores become the 1s)')
        b.clicked.connect(self.adopt_best)
        row.addWidget(b)
        rl.addLayout(row)
        right.addTab(run, 'Run')
        right.addTab(self.parts_tab(), 'Parts')
        right.addTab(self.scenarios_tab(), 'Scenarios')
        right.addTab(self.notes_tab(), 'Notes')
        split.addWidget(right)
        split.setSizes([760, 560])
        lay.addWidget(split, 1)
        self.setCentralWidget(root)
        self.resize(1400, 860)
        try:
            self.validator = Validator()
        except Exception as e:
            self.validator = None
            self.status.setText(f"The game's validator did not start ({e}): ships are scored unchecked.")
        self.load_scenarios()
        if SAMPLE.exists():
            self.load_silhouette(SAMPLE)

    # ---- tabs
    def parts_tab(self) -> QWidget:
        w = QWidget()
        l = QVBoxLayout(w)
        self.part_filter = QLineEdit()
        self.part_filter.setPlaceholderText('Filter: name, category, role...')
        self.part_filter.textChanged.connect(self.fill_parts)
        l.addWidget(self.part_filter)
        cols = ['Name', 'Category', 'Role', 'Size', 'Mk', 'HP', 'Armour', 'Mass', 'Cost', 'Makes', 'Holds', 'Gives', 'Uses', 'DPS', 'Thrust', 'Cargo']
        self.parts_table = QTableWidget(0, len(cols))
        self.parts_table.setHorizontalHeaderLabels(cols)
        self.parts_table.verticalHeader().setVisible(False)
        self.parts_table.setSortingEnabled(True)
        self.parts_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeToContents)
        l.addWidget(self.parts_table, 1)
        l.addWidget(QLabel(f'From the game\'s data ({self.cat.made[:10]}). Run export.ts again after changing it.', objectName='small'))
        self.fill_parts()
        return w

    def fill_parts(self):
        f = self.part_filter.text().lower().strip()
        rows = []
        for p in self.cat.parts.values():
            pw = p.get('power') or {}
            text = f"{p['name']} {p['category']} {pw.get('role', '')} {p['material']}".lower()
            if f and f not in text:
                continue
            rows.append([p['name'] + ('' if p['model'] else f" ({p['material']})"), p['category'], pw.get('role') or '', f"{p['w']}x{p['h']}", p['grade'], p['hp'], p['armour'],
                         p['mass'], p['cost'] or 0, pw.get('makes') or 0, pw.get('holds') or 0, pw.get('gives') or 0, pw.get('uses') or 0, p['dps'], p['thrust'], p['cargo']])
        t = self.parts_table
        t.setSortingEnabled(False)
        t.setRowCount(len(rows))
        for i, row in enumerate(rows):
            for j, v in enumerate(row):
                it = QTableWidgetItem()
                if isinstance(v, (int, float)):
                    it.setData(Qt.DisplayRole, round(v, 1) if isinstance(v, float) else v)
                else:
                    it.setText(str(v))
                t.setItem(i, j, it)
        t.setSortingEnabled(True)

    def scenarios_tab(self) -> QWidget:
        w = QWidget()
        l = QVBoxLayout(w)
        self.sc_edit = QPlainTextEdit()
        self.sc_edit.setStyleSheet('font-family: Consolas; font-size: 12px;')
        l.addWidget(self.sc_edit, 1)
        b = QPushButton('Save and use')
        b.clicked.connect(self.save_scenarios)
        l.addWidget(b)
        self.sc_note = QLabel('', objectName='small')
        self.sc_note.setWordWrap(True)
        l.addWidget(self.sc_note)
        return w

    def notes_tab(self) -> QWidget:
        w = QWidget()
        l = QVBoxLayout(w)
        l.addWidget(QLabel('Feedback on this run. Saved with the scenario, the settings and the best ship\'s scores.', objectName='small'))
        self.notes = QPlainTextEdit()
        l.addWidget(self.notes, 1)
        b = QPushButton('Save note')
        b.clicked.connect(self.save_note)
        l.addWidget(b)
        self.note_status = QLabel('', objectName='small')
        l.addWidget(self.note_status)
        return w

    # ---- scenarios
    def load_scenarios(self):
        text = SCENARIOS.read_text(encoding='utf-8')
        self.sc_edit.setPlainText(text)
        self.scenarios = json.loads(text)['scenarios']
        cur = self.scenario_box.currentText()
        self.scenario_box.blockSignals(True)
        self.scenario_box.clear()
        for s in self.scenarios:
            self.scenario_box.addItem(s['name'])
        i = self.scenario_box.findText(cur)
        self.scenario_box.setCurrentIndex(max(i, 0))
        self.scenario_box.blockSignals(False)
        self.scenario_changed()

    def save_scenarios(self):
        try:
            d = json.loads(self.sc_edit.toPlainText())
            assert isinstance(d.get('scenarios'), list)
        except Exception as e:
            self.sc_note.setText(f'Not saved: {e}')
            return
        SCENARIOS.write_text(self.sc_edit.toPlainText(), encoding='utf-8')
        self.sc_note.setText('Saved.')
        self.load_scenarios()

    def scenario(self) -> dict:
        s = dict(self.scenarios[max(0, self.scenario_box.currentIndex())])
        s['budget'] = self.budget.value()
        s['level'] = self.level.value()
        s['points'] = self.cat.points_limit(self.level.value())
        return s

    def scenario_changed(self, *_a):
        s = self.scenarios[max(0, self.scenario_box.currentIndex())]
        self.budget.setValue(int(s.get('budget') or 0))
        self.level.setValue(int(s.get('level', 20)))
        self.scenario_box.setToolTip(s.get('about', ''))
        self.rebuild()

    # ---- the start
    def open_silhouette(self):
        path, _ = QFileDialog.getOpenFileName(self, 'Open silhouette', str(HERE.parent / 'out' / 'silhouettes'), 'Silhouette (*.json)')
        if path:
            self.load_silhouette(Path(path))

    def load_silhouette(self, path: Path):
        try:
            self.sil = Silhouette.load(path)
        except Exception as e:
            self.status.setText(f'Could not read {path.name}: {e}')
            return
        self.sil_label.setText(f'{path.name}: {len(self.sil.turrets)} turret cells, {len(self.sil.engines)} engine cells')
        self.rebuild()

    def rebuild(self, *_a):
        if not self.sil or self.running:
            return
        sc = self.scenario()
        self.start_ship, notes = cheapest_build(self.sil, self.cat, sc['level'])
        m = measure(self.cat, self.start_ship, sc, self.validator.check(self.start_ship, self.cat) if self.validator else None)
        self.start_m = m
        self.start_view.show_ship(self.start_ship, m)
        self.best_view.show_ship(None, {})
        self.best = None
        self.chart.set([])
        self.status.setText(('\n'.join(notes) + '\n' if notes else '') + f"Start: {m['cost']:.0f} of {sc['budget']} credits, {m['points']} of {sc['points']} build points"
                            + ('.' if m['valid'] else f", and the game turns it down: {'; '.join(e['message'] for e in m['errors'][:4])}"))
        self.report.setHtml(self.report_html(m, None, []))

    # ---- running
    def start(self):
        if self.running or not self.start_ship:
            return
        sc = self.scenario()
        self.evolver = Evolver(self.cat, self.start_ship, sc, self.validator, population=self.pop.value(), seed=int(time.time()) % 100000)
        self.running, self.stop_flag = True, False
        self.go.setEnabled(False)
        self.stop_btn.setEnabled(True)
        self.run_info = {'scenario': sc, 'silhouette': self.sil.name, 'started': time.strftime('%Y-%m-%d %H:%M:%S')}
        self.run_dir = OUT / f"{time.strftime('%Y%m%d-%H%M%S')}-{''.join(ch if ch.isalnum() else '-' for ch in sc['name'].lower())[:30]}"
        self.run_dir.mkdir(parents=True, exist_ok=True)
        ev = self.evolver

        def loop():
            try:
                while not self.stop_flag:
                    best, s = ev.step()
                    self.bridge.gen.emit(ev.gen, best.copy(), s, list(ev.history))
                self.bridge.stopped.emit('Stopped.')
            except Exception as e:
                self.bridge.stopped.emit(f'Error: {type(e).__name__}: {e}')
        threading.Thread(target=loop, daemon=True).start()
        self.status.setText('Evolving...')

    def on_gen(self, gen, best, s, history):
        self.best = (best, s)
        self.best_view.show_ship(best, s['m'])
        self.chart.set(history)
        m = s['m']
        sc = self.evolver.sc
        self.status.setText(f"Generation {gen}: score {s['fit']:.3f} (the start scores {self.evolver.score(self.evolver.start)['fit']:.3f}), "
                            f"{m['cost']:.0f} of {sc['budget']} credits, {m['points']} of {sc['points']} build points, "
                            + ('valid in the game.' if m['valid'] else 'NOT valid in the game.'))
        self.report.setHtml(self.report_html(m, s, history))
        if gen % 10 == 0:
            self.autosave(gen)

    def autosave(self, gen):
        """The best so far, its picture and the score curve, in this run's folder"""
        ship, s = self.best
        d = ship.to_json()
        d.update(run=self.run_info, generation=gen, score=s['fit'], history=self.evolver.history,
                 terms=[list(t) for t in s['terms']], measures={k: v for k, v in s['m'].items() if not isinstance(v, (dict, list))})
        (self.run_dir / 'best.json').write_text(json.dumps(d, indent=1), encoding='utf-8')
        self.best_view.grab().save(str(self.run_dir / 'best.png'))

    def on_stopped(self, why):
        self.running = False
        self.go.setEnabled(True)
        self.stop_btn.setEnabled(False)
        self.status.setText(self.status.text() + ' ' + why)

    def report_html(self, m, s, history) -> str:
        base = self.evolver.base if (self.evolver and s) else m
        rows = []
        for k, words in METRICS.items():
            rows.append(f"<tr><td>{words}</td><td align=right>{m.get(k, 0):.1f}</td><td align=right>{base.get(k, 0):.1f}</td></tr>")
        terms = ''
        if s:
            terms = '<h4>Score</h4><table cellpadding=3><tr><th align=left>term</th><th>weight</th><th>value</th><th>adds</th></tr>' + ''.join(
                f"<tr><td>{k}</td><td align=right>{w:+.2f}</td><td align=right>{v:.1f}</td><td align=right>{c:+.3f}</td></tr>" for k, w, v, c in s['terms']) + \
                f"<tr><td><b>total</b></td><td></td><td></td><td align=right><b>{s['fit']:+.3f}</b></td></tr></table>"
        ship = self.best[0] if (self.best and s) else self.start_ship
        counts = Counter(self.cat.parts[p.pid]['name'] for p in ship.full()) if ship else {}
        parts = ', '.join(f'{n} {c}' for n, c in counts.most_common())
        return (terms + '<h4>Measures</h4><table cellpadding=3><tr><th align=left></th><th>this ship</th><th>start</th></tr>' + ''.join(rows)
                + f"<tr><td>cost (credits)</td><td align=right>{m['cost']:.0f}</td><td align=right>{base['cost']:.0f}</td></tr>"
                + f"<tr><td>mass</td><td align=right>{m['mass']:.0f}</td><td align=right>{base['mass']:.0f}</td></tr>"
                + f"<tr><td>build points</td><td align=right>{m['points']}</td><td align=right>{base['points']}</td></tr>"
                + f"<tr><td>parts doing nothing (unpowered / idle)</td><td align=right>{m['unpowered']} / {m['idle']}</td><td align=right>{base['unpowered']} / {base['idle']}</td></tr></table>"
                + ("<h4>The game's validator</h4><p>" + ('Valid.' if m['valid'] else '<br>'.join(e['message'] for e in m['errors'][:10])) + '</p>')
                + f'<h4>Parts</h4><p>{parts}</p>')

    # ---- keeping things
    def save_best(self):
        if not self.best:
            return
        OUT.mkdir(parents=True, exist_ok=True)
        path, _ = QFileDialog.getSaveFileName(self, 'Save best', str(OUT / f"{time.strftime('%Y%m%d-%H%M%S')}-best.json"), 'Ship (*.json)')
        if path:
            ship, s = self.best
            d = ship.to_json()
            d.update(run=self.run_info, score=s['fit'], measures={k: v for k, v in s['m'].items() if not isinstance(v, (dict, list))})
            Path(path).write_text(json.dumps(d, indent=1), encoding='utf-8')
            self.status.setText(f'Saved {Path(path).name}')

    def adopt_best(self):
        if self.best and not self.running:
            self.start_ship = self.best[0].copy()
            self.start_m = measure(self.cat, self.start_ship, self.scenario(), self.validator.check(self.start_ship, self.cat) if self.validator else None)
            self.start_view.show_ship(self.start_ship, self.start_m)
            self.status.setText('The best ship is the new start.')

    def save_note(self):
        text = self.notes.toPlainText().strip()
        if not text:
            return
        OUT.mkdir(parents=True, exist_ok=True)
        entry = {'at': time.strftime('%Y-%m-%d %H:%M:%S'), 'note': text, 'run': getattr(self, 'run_info', None),
                 'best': ({'score': self.best[1]['fit'], 'measures': {k: v for k, v in self.best[1]['m'].items() if not isinstance(v, (dict, list))},
                           'ship': self.best[0].to_json()} if self.best else None)}
        with open(OUT / 'notes.jsonl', 'a', encoding='utf-8') as f:
            f.write(json.dumps(entry) + '\n')
        self.notes.clear()
        self.note_status.setText(f'Saved to {OUT / "notes.jsonl"}')


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    log = OUT / 'crash.log'

    def hook(kind, err, tb):
        import traceback
        with open(log, 'a', encoding='utf-8') as f:
            f.write(time.strftime('%Y-%m-%d %H:%M:%S ') + ''.join(traceback.format_exception(kind, err, tb)) + '\n')
    sys.excepthook = hook
    app = QApplication(sys.argv)
    w = Window()
    w.show()
    if '--run' in sys.argv:
        name = sys.argv[sys.argv.index('--run') + 1] if len(sys.argv) > sys.argv.index('--run') + 1 else ''
        i = w.scenario_box.findText(name)
        if i >= 0:
            w.scenario_box.setCurrentIndex(i)
        from PySide6.QtCore import QTimer
        QTimer.singleShot(800, w.start)
    code = app.exec()
    if w.validator:
        w.validator.close()
    return code


if __name__ == '__main__':
    sys.exit(main())
