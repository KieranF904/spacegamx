# The ports evolver's window: ships under the ports rules (docs/design/energy-ports-2026-11.md), evolved from a start
# (hull over the outline, a core with a reactor either side, guns and engines on the silhouette's marks, the scenario's
# start parts) with no router: wiring evolves like everything else, helped by aimed changes and the wiring score.
# Each ship is scored by the Energy Lab's own model (ports_score.cjs). Open in lab shows the best ship in the lab, where
# it runs live; every 10 generations the best is saved (out/ports-<run>/: best.json, lab.json, best.png) and copied to
# prototypes/energy-lab/evolved/<scenario>.json, which the lab opens as ports.html#file=evolved/<scenario>.json.
#   --run "<scenario name>"   start evolving that scenario as soon as the window opens
#   pythonw scripts/shipgen/evolver/ports_app.py   or   npm run evolver:ports
import json
import sys
import threading
import time
import webbrowser
from collections import Counter
from pathlib import Path

from PySide6.QtCore import QPointF, QRectF, Qt, QTimer
from PySide6.QtGui import QColor, QFont, QPainter, QPen, QPolygonF
from PySide6.QtWidgets import (
    QApplication, QComboBox, QHBoxLayout, QLabel, QMainWindow, QPlainTextEdit, QPushButton, QSpinBox, QSplitter, QTabWidget, QTextBrowser,
    QToolTip, QVBoxLayout, QWidget,
)

from app import STYLE, Bridge, Chart
from model import GAME, HERE, Silhouette
from ports_evolve import PortsEvolver, PortsScorer, PShip, feed_offsets, lab_design, port_offsets, ship_from_json, ship_json

OUT = HERE / 'out'
SCENARIOS = HERE / 'ports_scenarios.json'
LAB = GAME / 'prototypes' / 'energy-lab'
EVOLVED = LAB / 'evolved'
SIDE_V = {'N': (0, -1), 'E': (1, 0), 'S': (0, 1), 'W': (-1, 0)}
MEASURES = [
    ('damage_before_down', 'damage dealt before the core goes (after the enemy\'s armour)'), ('sustained_dps', 'damage a second, power phase'),
    ('alive_s', 'seconds until the core goes'), ('half_s', 'seconds until its guns are down to half'), ('systems_kept', 'firepower, thrust and power kept, over the seconds it lasts'),
    ('wiring', 'wiring credit (unfed ports: share of the shortest path built)'), ('live_conduits', 'conduits carrying power'), ('unpowered', 'guns, engines, shields under a quarter fed'),
    ('thrust_to_mass', 'thrust for its mass'), ('engine_zone', 'engines near the back'), ('wasted', 'power wasted at generators (a second)'), ('clashes', 'ports facing the same way'),
    ('fx_share', 'share of damage from shots carrying an effect'), ('feed_used', 'feed used in the power phase'), ('feed_wiring', 'feed wiring (Combiners and feed guns fed, or the share of their path)'),
    ('idle', 'parts doing nothing'), ('detached', 'parts not joined to the core'),
]


def slug(name: str) -> str:
    return ''.join(ch if ch.isalnum() else '-' for ch in name.lower())[:30].strip('-')


