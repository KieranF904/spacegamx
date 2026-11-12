/**
 * @contract client.ui.status-effects
 * owns:       the status effects the client knows about the pilot's own ship (EMP, slowed, marked, the cold's stages, holding with a landmark): what
 *             each is, what it does, what clears it, and which are on now with the time left
 * needs:      common warmthStage (the cold's stage from the warmth %), the own entity's empUntil / slowUntil / markUntil / warmth,
 *             the landmark it is carried with (JumpControl.heldBy)
 * invariants: a timed status shows only while its end tick is ahead, with whole seconds left rounded up; the cold shows
 *             from chilled down, with no timer; holding shows while a landmark carries the ship, with how much — client/src/ui/hud/statusEffects.test.ts
 * extend:     a new status is one STATUS_DEFS entry and one branch in activeStatuses()
 */

import { warmthStage } from '@space-game/common';

export type StatusId = 'emp' | 'slowed' | 'marked' | 'chilled' | 'numb' | 'frozen' | 'holding';

export interface StatusDef {
  id: StatusId;
  label: string;
  /** A short glyph for the icon */
  glyph: string;
  color: string;
  /** What it does, and what clears it (the tooltip) */
  does: string;
  clears: string;
}

export const STATUS_DEFS: Readonly<Record<StatusId, StatusDef>> = {
  emp: { id: 'emp', label: 'EMP', glyph: 'ϟ', color: '#facc15', does: 'Drive at 35%, guns silent, no jump.', clears: 'Wears off by itself.' },
  slowed: { id: 'slowed', label: 'Slowed', glyph: '❄', color: '#7dd3fc', does: 'Thrust and turning at 60% (a Frostbite beam).', clears: 'Get out of the beam; it wears off a moment later.' },
  marked: { id: 'marked', label: 'Marked', glyph: '◎', color: '#f87171', does: 'Every hit on you does 20% more (a Searchlight beam).', clears: 'Get out of the beam; it wears off a moment later.' },
  chilled: { id: 'chilled', label: 'Chilled', glyph: '❆', color: '#9fd8ff', does: 'Cold is building up. No cost yet.', clears: 'Warm up near a star, a station or a fire.' },
  numb: { id: 'numb', label: 'Numb', glyph: '❆', color: '#7cc4ff', does: 'Drive at 80%: the cold has numbed it.', clears: 'Warm up near a star, a station or a fire.' },
  frozen: { id: 'frozen', label: 'Frozen', glyph: '❆', color: '#ff9b9b', does: 'Frozen through: the ship seizes up.', clears: 'It thaws a little by itself; warm up to stop it.' },
  holding: { id: 'holding', label: 'Holding', glyph: '⚓', color: '#86efac', does: 'Carried along with it: stop here and you stay beside it.', clears: 'Fly out of its range; the hold fades with distance.' },
};

/** What the tray reads of the own ship */
export interface StatusSource {
  /** The tick to count from (the server tick as the client has it) */
  tick: number;
  empUntil?: number;
  slowUntil?: number;
  markUntil?: number;
  /** Warmth % (100: warm) */
  warmth?: number;
  /** The moving landmark carrying the ship (common world/landmarks.ts), and how much of its move (1: all of it) */
  held?: { name: string; weight: number } | null;
}

export interface ActiveStatus {
  def: StatusDef;
  /** Whole seconds left, rounded up; null: no timer (the cold) */
  secs: number | null;
  /** The cold: warmth %. Holding: how much of the landmark's move carries the ship, % */
  pct?: number;
  /** Holding: the landmark's name */
  name?: string;
}

const TPS = 60;
const left = (until: number | undefined, tick: number): number => (until === undefined ? 0 : until - tick);

/** The statuses on now, most urgent first (out is reused) */
export function activeStatuses(s: StatusSource, out: ActiveStatus[] = []): ActiveStatus[] {
  out.length = 0;
  const timed = (id: StatusId, until: number | undefined) => {
    const t = left(until, s.tick);
    if (t > 0) out.push({ def: STATUS_DEFS[id], secs: Math.ceil(t / TPS) });
  };
  timed('emp', s.empUntil);
  timed('slowed', s.slowUntil);
  timed('marked', s.markUntil);
  if (s.warmth !== undefined) {
    const st = warmthStage(s.warmth).name;
    if (st !== 'warm') out.push({ def: STATUS_DEFS[st], secs: null, pct: Math.round(s.warmth) });
  }
  if (s.held && s.held.weight > 0) out.push({ def: STATUS_DEFS.holding, secs: null, pct: Math.max(1, Math.round(s.held.weight * 100)), name: s.held.name });
  return out;
}

/** The tooltip, plain text lines */
export function statusTip(a: ActiveStatus): string {
  const head = a.def.id === 'holding' ? `Holding with ${a.name}${(a.pct ?? 100) < 100 ? ` (${a.pct}%, fading)` : ''}`
    : a.secs !== null ? `${a.def.label}: ${a.secs} s left` : `${a.def.label}: warmth ${a.pct}%`;
  return `${head}\n${a.def.does}\nClears: ${a.def.clears}`;
}
