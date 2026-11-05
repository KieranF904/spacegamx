/**
 * The info panel: a fixed panel at the bottom right (just above the target
 * panel) that reads out whatever's under the cursor, which gets a faint ring
 * so you can see what it's describing. It stays up a moment after the cursor
 * moves off, so there's time to read it.
 *
 * - Another pilot: who they are, their level and standing, the ship they fly
 *   and how it's holding up, and their party (P invites them).
 * - Any other ship (hostiles, civilians, derelicts): faction, rating against
 *   yours, hull, shield and core.
 * - An asteroid, at a glance: roughly what it's made of, how much ore it
 *   holds, and whether it's too hard for ordinary guns. A scanner gives the
 *   exact shares and finds gem seams.
 *
 * Your current target isn't repeated here: the target panel shows it.
 */

import { EntityType, ServerPilotInfoMessage, ClientMessage } from '@space-game/common';
import type { GameState, InterpolatedEntity } from '../state/GameState';
import miningTable from '../../../data/mining.json';
import { esc, isShip, shipKind, shipSubHtml, shipBarsHtml, distText } from './shipReadout';

const ASK_EVERY = 4000;
/** How long the panel stays after the cursor moves off (ms) */
const LINGER = 1800;
/** Hover this long before it changes, so sweeping the cursor across things doesn't flicker it */
const SETTLE = 120;
const ROCK_NAMES: Record<string, string> = {
  asteroid_metal: 'Metal asteroid', asteroid_ice: 'Ice asteroid', asteroid_fuel: 'Volatile asteroid',
  asteroid_crystal: 'Crystal asteroid', asteroid_mega: 'Dense asteroid', comet: 'Comet',
};
const ORE_HARDNESS = miningTable.oreHardness as Record<string, number>;
const TOOLS_FOR: Record<number, string> = { 2: 'a mining laser or laser', 3: 'a titanium-grade miner or lance' };

/** A rough share, as a glance gives it */
function amount(w: number): string {
  return w >= 0.45 ? 'Mostly' : w >= 0.22 ? 'Rich' : w >= 0.08 ? 'Some' : 'Trace';
}

export interface InfoPanelDeps {
  state: GameState;
  send(m: ClientMessage): void;
  /** Cursor in world units */
  cursorWorld(): { x: number; y: number };
  worldToScreen(x: number, y: number): { x: number; y: number };
  zoom(): number;
  /** A ship's radius (world units) */
  radius(id: number): number;
  inParty(id: number): boolean;
  /** An item's display name */
  itemName(id: string): string;
  myRating(): number;
  /** The locked target (not repeated here) */
  target(): number;
  /** The target panel's height (this panel sits above it) */
  belowHeight(): number;
}

/** Hover picks run at most this often while the cursor holds still (ms) */
const PICK_MS = 80;

export class InfoPanel {
  private el: HTMLDivElement;
  private ring: HTMLDivElement;
  private cache = new Map<number, { info: ServerPilotInfoMessage | null; asked: number }>();
  /** Under the cursor right now (-1: nothing) */
  private over = -1;
  private overSince = 0;
  /** Being described (may linger after the cursor moves off) */
  private shown = -1;
  private shownUntil = 0;
  private html = '';

  constructor(private d: InfoPanelDeps) {
    const css = document.createElement('style');
    css.textContent = `
.inf-p { position: fixed; right: 70px; bottom: 112px; width: 228px; display: none; z-index: 860; padding: 9px 11px; border-radius: 10px; pointer-events: none;
  background: rgba(10, 14, 26, 0.86); border: 1px solid var(--c, #4dd0e1); color: #d6deeb; font: 12px 'Segoe UI', system-ui, sans-serif;
  box-shadow: 0 0 16px rgba(0,0,0,0.4); transition: opacity .2s; }
.inf-p.fade { opacity: 0.55; }
.inf-p .t { font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 2px; color: var(--c); display: flex; justify-content: space-between; }
.inf-p .n { font: 700 14px 'Segoe UI', sans-serif; color: #fff; margin: 2px 0 1px; display: flex; justify-content: space-between; gap: 8px; }
.inf-p .n span { color: #93c5fd; font-size: 12px; font-weight: 600; }
.inf-p .s { color: #8394ad; font-size: 11px; margin-bottom: 5px; }
.inf-p .ti { color: #fde68a; font-size: 11px; margin: 1px 0 5px; }
.inf-p .kv { display: flex; justify-content: space-between; color: #8394ad; margin-top: 2px; }
.inf-p .kv b { color: #d6deeb; font-weight: 600; }
.inf-p .rw { display: grid; grid-template-columns: 46px 1fr 34px; align-items: center; gap: 6px; font-size: 11px; color: #8394ad; margin-top: 3px; }
.inf-p .rw b { color: #d6deeb; text-align: right; font-weight: 600; }
.inf-p .bar { height: 5px; border-radius: 3px; background: rgba(255,255,255,0.08); overflow: hidden; }
.inf-p .bar i { display: block; height: 100%; }
.inf-p .ore { display: grid; grid-template-columns: 1fr 52px 44px; align-items: center; gap: 6px; margin-top: 3px; color: #d6deeb; }
.inf-p .ore em { font-style: normal; color: #8394ad; font-size: 11px; text-align: right; }
.inf-p .ore .bar i { background: linear-gradient(90deg, #0891b2, #67e8f9); }
.inf-p .hard { color: #fbbf24; font-size: 11px; margin-top: 5px; }
.inf-p .k { margin-top: 6px; color: #64748b; font-size: 10px; letter-spacing: 0.5px; }
.inf-ring { position: fixed; pointer-events: none; z-index: 74; display: none; border-radius: 50%; border: 1px dashed var(--c, #4dd0e1); opacity: 0.55; transform: translate(-50%, -50%); }`;
    document.head.appendChild(css);
    this.el = document.createElement('div');
    this.el.className = 'inf-p';
    this.el.dataset.hudAvoid = '1';
    this.ring = document.createElement('div');
    this.ring.className = 'inf-ring';
    document.body.append(this.el, this.ring);
  }

