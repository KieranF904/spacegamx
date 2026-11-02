# The Shipgen window: the form (make ships in a batch, one ship, evolve, compare), the live view (progress strip, the
# assembly grid beside the rendered picture, metrics, step log), the saved ships with ratings, this session's designs and
# every run on disk. The live view always shows the newest run: the app's own, else the newest one from the command line.
import html
import json
import os
import time
import webbrowser
from pathlib import Path

from PySide6.QtCore import QSettings, QSize, Qt, QTimer
from PySide6.QtGui import QColor, QIcon, QPainter, QPixmap, QStandardItemModel
from PySide6.QtWidgets import (
    QAbstractItemView, QButtonGroup, QCheckBox, QComboBox, QDoubleSpinBox, QFrame, QGridLayout, QHBoxLayout, QLabel,
    QListWidget, QListWidgetItem, QMainWindow, QMessageBox, QPlainTextEdit, QPushButton, QScrollArea, QSizeGrip, QSizePolicy, QSpinBox,
    QSplitter, QTabWidget, QTextBrowser, QToolButton, QVBoxLayout, QWidget,
)

from engine import Engine
from grid import CATEGORY_NAMES, COLOURS, GridView, parse_grid
from steplog import StepLog

esc = lambda s: html.escape(str(s if s is not None else ''))
STEP_NAMES = ['power', 'weapons', 'engines', 'fittings', 'armour', 'shape']
MODES = [('batch', 'Make ships'), ('design', 'One ship'), ('evolve', 'Evolve'), ('compare', 'Compare')]
GO_TEXT = {'batch': 'Start making ships', 'design': 'Design one ship', 'evolve': 'Start evolving', 'compare': 'Compare the models'}
SCORE_WORDS = {
    'power': 'power: guns and engines fed', 'fit': 'fit: what the role is for', 'lean': 'lean: not mostly power plant', 'symmetry': 'symmetry',
    'armourOutside': 'shell outside', 'enginesAft': 'engines aft', 'gunsOut': 'guns out', 'compactness': 'compact rows', 'silhouette': 'shaped outline',
}

STYLE = """
* { font-family: 'Segoe UI'; font-size: 13px; }
QMainWindow, QWidget { background: #0b0e12; color: #cfd8e1; }
QLabel, QCheckBox { background: transparent; }
QFrame#panel { background: #12171d; border: 1px solid #232c36; border-radius: 6px; }
QLabel#muted { color: #7c8896; }
QLabel#small { color: #7c8896; font-size: 11px; }
QLabel#h { color: #7c8896; font-size: 11px; font-weight: 600; letter-spacing: 1px; }
QPushButton, QToolButton { background: #171d24; color: #cfd8e1; border: 1px solid #232c36; border-radius: 4px; padding: 5px 10px; }
QPushButton:hover:!disabled, QToolButton:hover:!disabled { border-color: #6cb8ff; }
QPushButton:disabled { color: #4a5563; }
QPushButton#primary { background: #1d3a57; border-color: #2f5f8c; padding: 9px; font-size: 14px; }
QPushButton#danger:!disabled { background: #4a1f22; border-color: #7a3035; }
QPushButton#tab { padding: 6px 4px; font-size: 12px; }
QPushButton#tab:checked { background: #1d3a57; border-color: #2f5f8c; color: white; }
QComboBox, QSpinBox, QDoubleSpinBox, QPlainTextEdit, QLineEdit { background: #0e1217; color: #cfd8e1; border: 1px solid #232c36; border-radius: 4px; padding: 3px 5px; }
QComboBox QAbstractItemView { background: #0e1217; color: #cfd8e1; selection-background-color: #1d3a57; }
QTextBrowser, QListWidget { background: #0e1217; border: 1px solid #232c36; border-radius: 4px; }
QListWidget::item:selected { background: #1d3a57; }
QTabWidget::pane { border: 1px solid #232c36; border-radius: 4px; }
QTabBar::tab { background: #12171d; color: #7c8896; padding: 6px 14px; border: 1px solid #232c36; border-bottom: none; }
QTabBar::tab:selected { color: #cfd8e1; background: #171d24; }
QCheckBox { spacing: 6px; }
QSplitter::handle { background: #0b0e12; }
QScrollArea { border: none; }
"""


def label(text: str = '', name: str | None = None, wrap: bool = False) -> QLabel:
    l = QLabel(text)
    if name:
        l.setObjectName(name)
    l.setWordWrap(wrap)
    return l


def panel() -> QFrame:
    f = QFrame()
    f.setObjectName('panel')
    return f


