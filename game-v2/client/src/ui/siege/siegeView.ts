/**
 * What the siege panel and HUD work out from the server's siegeState (pure:
 * tested in siegeView.test.ts): the incoming fronts as nav markers, the pads a
 * pilot is close enough to build on at night, the next turret orders, the
 * focus fire's state, and each pad's name.
 */

import type { ServerSiegeStateMessage } from '@space-game/common';
import { compass } from './compass';

export interface BastionLayout { x: number; y: number; slots: { x: number; y: number }[] }

/** Fronts landing within `aheadTicks` (default 45 s), as nav markers: "Front · 12s" where it will land */
export function frontMarkers(m: ServerSiegeStateMessage | null, now: number, aheadTicks = 45 * 60): { name: string; x: number; y: number }[] {
  if (!m?.active || !m.incoming) return [];
  return m.incoming.filter((f) => f.at > now && f.at - now <= aheadTicks)
    .map((f) => ({ name: `${f.boss ? 'Boss front' : 'Front'} · ${Math.ceil((f.at - now) / 60)}s · ${f.ships}`, x: f.x, y: f.y }));
}

/** Empty pads within the night's build reach of `me` */
export function padsInReach(m: ServerSiegeStateMessage | null, b: BastionLayout | null, me: { x: number; y: number } | null): number[] {
  if (!m?.night || !b || !me || !m.turrets) return [];
  const reach = m.night.buildReach;
  return b.slots.map((p, i) => i).filter((i) => !m.turrets![i] && Math.hypot(b.x + b.slots[i].x - me.x, b.y + b.slots[i].y - me.y) <= reach);
}

/** The orders after `current` in the list (a button cycles them) */
export function nextOrders(list: { id: string }[] | undefined, current: string | undefined): string | undefined {
  if (!list?.length) return undefined;
  const i = list.findIndex((o) => o.id === current);
  return list[(i + 1) % list.length].id;
}

/** Focus fire now: on (seconds left), cooling down (seconds till ready), or ready */
export function focusState(m: ServerSiegeStateMessage | null, now: number): { kind: 'on' | 'wait' | 'ready'; secs: number } | null {
  const f = m?.focus;
  if (!f) return null;
  if (f.target !== undefined && (f.until ?? 0) > now) return { kind: 'on', secs: Math.ceil(((f.until ?? 0) - now) / 60) };
  if (f.readyAt > now) return { kind: 'wait', secs: Math.ceil((f.readyAt - now) / 60) };
  return { kind: 'ready', secs: 0 };
}

/** A pad's name: its number and which side of the bastion it's on */
export function padName(b: BastionLayout | null, i: number): string {
  const p = b?.slots[i];
  return p ? `Pad ${i + 1} · ${compass(p.x, p.y)}` : `Pad ${i + 1}`;
}