  /** The pilot under the cursor right now (-1: none) */
  get hovered(): number {
    return this.d.state.entities.get(this.over)?.type === EntityType.Player ? this.over : -1;
  }

  /** Describe this one for a while, wherever the cursor is (the right-click menu's "Inspect") */
  inspect(id: number): void {
    this.shown = id;
    this.shownUntil = performance.now() + 10000;
  }

  onInfo(m: ServerPilotInfoMessage): void {
    this.cache.set(m.id, { info: m, asked: this.cache.get(m.id)?.asked ?? performance.now() });
  }

  update(enabled: boolean): void {
    const now = performance.now();
    const id = enabled ? this.pick() : -1;
    if (id !== this.over) { this.over = id; this.overSince = now; }
    // Something new under the cursor, held a moment: describe it
    if (this.over >= 0 && now - this.overSince >= SETTLE) { this.shown = this.over; this.shownUntil = now + LINGER; }
    if (this.over >= 0 && this.over === this.shown) this.shownUntil = now + LINGER;
    const e = this.shown >= 0 ? this.d.state.entities.get(this.shown) : undefined;
    if (!enabled || !e || now > this.shownUntil || e.id === this.d.target()) {
      this.shown = -1;
      this.el.style.display = this.ring.style.display = 'none';
      this.html = '';
      return;
    }
    const html = e.type === EntityType.Asteroid ? this.rockHtml(e) : e.type === EntityType.Player ? this.pilotHtml(e, now) : this.shipHtml(e);
    if (html !== this.html) { this.html = html; this.el.innerHTML = html; }
    const color = e.type === EntityType.Asteroid ? '#4dd0e1' : e.type === EntityType.Player && this.d.inParty(e.id) ? '#4ade80' : shipKind(e).color;
    this.el.style.setProperty('--c', color);
    this.el.style.bottom = `${112 + (this.d.belowHeight() ? this.d.belowHeight() + 8 : 0)}px`;
    this.el.classList.toggle('fade', this.over !== this.shown);
    this.el.style.display = 'block';
    // The ring round what it describes
    const p = this.d.worldToScreen(e.renderX, e.renderY);
    const r = (e.type === EntityType.Asteroid ? e.data?.[0] ?? 30 : this.d.radius(e.id)) * this.d.zoom() + 10;
    this.ring.style.cssText = `display:block; left:${p.x}px; top:${p.y}px; width:${r * 2}px; height:${r * 2}px; --c:${color}`;
  }

  /** The last pick: where the cursor was, when, and what it found (re-picked when the cursor moves, or every PICK_MS) */
  private picked = { x: NaN, y: NaN, at: 0, id: -1 };

  /** What's under the cursor: a ship first, else an asteroid */
  private pick(): number {
    const m = this.d.cursorWorld();
    const now = performance.now();
    const P = this.picked;
    if (Math.abs(m.x - P.x) < 2 / this.d.zoom() && Math.abs(m.y - P.y) < 2 / this.d.zoom() && now - P.at < PICK_MS) return P.id;
    const me = this.d.state.playerId;
    let best = -1, bd = Infinity;
    for (const e of this.d.state.entities.values()) {
      if (e.id === me || !isShip(e)) continue;
      const dx = e.renderX - m.x, dy = e.renderY - m.y, reach = this.d.radius(e.id) + 30;
      if (Math.abs(dx) > reach || Math.abs(dy) > reach) continue;
      const d = Math.hypot(dx, dy);
      if (d < reach && d < bd) { bd = d; best = e.id; }
    }
    if (best < 0) {
      for (const e of this.d.state.entities.values()) {
        if (e.type !== EntityType.Asteroid || !e.composition) continue;
        const dx = e.renderX - m.x, dy = e.renderY - m.y, r = (e.data?.[0] ?? 30) + 12;
        if (Math.abs(dx) > r || Math.abs(dy) > r) continue;
        const d = Math.hypot(dx, dy) - (r - 12);
        if (d < 12 && d < bd) { bd = d; best = e.id; }
      }
    }
    this.picked = { x: m.x, y: m.y, at: now, id: best };
    return best;
  }