class PortView(QWidget):
    """A ship drawn as the lab draws it: parts in their colours, ports on their edges (amber out, blue in), a red cross
    on anything under a quarter fed, a red port where a gun or engine's line is missing"""

    def __init__(self, win):
        super().__init__()
        self.win = win
        self.ship: PShip | None = None
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
        ev = self.win.ev_for_drawing()
        if not self.ship or not ev:
            return
        T, s = ev.T, self.ship.sil
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
        full = ev.full(self.ship)
        fed = self.m.get('fed', {})
        open_set = {(o[0], o[3], o[4], o[7]) for o in self.m.get('open', [])}
        for i, p in enumerate(full):
            t = T[p.type]
            cells = ev.cells(p)
            x0, y0 = min(c[0] for c in cells), min(c[1] for c in cells)
            w, h = ev.dims(t, p.rot)
            rect = QRectF(ox + x0 * k + 1, oy + y0 * k + 1, w * k - 2, h * k - 2)
            col = QColor(t['col'])
            if t['kind'] != 'inert':
                col = QColor.fromRgbF(col.redF() * 0.55 + 0.03, col.greenF() * 0.55 + 0.04, col.blueF() * 0.55 + 0.05)
            g.setBrush(col)
            g.setPen(QPen(QColor(t['col']).darker(130), 1))
            g.drawRoundedRect(rect, 2, 2)
            if k >= 16 and t['kind'] != 'inert' and not t.get('conduit'):
                g.setPen(QColor('#e9eff3'))
                g.setFont(QFont('Segoe UI', max(6, int(k * 0.28))))
                g.drawText(rect, Qt.AlignCenter, t['name'].split(' ')[0][:7] if w * k < 70 else t['name'])
            if k >= 8:
                for d, side, dx, dy in port_offsets(t, p.rot, p.flip):
                    px, py = x0 + dx, y0 + dy
                    is_open = (d, px, py, side) in open_set
                    colr = '#f5a83a' if d == 'out' else '#60a5fa'
                    alpha = 1.0
                    if is_open:
                        if d == 'in' and t['kind'] in ('weapon', 'engine', 'util'):
                            colr = '#ef6a5a'
                        elif d == 'out' and t['kind'] == 'gen':
                            colr = '#ef6a5a'
                        else:
                            alpha = 0.35
                    vx, vy = SIDE_V[side]
                    ux, uy = -vy, vx
                    a = k * 0.2
                    ex, ey = ox + (px + 0.5) * k + vx * k / 2, oy + (py + 0.5) * k + vy * k / 2
                    if d == 'out':
                        pts = [(ex - vx, ey - vy), (ex - vx * a + ux * a, ey - vy * a + uy * a), (ex - vx * a - ux * a, ey - vy * a - uy * a)]
                    else:
                        pts = [(ex - vx + ux * a, ey - vy + uy * a), (ex - vx - ux * a, ey - vy - uy * a), (ex - vx * a, ey - vy * a)]
                    c = QColor(colr)
                    c.setAlphaF(alpha)
                    g.setPen(Qt.NoPen)
                    g.setBrush(c)
                    g.drawPolygon(QPolygonF([QPointF(*q) for q in pts]))
            # (Feed: a pipe's channel to each side; a small square on any other part's feed point)
            if k >= 8 and t.get('feed'):
                pc = QColor('#a77bdc')
                for side, dx, dy in feed_offsets(t, p.rot, p.flip):
                    vx, vy = SIDE_V[side]
                    cx0, cy0 = ox + (x0 + dx + 0.5) * k, oy + (y0 + dy + 0.5) * k
                    ex, ey = cx0 + vx * k / 2, cy0 + vy * k / 2
                    if t['kind'] == 'pipe' or t['id'] == 'passthrough':
                        g.setPen(QPen(pc, max(2, k / 7)))
                        g.drawLine(QPointF(cx0, cy0), QPointF(ex, ey))
                    else:
                        r0 = max(2, k / 9)
                        g.setPen(Qt.NoPen)
                        g.setBrush(pc)
                        g.drawRect(QRectF(ex - vx * r0 - r0, ey - vy * r0 - r0, 2 * r0, 2 * r0))
            if t['kind'] in ('weapon', 'engine', 'util') and fed.get(str(i), fed.get(i, 1)) < 0.25:
                g.setPen(QPen(QColor('#ff3b3b'), 2))
                g.drawLine(rect.topLeft(), rect.bottomRight())
                g.drawLine(rect.topRight(), rect.bottomLeft())
        g.setPen(QPen(QColor('#2f5f8c'), 1, Qt.DashLine))
        g.drawLine(QPointF(ox + (s.mid + 0.5) * k, oy - 4), QPointF(ox + (s.mid + 0.5) * k, oy + s.h * k + 4))

    def mouseMoveEvent(self, e):
        ev = self.win.ev_for_drawing()
        if not self.ship or not ev:
            return
        k, ox, oy = self.geo()
        c, r = int((e.position().x() - ox) // k), int((e.position().y() - oy) // k)
        for i, p in enumerate(ev.full(self.ship)):
            if (c, r) in ev.cells(p):
                t = ev.T[p.type]
                lines = [f"<b>{t['name']}</b> {t['w']}x{t['h']}" + (f" turned {p.rot * 90}°" if p.rot else '') + (' flipped' if p.flip else ''),
                         t.get('say', ''), f"HP {t['hp']}, armour {t['armour']}, mass {t['mass']}, {t['cost']} credits",
                         'Ports: ' + (', '.join(f"{q['dir']} {q['side']} {q['rate']}" for q in t['ports']) or 'none') + ' (own frame: N is the nose)']
                f = self.m.get('fed', {}).get(str(i))
                if f is not None:
                    lines.append(f'gets {f * 100:.0f}% of what it wants')
                QToolTip.showText(e.globalPosition().toPoint(), '<br>'.join(x for x in lines if x), self)
                return
        QToolTip.hideText()


class Window(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle('Ship evolver: ports')
        self.setStyleSheet(STYLE)
        self.scorer = PortsScorer()
        self.ev: PortsEvolver | None = None
        self.preview: PortsEvolver | None = None
        self.best: tuple | None = None
        self.running = False
        self.stop_flag = False
        self.bridge = Bridge()
        self.bridge.gen.connect(self.on_gen)
        self.bridge.stopped.connect(self.on_stopped)
        root = QWidget()
        lay = QVBoxLayout(root)
        bar = QHBoxLayout()
        bar.addWidget(QLabel('Scenario'))
        self.scenario_box = QComboBox()
        self.scenario_box.currentIndexChanged.connect(self.scenario_changed)
        bar.addWidget(self.scenario_box)
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
        self.start_view, self.best_view = PortView(self), PortView(self)
        for v, name in ((self.start_view, 'Start'), (self.best_view, 'Best so far')):
            box = QVBoxLayout()
            box.addWidget(QLabel(name, objectName='small'))
            box.addWidget(v, 1)
            views.addLayout(box, 1)
        ll.addLayout(views, 1)
        ll.addWidget(QLabel('Amber triangle: an out port; blue: an in port; faint: facing nothing; red: a gun or engine with a line missing, or a generator '
                            'giving into nothing. Purple: feed (pipe channels, and feed points on tanks, Combiners and feed guns). Red cross: under a quarter fed. '
                            'Hover a part for its numbers. Open in lab to run it live.', objectName='small', wordWrap=True))
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
        for text, fn, tip in (('Open in lab', self.open_in_lab, 'Show the best ship in the Energy Lab (ports.html) in your browser'),
                              ('Copy for lab', self.copy_for_lab, 'Copy the best ship as a lab design (Save, share, reset > Load design from the box)'),
                              ('Start from best', self.adopt_best, 'Make the best ship the new start (its scores become the 1s)')):
            b = QPushButton(text)
            b.setToolTip(tip)
            b.clicked.connect(fn)
            row.addWidget(b)
        rl.addLayout(row)
        right.addTab(run, 'Run')
        right.addTab(self.scenarios_tab(), 'Scenarios')
        split.addWidget(right)
        split.setSizes([760, 560])
        lay.addWidget(split, 1)
        self.setCentralWidget(root)
        self.resize(1400, 880)
        self.start_ship: PShip | None = None
        self.load_scenarios()

    def ev_for_drawing(self):
        return self.ev or self.preview

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
        self.rebuild()

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
        return dict(self.scenarios[max(0, self.scenario_box.currentIndex())])

    def scenario_changed(self, *_a):
        if not self.running:
            self.start_ship = None
            self.rebuild()

    def rebuild(self, *_a):
        """The start for the scenario: the kept start (Start from best) when there is one, else the seed ship"""
        if self.running:
            return
        sc = self.scenario()
        self.scenario_box.setToolTip(sc.get('about', ''))
        self.sil = Silhouette.load(HERE / 'samples' / sc.get('silhouette', 'gunship.json'))
        if self.start_ship and self.start_ship.sil.name == self.sil.name:
            self.start_ship.sil = self.sil
        else:
            self.start_ship = None
        self.preview = PortsEvolver(self.scorer, self.sil, sc, population=2, start=self.start_ship)
        self.ev = None
        self.start_ship = self.preview.start
        m = self.preview.score(self.start_ship)['m']
        self.start_view.show_ship(self.start_ship, m)
        self.best_view.show_ship(None, {})
        self.best = None
        self.chart.set([])
        self.status.setText(f"{sc.get('about', '')} Start: {m['cost']:.0f} of {sc.get('budget')} credits, {m['points']} of {sc.get('points')} build points.")
        self.report.setHtml(self.report_html(m, None))

    def start(self):
        if self.running:
            return
        sc = self.scenario()
        self.ev = PortsEvolver(self.scorer, self.sil, sc, population=self.pop.value(), seed=int(time.time()) % 100000, start=self.start_ship)
        self.running, self.stop_flag = True, False
        self.go.setEnabled(False)
        self.stop_btn.setEnabled(True)
        self.run_info = {'scenario': sc, 'silhouette': self.sil.name, 'started': time.strftime('%Y-%m-%d %H:%M:%S')}
        self.run_dir = OUT / f"ports-{time.strftime('%Y%m%d-%H%M%S')}-{slug(sc['name'])}"
        self.run_dir.mkdir(parents=True, exist_ok=True)
        ev = self.ev

        def loop():
            try:
                while not self.stop_flag:
                    best, s = ev.step()
                    self.bridge.gen.emit(ev.gen, best.copy(), s, list(ev.history))
                self.bridge.stopped.emit('Stopped.')
            except Exception as e:
                import traceback
                with open(OUT / 'crash.log', 'a', encoding='utf-8') as f:
                    f.write(time.strftime('%Y-%m-%d %H:%M:%S ') + traceback.format_exc() + '\n')
                self.bridge.stopped.emit(f'Error: {type(e).__name__}: {e}')
        threading.Thread(target=loop, daemon=True).start()
        self.status.setText('Evolving...')

    def on_gen(self, gen, best, s, history):
        self.best = (best, s)
        self.best_view.show_ship(best, s['m'])
        self.chart.set(history)
        m, sc = s['m'], self.ev.sc
        self.status.setText(f"Generation {gen}: score {s['fit']:.2f} (the start scores {self.ev.score(self.ev.start)['fit']:.2f}). "
                            f"{m['cost']:.0f} of {sc.get('budget')} credits, {m['points']} of {sc.get('points')} build points.")
        self.report.setHtml(self.report_html(m, s))
        if gen % 10 == 0:
            self.autosave(gen)

    def lab(self) -> dict | None:
        if not self.best:
            return None
        ship, s = self.best
        m = s['m']
        about = (f"Evolved by the ports evolver ({self.ev.sc['name']}, generation {self.ev.gen}): score {s['fit']:.2f}, "
                 f"{m['sustained_dps']:.0f} damage a second, {m['damage_before_down']:.0f} dealt before the core went, {m['cost']:.0f} credits.")
        return lab_design(self.ev, ship, f"Evolved: {self.ev.sc['name']}", about)

    def autosave(self, gen):
        ship, s = self.best
        d = ship_json(self.ev, ship)
        d.update(run=self.run_info, generation=gen, score=s['fit'], history=self.ev.history, terms=[list(t) for t in s['terms']],
                 measures={k: v for k, v in s['m'].items() if not isinstance(v, (dict, list))})
        (self.run_dir / 'best.json').write_text(json.dumps(d, indent=1), encoding='utf-8')
        lab = json.dumps(self.lab())
        (self.run_dir / 'lab.json').write_text(lab, encoding='utf-8')
        EVOLVED.mkdir(parents=True, exist_ok=True)
        (EVOLVED / f"{slug(self.ev.sc['name'])}.json").write_text(lab, encoding='utf-8')
        self.best_view.grab().save(str(self.run_dir / 'best.png'))

    def open_in_lab(self):
        lab = self.lab()
        if not lab:
            self.status.setText('Nothing evolved yet.')
            return
        # (A small page that sends the browser on to the lab with the design in the address: a file:// link can't
        # carry the part after # through the shell)
        from urllib.parse import quote
        url = (LAB / 'ports.html').as_uri() + '#design=' + quote(json.dumps(lab, separators=(',', ':')))
        page = OUT / 'open-in-lab.html'
        page.write_text(f'<!doctype html><meta charset="utf-8"><script>location.replace({json.dumps(url)})</script>', encoding='utf-8')
        webbrowser.open(page.as_uri())

    def copy_for_lab(self):
        lab = self.lab()
        if lab:
            QApplication.clipboard().setText(json.dumps(lab))
            self.status.setText('Copied. In the lab: Save, share, reset > paste into the box > Load design from the box.')

    def adopt_best(self):
        if self.best and not self.running:
            self.start_ship = self.best[0].copy()
            self.rebuild()
            self.status.setText('The best ship is the new start.')

    def on_stopped(self, why):
        self.running = False
        self.go.setEnabled(True)
        self.stop_btn.setEnabled(False)
        self.status.setText(self.status.text() + ' ' + why)

    def report_html(self, m, s) -> str:
        base = self.ev.base if (self.ev and s) else m
        rows = ''.join(f"<tr><td>{words}</td><td align=right>{m.get(k, 0):.2f}</td><td align=right>{base.get(k, 0):.2f}</td></tr>" for k, words in MEASURES)
        terms = ''
        if s:
            terms = '<h4>Score</h4><table cellpadding=3><tr><th align=left>term</th><th>weight</th><th>value</th><th>adds</th></tr>' + ''.join(
                f"<tr><td>{k}</td><td align=right>{w:+.2f}</td><td align=right>{v:.1f}</td><td align=right>{c:+.3f}</td></tr>" for k, w, v, c in s['terms']) + \
                f"<tr><td><b>total</b></td><td></td><td></td><td align=right><b>{s['fit']:+.3f}</b></td></tr></table>"
        ship = self.best[0] if (self.best and s) else self.start_ship
        ev = self.ev_for_drawing()
        counts = Counter(ev.T[p.type]['name'] for p in ev.full(ship)) if (ship and ev) else {}
        parts = ', '.join(f'{n} {c}' for n, c in counts.most_common())
        return (terms + '<h4>Measures</h4><table cellpadding=3><tr><th align=left></th><th>this ship</th><th>start</th></tr>' + rows
                + f"<tr><td>cost (credits)</td><td align=right>{m['cost']:.0f}</td><td align=right>{base['cost']:.0f}</td></tr>"
                + f"<tr><td>mass</td><td align=right>{m['mass']:.0f}</td><td align=right>{base['mass']:.0f}</td></tr>"
                + f"<tr><td>build points</td><td align=right>{m['points']}</td><td align=right>{base['points']}</td></tr></table>"
                + f'<h4>Parts</h4><p>{parts}</p>')

    def closeEvent(self, e):
        self.stop_flag = True
        self.scorer.close()
        super().closeEvent(e)


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
        QTimer.singleShot(800, w.start)
    return app.exec()


if __name__ == '__main__':
    sys.exit(main())
