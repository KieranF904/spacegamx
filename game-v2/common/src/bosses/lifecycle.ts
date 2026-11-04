/**
 * A lair boss's life (docs/bosses/rework-2026-11.md 7.2-7.3), and every enemy's recovery (section 8):
 *
 *   DORMANT     no entity: the lair shows its look-only scenery
 *   WAKING      a pilot crossed the barrier inward: the entity is there, rising out of its lair, not yet engageable
 *   ACTIVE      the fight
 *   RECOVERING  out of combat (nobody inside the barrier, nobody hurting it): it idles LIFE.idle ticks
 *   HEALING     then it heals, full LIFE.heal ticks after the heal starts (anyone entering or any damage stops it)
 *   SLEEPING    healed to full out of combat: it sinks back (LIFE.sleep ticks), and the entity is removed at the end
 *
 * Each change is a server decision stamped with its tick: clients play the animation from that tick (lifeRise), so a
 * pilot arriving mid-wake sees the same frame as everyone else. Pure.
 */

export const LIFE_STATES = ['dormant', 'waking', 'active', 'recovering', 'healing', 'sleeping'] as const;
export type LifeState = (typeof LIFE_STATES)[number];

export const LIFE = {
  /** Its rising out of the lair */
  wake: 240,
  /** Out of combat this long before it heals (every enemy) */
  idle: 1800,
  /** From the heal's start to full (every enemy) */
  heal: 7200,
  /** Its sinking back */
  sleep: 420,
  /** Lost parts regrow in the heal's last this many ticks (enemies): at its end */
  regrow: 1800,
} as const;

/** A sleeping system's boss comes back dormant and full once it has been asleep at least this long */
export const LIFE_ASLEEP_RESET = LIFE.idle + LIFE.heal;

/** How much of its full HP a heal started at `from` has put back by `tick` (0..1 of the whole heal) */
export function healProgress(from: number, tick: number): number {
  if (tick <= from) return 0;
  return Math.min(1, (tick - from) / LIFE.heal);
}

/**
 * How far out of its lair it is drawn (0: buried, 1: fully up) at a tick, in a state that began at `at`. Waking rises
 * 0 → 1 over LIFE.wake, sleeping sinks 1 → 0 over LIFE.sleep (eased); every other state with an entity is up
 */
export function lifeRise(state: LifeState, at: number, tick: number): number {
  const ease = (k: number) => { const t = Math.max(0, Math.min(1, k)); return t * t * (3 - 2 * t); };
  if (state === 'dormant') return 0;
  if (state === 'waking') return ease((tick - at) / LIFE.wake);
  if (state === 'sleeping') return 1 - ease((tick - at) / LIFE.sleep);
  return 1;
}

/** Can it be hurt (and does it fight) in this state */
export const lifeEngageable = (s: LifeState) => s === 'active' || s === 'recovering' || s === 'healing';
