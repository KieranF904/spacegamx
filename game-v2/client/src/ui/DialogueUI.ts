/**
 * Conversations (the server's `talk` messages, econ/dialogue.ts): a panel
 * over the chat box, bottom left. Who's talking, what they said (typed out:
 * click, Space or Enter to finish it), and your answers (click, or 1-9).
 * A job on offer shows as a card, its steps and rewards, with Accept and
 * Not now; a finished job shows what it paid. Esc walks away.
 *
 * Nothing over comms ever opens the panel: a call with nothing to decide is
 * a toast (quest news comes as toasts and the log's badge anyway).
 */

import type { TalkView, ClientMessage } from '@space-game/common';
import type { PilotState } from '../econ/clientEcon';
import { rewardsHtml, CHAIN } from './QuestUI';

export interface DialogueDeps {
  pilot: PilotState;
  send(m: ClientMessage): void;
  sound(id: string, volume?: number): void;
  /** Follow a job (a call's "Show me the way") */
  track(id: string): void;
  toast(text: string, kind?: 'info' | 'good' | 'warn' | 'bad'): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.dlg { position: fixed; left: 16px; bottom: 20px; width: min(460px, calc(100vw - 32px)); max-height: min(560px, calc(100vh - 140px)); z-index: 3000;
  display: none; flex-direction: column; background: linear-gradient(180deg, rgba(14, 22, 40, 0.97), rgba(7, 12, 24, 0.97));
  border: 1px solid rgba(120, 150, 200, 0.28); border-top: 2px solid var(--pc); border-radius: 14px; box-shadow: 0 24px 70px rgba(0,0,0,0.6);
  font: 13px 'Segoe UI', system-ui, sans-serif; color: #d6deeb; opacity: 0; transform: translateY(10px); transition: opacity .2s, transform .2s; }
.dlg.on { opacity: 1; transform: none; }
.dlg-top { display: flex; gap: 12px; align-items: center; padding: 12px 14px 8px; }
.dlg-av { width: 42px; height: 42px; border-radius: 50%; display: grid; place-items: center; flex: none;
  background: radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--pc) 60%, #fff 0%), rgba(10,16,30,0.9) 75%);
  border: 1px solid var(--pc); font: 700 16px 'Segoe UI', sans-serif; color: #fff; text-shadow: 0 1px 3px #000; }
.dlg-who { flex: 1; min-width: 0; }
.dlg-who .n { font: 600 15px 'Segoe UI', sans-serif; color: #fff; }
.dlg-who .t { color: #8394ad; font-size: 11px; }
.dlg-tag { font: 700 9px 'Segoe UI', sans-serif; letter-spacing: 2px; color: #7dd3fc; border: 1px solid rgba(125,211,252,0.45); border-radius: 5px; padding: 2px 6px; }
.dlg-x { all: unset; cursor: pointer; color: #56657c; font-size: 16px; padding: 2px 6px; border-radius: 6px; }
.dlg-x:hover { color: #fff; background: rgba(255,255,255,0.06); }
.dlg-ttl { padding: 0 14px 4px; font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 2px; color: var(--pc); text-transform: uppercase; }
.dlg-body { padding: 4px 14px 8px; overflow-y: auto; display: flex; flex-direction: column; gap: 7px; scrollbar-width: thin; }
.dlg-ln { line-height: 1.55; color: #c9d4e5; white-space: pre-wrap; }
.dlg-ln.you { color: #a5b4cb; font-style: italic; padding-left: 14px; border-left: 2px solid rgba(140,170,220,0.25); }
.dlg-card { border: 1px solid rgba(140,170,220,0.16); border-top: 2px solid var(--qc); border-radius: 10px; padding: 9px 11px; background: rgba(4,8,16,0.4); }
.dlg-card h5 { margin: 0 0 4px; font: 600 13px 'Segoe UI', sans-serif; color: #fff; display: flex; gap: 8px; align-items: baseline; }
.dlg-card h5 .c { font: 700 9px 'Segoe UI', sans-serif; letter-spacing: 1.5px; color: var(--qc); text-transform: uppercase; }
.dlg-card h5 .lv { margin-left: auto; color: #8394ad; font-weight: 400; font-size: 11px; }
.dlg-card ol { margin: 4px 0 6px; padding-left: 18px; color: #c9d4e5; line-height: 1.5; font-size: 12px; }
.dlg-ch { display: flex; flex-direction: column; gap: 5px; padding: 8px 14px 12px; border-top: 1px solid rgba(140,170,220,0.1); }
.dlg-ch button { all: unset; cursor: pointer; display: flex; gap: 8px; align-items: baseline; padding: 6px 10px; border-radius: 8px;
  border: 1px solid rgba(140,170,220,0.16); background: rgba(255,255,255,0.03); color: #e5ecf7; line-height: 1.35; }
.dlg-ch button:hover, .dlg-ch button:focus-visible { background: rgba(125,211,252,0.1); border-color: rgba(125,211,252,0.4); }
.dlg-ch button .k { color: #56657c; font: 700 10px 'Segoe UI', sans-serif; min-width: 10px; }
.dlg-ch button.quest { border-color: rgba(251,191,36,0.4); }
.dlg-ch button.quest::before { content: '!'; color: #fbbf24; font-weight: 700; }
.dlg-ch button.go { border-color: rgba(74,222,128,0.5); background: rgba(34,197,94,0.1); color: #bbf7d0; }
.dlg-ch button.bye { color: #a9b6c9; }
.dlg-ch.wait button { opacity: 0.35; pointer-events: none; }
.dlg-hint { color: #56657c; font-size: 10px; padding: 0 14px 10px; }`;
  document.head.appendChild(css);
}

export class DialogueUI {
  private root: HTMLDivElement;
  private view: TalkView | null = null;
  private typing: number | null = null;
  private finish: (() => void) | null = null;

  constructor(private d: DialogueDeps) {
    injectStyles();
    this.root = document.createElement('div');
    this.root.className = 'dlg';
    this.root.dataset.hudAvoid = '1';
    document.body.appendChild(this.root);
  }

  get isOpen(): boolean {
    return this.view !== null;
  }

  /** The server's latest: show it, or (null) close */
  set(v: TalkView | null): void {
    if (!v) { this.hide(); return; }
    // A call with nothing to decide is just a toast
    if (v.comms && !v.offer && v.choices.length === 1) {
      const line = v.lines.map((l) => l.text).join(' ');
      this.d.toast(`${v.who.name}: ${line.length > 140 ? `${line.slice(0, 137)}…` : line}`, v.paid ? 'good' : 'info');
      this.d.send({ type: 'talk', n: v.n, close: true });
      return;
    }
    const first = !this.view;
    this.view = v;
    this.render();
    if (first) {
      this.root.style.display = 'flex';
      requestAnimationFrame(() => this.root.classList.add('on'));
      this.d.sound(v.comms ? 'scan_ping' : 'ui_open', 0.5);
    }
    if (v.paid) this.d.sound('level_up', 0.6);
  }

  /** Walk away */
  close(): void {
    if (!this.view) return;
    this.d.send({ type: 'talk', n: this.view.n, close: true });
    this.hide();
  }

  /** Off screen (the connection ended) */
  hide(): void {
    this.stopTyping();
    this.view = null;
    this.root.classList.remove('on');
    this.root.style.display = 'none';
    this.root.replaceChildren();
  }

  /** Keys while it's open: digits answer, Space/Enter finish the words (or take the only answer), Esc walks away */
  onKey(code: string): boolean {
    if (!this.view) return false;
    if (code === 'Escape') { this.close(); return true; }
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      if (this.finish) { this.finish(); return true; }
      if (this.view.choices.length === 1) { this.choose(0); return true; }
      return false;
    }
    const m = /^(?:Digit|Numpad)([1-9])$/.exec(code);
    if (m) {
      const i = Number(m[1]) - 1;
      if (i < this.view.choices.length) { this.choose(i); return true; }
    }
    return false;
  }

  private choose(i: number): void {
    const v = this.view;
    if (!v || this.finish) { this.finish?.(); return; }
    const c = v.choices[i];
    if (!c) return;
    if (c.track) this.d.track(c.track);
    this.d.sound('ui_click', 0.4);
    // Wait for the answer (the server's next page, or null)
    this.root.querySelector('.dlg-ch')?.classList.add('wait');
    this.d.send({ type: 'talk', n: v.n, choice: i });
  }

  private stopTyping(): void {
    if (this.typing !== null) { clearInterval(this.typing); this.typing = null; }
    this.finish = null;
  }

  private render(): void {
    const v = this.view!;
    this.stopTyping();
    this.root.style.setProperty('--pc', v.who.color);
    const initials = v.who.name.replace(/^(Dr|Lieutenant|Commander|Warden|Harbourmaster|Depot Chief|Forgemaster|Researcher|Merchant|Old)\.?\s+/, '')
      .split(/\s+/).filter((w) => /^[A-Z]/.test(w)).slice(0, 2).map((w) => w[0]).join('') || '◆';
    const card = v.offer ? (() => {
      const q = v.offer!;
      const ch = CHAIN[q.chain] ?? { label: q.chain, color: '#c9d4e5' };
      return `<div class="dlg-card" style="--qc:${ch.color}"><h5><span class="c">${esc(ch.label)}</span>${esc(q.name)}<span class="lv">${q.level > 1 ? `lvl ${q.level}` : ''}</span></h5>
        <ol>${q.steps.map((s) => `<li>${esc(s.text)}</li>`).join('')}</ol>${rewardsHtml(this.d.pilot, q.rewards)}</div>`;
    })() : '';
    const paid = v.paid ? `<div class="dlg-card" style="--qc:#4ade80">${rewardsHtml(this.d.pilot, v.paid)}</div>` : '';
    this.root.innerHTML = `
      <div class="dlg-top"><div class="dlg-av">${esc(initials)}</div>
        <div class="dlg-who"><div class="n">${esc(v.who.name)}</div><div class="t">${esc(v.who.title)}</div></div>
        ${v.comms ? '<span class="dlg-tag">COMMS</span>' : ''}<button class="dlg-x" title="Walk away (Esc)">✕</button></div>
      ${v.title ? `<div class="dlg-ttl">${esc(v.title)}</div>` : ''}
      <div class="dlg-body"></div>
      <div class="dlg-ch"></div>
      <div class="dlg-hint">1-${Math.max(1, v.choices.length)} to answer · Space to skip ahead · Esc to walk away</div>`;
    (this.root.querySelector('.dlg-x') as HTMLElement).onclick = () => this.close();
    const body = this.root.querySelector('.dlg-body') as HTMLElement;
    const choices = this.root.querySelector('.dlg-ch') as HTMLElement;
    v.choices.forEach((c, i) => {
      const b = document.createElement('button');
      if (c.tone) b.className = c.tone;
      b.innerHTML = `<span class="k">${i + 1}</span><span>${esc(c.text)}</span>`;
      b.onclick = () => this.choose(i);
      choices.appendChild(b);
    });
    // The lines, typed out one after another; the card and the answers once they're all there
    const els = v.lines.map((l) => {
      const el = document.createElement('div');
      el.className = `dlg-ln${l.you ? ' you' : ''}`;
      body.appendChild(el);
      return { el, text: l.text };
    });
    const extra = document.createElement('div');
    extra.innerHTML = card + paid;
    const done = () => {
      this.stopTyping();
      for (const x of els) x.el.textContent = x.text;
      if (extra.innerHTML && !extra.isConnected) body.appendChild(extra);
      choices.classList.remove('wait');
      body.scrollTop = body.scrollHeight;
    };
    choices.classList.add('wait');
    let li = 0, ci = 0;
    this.finish = done;
    this.typing = window.setInterval(() => {
      const cur = els[li];
      if (!cur) { done(); return; }
      ci = Math.min(cur.text.length, ci + 3);
      cur.el.textContent = cur.text.slice(0, ci);
      if (ci >= cur.text.length) { li++; ci = 0; }
      body.scrollTop = body.scrollHeight;
    }, 16);
    body.onclick = () => this.finish?.();
  }
}
