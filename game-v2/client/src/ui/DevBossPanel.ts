/**
 * The boss tools (dev builds only: app/devTools.ts makes it; Shift+F9, or the F9 panel's button, opens it). The server
 * side is game/dev/bossDev.ts, which refuses anyone but a dev server's pilots and admins.
 *
 * For each boss in your system: its life (dormant, waking, fighting, recovering, healing, sleeping), stage, move and
 * window; buttons to go there, wake it or put it to sleep, skip its recovery clock, jump to a stage, play a move next,
 * open a window, take one of its personal attacks, hold it still, add dummy pilots (with a damage setting) and slow its
 * system's clock. Below: the last hits you took in an arena (what, whose, how much) and the fight summary.
 */

import type { ClientBossDevMessage, ServerBossDevMessage, BossDevRow } from '@space-game/common';
import { esc } from './escape';

type Send = (msg: Omit<ClientBossDevMessage, 'type'>) => void;

const LIFE_WORD: Record<string, string> = { dormant: 'dormant', waking: 'waking', active: 'fighting', recovering: 'recovering', healing: 'healing', sleeping: 'sinking back', live: 'live' };

export class DevBossPanel {
  private el = document.createElement('div');
  private body = document.createElement('div');
  private log = document.createElement('div');
  private sum = document.createElement('div');
  private shape = '';
  private dps: 'off' | 'starter' | 'l30' = 'starter';
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.code !== 'F9' || !e.shiftKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.toggle();
  };

  constructor(private send: Send) {
    Object.assign(this.el.style, {
      position: 'fixed', right: '16px', top: '70px', width: '360px', maxHeight: '78vh', overflowY: 'auto', padding: '12px 14px', zIndex: '9000', display: 'none',
      background: 'rgba(14, 10, 8, 0.94)', border: '1px solid #6a3f2a', borderRadius: '6px', color: '#f0dccb', font: '12px Segoe UI, sans-serif', userSelect: 'none',
    });
    const title = document.createElement('div');
    title.textContent = 'BOSS TOOLS · Shift+F9 (dev only)';
    Object.assign(title.style, { letterSpacing: '2px', fontSize: '11px', color: '#e0a47f', marginBottom: '8px' });
    Object.assign(this.log.style, { marginTop: '10px', fontSize: '11px', lineHeight: '1.45', color: '#d8c3b0' });
    Object.assign(this.sum.style, { marginTop: '8px', fontSize: '11px', lineHeight: '1.45', color: '#bfe6cf', whiteSpace: 'pre-wrap' });
    this.el.append(title, this.body, this.sum, this.log);
    this.el.addEventListener('mousedown', (e) => e.stopPropagation());
    document.body.appendChild(this.el);
    window.addEventListener('keydown', this.onKey, true);
  }

  toggle(): void {
    const open = this.el.style.display === 'none';
    this.el.style.display = open ? 'block' : 'none';
    this.send({ action: 'panel', on: open });
  }

  /** The server's state for the panel (bossDev) */
  update(msg: ServerBossDevMessage): void {
    if (this.el.style.display === 'none') return;
    const shape = msg.bosses.map((b) => `${b.id}|${b.moves.join(',')}|${b.personal.join(',')}`).join(';');
    if (shape !== this.shape) { this.shape = shape; this.build(msg.bosses); }
    for (const b of msg.bosses) {
      const st = this.body.querySelector<HTMLElement>(`[data-st="${b.id}"]`);
      if (st) st.innerHTML = this.status(b);
    }
    this.log.innerHTML = msg.log.length
      ? '<div style="color:#e0a47f;letter-spacing:2px;font-size:10px">HITS YOU TOOK (ARENA)</div>' + msg.log.slice().reverse()
        .map((e) => `<div>t${e.tick} · <b>${esc(e.attack || '?')}</b> · ${esc(e.source)} · ${e.dealt}</div>`).join('')
      : '<div style="color:#8a7464">No hits taken in an arena yet.</div>';
    if (msg.summary) this.sum.textContent = msg.summary;
  }

  private status(b: BossDevRow): string {
    const w = b.window ? ` · window ${Math.round(b.window.fill * 100)}%${b.window.crack ? ' CRACKED' : ''} ${(b.window.left / 60).toFixed(1)} s` : '';
    return `${esc(LIFE_WORD[b.life] ?? b.life)}${b.stage ? ` · stage ${b.stage}` : ''}${b.move ? ` · ${esc(b.move)}` : ''}${w}`
      + `${b.hold ? ' · HOLD' : ''}${b.dummies ? ` · ${b.dummies} dummies` : ''}${b.rate !== 60 ? ` · clock ${b.rate}/s` : ''}`;
  }

  private build(rows: BossDevRow[]): void {
    this.body.innerHTML = '';
    if (!rows.length) { this.body.textContent = 'No boss in this system.'; return; }
    for (const b of rows) {
      const head = document.createElement('div');
      head.innerHTML = `<div style="font-size:13px;color:#ffe2c8;margin-top:6px">${esc(b.name)}</div><div data-st="${esc(b.id)}" style="color:#c9a88f;margin-bottom:4px"></div>`;
      this.body.appendChild(head);
      const go = (action: ClientBossDevMessage['action'], extra: Partial<ClientBossDevMessage> = {}) => () => this.send({ action, boss: b.id, ...extra });
      this.row([['Go to', go('goto')], ['Wake', go('wake')], ['Sleep', go('sleep')], ['Heal', go('heal')], ['Skip clock', go('skip')]]);
      this.row([['Hold', go('hold')], ['Window now', go('window')], ['Summary', go('summary')], ['Stage 1', go('stage', { n: 1 })], ['2', go('stage', { n: 2 })], ['3', go('stage', { n: 3 })]]);
      if (b.moves.length) { this.label('Play next'); this.row(b.moves.map((m) => [m, go('move', { move: m })])); }
      if (b.personal.length) { this.label('Personal attack on me'); this.row(b.personal.map((m) => [m, go('personal', { move: m })])); }
      this.label('Dummy pilots (count as present, never die)');
      this.row((['off', 'starter', 'l30'] as const).map((d) => [`dps ${d}`, () => { this.dps = d; }]));
      this.row([0, 1, 2, 4, 8, 12].map((n) => [String(n), () => this.send({ action: 'dummies', boss: b.id, n, dps: this.dps })]));
      this.label('Clock');
      this.row([['x1', go('slow', { n: 60 })], ['x0.5', go('slow', { n: 30 })], ['x0.25', go('slow', { n: 15 })], ['Clear log', () => this.send({ action: 'log', on: false })]]);
    }
  }

  private label(text: string): void {
    const l = document.createElement('div');
    l.textContent = text;
    Object.assign(l.style, { fontSize: '10px', letterSpacing: '1px', color: '#a88a74', margin: '6px 0 3px' });
    this.body.appendChild(l);
  }

  private row(buttons: [string, () => void][]): void {
    const r = document.createElement('div');
    Object.assign(r.style, { display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '4px' });
    for (const [text, click] of buttons) {
      const b = document.createElement('button');
      b.textContent = text;
      Object.assign(b.style, { padding: '4px 7px', cursor: 'pointer', background: '#3a2218', border: '1px solid #8a4a2a', borderRadius: '4px', color: '#ffd8c0', font: '11px Segoe UI, sans-serif' });
      b.addEventListener('click', click);
      r.appendChild(b);
    }
    this.body.appendChild(r);
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey, true);
    this.el.remove();
  }
}
