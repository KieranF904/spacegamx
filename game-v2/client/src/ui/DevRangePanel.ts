/**
 * Weapons range panel (dev server only: Game makes it only in a Vite dev build; F10 opens it). Go to the range, pick any
 * weapon model to arm a test ship with two of it (or two different ones), switch "ideal ammo" and moving targets, and
 * read each dummy's damage, rate and time-to-kill. The server (devRange, WeaponsRange.ts) does all of it; nothing is saved.
 */
import type { ServerRangeStateMessage, RangeDummyState } from '@space-game/common';
import { setRangeSink } from './devRangeFeed';

export interface RangeGun { id: string; name: string; kind: string; fire: string; grade: number; mount: string }

/** What the "ideal ammo" switch means (also its tooltip) */
export const IDEAL_AMMO_RULE = "Every gun that takes crates fires unlimited rounds of its best crate and spends nothing from the hold. Best = the most direct damage per round (the crate's damage multiplier; splash, burn or frost it adds do not count); a tie goes to the standard crate.";

type RangeAction = { action: 'go' | 'arm' | 'ideal' | 'moving' | 'reset'; guns?: string[]; on?: boolean };

const css = (el: HTMLElement, s: Partial<CSSStyleDeclaration>) => Object.assign(el.style, s);

export class DevRangePanel {
  private el = document.createElement('div');
  private list = document.createElement('div');
  private gunsEl = document.createElement('div');
  private table = document.createElement('div');
  private slotEl = document.createElement('div');
  private ideal = document.createElement('input');
  private moving = document.createElement('input');
  private search = document.createElement('input');
  private mix = document.createElement('input');
  private slots: [string | null, string | null] = [null, null];
  private next = 0;
  private rows: { gun: RangeGun; el: HTMLButtonElement }[] = [];
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.code !== 'F10') return;
    e.preventDefault();
    this.el.style.display = this.el.style.display === 'none' ? 'block' : 'none';
  };

  constructor(private guns: RangeGun[], private send: (m: RangeAction) => void, private restore: () => void) {
    css(this.el, {
      position: 'fixed', right: '16px', top: '70px', width: '400px', maxHeight: '80vh', overflowY: 'auto', padding: '12px 14px', zIndex: '9000', display: 'none',
      background: 'rgba(8, 14, 24, 0.94)', border: '1px solid #2c4a66', borderRadius: '6px', color: '#cfe3f5', font: '12px Segoe UI, sans-serif', userSelect: 'none',
    });
    const title = this.text('WEAPONS RANGE · F10 (dev only)', { letterSpacing: '2px', fontSize: '11px', color: '#7fb3d9', marginBottom: '4px' });
    const how = this.text('1. Go to the range. 2. Click a weapon: your ship becomes a test rig with two of it (tick "A + B" for two different guns: each click fills slot A, then B). 3. Fire at the dummies: they never move or shoot, and come back a few seconds after dying. The table shows damage and time-to-kill. Nothing is saved; "Restore my ship" gives yours back.', { color: '#8aa5bc', marginBottom: '10px', lineHeight: '1.4' });
    this.el.append(title, how);

    const top = this.row();
    top.append(this.btn('Go to Weapons Range', () => this.send({ action: 'go' }), '#3a3318', '#b08a3a'), this.btn('Reset dummies', () => this.send({ action: 'reset' })), this.btn('Restore my ship', this.restore, '#183a22', '#4a7a5a'));
    this.el.append(top);

    const sw = this.row();
    sw.style.margin = '8px 0';
    this.ideal.type = 'checkbox';
    this.moving.type = 'checkbox';
    this.mix.type = 'checkbox';
    this.ideal.addEventListener('change', () => this.send({ action: 'ideal', on: this.ideal.checked }));
    this.moving.addEventListener('change', () => this.send({ action: 'moving', on: this.moving.checked }));
    this.mix.addEventListener('change', () => { this.next = 0; this.slots = [this.slots[0], null]; this.showSlots(); });
    sw.append(
      this.check(this.ideal, 'Use ideal ammo', IDEAL_AMMO_RULE),
      this.check(this.moving, 'Moving targets', 'Dummies sweep side to side across their spots. Toggling puts them back on their spots.'),
      this.check(this.mix, 'A + B', 'Arm two different guns: each click fills slot A, then slot B, then A again.'),
    );
    this.el.append(sw, this.slotEl, this.gunsEl);
    css(this.slotEl, { color: '#9fc4e2', margin: '4px 0' });
    css(this.gunsEl, { color: '#9fc4e2', margin: '4px 0 8px', lineHeight: '1.45' });

    this.el.append(this.text('TARGETS', { letterSpacing: '2px', fontSize: '11px', color: '#d9a07f', margin: '10px 0 4px' }), this.table);
    this.el.append(this.text('WEAPONS', { letterSpacing: '2px', fontSize: '11px', color: '#7fb3d9', margin: '12px 0 4px' }));
    this.search.placeholder = 'Search name, kind, firing model, Mk...';
    css(this.search, { width: '100%', boxSizing: 'border-box', padding: '5px 8px', marginBottom: '6px', background: '#0e1c2c', color: '#e2effa', border: '1px solid #2c4a66', borderRadius: '4px', font: '12px Segoe UI, sans-serif', userSelect: 'text' });
    this.search.addEventListener('input', () => this.filter());
    // (the game's keys shouldn't fire while typing here)
    for (const t of ['keydown', 'keyup', 'keypress']) this.search.addEventListener(t, (e) => { if ((e as KeyboardEvent).code !== 'F10') e.stopPropagation(); });
    this.el.append(this.search, this.list);
    const sorted = [...guns].sort((a, b) => a.kind.localeCompare(b.kind) || a.grade - b.grade || a.name.localeCompare(b.name));
    for (const gun of sorted) this.rows.push({ gun, el: this.weapon(gun) });
    this.showSlots();

    document.body.appendChild(this.el);
    window.addEventListener('keydown', this.onKey, true);
    setRangeSink((m) => this.onState(m));
  }

  private text(t: string, s: Partial<CSSStyleDeclaration>): HTMLDivElement {
    const d = document.createElement('div');
    d.textContent = t;
    css(d, s);
    return d;
  }

  private row(): HTMLDivElement {
    const r = document.createElement('div');
    css(r, { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' });
    return r;
  }

  private btn(label: string, click: () => void, bg = '#16304a', border = '#2c4a66'): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    css(b, { flex: '1', padding: '6px 8px', cursor: 'pointer', background: bg, border: `1px solid ${border}`, borderRadius: '4px', color: '#e2effa', font: '12px Segoe UI, sans-serif' });
    b.addEventListener('click', click);
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    return b;
  }

  private check(box: HTMLInputElement, label: string, tip: string): HTMLLabelElement {
    const l = document.createElement('label');
    l.title = tip;
    css(l, { display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', color: '#e2effa' });
    l.append(box, label);
    l.addEventListener('mousedown', (e) => e.stopPropagation());
    return l;
  }

  private weapon(g: RangeGun): HTMLButtonElement {
    const b = document.createElement('button');
    const top = this.text(`${g.name}  ·  Mk ${g.grade}`, { fontSize: '13px', color: '#e2effa' });
    const sub = this.text(`${g.kind} · ${g.fire} · ${g.mount}`, { fontSize: '11px', color: '#8aa5bc', marginTop: '2px' });
    b.append(top, sub);
    css(b, { display: 'block', width: '100%', textAlign: 'left', marginBottom: '4px', padding: '5px 10px', cursor: 'pointer', background: '#16304a', border: '1px solid #2c4a66', borderRadius: '4px' });
    b.addEventListener('click', () => this.pick(g.id));
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    this.list.appendChild(b);
    return b;
  }

  private pick(id: string): void {
    if (this.mix.checked) {
      this.slots[this.next] = id;
      this.next = 1 - this.next;
    } else {
      this.slots = [id, null];
    }
    const chosen = this.slots.filter((s): s is string => !!s);
    this.send({ action: 'arm', guns: chosen });
    this.showSlots();
  }

  private nameOf(id: string | null): string {
    return id ? this.guns.find((g) => g.id === id)?.name ?? id : '-';
  }

  private showSlots(): void {
    this.slotEl.textContent = this.mix.checked
      ? `Slot A: ${this.nameOf(this.slots[0])}   ·   Slot B: ${this.nameOf(this.slots[1])}   (next click: ${this.next ? 'B' : 'A'})`
      : `Test rig: 2 x ${this.nameOf(this.slots[0])}`;
  }

  private filter(): void {
    const q = this.search.value.trim().toLowerCase();
    for (const { gun, el } of this.rows) {
      const hay = `${gun.name} ${gun.kind} ${gun.fire} ${gun.mount} mk${gun.grade} mk ${gun.grade}`.toLowerCase();
      el.style.display = !q || q.split(/\s+/).every((w) => hay.includes(w)) ? 'block' : 'none';
    }
  }

  /** The server's readout */
  private onState(m: ServerRangeStateMessage): void {
    if (this.el.style.display === 'none') return;
    if (document.activeElement !== this.ideal) this.ideal.checked = m.ideal;
    if (document.activeElement !== this.moving) this.moving.checked = m.moving;
    this.gunsEl.textContent = '';
    for (const g of m.guns) this.gunsEl.append(this.text(`${g.name} (${g.kind}): ${m.ideal ? (g.crate ? `ideal crate: ${g.crate}` : 'no crate needed') : 'your own crates'}`, {}));
    if (!m.guns.length) this.gunsEl.textContent = 'No guns on this ship.';
    this.table.textContent = '';
    this.table.append(this.cells(['Target', 'm', 'Hull', 'Shield', 'dps', '5 s', 'TTK s'], '#7fb3d9'));
    for (const d of m.dummies) this.table.append(this.dummyRow(d));
  }

  private cells(v: string[], color: string, dead = false): HTMLDivElement {
    const r = document.createElement('div');
    css(r, { display: 'grid', gridTemplateColumns: '1fr 38px 40px 46px 40px 44px 46px', gap: '4px', padding: '2px 0', fontSize: '11px', color: dead ? '#6a7f90' : color, borderBottom: '1px solid #15283c' });
    v.forEach((t, i) => {
      const c = document.createElement('div');
      c.textContent = t;
      if (i) c.style.textAlign = 'right';
      else css(c, { overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' });
      r.append(c);
    });
    return r;
  }

  private dummyRow(d: RangeDummyState): HTMLDivElement {
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const live = d.fight > 0 && !d.dead;
    const r = this.cells([d.name, String(d.dist), d.dead ? 'down' : pct(d.hull), d.dead ? '-' : pct(d.shield), d.dps ? String(d.dps) : '-', d.dmg5 ? String(d.dmg5) : '-', live ? `${d.fight.toFixed(1)}...` : d.ttk !== null ? d.ttk.toFixed(1) : '-'], '#cfe3f5', d.dead);
    r.title = `${d.name}: total taken this fight ${d.total}`;
    return r;
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey, true);
    setRangeSink(null);
    this.el.remove();
  }
}
