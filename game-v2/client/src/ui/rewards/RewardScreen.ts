/**
 * @contract client.ui.rewards.screen
 * owns:       the reward screen's DOM, in two forms: a modal (backdrop, waits for its button: the tutorial's graduate screen) and a
 *             compact card (slides in at the top centre, folds to a "View" pill in combat or after a while: finished jobs)
 * needs:      rewardModel (RewardLine, CardLife), escape
 * invariants: the compact card never takes the keyboard from typing and never blocks the game behind it; the modal waits for its button — client/src/ui/rewards/rewardModel.test.ts
 * extend:     a new line kind is drawn from RewardLine (rewardModel.ts); callers pass the lines, this knows no quest or tutorial data
 */

import { esc } from '../escape';
import { CardLife, KIND_GLYPH, type RewardLine } from './rewardModel';

export interface RewardShowOptions {
  title: string;
  /** A small caps line above the title ("JOB COMPLETE") */
  kicker?: string;
  /** A line under the title (the giver's outro, or the tutorial's lead-in) */
  intro?: string;
  lines: RewardLine[];
  /** A small grey line under the list */
  note?: string;
  button: string;
  /** Pressed button, Enter or Esc (the compact card: when it is dismissed for good) */
  onClose?: () => void;
  /** 'modal' waits for its button; 'card' is the compact, non-blocking form */
  mode?: 'modal' | 'card';
}

export interface RewardDeps {
  sound?(id: string, v?: number): void;
  /** Is the pilot in combat now (the compact card folds then) */
  inCombat?(): boolean;
  now?(): number;
}

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.rw-modal { position: fixed; inset: 0; z-index: 2200; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(2, 6, 14, 0.78); }
.rw-modal[hidden], .rw-card[hidden], .rw-pill[hidden] { display: none; }
.rw-box { width: min(420px, 100%); box-sizing: border-box; padding: 22px 24px; border-radius: 14px; text-align: center; color: #e5ecf7; font: 14px 'Segoe UI', system-ui, sans-serif;
  background: linear-gradient(180deg, rgba(16, 30, 52, 0.98), rgba(8, 16, 30, 0.98)); border: 1px solid rgba(251, 191, 36, 0.6); box-shadow: 0 0 40px rgba(251, 191, 36, 0.18); }
