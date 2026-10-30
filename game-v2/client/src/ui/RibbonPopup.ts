/**
 * A ribbon earned: a medal card drops in at the top of the screen with its
 * name, what it was for and what it paid, then fades. Several queue up.
 */

import type { RibbonDef } from '@space-game/common';

function esc(t: string): string {
  return t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export class RibbonPopup {
  private queue: { def: RibbonDef; credits: number; xp: number }[] = [];
  private busy = false;
  private el: HTMLDivElement;

  constructor(private sound: (id: string) => void) {
    const css = document.createElement('style');
    css.textContent = `
.ribp { position: fixed; left: 50%; top: 86px; transform: translate(-50%, -20px); opacity: 0; z-index: 2600; pointer-events: none;
  display: flex; align-items: center; gap: 14px; padding: 12px 20px 12px 14px; border-radius: 14px;
  background: linear-gradient(180deg, rgba(30, 40, 20, 0.96), rgba(14, 20, 10, 0.96)); border: 1px solid rgba(134, 239, 172, 0.6);
  box-shadow: 0 0 40px rgba(134, 239, 172, 0.2), 0 16px 40px rgba(0,0,0,0.5); color: #e5ecf7; font: 13px 'Segoe UI', system-ui, sans-serif;
  transition: opacity .35s, transform .35s; }
.ribp.on { opacity: 1; transform: translate(-50%, 0); }
.ribp.rare { border-color: rgba(251, 191, 36, 0.75); background: linear-gradient(180deg, rgba(44, 34, 10, 0.96), rgba(22, 16, 6, 0.96)); box-shadow: 0 0 50px rgba(251, 191, 36, 0.3), 0 16px 40px rgba(0,0,0,0.5); }
.ribp .m { width: 48px; height: 48px; border-radius: 50%; display: grid; place-items: center; font-size: 26px; color: #86efac;
  border: 2px solid rgba(134, 239, 172, 0.7); box-shadow: inset 0 0 12px rgba(134,239,172,0.3); }
.ribp.rare .m { color: #fde68a; border-color: rgba(251, 191, 36, 0.8); box-shadow: inset 0 0 14px rgba(251,191,36,0.35); }
.ribp .k { font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 3px; color: #86efac; }
.ribp.rare .k { color: #fbbf24; }
.ribp .n { font: 700 17px 'Segoe UI', sans-serif; color: #fff; }
.ribp .d { color: #a9b6c9; font-size: 12px; }
.ribp .r { color: #fde68a; font-size: 12px; margin-top: 2px; }`;
    document.head.appendChild(css);
    this.el = document.createElement('div');
    this.el.className = 'ribp';
    document.body.appendChild(this.el);
  }

  show(def: RibbonDef, credits: number, xp: number): void {
    this.queue.push({ def, credits, xp });
    if (!this.busy) this.next();
  }

  private next(): void {
    const it = this.queue.shift();
    if (!it) { this.busy = false; return; }
    this.busy = true;
    const reward = [credits(it.credits), it.xp ? `+${it.xp.toLocaleString()} XP` : ''].filter(Boolean).join(' · ');
    this.el.className = `ribp${it.def.rare ? ' rare' : ''}`;
    this.el.innerHTML = `<div class="m">${it.def.icon}</div><div><div class="k">${it.def.rare ? 'RARE RIBBON' : 'RIBBON EARNED'}</div>
      <div class="n">${esc(it.def.name)}</div><div class="d">${esc(it.def.description)}</div>${reward ? `<div class="r">${reward}</div>` : ''}</div>`;
    this.sound(it.def.rare ? 'level_up' : 'credits');
    requestAnimationFrame(() => this.el.classList.add('on'));
    setTimeout(() => { this.el.classList.remove('on'); setTimeout(() => this.next(), 450); }, it.def.rare ? 5200 : 3800);
  }
}

function credits(n: number): string {
  return n ? `+${n.toLocaleString()} cr` : '';
}
