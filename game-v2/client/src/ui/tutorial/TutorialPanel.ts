/**
 * @contract client.ui.tutorial.panel
 * owns:       the lesson's DOM: the compact instruction card (step n/total, title, lines, progress bar, Continue, Leave
 *             training with its inline confirm), the "step done" toast, a new step's chime and flare, and the graduate screen
 * needs:      tutorialModel (PanelModel, LeaveFlow, packLines), escape
 * invariants: all decisions are in tutorialModel.ts; this only draws a PanelModel and forwards clicks — client/src/ui/tutorial/tutorialModel.test.ts
 * extend:     a new element is drawn from a field of PanelModel; the controller (TutorialUI) feeds it
 */

import { esc } from '../escape';
import { RewardScreen } from '../rewards/RewardScreen';
import type { RewardLine } from '../rewards/rewardModel';
import { LeaveFlow, type PanelModel } from './tutorialModel';
import { cardPosition, type CardAnchor, type Rect } from './placement';

/** A card whose top is above this (px) sits where the game's toasts are: they move under it */
const TOAST_BAND = 160;

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.tp { position: fixed; top: 0; left: 0; transform: translate(var(--tx, 0px), var(--ty, 10px)); transition: transform 0.22s ease-out; z-index: 2100; width: min(440px, calc(100vw - 32px)); box-sizing: border-box;
  padding: 10px 14px 12px; border-radius: 12px; background: linear-gradient(180deg, rgba(16, 30, 52, 0.94), rgba(8, 16, 30, 0.94));
  border: 1px solid rgba(251, 191, 36, 0.55); box-shadow: 0 0 26px rgba(251, 191, 36, 0.12), 0 10px 34px rgba(0,0,0,0.5);
  color: #e5ecf7; font: 13px 'Segoe UI', system-ui, sans-serif; line-height: 1.45; }
.tp[hidden], .tp-done[hidden] { display: none; }
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
.tp button { all: unset; cursor: pointer; padding: 3px 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.25); color: #d6deeb; font: 600 12px 'Segoe UI', sans-serif; }
.tp button:hover { background: rgba(255,255,255,0.1); color: #fff; }
.tp button:focus-visible { outline: 2px solid #6cc8ff; outline-offset: 1px; }
.tp button.go { background: #f59e0b; border-color: #f59e0b; color: #1a1205; }
.tp button.go:hover { background: #fbbf24; color: #1a1205; }
.tp button.warn { border-color: rgba(248, 113, 113, 0.7); color: #fecaca; }
.tp button.leave { border-color: transparent; color: #8394ad; padding: 3px 6px; }
.tp-done { position: absolute; top: 7px; right: 10px; max-width: 62%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 1px 10px; border-radius: 999px; pointer-events: none;
  background: rgba(10, 40, 28, 0.94); border: 1px solid rgba(74, 222, 128, 0.7); color: #bbf7d0; font: 600 11px 'Segoe UI', sans-serif; animation: tpToast 2.6s ease-out forwards; }
@keyframes tpToast { 0% { opacity: 0; transform: translateY(-4px); } 10%, 80% { opacity: 1; transform: none; } 100% { opacity: 0; } }
/* A new step: the card's border flares twice and its contents slide in (the card's own transform is its placement, so the body moves) */
.tp.tp-new { animation: tpFlare 1.4s ease-out; }
.tp.tp-new > .tp-body { animation: tpIn 0.35s ease-out; }
@keyframes tpFlare { 0%, 40% { border-color: #fde68a; box-shadow: 0 0 0 3px rgba(251, 191, 36, 0.55), 0 0 44px rgba(251, 191, 36, 0.55), 0 10px 34px rgba(0,0,0,0.5); }
  20%, 60% { border-color: rgba(251, 191, 36, 0.55); box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.25), 0 0 26px rgba(251, 191, 36, 0.2), 0 10px 34px rgba(0,0,0,0.5); } }
@keyframes tpIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
/* Over a window (the station's, the hold), the hangar or the map: the same card, moved by it (placement.ts), above its veil; it glides there */
.tp.anch { z-index: 2600; }
@media (prefers-reduced-motion: reduce) { .tp { transition: none; } .tp-done { animation: none; } .tp-bar > i { transition: none; } .tp.tp-new, .tp.tp-new > .tp-body { animation: none; } }
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
  /** The card's contents (rebuilt on a change) and its "step done" pill (kept across rebuilds, in the card's corner) */
  private body = document.createElement('div');
  private toastEl = document.createElement('div');
  private toastTimer = 0;
  private grad: RewardScreen;
  private flow: LeaveFlow;
  private model: PanelModel | null = null;
  private pack: RewardLine[] = [];
  /** What is drawn now, so an unchanged state does not rebuild (and drop a click in flight) */
  private shown = '';
  /** The last spot worked out (an unchanged one is not set again) and whether the card has had its first */
  private placed = '';
  private positioned = false;
  /** The step last drawn: a different one is announced (chime and flare) */
  private stepShown = '';

  constructor(private d: PanelDeps) {
    injectStyles();
    this.flow = new LeaveFlow(() => d.leave());
    this.card.className = 'tp';
    this.card.hidden = true;
    this.card.setAttribute('role', 'region');
    this.card.setAttribute('aria-label', 'Training');
    this.body.className = 'tp-body';
    this.toastEl.className = 'tp-done';
    this.toastEl.hidden = true;
    this.toastEl.setAttribute('role', 'status');
    this.card.append(this.body, this.toastEl);
    this.grad = new RewardScreen({ sound: (id, v) => d.sound(id, v) });
    document.body.append(this.card);
    this.card.addEventListener('click', (e) => this.click(e));
  }

  /** Show this card (null hides everything); `pack` is the graduate screen's list */
  set(model: PanelModel | null, pack: RewardLine[]): void {
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
  reset(): void { this.flow.reset(); this.stepShown = ''; this.set(null, []); }

  /** Hide behind full-screen views (the menu) */
  setHidden(hidden: boolean): void {
    this.card.style.visibility = hidden ? 'hidden' : 'visible';
    if (hidden || this.card.hidden) { this.toastsAt(null); this.placed = ''; }
  }

  /** Is this element part of the card (its own key caps glow, and are no control to keep clear of)? */
  contains(el: Element): boolean { return this.card.contains(el); }

  /**
   * The game's toasts (ToastUI) drop below the card while it sits at the top of the screen, so neither covers the other:
   * `--toast-top` on the page root, or the toasts' own spot (null)
   */
  private toastsAt(cardBottom: number | null): void {
    const root = document.documentElement.style;
    if (cardBottom === null) root.removeProperty('--toast-top');
    else root.setProperty('--toast-top', `${Math.round(cardBottom + 8)}px`);
  }

  /**
   * Over a window, the hangar or the map the card sits by it (placement.ts); otherwise at its usual top-centre spot.
   * Called each frame: it only touches the page when the spot changes
   */
  place(anchor: CardAnchor | null, avoid: readonly Rect[] = []): void {
    if (this.card.hidden) { this.toastsAt(null); return; }
    const w = this.card.offsetWidth, h = this.card.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    const r = (q: Rect) => `${Math.round(q.left)},${Math.round(q.top)},${Math.round(q.width)},${Math.round(q.height)}`;
    const key = `${w}|${h}|${vw}|${vh}|${anchor ? `${anchor.mode}|${r(anchor.rect)}` : ''}|${avoid.map(r).join(';')}`;
    if (key === this.placed) return;
    this.placed = key;
    const { x, y } = cardPosition(anchor, { w, h }, { w: vw, h: vh }, avoid);
    // (a card at the top of the screen pushes the game's toasts down under it)
    this.toastsAt(y < TOAST_BAND ? y + h : null);
    // (the first spot is taken at once, with no glide from the corner)
    if (!this.positioned) this.card.style.transition = 'none';
    this.card.style.setProperty('--tx', `${Math.round(x)}px`);
    this.card.style.setProperty('--ty', `${Math.round(y)}px`);
    this.card.classList.toggle('anch', !!anchor);
    if (!this.positioned) { void this.card.offsetWidth; this.card.style.transition = ''; this.positioned = true; }
  }

  /** "Done: <step>" in the card's top corner for a moment (part of the card, so it never covers its title or a window) */
  toast(text: string, quiet = false): void {
    this.toastEl.textContent = `✓ Done: ${text}`;
    this.toastEl.title = this.toastEl.textContent;
    this.toastEl.hidden = false;
    // Restart the animation for back-to-back toasts
    this.toastEl.style.animation = 'none';
    void this.toastEl.offsetWidth;
    this.toastEl.style.animation = '';
    if (!quiet) this.d.sound('scan_ping', 0.5);
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { this.toastEl.hidden = true; }, 2700);
  }

  /** A new step's card: a chime and a flare, so it is clear there is something new to read */
  private announce(): void {
    this.d.sound('tutorial_step', 0.7);
    this.card.classList.remove('tp-new');
    void this.card.offsetWidth;
    this.card.classList.add('tp-new');
  }

  private render(): void {
    const m = this.model;
    const key = m ? `${m.returner ? 'r' : ''}${m.stepId}|${this.flow.phase}|${m.progress}|${m.counter ? m.counter.done : ''}|${m.lines.join('~')}|${this.pack.map((l) => `${l.count ?? ''}${l.label}`).join('~')}` : '';
    if (key === this.shown) return;
    this.shown = key;
    if (!m) { this.card.hidden = true; this.grad.hide(); return; }
    if (m.graduate) {
      this.card.hidden = true;
      this.grad.show({
        mode: 'modal', title: 'Training complete',
        ...(m.returner
          ? { intro: 'You know the basics.', lines: [], note: 'Your own ship is waiting, just as you left it.', button: 'Back to my ship' }
          : { intro: 'Here is your starter pack:', lines: this.pack, note: 'It goes to your station storage, with everything you mined and built. Next stop: Sol Central.', button: 'Enter Sol' }),
        onClose: () => {
          this.flow.enter();
          // (If the server never answers, the button comes back)
          window.setTimeout(() => { this.flow.reset(); this.render(); }, 6000);
        },
      });
      return;
    }
    this.grad.hide();
    if (this.card.hidden) { this.placed = ''; this.positioned = false; }
    this.card.hidden = false;
    if (m.stepId !== this.stepShown) { this.stepShown = m.stepId; this.announce(); }
    const confirm = this.flow.phase === 'confirm', sent = this.flow.phase === 'sent';
    this.body.innerHTML = `<div class="tp-h"><span>TRAINING · ${m.n} / ${m.total}</span></div>
      <div class="tp-t">${esc(m.title)}</div>
      ${m.lines.map((l) => `<div class="tp-l">${l}</div>`).join('')}
      ${m.counter ? `<div class="tp-ct${m.counter.done >= m.counter.total ? ' full' : ''}" role="status">${esc(m.counter.label)} ${m.counter.done}/${m.counter.total}</div>` : ''}
      <div class="tp-bar"><i style="width:${Math.round(m.progress * 100)}%"></i></div>
      <div class="tp-row">${sent ? '<span class="q">Leaving...</span>' : confirm
        ? `<span class="q">${m.returner ? "Leave now? You'll go back to your own ship, just as you left it." : "Leave now? You'll get the starter pack and can't come back."}</span><button class="warn" data-a="yes">Leave</button><button data-a="no">Stay</button>`
        : `${m.canContinue ? '<button class="go" data-a="continue">Continue</button>' : ''}<button class="leave" data-a="ask">Leave training</button>`}</div>`;
  }

  private click(e: Event): void {
    const a = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-a]')?.dataset.a;
    if (!a || !this.model) return;
    if (a === 'continue') this.d.ack(this.model.stepId);
    else if (a === 'ask') this.flow.ask();
    else if (a === 'no') this.flow.cancel();
    else if (a === 'yes') this.flow.confirm();
    // (If the server never answers, the buttons come back)
    if (this.flow.phase === 'sent') window.setTimeout(() => { this.flow.reset(); this.render(); }, 6000);
    this.d.sound('ui_click', 0.4);
    this.render();
  }
}
