/**
 * The loading screen between choosing a server (or arriving somewhere, or respawning) and the world being in sync:
 * the sign-in screen's look (near-black space, Orbitron title with the warm glow, Rajdhani lettering), a status line
 * naming the step being waited on, a thin progress bar, and a quick fade out. app/loadingFlow.ts decides when.
 */

const STYLE = `
.sg-load { position: fixed; inset: 0; z-index: 4500; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(ellipse at 50% 46%, rgba(255, 110, 30, 0.10) 0%, rgba(255, 80, 0, 0.03) 32%, rgba(0, 0, 0, 0) 60%), #000005;
  opacity: 1; transition: opacity 380ms ease-out; pointer-events: auto; user-select: none; }
.sg-load.sg-out { opacity: 0; pointer-events: none; }
.sg-load[hidden] { display: none; }
.sg-load-box { display: flex; flex-direction: column; align-items: center; gap: 14px; margin-top: -6vh; }
.sg-load-title { font-family: 'Orbitron', 'Rajdhani', 'Arial Black', sans-serif; font-size: 30px; font-weight: 900; color: #fff;
  letter-spacing: 8px; text-transform: uppercase; text-align: center; padding-left: 8px;
  text-shadow: 0 0 10px rgba(255, 200, 100, 0.7), 0 0 22px rgba(255, 150, 50, 0.5), 0 0 48px rgba(255, 100, 0, 0.3); }
.sg-load-sub { font-family: 'Rajdhani', 'Arial', sans-serif; font-size: 14px; color: #ff9944; opacity: 0.8;
  letter-spacing: 6px; text-transform: uppercase; text-align: center; padding-left: 6px; min-height: 18px; }
.sg-load-bar { position: relative; width: 260px; height: 2px; margin-top: 18px; background: rgba(255, 150, 50, 0.14); overflow: hidden; border-radius: 1px; }
.sg-load-fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: linear-gradient(90deg, #cc3300, #ff8833);
  box-shadow: 0 0 8px rgba(255, 136, 51, 0.7); transition: width 300ms ease-out; }
.sg-load-bar::after { content: ''; position: absolute; top: 0; bottom: 0; width: 60px; left: -60px;
  background: linear-gradient(90deg, rgba(255, 200, 150, 0), rgba(255, 220, 180, 0.55), rgba(255, 200, 150, 0));
  animation: sg-load-sweep 1.4s ease-in-out infinite; }
@keyframes sg-load-sweep { from { left: -60px; } to { left: 260px; } }
.sg-load-step { font-family: 'Rajdhani', 'Arial', sans-serif; font-size: 13px; color: rgba(255, 200, 150, 0.7);
  letter-spacing: 3px; text-transform: uppercase; text-align: center; padding-left: 3px; min-height: 17px; }
`;

let styled = false;

export class LoadingScreen {
  private root: HTMLDivElement;
  private title: HTMLDivElement;
  private sub: HTMLDivElement;
  private fill: HTMLDivElement;
  private step: HTMLDivElement;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private shown = false;

  constructor(parent: HTMLElement) {
    if (!styled) {
      styled = true;
      const s = document.createElement('style');
      s.textContent = STYLE;
      document.head.appendChild(s);
    }
    this.root = document.createElement('div');
    this.root.className = 'sg-load';
    this.root.id = 'join-loading';
    this.root.hidden = true;
    this.root.innerHTML = `<div class="sg-load-box"><div class="sg-load-title"></div><div class="sg-load-sub"></div>
      <div class="sg-load-bar"><div class="sg-load-fill"></div></div><div class="sg-load-step"></div></div>`;
    this.title = this.root.querySelector('.sg-load-title')!;
    this.sub = this.root.querySelector('.sg-load-sub')!;
    this.fill = this.root.querySelector('.sg-load-fill')!;
    this.step = this.root.querySelector('.sg-load-step')!;
    parent.appendChild(this.root);
  }

  /** Up at once (no fade in: it covers the world the frame it's asked for) */
  show(title: string, subtitle: string): void {
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    this.title.textContent = title;
    this.sub.textContent = subtitle;
    if (!this.shown) {
      this.fill.style.transition = 'none';
      this.fill.style.width = '0%';
      void this.fill.offsetWidth;
      this.fill.style.transition = '';
    }
    this.root.classList.remove('sg-out');
    this.root.hidden = false;
    this.shown = true;
  }

  /** The step being waited on, and how far along (0..1) */
  setStep(step: string, progress: number): void {
    if (this.step.textContent !== step) this.step.textContent = step;
    const w = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
    if (this.fill.style.width !== w) this.fill.style.width = w;
  }

  /** Fade out (`instant`: gone now, e.g. for a dropped connection's message) */
  hide(instant = false): void {
    if (!this.shown) return;
    this.shown = false;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (instant) { this.root.hidden = true; this.root.classList.remove('sg-out'); return; }
    this.root.classList.add('sg-out');
    this.hideTimer = setTimeout(() => { this.hideTimer = null; this.root.hidden = true; }, 420);
  }

  get visible(): boolean {
    return this.shown;
  }
}
