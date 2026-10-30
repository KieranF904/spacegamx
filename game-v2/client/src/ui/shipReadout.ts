/**
 * What a ship's readout says (the target panel and the info panel share it):
 * its kind and colour, faction and state, its rating against yours, and its
 * hull, shield and core bars.
 */

import { EntityType } from '@space-game/common';
import type { InterpolatedEntity } from '../state/GameState';
import factionsData from '../../../data/factions.json';
import { threatTag } from './threat';

const FACTIONS = Object.values((factionsData as unknown as { factions: Record<string, { name: string; color: string }> }).factions);

export function esc(t: string): string {
  return t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function isShip(e: InterpolatedEntity): boolean {
  return e.type === EntityType.ShipBody || e.type === EntityType.Player;
}

export function shipKind(e: InterpolatedEntity): { label: string; color: string } {
  if (e.type === EntityType.Player) return { label: 'PILOT', color: '#60a5fa' };
  switch (e.data?.[0]) {
    case 3:
      // (data[9]: a passive pack nobody's provoked yet)
      if (e.data?.[9] === 1 && e.data?.[4] !== 2) return { label: 'PASSIVE', color: '#9ca3af' };
      return { label: e.data?.[4] === 2 ? 'BOSS' : e.data?.[4] === 1 ? 'ELITE HOSTILE' : 'HOSTILE', color: e.data?.[4] === 2 ? '#fb923c' : '#f87171' };
    case 2: return { label: 'CIVILIAN', color: '#fbbf24' };
    case 1: return { label: 'DERELICT', color: '#a3a3a3' };
    default: return { label: 'SHIP', color: '#93c5fd' };
  }
}

/** The lines under a ship's name: faction and state, then its rating against yours */
export function shipSubHtml(e: InterpolatedEntity, myRating: number): string {
  const d = e.data ?? [];
  const faction = e.type === EntityType.ShipBody && d[0] === 3 && (d[3] ?? -1) >= 0 ? FACTIONS[d[3]]?.name ?? '' : '';
  const sub = [faction, d[2] === 1 ? 'EMP: disabled' : '', d[0] === 3 && d[9] === 1 ? 'leaves you be unless shot' : ''].filter(Boolean).join(' · ') || (d[0] === 2 ? 'Under your protection if it is a job' : d[0] === 1 ? 'Break its core for salvage' : '');
  const rating = e.type === EntityType.ShipBody && d[0] === 3 && (d[8] ?? 0) > 0 ? `<div class="s">${threatTag(myRating, d[8], 'Rated')}</div>` : '';
  return `${sub ? `<div class="s">${esc(sub)}</div>` : ''}${rating}`;
}

/** Hull, shield and core bars (rows of class "rw") */
export function shipBarsHtml(e: InterpolatedEntity): string {
  const d = e.data ?? [];
  const bars: [string, number, string][] = [];
  if (e.type === EntityType.ShipBody) {
    bars.push(['Hull', d[7] ?? 100, 'linear-gradient(90deg,#16a34a,#86efac)']);
    if ((d[1] ?? 0) > 0) bars.push(['Shield', d[1], 'linear-gradient(90deg,#0284c7,#7dd3fc)']);
    if (d[0] === 3 || d[0] === 1) bars.push(['Core', d[5] ?? 100, 'linear-gradient(90deg,#b45309,#fbbf24)']);
  } else if (e.type === EntityType.Player) {
    if ((d[4] ?? 0) > 0) bars.push(['Shield', d[4], 'linear-gradient(90deg,#0284c7,#7dd3fc)']);
  } else if (e.maxHp) {
    bars.push(['Hull', Math.round((e.hp / e.maxHp) * 100), 'linear-gradient(90deg,#16a34a,#86efac)']);
  }
  return bars.map(([l, v, g]) => `<div class="rw">${l}<div class="bar"><i style="width:${Math.max(0, Math.min(100, v))}%; background:${g}"></i></div><b>${Math.round(v)}%</b></div>`).join('');
}

/** "1.2 km" / "640 m" */
export function distText(d: number): string {
  return d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`;
}
