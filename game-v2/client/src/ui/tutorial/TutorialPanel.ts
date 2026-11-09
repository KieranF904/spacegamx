/**
 * @contract client.ui.tutorial.panel
 * owns:       the lesson's DOM: the compact instruction card (step n/total, title, lines, progress bar, Continue, Leave
 *             training with its inline confirm), the "step done" toast, and the graduate screen
 * needs:      tutorialModel (PanelModel, LeaveFlow, packLines), escape
 * invariants: all decisions are in tutorialModel.ts; this only draws a PanelModel and forwards clicks — client/src/ui/tutorial/tutorialModel.test.ts
 * extend:     a new element is drawn from a field of PanelModel; the controller (TutorialUI) feeds it
 */

import { esc } from '../escape';
import { LeaveFlow, type PanelModel } from './tutorialModel';

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.tp { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); z-index: 2100; width: min(440px, calc(100vw - 32px)); box-sizing: border-box;
  padding: 10px 14px 12px; border-radius: 12px; background: linear-gradient(180deg, rgba(16, 30, 52, 0.94), rgba(8, 16, 30, 0.94));
  border: 1px solid rgba(251, 191, 36, 0.55); box-shadow: 0 0 26px rgba(251, 191, 36, 0.12), 0 10px 34px rgba(0,0,0,0.5);
  color: #e5ecf7; font: 13px 'Segoe UI', system-ui, sans-serif; line-height: 1.45; }
