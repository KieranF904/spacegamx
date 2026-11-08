/**
 * @contract client.hangar.tips
 * owns:       the hangar's part tooltips (grid and palette): when they show and what they say
 * needs:      HangarHost (tip, tipKey, tipGen, deps), partTip.ts
 * invariants: tooltip contents rebuild only when the key changes — none pinned
 * extend:     a new tooltip source is one function here, calling showTip with its key
 */

import { partItemId, parsePartItemId, type MountingProblem } from '@space-game/common';
import { modelLock } from '../modelCards';
import { partTipHtml, type PartTipCtx } from '../partTip';
import type { HangarHost } from './host';

/** A broken mounting rule without its "Pip 3: " (the part is the one in hand or under the mouse) */
export function ruleText(m: MountingProblem): string {
  return m.message.replace(/^[^:]*?\d+: /, '');
}

export function tipCtx(host: HangarHost): PartTipCtx {
  return { catalog: host.deps.catalog, tuning: host.deps.tuning, econ: host.deps.econ, free: host.free, have: (id) => host.deps.have(id), canMake: (id) => host.deps.canMake(id) };
}

/** Show the tooltip at the mouse; its contents are only built when `key` changes */
export function showTip(host: HangarHost, key: string, html: () => string, x: number, y: number): void {
  if (key !== host.tipKey) {
    host.tipKey = key;
    host.tip.innerHTML = html();
    host.tip.style.display = 'block';
  }
  const w = host.tip.offsetWidth, h = host.tip.offsetHeight;
  const left = x + 18 + w > innerWidth - 8 ? x - 14 - w : x + 18;
  const top = Math.min(y + 16, innerHeight - h - 8);
  host.tip.style.left = `${Math.max(8, left)}px`;
  host.tip.style.top = `${Math.max(8, top)}px`;
}

export function hideTip(host: HangarHost): void {
  if (!host.tipKey) return;
  host.tipKey = '';
  host.tip.style.display = 'none';
}

/** The part under the mouse on the grid */
export function gridTip(host: HangarHost, e: MouseEvent): void {
  // (A port under the mouse, on the energy overlay: its rating, what it links to, the flow on it)
  const port = host.ports.tip(host.derived, (i) => host.partName(i));
  if (port) return host.showTip(`port:${host.tipGen}:${port.key}`, port.html, e.clientX, e.clientY);
  const i = host.mouse ? host.partAt(host.mouse) : -1;
  if (i < 0) return host.hideTip();
  const p = host.bp.parts[i];
  const { ghosts, fresh } = host.grantAll ? { ghosts: new Set<number>(), fresh: new Set<number>() } : host.ghostInfo();
  const hs = host.deps.hangarState();
  const rec = hs?.slots[host.slot];
  const isNew = fresh.has(p.uid) && hs !== null;
  const state = ghosts.has(p.uid) && !fresh.has(p.uid) ? 'ghost' : isNew ? 'new' : rec?.wrecked.includes(p.uid) ? 'wrecked' : 'built';
  // On the ship you're flying: how it's holding up
  let live: PartTipCtx['live'] = null;
  if (state === 'built' && hs && host.slot === hs.active) {
    const ship = host.deps.liveShip?.();
    const k = ship ? ship.blueprint.parts.findIndex((q) => q.uid === p.uid && partItemId(q) === partItemId(p)) : -1;
    if (ship && k >= 0 && !ship.ghost[k]) live = { hp: ship.hp[k], max: ship.maxHp[k], detached: ship.detached[k] };
  }
  const key = `g:${host.tipGen}:${p.uid}:${live ? `${Math.round((live.hp / live.max) * 100)}${live.detached ? 'x' : ''}` : ''}`;
  const mounting = host.mountingBroken.get(i)?.map(ruleText);
  host.showTip(key, () => partTipHtml(p, { ...host.tipCtx(), derived: host.derived, index: i, state, live, mounting }), e.clientX, e.clientY);
}

/** A palette part's tooltip (by item id): what it is, how many you have, what making it takes or what it waits on */
export function partTip(host: HangarHost, id: string, e: MouseEvent): void {
  const q = host.deps.econ.items.get(id)?.part ?? parsePartItemId(id);
  const f = q && host.deps.catalog.functions.get(q.fn);
  if (!q || !f) return;
  const left = host.remaining(id);
  const lock = f.model && !host.free && !host.deps.canMake(id) ? modelLock(f, false, host.deps.level?.() ?? 1).why : '';
  host.showTip(`p:${host.tipGen}:${id}`, () => partTipHtml(q, { ...host.tipCtx(), state: 'palette', spare: left === Infinity ? 0 : Math.max(0, left), lock }), e.clientX, e.clientY);
}
