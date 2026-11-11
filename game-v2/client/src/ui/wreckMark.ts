/**
 * @contract client.ui.wreck-mark
 * owns:       the pilot's own wreck as the client keeps it (from the `wreck` message) and the words its markers show
 * needs:      the wreck message type; npm: @space-game/common
 * invariants: a wreck is yours alone, then open to all, then gone, and the label says which — client/src/ui/wreckMark.test.ts
 * extend:     a new place that marks the wreck reads wreckLabel / wreckLive
 */
/**
 * Your wreck (docs/design/death-rework-2026-11.md): yours alone for a while, then anyone may loot it, then it's gone.
 * The HUD marker, the system map and the context menu all read it from here, so they agree.
 */

import type { ServerWreckMessage } from '@space-game/common';

export interface WreckMark {
  system: string;
  x: number;
  y: number;
  /** Wall ms it is yours alone until */
  until: number;
  /** Wall ms it is gone at */
  gone: number;
}

/** The mark a `wreck` message gives (null: none, or gone) */
export function wreckFromMessage(msg: ServerWreckMessage, now: number): WreckMark | null {
  if (msg.gone || msg.system === undefined) return null;
  const until = now + (msg.seconds ?? 0) * 1000;
  return { system: msg.system, x: msg.x ?? 0, y: msg.y ?? 0, until, gone: until + (msg.open ?? 0) * 1000 };
}

/** Still there */
export function wreckLive(w: WreckMark | null | undefined, now: number): w is WreckMark {
  return !!w && w.gone > now;
}

const clock = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** What its marker says: whose it is, and for how long (null: gone) */
export function wreckLabel(w: WreckMark | null | undefined, now: number): string | null {
  if (!wreckLive(w, now)) return null;
  return w.until > now ? `⚑ Your wreck · yours for ${clock(w.until - now)}` : `⚑ Your wreck · open to all, ${clock(w.gone - now)} left`;
}