.tp[hidden], .tp-toast[hidden], .tp-grad[hidden] { display: none; }
.tp-h { display: flex; justify-content: space-between; align-items: center; gap: 10px; font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 2.5px; color: #fbbf24; }
.tp-t { margin: 3px 0 4px; font: 700 16px 'Segoe UI', sans-serif; color: #fff; }
.tp-l { margin: 2px 0; color: #cfd8e6; }
.tp kbd { display: inline-block; min-width: 16px; padding: 0 6px; margin: 0 2px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.35); border-bottom-width: 3px;
  background: rgba(255,255,255,0.08); font: 700 12px 'Segoe UI', sans-serif; text-align: center; color: #fff; }
.tp-ct { display: inline-block; margin: 5px 0 1px; padding: 1px 10px; border-radius: 999px; background: rgba(251, 191, 36, 0.14); border: 1px solid rgba(251, 191, 36, 0.5); color: #fde68a; font: 700 12px 'Segoe UI', sans-serif; letter-spacing: 0.5px; }
.tp-ct.full { background: rgba(74, 222, 128, 0.16); border-color: rgba(74, 222, 128, 0.7); color: #bbf7d0; }
.tp-bar { height: 4px; margin-top: 9px; border-radius: 2px; background: rgba(255,255,255,0.1); overflow: hidden; }
.tp-bar > i { display: block; height: 100%; background: linear-gradient(90deg, #f59e0b, #fbbf24); transition: width 0.4s; }
.tp-row { display: flex; justify-content: flex-end; align-items: center; gap: 8px; margin-top: 8px; font-size: 12px; }
.tp-row .q { flex: 1; color: #fca5a5; }
.tp button, .tp-grad button { all: unset; cursor: pointer; padding: 3px 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.25); color: #d6deeb; font: 600 12px 'Segoe UI', sans-serif; }
.tp button:hover, .tp-grad button:hover { background: rgba(255,255,255,0.1); color: #fff; }
.tp button:focus-visible, .tp-grad button:focus-visible { outline: 2px solid #6cc8ff; outline-offset: 1px; }
.tp button.go, .tp-grad button.go { background: #f59e0b; border-color: #f59e0b; color: #1a1205; }
.tp button.go:hover, .tp-grad button.go:hover { background: #fbbf24; color: #1a1205; }
.tp button.warn { border-color: rgba(248, 113, 113, 0.7); color: #fecaca; }
.tp button.leave { border-color: transparent; color: #8394ad; padding: 3px 6px; }
.tp-toast { position: fixed; top: 22px; left: 50%; transform: translateX(-50%); z-index: 2610; padding: 6px 16px; border-radius: 999px; pointer-events: none;
  background: rgba(10, 40, 28, 0.94); border: 1px solid rgba(74, 222, 128, 0.7); color: #bbf7d0; font: 600 13px 'Segoe UI', sans-serif; animation: tpToast 2.6s ease-out forwards; }
@keyframes tpToast { 0% { opacity: 0; transform: translate(-50%, -8px); } 10%, 80% { opacity: 1; transform: translate(-50%, 0); } 100% { opacity: 0; } }
.tp-grad { position: fixed; inset: 0; z-index: 2200; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(2, 6, 14, 0.78); }
.tp-grad > div { width: min(420px, 100%); box-sizing: border-box; padding: 22px 24px; border-radius: 14px; text-align: center; color: #e5ecf7; font: 14px 'Segoe UI', system-ui, sans-serif;
  background: linear-gradient(180deg, rgba(16, 30, 52, 0.98), rgba(8, 16, 30, 0.98)); border: 1px solid rgba(251, 191, 36, 0.6); box-shadow: 0 0 40px rgba(251, 191, 36, 0.18); }
.tp-grad h2 { margin: 0 0 6px; font: 700 22px 'Segoe UI', sans-serif; color: #fbbf24; letter-spacing: 1px; }
.tp-grad p { margin: 4px 0; color: #cfd8e6; }
.tp-grad ul { list-style: none; margin: 12px 0 16px; padding: 10px 14px; border-radius: 8px; background: rgba(255,255,255,0.05); text-align: left; max-height: 40vh; overflow: auto; }
.tp-grad li { padding: 1px 0; }
.tp-grad button { padding: 7px 26px; font-size: 14px; }
/* Over a window (the station's, the hold) or the hangar: a strip along the bottom, above the window's veil, so the card stays readable without covering its tabs */
.tp.low { top: auto; bottom: 8px; z-index: 2600; width: min(640px, calc(100vw - 32px)); padding: 6px 12px; }
.tp.low .tp-h, .tp.low .tp-bar { display: none; }
.tp.low .tp-t { display: inline; margin: 0 8px 0 0; font-size: 13px; }
.tp.low .tp-l, .tp.low .tp-ct { display: inline; margin: 0 6px 0 0; }
.tp.low .tp-row { float: right; margin: 0 0 0 8px; }
@media (prefers-reduced-motion: reduce) { .tp-toast { animation: none; } .tp-bar > i { transition: none; } }
`;
  document.head.appendChild(css);
}

export interface PanelDeps {
  /** Sends the Continue report for the shown step */
  ack(step: string): void;
  /** Sends tutorialLeave */
  leave(): void;
  sound(id: string, v?: number): void;
}

export class TutorialPanel {
  private card = document.createElement('div');
  private toastEl = document.createElement('div');
  private grad = document.createElement('div');
  private flow: LeaveFlow;
  private model: PanelModel | null = null;
  private pack: string[] = [];
  /** What is drawn now, so an unchanged state does not rebuild (and drop a click in flight) */
  private shown = '';

  constructor(private d: PanelDeps) {
    injectStyles();
    this.flow = new LeaveFlow(() => d.leave());
    this.card.className = 'tp';
    this.card.hidden = true;
    this.card.setAttribute('role', 'region');
    this.card.setAttribute('aria-label', 'Training');
    this.toastEl.className = 'tp-toast';
    this.toastEl.hidden = true;
    this.toastEl.setAttribute('role', 'status');
    this.grad.className = 'tp-grad';
    this.grad.hidden = true;
    document.body.append(this.card, this.toastEl, this.grad);
    this.card.addEventListener('click', (e) => this.click(e));
    this.grad.addEventListener('click', (e) => this.click(e));
  }

  /** Show this card (null hides everything); `pack` is the graduate screen's list */
  set(model: PanelModel | null, pack: string[]): void {
    this.model = model;
    this.pack = pack;
    if (!model) this.flow.reset();
    this.render();
  }

  /** Ask whether to leave now (the yard's edge was reached): the card's leave confirm, if the card is up */
  askLeave(): void {
    if (!this.model || this.model.graduate) return;
    this.flow.ask();
    this.render();
  }

  /** The reset on a new connection */
  reset(): void { this.flow.reset(); this.set(null, []); }

  /** Hide behind full-screen views (the map, the hangar, the menu) */
  setHidden(hidden: boolean): void {
    this.card.style.visibility = hidden ? 'hidden' : 'visible';
  }

  /** Over a window (the station's, the hold) or the hangar: the card as a strip along the bottom, above it */
  setLow(low: boolean): void {
    this.card.classList.toggle('low', low);
  }

  toast(text: string): void {
    this.toastEl.textContent = `Done: ${text}`;
    this.toastEl.hidden = false;
    // Restart the animation for back-to-back toasts
    this.toastEl.style.animation = 'none';
    void this.toastEl.offsetWidth;
    this.toastEl.style.animation = '';
    this.d.sound('scan_ping', 0.5);
    window.setTimeout(() => { this.toastEl.hidden = true; }, 2700);
  }

  private render(): void {
    const m = this.model;
    const key = m ? `${m.stepId}|${this.flow.phase}|${m.progress}|${m.counter ? m.counter.done : ''}|${m.lines.join('~')}|${this.pack.join('~')}` : '';
    if (key === this.shown) return;
    this.shown = key;
    if (!m) { this.card.hidden = true; this.grad.hidden = true; return; }
    if (m.graduate) {
      this.card.hidden = true;
      this.grad.hidden = false;
      this.grad.innerHTML = `<div role="dialog" aria-label="Training complete"><h2>Training complete</h2><p>You know the whole loop. Your starter pack is waiting:</p>
        <ul>${this.pack.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><button class="go" data-a="enter">Enter Sol</button></div>`;
      this.grad.querySelector<HTMLButtonElement>('[data-a="enter"]')?.focus();
      return;
    }
    this.grad.hidden = true;
    this.card.hidden = false;
    const confirm = this.flow.phase === 'confirm', sent = this.flow.phase === 'sent';
    this.card.innerHTML = `<div class="tp-h"><span>TRAINING · ${m.n} / ${m.total}</span></div>
      <div class="tp-t">${esc(m.title)}</div>
      ${m.lines.map((l) => `<div class="tp-l">${l}</div>`).join('')}
      ${m.counter ? `<div class="tp-ct${m.counter.done >= m.counter.total ? ' full' : ''}" role="status">${esc(m.counter.label)} ${m.counter.done}/${m.counter.total}</div>` : ''}
      <div class="tp-bar"><i style="width:${Math.round(m.progress * 100)}%"></i></div>
      <div class="tp-row">${sent ? '<span class="q">Leaving...</span>' : confirm
        ? `<span class="q">Leave now? You'll get the starter pack and can't come back.</span><button class="warn" data-a="yes">Leave</button><button data-a="no">Stay</button>`
        : `${m.canContinue ? '<button class="go" data-a="continue">Continue</button>' : ''}<button class="leave" data-a="ask">Leave training</button>`}</div>`;
  }

  private click(e: Event): void {
    const a = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-a]')?.dataset.a;
    if (!a || !this.model) return;
    if (a === 'continue') this.d.ack(this.model.stepId);
    else if (a === 'ask') this.flow.ask();
    else if (a === 'no') this.flow.cancel();
    else if (a === 'yes') this.flow.confirm();
    else if (a === 'enter') this.flow.enter();
    // (If the server never answers, the buttons come back)
    if (this.flow.phase === 'sent') window.setTimeout(() => { this.flow.reset(); this.render(); }, 6000);
    this.d.sound('ui_click', 0.4);
    this.render();
  }
}