.rw-box .rw-k { font: 700 11px 'Segoe UI', sans-serif; letter-spacing: 2px; color: #8fa0b8; margin-bottom: 4px; }
.rw-box h2 { margin: 0 0 6px; font: 700 22px 'Segoe UI', sans-serif; color: #fbbf24; letter-spacing: 1px; }
.rw-box p { margin: 4px 0; color: #cfd8e6; }
.rw-box p.rw-sub { margin: -6px 0 14px; font-size: 12px; color: #8fa0b8; }
.rw-box p.rw-intro { font-style: italic; color: #b3c0d4; line-height: 1.45; }
.rw-box ul { list-style: none; margin: 12px 0 16px; padding: 10px 14px; border-radius: 8px; background: rgba(255,255,255,0.05); text-align: left; max-height: 40vh; overflow: auto; }
.rw-box li { display: flex; align-items: center; gap: 10px; padding: 2px 0; }
.rw-box li .rw-ic { flex: none; width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255,255,255,0.06); color: #fbbf24; font-size: 15px; }
.rw-box li .rw-ic img { width: 24px; height: 24px; image-rendering: auto; }
.rw-box li .rw-n { font-variant-numeric: tabular-nums; font-weight: 700; color: #fff; min-width: 3.4em; text-align: right; }
.rw-box li .rw-l { flex: 1; min-width: 0; color: #cfd8e6; }
.rw-box li.rw-unlock .rw-l { color: #9fd4ff; }
.rw-box button, .rw-pill button { all: unset; cursor: pointer; padding: 7px 26px; border-radius: 6px; border: 1px solid #f59e0b; background: #f59e0b; color: #1a1205; font: 600 14px 'Segoe UI', sans-serif; }
.rw-box button:hover, .rw-pill button:hover { background: #fbbf24; border-color: #fbbf24; }
.rw-box button:focus-visible, .rw-pill button:focus-visible { outline: 2px solid #6cc8ff; outline-offset: 1px; }
.rw-card { position: fixed; top: 108px; left: 50%; z-index: 2050; width: min(360px, calc(100vw - 32px)); transform: translateX(-50%); animation: rw-in 0.28s ease-out; }
.rw-card .rw-box { padding: 12px 16px 14px; border-radius: 12px; }
.rw-card .rw-box h2 { font-size: 17px; }
.rw-card .rw-box ul { margin: 8px 0 10px; padding: 6px 10px; max-height: 32vh; }
.rw-card .rw-box button { padding: 4px 20px; font-size: 13px; }
.rw-card .rw-hint { margin-top: 6px; font-size: 11px; color: #6f819b; }
.rw-pill { position: fixed; top: 108px; left: 50%; z-index: 2050; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; max-width: calc(100vw - 32px); box-sizing: border-box;
  padding: 5px 6px 5px 14px; border-radius: 999px; color: #e5ecf7; font: 13px 'Segoe UI', system-ui, sans-serif; background: rgba(12, 22, 40, 0.92); border: 1px solid rgba(251, 191, 36, 0.55); animation: rw-in 0.28s ease-out; }
.rw-pill .rw-t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rw-pill button { padding: 3px 14px; font-size: 12px; }
.rw-pill .rw-x { all: unset; cursor: pointer; padding: 2px 8px; color: #8fa0b8; font-size: 15px; }
.rw-pill .rw-x:hover { color: #fff; background: none; }
@keyframes rw-in { from { opacity: 0; transform: translate(-50%, -14px); } to { opacity: 1; transform: translate(-50%, 0); } }
@media (prefers-reduced-motion: reduce) { .rw-card, .rw-pill { animation: none; } }
`;
  document.head.appendChild(css);
}

/** The list markup (exported for the tutorial's screenshot check and tests) */
export function linesHtml(lines: RewardLine[]): string {
  return `<ul>${lines.map((l) => {
    const ic = l.icon ? `<img src="${esc(l.icon)}" alt="">` : KIND_GLYPH[l.kind];
    const n = l.count !== undefined ? `<span class="rw-n">${l.kind === 'item' ? `${l.count.toLocaleString('en-US')}×` : `${l.kind === 'rep' || l.kind === 'xp' || l.kind === 'skill' ? '+' : ''}${l.count.toLocaleString('en-US')}`}</span>` : '<span class="rw-n"></span>';
    return `<li class="rw-${l.kind}"><span class="rw-ic" aria-hidden="true">${ic}</span>${n}<span class="rw-l">${esc(l.label)}</span></li>`;
  }).join('')}</ul>`;
}

export class RewardScreen {
  private modal = document.createElement('div');
  private card = document.createElement('div');
  private pill = document.createElement('div');
  private life = new CardLife();
  private opts: RewardShowOptions | null = null;
  private timer = 0;
  private onKey = (e: KeyboardEvent): void => this.key(e);

  constructor(private d: RewardDeps = {}) {
    injectStyles();
    this.modal.className = 'rw-modal';
    this.card.className = 'rw-card';
    this.pill.className = 'rw-pill';
    for (const el of [this.modal, this.card, this.pill]) { el.hidden = true; el.addEventListener('click', (e) => this.click(e)); }
    this.modal.setAttribute('role', 'dialog');
    this.card.setAttribute('role', 'dialog');
    this.pill.setAttribute('role', 'status');
    document.body.append(this.modal, this.card, this.pill);
  }

  private now(): number { return this.d.now ? this.d.now() : Date.now(); }

  /** Is anything of it up (modal, card or pill)? */
  get isOpen(): boolean { return !this.modal.hidden || !this.card.hidden || !this.pill.hidden; }

  private box(o: RewardShowOptions, hint: string): string {
    return `<div class="rw-box">${o.kicker ? `<div class="rw-k">${esc(o.kicker)}</div>` : ''}<h2>${esc(o.title)}</h2>${o.intro ? `<p class="${o.mode === 'card' ? 'rw-intro' : ''}">${esc(o.intro)}</p>` : ''}
      ${linesHtml(o.lines)}${o.note ? `<p class="rw-sub">${esc(o.note)}</p>` : ''}<button class="go" data-a="close">${esc(o.button)}</button>${hint}</div>`;
  }

  show(o: RewardShowOptions): void {
    this.hide();
    this.opts = o;
    if (o.mode === 'card') {
      this.life.open(this.now(), this.d.inCombat?.() ?? false);
      this.paint();
      window.addEventListener('keydown', this.onKey, true);
      this.timer = window.setInterval(() => { if (this.life.tick(this.now(), this.d.inCombat?.() ?? false)) this.paint(); }, 400);
      this.d.sound?.('scan_ping', 0.5);
      return;
    }
    this.modal.innerHTML = this.box(o, '').replace('<div class="rw-box">', `<div class="rw-box" aria-label="${esc(o.title)}">`);
    this.modal.hidden = false;
    this.modal.querySelector<HTMLButtonElement>('[data-a="close"]')?.focus();
  }

  /** Close everything without calling onClose */
  hide(): void {
    window.clearInterval(this.timer);
    window.removeEventListener('keydown', this.onKey, true);
    this.life.state = 'gone';
    this.modal.hidden = this.card.hidden = this.pill.hidden = true;
    this.opts = null;
  }

  /** Redraw the compact form for the card's state */
  private paint(): void {
    const o = this.opts;
    if (!o) return;
    const st = this.life.state;
    if (st === 'gone') { const cb = o.onClose; this.hide(); cb?.(); return; }
    const wasCard = !this.card.hidden;
    this.card.hidden = st !== 'open';
    this.pill.hidden = st !== 'pill';
    if (st === 'open') {
      if (!wasCard) this.card.innerHTML = this.box(o, '<div class="rw-hint">Enter or Esc to put away</div>');
      this.card.setAttribute('aria-label', o.title);
    } else {
      const lead = o.lines.slice(0, 2).map((l) => (l.count !== undefined ? `${l.count.toLocaleString('en-US')} ${l.label}` : l.label)).join(', ');
      this.pill.innerHTML = `<span class="rw-t">${esc(o.title)}${lead ? ` · ${esc(lead)}` : ''}</span><button data-a="view">View</button><button class="rw-x" data-a="drop" aria-label="Dismiss">×</button>`;
    }
  }

  private click(e: Event): void {
    const a = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-a]')?.dataset.a;
    if (!a || !this.opts) return;
    this.d.sound?.('ui_click', 0.4);
    if (this.opts.mode !== 'card') { const cb = this.opts.onClose; this.hide(); cb?.(); return; }
    if (a === 'view') this.life.view(this.now());
    else if (a === 'drop') this.life.state = 'gone';
    else this.life.dismiss(this.now());
    this.paint();
  }

  private key(e: KeyboardEvent): void {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    if (this.life.state !== 'open') return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    e.stopPropagation();
    this.life.dismiss(this.now());
    this.paint();
  }

  /** Reopen the folded card (the pill's View) */
  view(): void { this.life.view(this.now()); this.paint(); }
}