  private distance(e: InterpolatedEntity): string {
    const me = this.d.state.entities.get(this.d.state.playerId);
    return me ? distText(Math.hypot(e.renderX - me.renderX, e.renderY - me.renderY)) : '';
  }

  private pilotHtml(e: InterpolatedEntity, now: number): string {
    const c = this.cache.get(e.id);
    if (!c || now - c.asked > ASK_EVERY) {
      this.cache.set(e.id, { info: c?.info ?? null, asked: now });
      this.d.send({ type: 'pilotInfo', id: e.id });
    }
    const info = c?.info;
    const party = this.d.inParty(e.id);
    const head = `<div class="t"><span>PILOT${party ? ' · YOUR PARTY' : ''}</span><span>${this.distance(e)}</span></div>`;
    if (!info) return `${head}<div class="n">${esc(e.name ?? 'Pilot')}</div><div class="s">Reading their transponder…</div>`;
    return `${head}<div class="n">${esc(info.name)}<span>Level ${info.level}</span></div>
      <div class="ti">${esc(info.title)}${info.guest ? ' · guest' : ''}</div>
      <div class="kv">Ship <b>${esc(info.ship)}</b></div>
      <div class="kv">Parts <b>${info.parts}</b></div>
      <div class="rw">Hull<div class="bar"><i style="width:${info.hull}%; background:linear-gradient(90deg,#16a34a,#86efac)"></i></div><b>${info.hull}%</b></div>
      ${shipBarsHtml(e)}
      <div class="kv">Kills <b>${info.kills.toLocaleString()}</b></div>
      ${info.ribbons ? `<div class="kv">Ribbons <b>${info.ribbons}${info.topRibbon ? ` · ${esc(info.topRibbon)}` : ''}</b></div>` : ''}
      ${info.party ? `<div class="kv">Party <b>${info.party.mine ? 'yours' : `${esc(info.party.leader)}'s`} · ${info.party.size}/4</b></div>` : ''}
      <div class="k">${party ? 'In your party' : info.party && !info.party.mine ? 'In another party' : 'P: invite to your party'} · T: target</div>`;
  }

  private shipHtml(e: InterpolatedEntity): string {
    const k = shipKind(e);
    return `<div class="t"><span>${k.label}</span><span>${this.distance(e)}</span></div><div class="n">${esc(e.name ?? 'Unknown')}</div>${shipSubHtml(e, this.d.myRating())}`
      + shipBarsHtml(e) + `<div class="k">T: target it</div>`;
  }

  /** What an asteroid holds, roughly (the scanner tells it exactly) */
  private rockHtml(e: InterpolatedEntity): string {
    const c = e.composition!;
    const ores = Object.entries(c.ores).sort((a, b) => b[1] - a[1]).filter(([, w]) => w >= 0.02);
    const hardest = Math.max(c.hardness, ...ores.map(([id]) => ORE_HARDNESS[id] ?? 1));
    // An outlier: mined down a stage at a time
    const st = c.stage ? `<div class="hard">Outlier · stage ${c.stage.at + 1} of ${c.stage.of}: mined down, it breaks into a smaller rock</div>` : '';
    return `<div class="t"><span>${c.stage ? 'OUTLIER' : 'ASTEROID'}</span><span>${this.distance(e)}</span></div>
      <div class="n">${esc((miningTable.types as Record<string, { name?: string }>)[c.type]?.name ?? ROCK_NAMES[c.type] ?? 'Asteroid')}<span>~${c.units} ore</span></div>
      ${ores.map(([id, w]) => {
        const hard = (ORE_HARDNESS[id] ?? 1) > c.hardness ? ` ${'▲'.repeat(ORE_HARDNESS[id])}` : '';
        // Approximate: to the nearest 5%
        const pct = Math.max(5, Math.round(w * 20) * 5);
        return `<div class="ore">${esc(this.d.itemName(id))}${hard}<div class="bar"><i style="width:${pct}%"></i></div><em>${amount(w)}</em></div>`;
      }).join('')}
      ${c.hardness >= 2 ? `<div class="hard">${'▲'.repeat(c.hardness)} Hard rock: mine it with ${TOOLS_FOR[c.hardness] ?? 'a heavy miner'}</div>`
        : hardest >= 2 ? `<div class="hard">▲ marks ore that needs ${TOOLS_FOR[hardest] ?? 'a heavy miner'}</div>` : ''}
      ${st}<div class="k">A scanner reads exact shares and gem seams</div>`;
  }
}
