/**
 * Boss fights' messages (docs/bosses/rework-2026-11.md): a lair boss's life, its weak-point windows, and the dev tools
 * Kieran playtests with (dev servers and admins only).
 */

import type { LifeState } from '../bosses/lifecycle.js';

/**
 * A lair boss's life changed (common bosses/lifecycle.ts), from tick `at`: clients draw it rising out of its lair
 * (waking), sinking back (sleeping) or gone (dormant) from that tick. Also sent to a pilot arriving mid-change
 */
export interface ServerBossLifeMessage {
  type: 'bossLife';
  boss: string;
  bodyId: number;
  state: LifeState;
  at: number;
}

/**
 * A boss's weak-point window (common bosses/windows.ts): opened at `at` for `ticks`, its cap `cap`, filled `fill` of
 * WINDOW.steps; `crack`: filled early (a stagger to its end). Sent at its opening, as it fills (at most every 6 ticks),
 * on a crack, and closed with `ticks` 0
 */
export interface ServerBossWindowMessage {
  type: 'bossWindow';
  bodyId: number;
  at: number;
  ticks: number;
  cap: number;
  fill: number;
  crack?: boolean;
}

/** One hit a pilot took in a boss's arena (the dev damage log) */
export interface BossLogEntry {
  tick: number;
  /** The move or personal attack that did it ('' unknown) */
  attack: string;
  /** Who did it: the boss's name, its drone, or whose personal attack */
  source: string;
  /** Before and after armour */
  raw: number;
  dealt: number;
}

/** A boss as the dev panel shows it */
export interface BossDevRow {
  id: string;
  name: string;
  eid: number;
  life: LifeState | 'live';
  stage: number;
  move: string;
  /** Its moves (to play one) and personal attacks (to force one on you) */
  moves: string[];
  personal: string[];
  /** An open window: its fill (0..1) and ticks left */
  window: { fill: number; left: number; crack: boolean } | null;
  hold: boolean;
  dummies: number;
  /** Its system's clock rate (60: normal) */
  rate: number;
}

/** (dev) The boss panel's state: the bosses in your system, and the last hits you took in an arena */
export interface ServerBossDevMessage {
  type: 'bossDev';
  bosses: BossDevRow[];
  log: BossLogEntry[];
  /** A fight summary, when asked for */
  summary?: string;
}

export type BossServerMessage = ServerBossLifeMessage | ServerBossWindowMessage | ServerBossDevMessage;

/**
 * (dev) The boss tools (server/src/game/dev/bossDev.ts): dev servers and admins only, refused in production.
 *   panel      send the panel's state (and keep sending it while it's open: `on`)
 *   goto       to the outside of its barrier
 *   wake/sleep force its life on (heal: start healing now; skip: skip the idle or the rest of the heal)
 *   stage      shed to the start of stage `n`
 *   move       play signature move `move` next; window: open a window now; personal: personal attack `move` on you
 *   hold       hold still, no moves (`on`)
 *   dummies    `n` dummy pilots inside its arena, dealing `dps` ('off' | 'starter' | 'l30')
 *   slow       its system's clock at `n` ticks a second (60, 30, 15)
 *   log        the damage log (cleared with `on` false)
 *   summary    the fight summary now
 */
export interface ClientBossDevMessage {
  type: 'bossDevTool';
  action: 'panel' | 'goto' | 'wake' | 'sleep' | 'heal' | 'skip' | 'stage' | 'move' | 'window' | 'personal' | 'hold' | 'dummies' | 'slow' | 'log' | 'summary';
  boss?: string;
  n?: number;
  move?: string;
  dps?: 'off' | 'starter' | 'l30';
  on?: boolean;
}