def clock(ms: float) -> str:
    s = int(ms // 1000)
    return f'{s // 60}:{s % 60:02d}'


class StepsBar(QWidget):
    """The staged build's steps as segments: done green, current blue, failed red, skipped grey"""
    COLOURS = {'done': '#5fd39a', 'on': '#6cb8ff', 'failed': '#ef6b6b', 'skipped': '#3a4552', '': '#222a33'}

    def __init__(self):
        super().__init__()
        self.steps: list[tuple[str, str]] = []
        self.setFixedHeight(26)

    def set_steps(self, steps: list[tuple[str, str]]) -> None:
        self.steps = steps
        self.setVisible(bool(steps))
        self.update()

    def paintEvent(self, _e) -> None:
        if not self.steps:
            return
        g = QPainter(self)
        g.setRenderHint(QPainter.Antialiasing)
        n, gap = len(self.steps), 4
        w = (self.width() - gap * (n - 1)) / n
        for i, (name, st) in enumerate(self.steps):
            x = i * (w + gap)
            g.setPen(Qt.NoPen)
            g.setBrush(QColor(self.COLOURS.get(st, '#222a33')))
            g.drawRoundedRect(int(x), 2, int(w), 6, 3, 3)
            g.setPen(QColor('#7c8896'))
            g.drawText(int(x), 22, name)


class PictureView(QLabel):
    """The rendered picture, scaled to fit; plays a timelapse's frames"""

    def __init__(self):
        super().__init__()
        self.setAlignment(Qt.AlignCenter)
        self.setMinimumSize(240, 240)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setStyleSheet('background:#080a0d;border:1px solid #232c36;border-radius:4px;color:#3a4552;')
        self.pix: QPixmap | None = None
        self.frames: list[str] = []
        self.frame = 0
        self.timer = QTimer(self)
        self.timer.timeout.connect(self._next)
        self.show_file(None)

    def show_file(self, path: str | None, keep_frames: bool = False) -> None:
        if not keep_frames:
            self.timer.stop()
        if path and os.path.exists(path):
            self.pix = QPixmap(path)
            self._fit()
        else:
            self.pix = None
            self.setPixmap(QPixmap())
            self.setText('no picture yet')

    def play(self, files: list[str]) -> None:
        self.frames, self.frame = files, 0
        if files:
            self.timer.start(140)

    def _next(self) -> None:
        if self.frame >= len(self.frames):
            self.timer.stop()
            return
        self.show_file(self.frames[self.frame], keep_frames=True)
        self.frame += 1

    def _fit(self) -> None:
        if self.pix and not self.pix.isNull():
            self.setPixmap(self.pix.scaled(self.size() - QSize(4, 4), Qt.KeepAspectRatio, Qt.SmoothTransformation))

    def resizeEvent(self, e) -> None:
        self._fit()
        super().resizeEvent(e)


class MainWindow(QMainWindow):
    def __init__(self, engine: Engine):
        super().__init__()
        self.engine = engine
        self.prefs = QSettings('Spacegame', 'Shipgen')
        self.setWindowTitle('Shipgen')
        self.setStyleSheet(STYLE)
        self.legend: dict[str, str] = {}
        self.roles: list[dict] = []
        self.models: list[dict] = []
        self.library: list[dict] = []
        self.run_id: str | None = None
        self.run_mode: str | None = None
        self.run_status = 'idle'
        self.watching: str | None = None
        self.watch_ended = False
        self.pinned: str | None = None
        self.mode = 'design'
        self.selected: dict | None = None
        self.start_bp: dict | None = None
        self.progress: dict | None = None
        self.prev_cells = None
        self.final_cells = None
        self.checks: dict[str, dict] = {}
        self.ships: list[dict] = []
        self.ships_key = ''
        self.renderer_state = 'starting'
        self._build()
        self.engine.message.connect(self.on_message)
        self.engine.died.connect(self.on_died)
        self.follow_timer = QTimer(self)
        self.follow_timer.timeout.connect(self.follow)
        self.tick = QTimer(self)
        self.tick.timeout.connect(self._tick)
        self.tick.start(1000)
        self.ships_timer = QTimer(self)
        self.ships_timer.timeout.connect(self.refresh_ships)
        self.ships_timer.start(30000)

    # ------------------------------------------------------------------------------------------------------- building
    def _build(self) -> None:
        root = QSplitter(Qt.Vertical)
        top = QSplitter(Qt.Horizontal)
        top.addWidget(self._controls())
        top.addWidget(self._stage())
        top.addWidget(self._log())
        top.setStretchFactor(1, 1)
        self.top = top
        root.addWidget(top)
        root.addWidget(self._bottom())
        self.root = root
        self.setCentralWidget(root)
        self.grip = QSizeGrip(self)
        self.grip.setVisible(False)
        self.laid_out = False

    def _controls(self) -> QWidget:
        box = panel()
        lay = QVBoxLayout(box)
        tabs = QHBoxLayout()
        self.mode_group = QButtonGroup(self)
        self.mode_buttons = {}
        for m, text in MODES:
            b = QPushButton(text)
            b.setObjectName('tab')
            b.setCheckable(True)
            self.mode_group.addButton(b)
            self.mode_buttons[m] = b
            b.clicked.connect(lambda _=False, m=m: self.set_mode(m))
            tabs.addWidget(b)
        lay.addLayout(tabs)

        self.model_label = label('Model', 'muted')
        lay.addWidget(self.model_label)
        self.model = QComboBox()
        lay.addWidget(self.model)
        self.model2_label = label('Second model', 'muted')
        self.model2 = QComboBox()
        lay.addWidget(self.model2_label)
        lay.addWidget(self.model2)
        self.model_note = label('', 'small', wrap=True)
        lay.addWidget(self.model_note)

        # (Make ships)
        self.batch_box = QWidget()
        bl = QVBoxLayout(self.batch_box)
        bl.setContentsMargins(0, 0, 0, 0)
        bl.addWidget(label('Roles (made in turn)', 'muted'))
        self.role_grid = QGridLayout()
        bl.addLayout(self.role_grid)
        self.role_checks: dict[str, QCheckBox] = {}
        row = QGridLayout()
        row.addWidget(label('Ships to make', 'muted'), 0, 0)
        row.addWidget(label('Minutes per ship', 'muted'), 0, 1)
        self.max_ships = QSpinBox()
        self.max_ships.setRange(0, 1000)
        self.max_ships.setSpecialValueText('until stopped')
        self.ship_minutes = QSpinBox()
        self.ship_minutes.setRange(5, 1440)
        self.ship_minutes.setValue(120)
        row.addWidget(self.max_ships, 1, 0)
        row.addWidget(self.ship_minutes, 1, 1)
        bl.addLayout(row)
        bl.addWidget(label('Refinement rounds after a valid design', 'muted'))
        self.refine = QSpinBox()
        self.refine.setRange(0, 10)
        self.refine.setValue(3)
        bl.addWidget(self.refine)
        lay.addWidget(self.batch_box)

        # (One ship, evolve, compare)
        self.single_box = QWidget()
        sl = QVBoxLayout(self.single_box)
        sl.setContentsMargins(0, 0, 0, 0)
        sl.addWidget(label('Role', 'muted'))
        self.role = QComboBox()
        self.role.currentIndexChanged.connect(self.role_changed)
        sl.addWidget(self.role)
        self.role_summary = label('', 'small', wrap=True)
        sl.addWidget(self.role_summary)
        self.start_label = label('Start from (change a ship instead of starting blank)', 'muted')
        sl.addWidget(self.start_label)
        self.start_from = QComboBox()
        self.start_from.activated.connect(self.start_picked)
        sl.addWidget(self.start_from)
        lay.addWidget(self.single_box)

        lay.addWidget(label('Description (what you want; added to the brief)', 'muted'))
        self.note = QPlainTextEdit()
        self.note.setPlaceholderText('e.g. long and narrow, a needle nose, engines in a row at the tail')
        self.note.setMaximumHeight(80)
        lay.addWidget(self.note)
        self.go = QPushButton('Start')
        self.go.setObjectName('primary')
        self.go.clicked.connect(self.start_run)
        lay.addWidget(self.go)
        self.form_msg = label('', 'small', wrap=True)
        lay.addWidget(self.form_msg)

        self.adv_toggle = QToolButton()
        self.adv_toggle.setText('Advanced')
        self.adv_toggle.setCheckable(True)
        self.adv_toggle.setArrowType(Qt.RightArrow)
        self.adv_toggle.setToolButtonStyle(Qt.ToolButtonTextBesideIcon)
        self.adv_toggle.toggled.connect(lambda on: (self.adv.setVisible(on), self.adv_toggle.setArrowType(Qt.DownArrow if on else Qt.RightArrow)))
        lay.addWidget(self.adv_toggle)
        self.adv = QWidget()
        al = QVBoxLayout(self.adv)
        al.setContentsMargins(0, 0, 0, 0)
        al.addWidget(label('Build', 'muted'))
        self.build = QComboBox()
        for v, t in [('auto', 'auto: by role (small ships in one go, the rest in steps)'), ('oneshot', 'one go: the whole ship each round'), ('staged', 'in steps: outline, power, guns, engines, fittings, armour, shape')]:
            self.build.addItem(t, v)
        al.addWidget(self.build)
        al.addWidget(label('Reply format', 'muted'))
        self.contract = QComboBox()
        self.contract.addItem('auto (measured per model)', 'auto')
        al.addWidget(self.contract)
        self.concept = QCheckBox('concept first: a short plan the rounds follow')
        self.concept.setChecked(True)
        self.mirror = QCheckBox('mirror: the model writes the left half')
        self.mirror.setChecked(True)
        self.think = QCheckBox('let thinking models think (better, slower)')
        self.think.setChecked(True)
        for c in (self.concept, self.mirror, self.think):
            al.addWidget(c)
        g = QGridLayout()
        g.addWidget(label('Temperature', 'muted'), 0, 0)
        g.addWidget(label('Tries (per step)', 'muted'), 0, 1)
        self.temperature = QDoubleSpinBox()
        self.temperature.setRange(0, 1.5)
        self.temperature.setSingleStep(0.05)
        self.temperature.setValue(0.6)
        self.rounds = QSpinBox()
        self.rounds.setRange(0, 20)
        self.rounds.setSpecialValueText('default')
        g.addWidget(self.temperature, 1, 0)
        g.addWidget(self.rounds, 1, 1)
        self.evolve_row = QWidget()
        el = QGridLayout(self.evolve_row)
        el.setContentsMargins(0, 0, 0, 0)
        el.addWidget(label('Children / gen', 'muted'), 0, 0)
        el.addWidget(label('Generations', 'muted'), 0, 1)
        self.population = QSpinBox()
        self.population.setRange(1, 12)
        self.population.setValue(3)
        self.generations = QSpinBox()
        self.generations.setRange(1, 10)
        self.generations.setValue(2)
        el.addWidget(self.population, 1, 0)
        el.addWidget(self.generations, 1, 1)
        self.compare_row = QWidget()
        cl = QHBoxLayout(self.compare_row)
        cl.setContentsMargins(0, 0, 0, 0)
        cl.addWidget(label('Trials each', 'muted'))
        self.trials = QSpinBox()
        self.trials.setRange(1, 10)
        self.trials.setValue(2)
        cl.addWidget(self.trials)
        self.size_row = QWidget()
        zl = QGridLayout(self.size_row)
        zl.setContentsMargins(0, 0, 0, 0)
        zl.addWidget(label('Tier (max level)', 'muted'), 0, 0)
        zl.addWidget(label('Size (cells, min / max)', 'muted'), 0, 1, 1, 2)
        self.max_level = QSpinBox()
        self.max_level.setRange(0, 99)
        self.max_level.setSpecialValueText('role')
        self.cells_min = QSpinBox()
        self.cells_min.setRange(0, 2000)
        self.cells_min.setSpecialValueText('role')
        self.cells_max = QSpinBox()
        self.cells_max.setRange(0, 2000)
        self.cells_max.setSpecialValueText('role')
        zl.addWidget(self.max_level, 1, 0)
        zl.addWidget(self.cells_min, 1, 1)
        zl.addWidget(self.cells_max, 1, 2)
        al.addLayout(g)
        al.addWidget(self.evolve_row)
        al.addWidget(self.compare_row)
        al.addWidget(self.size_row)
        self.critic_label = label('Critic (a vision model rates looks; recorded, not scored)', 'muted')
        self.critic = QComboBox()
        al.addWidget(self.critic_label)
        al.addWidget(self.critic)
        self.lms = QCheckBox('let LM Studio chat (loads the model there)')
        self.lms.toggled.connect(self.lms_changed)
        al.addWidget(self.lms)
        self.colours = label('', 'small', wrap=True)
        self.colours.setTextFormat(Qt.RichText)
        self.colours.setText(' '.join(f'<span style="color:{c}">■</span> {esc(CATEGORY_NAMES[k])}' for k, c in COLOURS.items()) +
                             ' <span style="color:#ffd866">▢</span> changed this round <span style="color:#ff5b5b">■</span> unpowered')
        al.addWidget(self.colours)
        self.adv.setVisible(False)
        lay.addWidget(self.adv)
        lay.addStretch(1)
        self.build.currentIndexChanged.connect(lambda: self.prefs.setValue('build', self.build.currentData()))

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll.setWidget(box)
        scroll.setMinimumWidth(330)
        self.controls_box = scroll
        return scroll

    def _stage(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        lay.setContentsMargins(0, 0, 0, 0)
        head = QHBoxLayout()
        title = label('Shipgen')
        title.setStyleSheet('font-size:15px;font-weight:600;')
        self.title_label = title
        head.addWidget(title)
        self.status = label('idle')
        self.status.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Fixed)
        self.status.setStyleSheet('border:1px solid #232c36;border-radius:9px;padding:1px 8px;font-size:11px;')
        head.addWidget(self.status)
        self.run_info = label('', 'muted')
        self.run_info.setMinimumWidth(0)
        self.run_info.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
        head.addWidget(self.run_info, 1)
        self.head_gap = QWidget()
        head.addWidget(self.head_gap, 0)
        self.renderer_label = label('renderer: starting', 'small')
        head.addWidget(self.renderer_label)
        self.live = label('', 'small')
        head.addWidget(self.live)
        self.preview_caption = label('', 'small')
        self.preview_caption.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
        head.addWidget(self.preview_caption, 1)
        self.borderless = QPushButton('Borderless')
        self.borderless.setObjectName('tab')
        self.borderless.setCheckable(True)
        self.borderless.setToolTip('No window frame: drag the picture to move it, the corner to resize it')
        self.borderless.toggled.connect(self.set_borderless)
        head.addWidget(self.borderless)
        self.on_top = QPushButton('On top')
        self.on_top.setObjectName('tab')
        self.on_top.setCheckable(True)
        self.on_top.setToolTip('Keep this window above the others')
        self.on_top.toggled.connect(self.keep_on_top)
        head.addWidget(self.on_top)
        self.view_buttons = {}
        for v, text, tip in [('studio', 'Studio', 'Everything: the form, the live view, the log and the ships'), ('live', 'Preview', 'Just the rendered picture, in a small window you can keep on top'),
                             ('ships', 'Ships', 'The saved ships, large, beside the selected one')]:
            b = QPushButton(text)
            b.setObjectName('tab')
            b.setCheckable(True)
            b.setToolTip(tip)
            b.clicked.connect(lambda _=False, v=v: self.set_view(v))
            head.addWidget(b)
            self.view_buttons[v] = b
        self.back = QPushButton('Back to the app')
        self.back.setObjectName('tab')
        self.back.clicked.connect(lambda: self.set_view('studio'))
        head.addWidget(self.back)
        self.stop = QPushButton('Stop')
        self.stop.setObjectName('danger')
        self.stop.setEnabled(False)
        self.stop.clicked.connect(self.stop_run)
        head.addWidget(self.stop)
        lay.addLayout(head)

        self.progress_box = panel()
        pl = QVBoxLayout(self.progress_box)
        pt = QHBoxLayout()
        self.p_title = label('')
        self.p_title.setStyleSheet('font-weight:600;')
        self.p_where = label('', 'muted')
        self.p_clock = label('', 'muted')
        pt.addWidget(self.p_title)
        pt.addWidget(self.p_where, 1)
        pt.addWidget(self.p_clock)
        pl.addLayout(pt)
        self.p_steps = StepsBar()
        pl.addWidget(self.p_steps)
        self.p_tally = label('', 'small')
        pl.addWidget(self.p_tally)
        self.progress_box.setVisible(False)
        lay.addWidget(self.progress_box)

        self.concept_note = label('', 'small', wrap=True)
        lay.addWidget(self.concept_note)

        views = QSplitter(Qt.Horizontal)
        gw = QWidget()
        self.grid_box = gw
        gl = QVBoxLayout(gw)
        gl.setContentsMargins(0, 0, 0, 0)
        self.grid_tag = label('ASSEMBLY', 'h')
        gl.addWidget(self.grid_tag)
        self.grid = GridView()
        gl.addWidget(self.grid, 1)
        pw = QWidget()
        pl2 = QVBoxLayout(pw)
        pl2.setContentsMargins(0, 0, 0, 0)
        self.render_tag = label('RENDER', 'h')
        pl2.addWidget(self.render_tag)
        self.picture = PictureView()
        pl2.addWidget(self.picture, 1)
        views.addWidget(gw)
        views.addWidget(pw)
        lay.addWidget(views, 3)
        self.foot = label('', 'small')
        lay.addWidget(self.foot)

        sel = panel()
        self.sel_box = sel
        sl = QHBoxLayout(sel)
        sl.addWidget(label('Selected:', 'muted'))
        self.sel_name = label('none yet')
        self.sel_name.setStyleSheet('font-weight:600;')
        sl.addWidget(self.sel_name)
        self.sel_score = label('', 'muted')
        sl.addWidget(self.sel_score)
        self.stars = []
        for i in range(1, 6):
            b = QToolButton()
            b.setText('★')
            b.setToolTip('rate this saved ship (click the same star again to clear)')
            b.setStyleSheet('QToolButton{border:none;background:transparent;font-size:16px;color:#3a4552;padding:0 1px;}')
            b.clicked.connect(lambda _=False, i=i: self.rate(i))
            sl.addWidget(b)
            self.stars.append(b)
        sl.addStretch(1)
        self.act_save = QPushButton('Save to library')
        self.act_save.setToolTip('Write data/ships/blueprints/dev/gen-<role>-<n>.json (flyable from the F9 panel after a game-server restart)')
        self.act_lab = QPushButton('Open in Energy Lab')
        self.act_start = QPushButton('Use as start point')
        self.act_lapse = QPushButton('Timelapse')
        self.act_folder = QPushButton('Show folder')
        for b, f in [(self.act_save, self.save_selected), (self.act_lab, self.lab_selected), (self.act_start, self.use_as_start), (self.act_lapse, self.timelapse), (self.act_folder, self.open_folder)]:
            b.clicked.connect(f)
            b.setEnabled(False)
            sl.addWidget(b)
        lay.addWidget(sel)
        self.act_msg = label('', 'small', wrap=True)
        lay.addWidget(self.act_msg)
        self.metrics = QTextBrowser()
        self.metrics.setMinimumHeight(120)
        lay.addWidget(self.metrics, 1)
        self._stars(None)
        return w

    def _log(self) -> QWidget:
        box = panel()
        box.setMinimumWidth(340)
        self.log_box = box
        lay = QVBoxLayout(box)
        head = QHBoxLayout()
        head.addWidget(label('STEP LOG', 'h'))
        head.addStretch(1)
        self.follow_check = QCheckBox('follow')
        self.follow_check.setChecked(True)
        head.addWidget(self.follow_check)
        lay.addLayout(head)
        self.log = StepLog()
        self.follow_check.toggled.connect(lambda on: setattr(self.log, 'follow', on))
        lay.addWidget(self.log, 1)
        return box

    def _bottom(self) -> QWidget:
        tabs = QTabWidget()
        sw = QWidget()
        sl = QVBoxLayout(sw)
        row = QHBoxLayout()
        self.ships_role = QComboBox()
        self.ships_role.addItem('all roles', '')
        self.ships_sort = QComboBox()
        for v, t in [('new', 'newest first'), ('score', 'best score first'), ('rating', 'best rated first')]:
            self.ships_sort.addItem(t, v)
        self.ships_role.currentIndexChanged.connect(self.draw_ships)
        self.ships_sort.currentIndexChanged.connect(self.draw_ships)
        row.addWidget(self.ships_role)
        row.addWidget(self.ships_sort)
        self.ships_count = label('', 'small')
        row.addWidget(self.ships_count)
        row.addStretch(1)
        sl.addLayout(row)
        self.ships_list = self._cards()
        self.ships_list.itemClicked.connect(self.open_ship)
        sl.addWidget(self.ships_list)
        tabs.addTab(sw, 'Saved ships')
        self.gallery = self._cards()
        self.gallery.itemClicked.connect(self.open_gallery)
        tabs.addTab(self.gallery, 'This session')
        rw = QWidget()
        rl = QVBoxLayout(rw)
        rl.addWidget(label('The live view always shows the newest run. Pick one here to look at it until it ends.', 'small'))
        self.runs_list = QListWidget()
        self.runs_list.itemClicked.connect(self.pick_run)
        rl.addWidget(self.runs_list)
        tabs.addTab(rw, 'All runs')
        tabs.currentChanged.connect(lambda i: self.refresh_runs() if i == 2 else None)
        self.bottom_tabs = tabs
        return tabs

    def _cards(self) -> QListWidget:
        l = QListWidget()
        l.setViewMode(QListWidget.IconMode)
        l.setIconSize(QSize(150, 150))
        l.setGridSize(QSize(172, 236))
        l.setResizeMode(QListWidget.Adjust)
        l.setMovement(QListWidget.Static)
        l.setWordWrap(True)
        l.setSelectionMode(QAbstractItemView.SingleSelection)
        return l

    # ------------------------------------------------------------------------------------------------------- start up
    def boot(self) -> None:
        self.engine.call('info', cb=self._info)

    def _info(self, r, err) -> None:
        if err:
            self.form_msg.setText(f'engine: {err}')
            return
        self.roles = r['roles']
        self.legend = {x['code']: x['cat'] for x in r['legend']}
        self.grid.legend = self.legend
        self.library = r['library']
        for c in r['contracts']:
            self.contract.addItem(f'{c["id"]}: {c["label"]}', c['id'])
        picked = self.prefs.value('roles', [x['id'] for x in self.roles])
        if isinstance(picked, str):
            picked = [picked]
        for i, ro in enumerate(self.roles):
            c = QCheckBox(ro['name'])
            c.setToolTip(f'{ro["summary"]}. {ro["size"]["cells"][0]}-{ro["size"]["cells"][1]} cells')
            c.setChecked(ro['id'] in picked)
            self.role_grid.addWidget(c, i // 2, i % 2)
            self.role_checks[ro['id']] = c
        self.role.addItem('(no role: the description only)', '')
        for ro in self.roles:
            self.role.addItem(ro['name'], ro['id'])
        self.role.setCurrentIndex(max(0, self.role.findData(self.prefs.value('role', 'starter'))))
        self.start_from.addItem('(blank: a new design)', '')
        self.start_from.addItem('(the selected design)', 'sel')
        self._enable_item(self.start_from, 1, False)
        groups: dict[str, list] = {}
        for s in self.library:
            groups.setdefault(s['group'], []).append(s)
        for gname, ss in groups.items():
            self.start_from.insertSeparator(self.start_from.count())
            for s in ss:
                self.start_from.addItem(f'{gname}: {s["name"]}', s['id'])
        # (Remembered settings)
        p = self.prefs
        self.temperature.setValue(float(p.value('temperature', 0.6)))
        self.max_ships.setValue(int(p.value('maxShips', 0)))
        self.ship_minutes.setValue(int(p.value('shipMinutes', 120)))
        self.refine.setValue(int(p.value('refine', 3)))
        self.concept.setChecked(p.value('concept', 'true') != 'false')
        self.mirror.setChecked(p.value('mirror', 'true') != 'false')
        self.think.setChecked(p.value('think', 'true') != 'false')
        self.set_mode(p.value('mode', 'batch'))
        self.build.setCurrentIndex(max(0, self.build.findData(p.value('build', 'auto' if self.mode == 'batch' else 'oneshot'))))
        self.contract.setCurrentIndex(max(0, self.contract.findData(p.value('contract', 'auto'))))
        self.role_changed()
        self.load_models()
        self.refresh_ships()
        self.refresh_gallery()
        self.engine.call('runs', cb=self._first_runs)

    def _first_runs(self, r, err) -> None:
        live = next((x for x in (r or {}).get('runs', []) if x['status'] == 'running'), None)
        if live:
            self.attach(live['id'], live['mode'], replay=True)
        self.follow_timer.start(3000)
        self.follow()

    @staticmethod
    def _enable_item(combo: QComboBox, i: int, on: bool) -> None:
        m = combo.model()
        if isinstance(m, QStandardItemModel):
            it = m.item(i)
            if it:
                it.setEnabled(on)

    def load_models(self) -> None:
        self.engine.call('models', {'fresh': True}, self._models)

    def _models(self, r, err) -> None:
        if err:
            self.model_note.setText(f'models: {err}')
            return
        self.models = r['models']
        self.lms.blockSignals(True)
        self.lms.setChecked(bool(r['lmstudioChat']))
        self.lms.blockSignals(False)
        chat = [m for m in self.models if m.get('chat')]
        local = [m for m in chat if not m.get('cloud') and not m.get('off')]
        self._fill_models(self.model, chat, self.prefs.value('model', local[0]['id'] if local else ''))
        self._fill_models(self.model2, chat, self.prefs.value('model2', local[1]['id'] if len(local) > 1 else ''))
        self._fill_models(self.critic, [m for m in chat if m.get('vision')], self.prefs.value('critic', ''), none='(no critic)')
        notes = []
        if not local:
            notes.append('No local model is ready: start Ollama, or load a model in LM Studio and tick "let LM Studio chat" under Advanced.')
        if any(m.get('provider') == 'lmstudio' and m.get('off') for m in self.models):
            notes.append('LM Studio models are listed only until "let LM Studio chat" is ticked (Advanced).')
        self.model_note.setText(' '.join(notes))

    def _fill_models(self, combo: QComboBox, models: list[dict], pick: str, none: str | None = None) -> None:
        combo.clear()
        combo.addItem(none or '(pick a model)', '')
        groups = [('Local: Ollama', [m for m in models if not m.get('cloud') and m['provider'] == 'ollama']),
                  ('Local: LM Studio', [m for m in models if not m.get('cloud') and m['provider'] == 'lmstudio']),
                  ('Cloud (an outside service; costs money)', [m for m in models if m.get('cloud')])]
        for g, ms in groups:
            if not ms:
                continue
            combo.addItem(f'— {g} —', None)
            self._enable_item(combo, combo.count() - 1, False)
            for m in ms:
                text = f'{m["name"]}{"  " + m["params"] if m.get("params") else ""}{" · vision" if m.get("vision") else ""}{" · CLOUD (paid)" if m.get("cloud") else ""}{" · " + m["off"] if m.get("off") else ""}'
                combo.addItem(text, m['id'])
                if m.get('off'):
                    self._enable_item(combo, combo.count() - 1, False)
        i = combo.findData(pick) if pick else -1
        ok = i > 0 and not next((m for m in models if m['id'] == pick and m.get('off')), None)
        combo.setCurrentIndex(i if ok else 0)

    def lms_changed(self, on: bool) -> None:
        self.engine.call('settings', {'lmstudioChat': on}, lambda r, e: (self.form_msg.setText(e or ('LM Studio may chat now: a run with an LM Studio model will LOAD it there.' if on else 'LM Studio models are listed only again.')), self.load_models()))

    # ------------------------------------------------------------------------------------------------------- the form
    def set_mode(self, mode: str) -> None:
        if mode not in dict(MODES):
            mode = 'batch'
        self.mode = mode
        self.mode_buttons[mode].setChecked(True)
        batch = mode == 'batch'
        self.batch_box.setVisible(batch)
        self.single_box.setVisible(not batch)
        self.start_label.setVisible(mode in ('design', 'evolve'))
        self.start_from.setVisible(mode in ('design', 'evolve'))
        self.model2_label.setVisible(mode == 'compare')
        self.model2.setVisible(mode == 'compare')
        self.model_label.setText('First model' if mode == 'compare' else 'Model')
        self.evolve_row.setVisible(mode == 'evolve')
        self.compare_row.setVisible(mode == 'compare')
        self.size_row.setVisible(not batch)
        self.critic_label.setVisible(not batch)
        self.critic.setVisible(not batch)
        self._enable_item(self.build, 0, batch)
        if not batch and self.build.currentData() == 'auto':
            self.build.setCurrentIndex(1)
        self.go.setText(GO_TEXT[mode])
        self.prefs.setValue('mode', mode)

    def role_changed(self) -> None:
        r = next((x for x in self.roles if x['id'] == self.role.currentData()), None)
        self.role_summary.setText(f'{r["summary"]}. Size {r["size"]["cells"][0]}-{r["size"]["cells"][1]} cells, level {r["band"]["maxLevel"]} parts.' if r
                                  else 'No role: the model gets only the rules, the legend and your description.')

    def start_picked(self) -> None:
        sid = self.start_from.currentData()
        if not sid or sid == 'sel':
            return
        self.engine.call('library', {'id': sid, 'role': self.role.currentData() or None},
                         lambda r, e: self.form_msg.setText(e) if e else self.show_design(r['bp'], r, name=r['bp']['name'], saved=sid))

    def form(self) -> dict:
        b = {
            'mode': self.mode, 'model': self.model.currentData(), 'temperature': self.temperature.value(), 'note': self.note.toPlainText().strip() or None,
            'think': self.think.isChecked(), 'build': self.build.currentData(), 'contract': self.contract.currentData(),
            'mirror': self.mirror.isChecked(), 'concept': self.concept.isChecked(),
        }
        if self.rounds.value():
            b['rounds'] = self.rounds.value()
        if self.mode == 'batch':
            b['roles'] = [k for k, c in self.role_checks.items() if c.isChecked()]
            if self.max_ships.value():
                b['maxShips'] = self.max_ships.value()
            b['shipMinutes'] = self.ship_minutes.value()
            b['generations'] = self.refine.value()
            self.prefs.setValue('roles', b['roles'])
        else:
            b['role'] = self.role.currentData() or None
            if self.critic.currentData():
                b['critic'] = self.critic.currentData()
            if self.max_level.value():
                b['maxLevel'] = self.max_level.value()
            if self.cells_min.value() or self.cells_max.value():
                r = next((x for x in self.roles if x['id'] == b['role']), None)
                b['cells'] = [self.cells_min.value() or (r['size']['cells'][0] if r else 10), self.cells_max.value() or (r['size']['cells'][1] if r else 200)]
            b['trials'] = self.trials.value()
            b['population'] = self.population.value()
            b['generations'] = self.generations.value()
            if self.mode == 'compare':
                b['models'] = [self.model.currentData(), self.model2.currentData()]
            st = self.start_from.currentData()
            if st == 'sel' and self.start_bp:
                b['startBp'] = self.start_bp
            elif st and st != 'sel':
                b['startId'] = st
            if b['build'] == 'auto':
                b['build'] = 'oneshot'
        p = self.prefs
        for k, v in [('model', b['model']), ('model2', self.model2.currentData()), ('critic', self.critic.currentData() or ''), ('role', self.role.currentData() or ''),
                     ('temperature', b['temperature']), ('contract', b['contract']), ('concept', str(b['concept']).lower()), ('mirror', str(b['mirror']).lower()),
                     ('think', str(b['think']).lower()), ('maxShips', self.max_ships.value()), ('shipMinutes', self.ship_minutes.value()), ('refine', self.refine.value())]:
            p.setValue(k, v)
        return {k: v for k, v in b.items() if v is not None}

    def start_run(self) -> None:
        f = self.form()
        if not f.get('model'):
            self.form_msg.setText('Pick a model.')
            return
        if f['mode'] == 'batch' and not f.get('roles'):
            self.form_msg.setText('Tick at least one role.')
            return
        if f['mode'] == 'compare' and f['models'][0] == f['models'][1]:
            self.form_msg.setText('Pick two different models.')
            return
        self.form_msg.setText('')
        self.engine.call('start', {'form': f}, lambda r, e: self.form_msg.setText(e) if e else self.attach(r['id'], f['mode']))

    def stop_run(self) -> None:
        if not self.run_id:
            return
        self.stop.setEnabled(False)
        self.form_msg.setText('Stopping after this step...' if self.run_mode == 'batch' else 'Stopping...')
        self.engine.call('stop', {'id': self.run_id}, lambda r, e: self.form_msg.setText(e) if e else None)

    # ------------------------------------------------------------------------------------------------------- live view
    def set_status(self, s: str, info: str | None = None) -> None:
        self.run_status = s
        colour = {'running': '#6cb8ff', 'done': '#5fd39a', 'stopped': '#f0b64e', 'failed': '#f0b64e'}.get(s, '#7c8896')
        self.status.setText(s)
        self.status.setStyleSheet(f'border:1px solid {colour};color:{colour};border-radius:9px;padding:1px 8px;font-size:11px;')
        if info is not None:
            self.run_info.setText(info)
        running = s == 'running'
        self.stop.setEnabled(running and not self.watching)
        self.go.setEnabled(not (running and not self.watching))

    def reset_view(self, title: str) -> None:
        self.log.clear_log()
        self.concept_note.setText('')
        self.grid.clear()
        self.picture.show_file(None)
        self.prev_cells = self.final_cells = None
        self.checks.clear()
        self.select(None)
        self.metrics.clear()
        self.foot.setText('')
        self.progress = {'title': title, 'where': '', 'since': time.time(), 'steps': [], 'tally': '', 'round': 0}
        self.draw_progress()

    def attach(self, rid: str, mode: str | None, replay: bool = False) -> None:
        """Shows the app's own run (its events come as messages; a run already going is replayed first)"""
        if self.watching:
            self.engine.call('unwatch')
        self.watching = None
        self.pinned = None
        self.run_id, self.run_mode = rid, mode
        self.reset_view('Making ships' if mode == 'batch' else 'Starting')
        self.set_status('running', '')
        if replay:
            self.engine.call('replay', {'id': rid}, lambda r, e: [self.on_event(x) for x in (r or {}).get('events', [])])

    def watch(self, wid: str) -> None:
        """Shows a run from the command line, from its record as it grows"""
        self.run_id = None
        self.run_mode = None
        self.watching = wid
        self.watch_ended = False
        self.reset_view('Watching')
        self.set_status('running', f'live: {wid.removeprefix("runs/")}')
        self.engine.call('watch', {'id': wid}, lambda r, e: self.form_msg.setText(e) if e else None)

    def follow(self) -> None:
        """The newest run: the app's own when one is going, else the newest live command-line run (a run picked by hand
        stays until it ends; a second run going at once takes over only once it is a minute ahead)"""
        if self.run_id and self.run_status == 'running':
            return

        def got(r, e):
            if e or not r:
                return
            runs = [x for x in r['runs'] if not x['id'].endswith(('-app', '-page')) and '-app/' not in x['id'] and '-page/' not in x['id']]
            self.watch_runs = runs
            if self.bottom_tabs.currentIndex() == 2:
                self.draw_runs()
            cur = next((x for x in runs if x['id'] == self.watching), None) if self.watching else None
            cur_live = bool(cur) and not cur['finished'] and not cur.get('stale') and not self.watch_ended
            if self.pinned and self.pinned == self.watching and cur_live:
                return
            self.pinned = None
            newest = next((x for x in runs if not x['finished'] and not x.get('stale')), None)
            if newest and newest['id'] != self.watching and (not cur_live or newest['modified'] - cur['modified'] > 60000):
                self.watch(newest['id'])
            elif not self.watching and not self.run_id and runs:
                self.watch(runs[0]['id'])
        self.engine.call('watchList', cb=got)

    def on_message(self, m: dict) -> None:
        t = m.get('type')
        if t == 'renderer':
            self.renderer_state = m.get('status')
            ok = self.renderer_state == 'ready'
            self.renderer_label.setText('renderer: ready' if ok else f'renderer: down ({m.get("detail", "")[:80]})')
            self.renderer_label.setStyleSheet(f'color:{"#5fd39a" if ok else "#ef6b6b"};font-size:11px;')
            return
        if t == 'event':
            if m['channel'] == 'run':
                # (Only one app run at a time: an event of another is a run started elsewhere in the app, so show it)
                if m['id'] != self.run_id:
                    self.attach(m['id'], None)
                self.on_event(m['e'])
            elif m['channel'] == 'watch' and m['id'] == self.watching:
                self.on_event(m['e'])
            return
        if t == 'end':
            if m['channel'] == 'run' and m['id'] == self.run_id:
                self.set_status(m.get('status') or 'done')
                self.refresh_ships()
                self.refresh_gallery()
            elif m['channel'] == 'watch' and m['id'] == self.watching:
                self.watch_ended = True
                self.set_status('done')
                self.refresh_ships()
                QTimer.singleShot(200, self.follow)

    def on_died(self, why: str) -> None:
        self.set_status('failed', why)
        QMessageBox.critical(self, 'Shipgen', f'{why}\n\nClose Shipgen and open it again.')

    def draw_progress(self) -> None:
        p = self.progress
        self.progress_box.setVisible(bool(p))
        if not p:
            return
        self.p_title.setText(p['title'])
        self.p_where.setText(' · '.join(x for x in [p['where'], f'try {p["round"]}' if p['round'] else ''] if x))
        self.p_clock.setText(clock((time.time() - p['since']) * 1000))
        self.p_steps.set_steps(p['steps'])
        self.p_tally.setText(p['tally'])
        self.p_tally.setVisible(bool(p['tally']))

    def _tick(self) -> None:
        if self.progress and self.run_status == 'running':
            self.p_clock.setText(clock((time.time() - self.progress['since']) * 1000))
        self.caption()

    def _set_step(self, name: str, st: str) -> None:
        p = self.progress
        steps = p['steps']
        for i, (n, s) in enumerate(steps):
            if n == name:
                steps[i] = (n, st)
                return
        steps.append((name, st))

    def on_batch(self, e: dict) -> None:
        p = self.progress or {'title': 'Making ships', 'where': '', 'since': time.time(), 'steps': [], 'tally': '', 'round': 0}
        self.progress = p
        per = ' · '.join(f'{r} {v["saved"]}/{v["attempts"]}' for r, v in (e.get('perRole') or {}).items())
        p['tally'] = f'{e.get("saved")} saved of {e.get("attempts")} attempts' + (f' · {per}' if per else '')
        ph = e.get('phase')
        if ph == 'design':
            p.update(title=f'Ship #{e["attempt"]}: {e["role"]}', where='writing the concept', since=time.time(), steps=[], round=0)
        elif ph == 'refine':
            p.update(where='refining the design', steps=[], round=0)
        elif ph == 'saved':
            sh = e.get('ship') or {}
            p['where'] = f'saved "{sh.get("name")}" (score {sh.get("score")}) in {e.get("minutes")} min'
            if e.get('file'):
                self.picture.show_file(e['file'])
            self.refresh_ships()
        elif ph == 'rejected':
            p['where'] = f'rejected after {e.get("minutes")} min: {"; ".join(e.get("why") or [])}'
        elif ph == 'error':
            p['where'] = f'error: {e.get("message")}'
        elif ph == 'waiting':
            p['where'] = f'waiting {e.get("waitS")} s ({e.get("message")})'
        elif ph == 'stopped':
            p.update(title='Batch finished', where=f'stopped: {e.get("reason")}')
        self.draw_progress()

    def on_event(self, e: dict) -> None:
        t = e.get('type')
        if t == 'batch':
            self.on_batch(e)
            self.log.event_in(e)
            return
        p = self.progress
        if t == 'start':
            self.mode_run = e.get('mode')
            self.checks.clear()
            self.concept_note.setText('')
            self.prev_cells = self.final_cells = None
            self.grid.clear()
            if self.run_mode != 'batch':
                verb = {'design': 'Designing', 'evolve': 'Evolving', 'compare': 'Comparing'}.get(e.get('mode'), 'Running')
                self.progress = p = {'title': f'{verb}{": " + e["role"] if e.get("role") else ""}', 'where': '', 'since': time.time(), 'steps': [], 'tally': '', 'round': 0}
            elif p:
                p.update(where='refining the design' if e.get('mode') == 'evolve' else f'designing{" in steps" if e.get("build") == "staged" else ""}', steps=[], round=0)
            if e.get('build') == 'staged' and p:
                p['steps'] = [(s, '') for s in STEP_NAMES]
            models = ' vs '.join(e.get('models') or [e.get('model') or ''])
            self.set_status('running', f'{"batch · " if self.run_mode == "batch" else ""}{e.get("mode")}{" (steps)" if e.get("build") == "staged" else ""} · {models} · {e.get("role") or "no role"} · {e.get("contract")}'
                            + ('' if not self.watching else f' · live: {self.watching.removeprefix("runs/")}'))
            self.draw_progress()
        elif t == 'concept':
            self.concept_note.setText(e.get('line', ''))
            if p:
                p['where'] = 'designing from the concept'
                self.draw_progress()
        elif t == 'step' and p:
            if e.get('status') == 'start':
                p['steps'] = [(n, 'done' if s == 'on' else s) for n, s in p['steps']]
                self._set_step(e['step'], 'on')
                p['where'] = f'step {e["index"]}/{e["of"]}: {e["step"]}'
            else:
                self._set_step(e['step'], 'done' if e['status'] == 'accepted' else e['status'])
            self.draw_progress()
        elif t == 'prompt':
            if self.final_cells:
                self.prev_cells = self.final_cells
            self.grid_tag.setText(f'ASSEMBLY · {e["lane"] + " · " if e.get("lane") else ""}ROUND {e.get("round")}')
            self.foot.setText('asking the model...')
            self.live.setText('')
            if p:
                p['round'] = e.get('round', 0)
                self.draw_progress()
        elif t == 'progress':
            k = lambda n: f'{n / 1000:.1f}k' if n >= 1000 else str(n)
            what = f'writing: {k(e["content"])} chars' + (f' after {k(e["thinking"])} of thinking' if e.get('thinking') else '') if e.get('content') else f'thinking: {k(e.get("thinking", 0))} chars'
            self.live.setText(what + (f' · ~{e["tokensPerSec"]} tok/s' if e.get('tokensPerSec') else ''))
            if not e.get('content'):
                self.foot.setText(f'the model is thinking ({k(e.get("thinking", 0))} chars so far)')
            return
        elif t == 'token':
            return
        elif t == 'grid':
            if e.get('partial'):
                if e.get('text'):
                    self.grid.show_grid(e['text'], self.prev_cells)
                return
            self.grid.show_grid(e.get('text'), self.prev_cells)
            self.final_cells = parse_grid(e.get('text')) or None
        elif t == 'reply':
            self.live.setText(f'{e["tokensPerSec"]} tok/s' if e.get('tokensPerSec') else '')
            self.foot.setText(f'reply in {e.get("ms", 0) / 1000:.1f} s' + (f', {e["outputTokens"]} tokens' if e.get('outputTokens') else ''))
        elif t == 'check':
            self.grid.overlay(e.get('result'), e.get('cells'))
            self.checks[f'{e.get("lane") or ""}|{e.get("round")}'] = {'result': e.get('result'), 'cells': e.get('cells')}
            errs = (e.get('result') or {}).get('errors') or []
            self.foot.setText('valid' if e.get('valid') else f'not valid: {errs[0]["message"] if errs else ""}')
            self.show_metrics(e.get('result'))
        elif t == 'render':
            self.picture.show_file(e.get('file'))
        elif t == 'best':
            c = self.checks.get(f'{e.get("lane") or ""}|{e.get("round")}') or {}
            if not (self.selected or {}).get('live') or e.get('valid') or not (self.selected or {}).get('valid'):
                self.select({'live': True, 'bp': e['bp'], 'name': e['name'], 'score': e['score'], 'valid': e['valid'], 'file': e.get('file'),
                             'role': self.role.currentData(), 'result': c.get('result')})
        elif t == 'done':
            self.live.setText('')
            m = e.get('metrics') or {}
            if m.get('kind') == 'compare':
                self.metrics.setHtml(self.compare_html(m))
            if p and self.run_mode != 'batch':
                p['steps'] = [(n, 'done' if s == 'on' else s) for n, s in p['steps']]
                p['where'] = 'stopped' if e.get('cancelled') else 'done'
                self.draw_progress()
            self.refresh_gallery()
        self.log.event_in(e)

    # ------------------------------------------------------------------------------------------------------- metrics
    @staticmethod
    def bar(pct: float) -> str:
        c = '#5fd39a' if pct >= 95 else '#f0b64e' if pct >= 50 else '#ef6b6b'
        n = max(0, min(10, round(pct / 10)))
        return f'<span style="color:{c}">{"█" * n}</span><span style="color:#222a33">{"█" * (10 - n)}</span> {round(pct)}%'

    def show_metrics(self, r: dict | None) -> None:
        if not r:
            return
        s, p = r['stats'], r.get('power')
        kv = [('score', r['score']), ('valid', 'yes' if r['valid'] else f'no ({len(r["errors"])} errors)'), ('parts', s['parts']), ('size', f'{s["width"]} x {s["height"]} ({s["cells"]} cells)'),
              ('mass', s['mass']), ('cost', s.get('cost') if s.get('cost') is not None else 'n/a'), ('thrust / mass', s['thrustToMass']), ('makes', f'{s["generation"]} E/s')]
        if p:
            kv += [('stores', f'{p["storage"]} E'), ('cruise', f'{p["thrust"]["cruisePct"]}%'), ('boost', f'{p["thrust"]["boostPct"]}%'), ('unpowered', len(p['unpowered'])), ('bottlenecks', len(p['bottlenecks']))]
        cells = ''.join(f'<td style="padding:1px 14px 1px 0"><span style="color:#7c8896">{esc(k)}</span> {esc(v)}</td>' + ('</tr><tr>' if i % 4 == 3 else '') for i, (k, v) in enumerate(kv))
        scores = ''.join(f'<tr><td style="color:#7c8896;padding-right:10px">{esc(SCORE_WORDS.get(k, k))}</td><td style="font-family:Consolas">{self.bar(float(v) * 100)}</td></tr>'
                         for k, v in r['scores'].items() if v is not None)
        fit = ' · '.join(f'{esc(f["words"])}: {f["value"]} of {f["target"]}' for f in r.get('fit') or [])
        guns = ''
        if p and p.get('weapons'):
            guns = '<table><tr><th align=left>weapon</th><th align=left>at</th><th align=left>10 s</th><th align=left>sustained</th></tr>' + ''.join(
                f'<tr><td>{esc(w["name"])} ({esc(w["code"])})</td><td>{w["row"]}, {w["col"]}</td><td style="font-family:Consolas">{self.bar(w["pct"])}</td><td style="font-family:Consolas">{self.bar(w["pctLong"])}</td></tr>'
                for w in p['weapons']) + '</table>'
        self.metrics.setHtml(f'<div style="color:#cfd8e1"><table><tr>{cells}</tr></table><br><table>{scores}</table>'
                             f'{"<div style=color:#7c8896>" + fit + "</div>" if fit else ""}<br>{guns}</div>')

    @staticmethod
    def compare_html(m: dict) -> str:
        rows = ''.join(f'<tr><td>{esc(x["model"])}</td><td>{x["trials"]}</td><td>{x["passes"]}</td><td>{round(x["passRate"] * 100)}%</td><td>{x.get("roundsPerValid") or "-"}</td>'
                       f'<td>{x["validPerMinute"]}</td><td>{x["meanScore"]}</td><td>{x.get("tokensPerSec") or "-"}</td><td>{x["ms"] / 1000:.0f} s</td></tr>' for x in m['models'])
        return ('<table style="color:#cfd8e1"><tr><th>model</th><th>trials</th><th>valid</th><th>pass rate</th><th>rounds / valid</th><th>valid / min</th>'
                f'<th>mean score</th><th>tok/s</th><th>time</th></tr>{rows}</table>')

    # ------------------------------------------------------------------------------------------------------- selection
    def select(self, d: dict | None) -> None:
        self.selected = d
        self.sel_name.setText(d['name'] if d else 'none yet')
        self.sel_score.setText(f'{"valid" if d["valid"] else "not valid"}{", score " + str(d["score"]) if d.get("score") is not None else ""}{", saved as " + d["saved"] if d.get("saved") else ""}' if d else '')
        for b in (self.act_lab, self.act_start, self.act_lapse):
            b.setEnabled(bool(d))
        self.act_save.setEnabled(bool(d) and d['valid'] and not str(d.get('saved') or '').startswith('dev/gen-'))
        self.act_lab.setEnabled(bool(d) and (d['valid'] or bool(d.get('saved'))))
        self.act_folder.setEnabled(bool(d) and bool(d.get('dir') or d.get('file')))
        self._stars(d)
        if d and d.get('result'):
            self.show_metrics(d['result'])

    def _stars(self, d: dict | None) -> None:
        on = bool(d and d.get('dir'))
        n = (d or {}).get('rating') or 0
        for i, b in enumerate(self.stars, 1):
            b.setVisible(on)
            b.setStyleSheet(f'QToolButton{{border:none;background:transparent;font-size:16px;color:{"#f5c542" if i <= n else "#3a4552"};padding:0 1px;}}')

    def show_design(self, bp: dict, view: dict, name: str, file: str | None = None, **extra) -> None:
        """A design outright (a saved ship, a library ship, a gallery pick): its grid with the check, its picture"""
        if self.run_status == 'running' and not self.watching:
            self.act_msg.setText('A run is going: the view stays on it; the design is selected below.')
        else:
            self.grid.show_grid(view['grid'])
            self.grid.overlay(view['check'], view['cells'])
            self.grid_tag.setText(f'ASSEMBLY · {name.upper()}')
            self.picture.show_file(file)
            if not file:
                self.engine.call('render', {'bp': bp}, lambda r, e: self.picture.show_file(r['file']) if r else None)
        self.select({'bp': bp, 'name': name, 'file': file, 'score': extra.get('score', view['check']['score']), 'valid': view['check']['valid'], 'result': view['check'], **extra})

    def rate(self, i: int) -> None:
        d = self.selected
        if not d or not d.get('dir'):
            return
        rating = 0 if d.get('rating') == i else i

        def done(r, e):
            if e:
                self.act_msg.setText(e)
                return
            d['rating'] = r.get('rating')
            self._stars(d)
            for s in self.ships:
                if s['dir'] == d['dir']:
                    s['rating'] = d['rating']
            self.ships_key = ''
            self.draw_ships()
        self.engine.call('rate', {'dir': d['dir'], 'rating': rating}, done)

    def save_selected(self) -> None:
        d = self.selected
        self.engine.call('save', {'bp': d['bp'], 'role': d.get('role') or self.role.currentData() or 'free'},
                         lambda r, e: self.act_msg.setText(e) if e else (d.update(saved=r['id']), self.select(d), self.act_msg.setText(f'Saved as {r["id"]} ({r["file"]}). {r["note"]}')))

    def lab_selected(self) -> None:
        d = self.selected
        self.act_msg.setText('Exporting ships to the Energy Lab...')

        def done(r, e):
            if e:
                self.act_msg.setText(e)
                return
            d['saved'] = r['saved']['id']
            self.select(d)
            webbrowser.open(r['url'])
            self.act_msg.setText(f'In the lab as "{r["saved"]["name"]}" ({r["saved"]["id"]}).')
        self.engine.call('lab', {'bp': d['bp'], 'role': d.get('role') or self.role.currentData() or 'free', 'saved': d.get('saved')}, done)

    def use_as_start(self) -> None:
        d = self.selected
        self.start_bp = d['bp']
        self._enable_item(self.start_from, 1, True)
        self.start_from.setItemText(1, f'(the selected design: {d["name"]})')
        self.start_from.setCurrentIndex(1)
        if self.mode in ('batch', 'compare'):
            self.set_mode('design')
        self.act_msg.setText(f'The next run starts from "{d["name"]}".')

    def timelapse(self) -> None:
        d = self.selected
        self.act_msg.setText('Rendering the build-up...')
        self.act_lapse.setEnabled(False)

        def done(r, e):
            self.act_lapse.setEnabled(True)
            if e:
                self.act_msg.setText(e)
                return
            self.picture.play([f['file'] for f in r['frames']])
            self.act_msg.setText(f'{len(r["frames"])} frames in {r["ms"] / 1000:.1f} s, saved in {r["dir"]}')
        self.engine.call('timelapse', {'bp': d['bp']}, done)

    def open_folder(self) -> None:
        d = self.selected or {}
        path = d.get('dir_abs') or (str(Path(d['file']).parent) if d.get('file') else None)
        if path and os.path.exists(path):
            os.startfile(path)

    # ------------------------------------------------------------------------------------------------------- lists
    def refresh_ships(self) -> None:
        self.engine.call('ships', cb=lambda r, e: (setattr(self, 'ships', r['ships']), self.draw_ships()) if r else None)

    def draw_ships(self) -> None:
        role = self.ships_role.currentData()
        roles = sorted({s['role'] for s in self.ships})
        if [self.ships_role.itemData(i) for i in range(1, self.ships_role.count())] != roles:
            self.ships_role.blockSignals(True)
            self.ships_role.clear()
            self.ships_role.addItem('all roles', '')
            for r in roles:
                self.ships_role.addItem(r, r)
            self.ships_role.setCurrentIndex(max(0, self.ships_role.findData(role)))
            self.ships_role.blockSignals(False)
            role = self.ships_role.currentData()
        sort = self.ships_sort.currentData()
        ships = [s for s in self.ships if not role or s['role'] == role]
        key_of = {'score': lambda s: -s['score'], 'rating': lambda s: (-(s.get('rating') or 0), -s['score'])}.get(sort, lambda s: '')
        ships = sorted(ships, key=key_of) if sort != 'new' else sorted(ships, key=lambda s: s['savedAt'], reverse=True)
        key = json.dumps([(s['dir'], s.get('rating')) for s in ships])
        self.ships_count.setText(f'{len(ships)} ships')
        if key == self.ships_key:
            return
        self.ships_key = key
        self.ships_list.clear()
        for s in ships:
            stars = '★' * (s.get('rating') or 0)
            it = QListWidgetItem(f'{s["name"]}\nscore {s["score"]} · {s["role"]}\n{(s.get("model") or "").split("/")[-1]}  {stars}')
            if s.get('png') and os.path.exists(s['png']):
                it.setIcon(QIcon(QPixmap(s['png']).scaled(150, 150, Qt.KeepAspectRatio, Qt.SmoothTransformation)))
            it.setToolTip(f'{s["dir"]}\n{s.get("concept") or ""}')
            it.setData(Qt.UserRole, s)
            self.ships_list.addItem(it)

    def open_ship(self, it: QListWidgetItem) -> None:
        s = it.data(Qt.UserRole)
        try:
            bp = json.loads(Path(s['bp']).read_text(encoding='utf-8'))
        except OSError as ex:
            self.act_msg.setText(str(ex))
            return
        self.engine.call('check', {'bp': bp, 'role': s['role']}, lambda r, e: self.act_msg.setText(e) if e else self.show_design(
            bp, r, name=s['name'], file=s.get('png'), score=s['score'], role=s['role'], dir=s['dir'], dir_abs=str(Path(s['bp']).parent), rating=s.get('rating')))

    def refresh_gallery(self) -> None:
        def got(r, e):
            if not r:
                return
            self.gallery.clear()
            for g in r['gallery']:
                it = QListWidgetItem(f'{g["name"]}\n{g["score"]}{"" if g["valid"] else " (invalid)"} · {g["model"].split("/")[-1]}')
                if g.get('file') and os.path.exists(g['file']):
                    it.setIcon(QIcon(QPixmap(g['file']).scaled(150, 150, Qt.KeepAspectRatio, Qt.SmoothTransformation)))
                it.setData(Qt.UserRole, g)
                self.gallery.addItem(it)
        self.engine.call('gallery', cb=got)

    def open_gallery(self, it: QListWidgetItem) -> None:
        g = it.data(Qt.UserRole)
        self.engine.call('check', {'bp': g['bp'], 'role': g.get('role')}, lambda r, e: self.act_msg.setText(e) if e else self.show_design(
            g['bp'], r, name=g['name'], file=g.get('file'), score=g['score'], role=g.get('role')))

    watch_runs: list[dict] = []

    def refresh_runs(self) -> None:
        self.engine.call('watchList', cb=lambda r, e: (setattr(self, 'watch_runs', r['runs']), self.draw_runs()) if r else None)

    def draw_runs(self) -> None:
        self.runs_list.clear()
        for r in self.watch_runs[:80]:
            state = 'done' if r['finished'] else 'stopped?' if r.get('stale') else 'LIVE'
            when = time.strftime('%Y-%m-%d %H:%M', time.localtime(r['modified'] / 1000))
            it = QListWidgetItem(f'[{state}]  {r["id"].removeprefix("runs/")}   {" · ".join(x for x in [r.get("mode"), r.get("model"), r.get("role")] if x)} · {when}')
            if r['id'] == self.watching:
                it.setForeground(QColor('#6cb8ff'))
            it.setData(Qt.UserRole, r['id'])
            self.runs_list.addItem(it)

    def pick_run(self, it: QListWidgetItem) -> None:
        wid = it.data(Qt.UserRole)
        if self.run_id and self.run_status == 'running':
            self.act_msg.setText('A run from the app is going: the view stays on it.')
            return
        self.pinned = wid
        self.watch(wid)

    def set_view(self, v: str) -> None:
        """Studio: everything. Preview: only the rendered picture of the newest run, in a small window that can go
        borderless and stay on top (Back to the app returns). Ships: the saved ships large, beside the selected one"""
        if v not in ('studio', 'live', 'ships'):
            v = 'studio'
        was = getattr(self, 'view', 'studio')
        if was == 'live' and v != 'live' and getattr(self, 'studio_geometry', None):
            self.restoreGeometry(self.studio_geometry)
        if v == 'live' and was != 'live':
            self.studio_geometry = self.saveGeometry()
        self.view = v
        live, ships = v == 'live', v == 'ships'
        self.controls_box.setVisible(v == 'studio')
        self.log_box.setVisible(v == 'studio')
        self.bottom_tabs.setVisible(not live)
        self.sel_box.setVisible(not live)
        self.metrics.setVisible(v == 'studio')
        self.act_msg.setVisible(not live)
        self.run_info.setVisible(not live)
        for wdg in (self.title_label, self.status, self.renderer_label, self.stop, self.live, self.concept_note, self.grid_box, self.render_tag, self.foot, self.progress_box):
            wdg.setVisible(not live)
        if not live:
            self.draw_progress()
        self.preview_caption.setVisible(live)
        self.on_top.setVisible(live)
        self.borderless.setVisible(live)
        self.back.setVisible(live)
        self.grip.setVisible(live)
        for k, b in self.view_buttons.items():
            b.setVisible(not live)
            b.setChecked(k == v)
        self.head_gap.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Preferred)
        if live:
            # (Again after the window settles: leaving a maximised state restores the old size a moment later)
            self.showNormal()
            self.resize(560, 600)
            QTimer.singleShot(150, lambda: self.resize(560, 600) if self.view == 'live' else None)
        elif ships:
            self.bottom_tabs.setCurrentIndex(0)
            h = self.height()
            self.root.setSizes([int(h * 0.45), int(h * 0.55)])
        elif was == 'ships':
            h = self.height()
            self.root.setSizes([int(h * 0.7), int(h * 0.3)])
        if not live:
            self.on_top.setChecked(False)
            self.borderless.setChecked(False)
        self.caption()
        self.prefs.setValue('view', v)

    def keep_on_top(self, on: bool) -> None:
        g = self.geometry()
        self.setWindowFlag(Qt.WindowStaysOnTopHint, on)
        self.show()
        self.setGeometry(g)

    def set_borderless(self, on: bool) -> None:
        g = self.geometry()
        self.setWindowFlag(Qt.FramelessWindowHint, on)
        self.show()
        self.setGeometry(g)

    def caption(self) -> None:
        """The preview's one line: what the run is doing, and for how long"""
        if getattr(self, 'view', '') != 'live':
            return
        p = self.progress
        bits = [p['title'], p['where'], clock((time.time() - p['since']) * 1000) if self.run_status == 'running' else ''] if p else [self.run_status]
        self.preview_caption.setText(' · '.join(b for b in bits + [self.live.text()] if b))

    # (In the preview, dragging anywhere moves the window: it may have no frame)
    def mousePressEvent(self, e) -> None:
        if getattr(self, 'view', '') == 'live' and e.button() == Qt.LeftButton:
            self._drag = e.globalPosition().toPoint() - self.frameGeometry().topLeft()
        super().mousePressEvent(e)

    def mouseMoveEvent(self, e) -> None:
        if getattr(self, '_drag', None) is not None and e.buttons() & Qt.LeftButton:
            self.move(e.globalPosition().toPoint() - self._drag)
        super().mouseMoveEvent(e)

    def mouseReleaseEvent(self, e) -> None:
        self._drag = None
        super().mouseReleaseEvent(e)

    def resizeEvent(self, e) -> None:
        self.grip.move(self.width() - self.grip.width(), self.height() - self.grip.height())
        super().resizeEvent(e)

    def showEvent(self, e) -> None:
        # (The panes' first sizes, from the window's own: controls and log fixed-ish, the live view takes the rest)
        if not self.laid_out:
            self.laid_out = True
            w, h = self.width(), self.height()
            self.top.setSizes([320, max(500, w - 320 - 440), 440])
            self.root.setSizes([int(h * 0.7), int(h * 0.3)])
            self.set_view(self.prefs.value('view', 'studio'))
        super().showEvent(e)

    # ------------------------------------------------------------------------------------------------------- closing
    def closeEvent(self, e) -> None:
        if self.run_id and self.run_status == 'running':
            r = QMessageBox.question(self, 'Shipgen', 'A run is going. Closing stops it. Close anyway?')
            if r != QMessageBox.Yes:
                e.ignore()
                return
        self.prefs.setValue('geometry', self.studio_geometry if getattr(self, 'view', '') == 'live' and getattr(self, 'studio_geometry', None) else self.saveGeometry())
        self.follow_timer.stop()
        self.engine.close()
        e.accept()
