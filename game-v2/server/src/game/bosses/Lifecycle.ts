/**
 * A lair boss's life (docs/bosses/rework-2026-11.md 7.2-7.3; the shared states and timings: common bosses/lifecycle.ts):
 * dormant in its lair with no entity, woken by a pilot passing its arena's barrier inward, fought, and once out of
 * combat (nobody inside, nobody hurting it) idling LIFE.idle, healing to full over LIFE.heal, then sinking back dormant.
 * Only bosses whose system has an `arena` for them live this way; the rest spawn as before (Bosses.ts).
 *
 * Every change of state is a tick-stamped server decision, sent to the system as `bossLife` (state and tick): clients
 * play the rise and the sink from that tick, so everyone sees the same frame. Called from Bosses.tick.
 */

import { LIFE, lifeRise, lifeEngageable, type LifeState, type ServerMessage } from '@space-game/common';

export interface LifeHost {
  tick(): number;
  /** Its system steps this pass (crowd dilation: sim/SystemClocks.ts) */
  active(num: number): boolean;
  /** Pilots inside the boss's arena (dummies too) */
  present(num: number): number[];
  /** Living pilots in a system (who is told) */
  players(num: number): number[];
  /** The last tick its ship took damage */
  lastHurt(eid: number): number;
  /** Bring its ship into the world at its lair, quietly (-1: couldn't) */
  spawn(id: string): number;
  /** Take its ship away, quietly (no kill, no respawn clock) */
  remove(eid: number): void;
  /** Heal every part by this share of its max */
  heal(eid: number, share: number): void;
  /** Everything back: lost parts regrown, every part full */
  restore(eid: number): void;
  /** Its respawn clock (after a kill) has run out */
  due(id: string): boolean;
  send(num: number, msg: ServerMessage): void;
  /** The fight starts: its title card */
  intro(eid: number): void;
  /** Its lair heaves as it rises or sinks (dust and rubble where it lies) */
  heave?(num: number, eid: number): void;
}

interface Life {
  id: string;
  num: number;
  state: LifeState;
  /** The tick it entered its state */
  at: number;
  eid: number;
  /** Pilots in its system who've been told its state */
  told: Set<number>;
}

/** Heal steps (ticks apart) */
const HEAL_STEP = 30;

export class Lifecycle {
  private lives = new Map<string, Life>();

  constructor(private host: LifeHost) {}

  /** Start keeping a boss this way (its system has an arena for it): dormant */
  adopt(id: string, num: number): void {
    if (!this.lives.has(id)) this.lives.set(id, { id, num, state: 'dormant', at: this.host.tick(), eid: -1, told: new Set() });
  }

  manages(id: string): boolean {
    return this.lives.has(id);
  }

  stateOf(id: string): LifeState | undefined {
    return this.lives.get(id)?.state;
  }

  /** The life of the boss with this ship */
  private byEid(eid: number): Life | undefined {
    for (const l of this.lives.values()) if (l.eid === eid && l.state !== 'dormant') return l;
    return undefined;
  }

  /** Is this ship a boss kept by its lifecycle (it recovers its own way, not as every enemy does) */
  holds(eid: number): boolean {
    return !!this.byEid(eid);
  }

  /** Can it be hurt and does it fight (a boss not kept this way: always) */
  engageable(eid: number): boolean {
    const l = this.byEid(eid);
    return !l || lifeEngageable(l.state);
  }

  /** How far out of its lair it is now (1: all the way) */
  rise(eid: number): number {
    const l = this.byEid(eid);
    return l ? lifeRise(l.state, l.at, this.host.tick()) : 1;
  }

  /** A pilot passed into this system's arena: its boss wakes (dormant and due, or sinking back) */
  entered(num: number): void {
    for (const l of this.lives.values()) {
      if (l.num !== num) continue;
      if (l.state === 'dormant' && this.host.due(l.id)) this.wake(l);
      else if (l.state === 'sleeping') this.rewake(l);
    }
  }

  /** (dev) wake now, or put it to sleep now (skips the out-of-combat clock) */
  force(id: string, to: 'wake' | 'sleep' | 'heal'): boolean {
    const l = this.lives.get(id);
    if (!l) return false;
    if (to === 'wake') { if (l.state === 'dormant') this.wake(l); else if (l.state === 'sleeping') this.rewake(l); else this.set(l, 'active'); return true; }
    if (l.eid < 0 || l.state === 'dormant') return false;
    if (to === 'heal') this.set(l, 'healing');
    else { this.host.restore(l.eid); this.set(l, 'sleeping'); }
    return true;
  }

  /** (dev) skip the idle, or the rest of the heal */
  skip(id: string): boolean {
    const l = this.lives.get(id);
    if (!l) return false;
    if (l.state === 'recovering') { this.set(l, 'healing'); return true; }
    if (l.state === 'healing') { this.host.restore(l.eid); this.set(l, 'sleeping'); return true; }
    return false;
  }

  /** It died (or was taken away): dormant; it wakes again once its respawn clock allows */
  gone(id: string): void {
    const l = this.lives.get(id);
    if (l && l.state !== 'dormant') { l.eid = -1; this.set(l, 'dormant'); }
  }

  /** Its system came back before its recovery would have run out: as it was, out of combat (the idle starts again) */
  resume(id: string, eid: number): void {
    const l = this.lives.get(id);
    if (!l) return;
    l.eid = eid;
    this.set(l, 'recovering');
  }

  /** Its system was put away and brought back (SystemMemory): dormant and full, quietly */
  reset(id: string): void {
    const l = this.lives.get(id);
    if (!l) return;
    if (l.eid >= 0) this.host.remove(l.eid);
    l.eid = -1; l.state = 'dormant'; l.at = this.host.tick(); l.told.clear();
  }

  private wake(l: Life): void {
    const eid = this.host.spawn(l.id);
    if (eid < 0) return;
    l.eid = eid;
    this.set(l, 'waking');
  }

  /** Sinking back and someone comes in: it rises again from where it had sunk to */
  private rewake(l: Life): void {
    const now = this.host.tick(), r = lifeRise('sleeping', l.at, now);
    // (the waking tick that puts it at the same height: the rise is monotonic, so a few halvings find it)
    let lo = 0, hi: number = LIFE.wake;
    for (let i = 0; i < 12; i++) { const m = (lo + hi) / 2; if (lifeRise('waking', 0, m) < r) lo = m; else hi = m; }
    this.set(l, 'waking');
    l.at = now - Math.round(lo);
    this.tell(l);
  }

  private set(l: Life, state: LifeState): void {
    l.state = state;
    l.at = this.host.tick();
    if (state === 'active') this.host.intro(l.eid);
    if ((state === 'waking' || state === 'sleeping') && l.eid >= 0) this.host.heave?.(l.num, l.eid);
    this.tell(l);
  }

  private tell(l: Life): void {
    this.host.send(l.num, { type: 'bossLife', boss: l.id, bodyId: l.eid, state: l.state, at: l.at });
    l.told = new Set(this.host.players(l.num));
  }

  /** Every tick (its system's pass) */
  tick(): void {
    const now = this.host.tick();
    for (const l of this.lives.values()) {
      if (l.state === 'dormant' || !this.host.active(l.num)) continue;
      const here = this.host.present(l.num).length > 0;
      const hurt = this.host.lastHurt(l.eid) >= l.at;
      switch (l.state) {
        case 'waking': if (now >= l.at + LIFE.wake) this.set(l, 'active'); break;
        case 'active': if (!here && this.host.lastHurt(l.eid) < now) this.set(l, 'recovering'); break;
        case 'recovering':
          if (here || hurt) this.set(l, 'active');
          else if (now >= l.at + LIFE.idle) this.set(l, 'healing');
          break;
        case 'healing':
          if (here || hurt) { this.set(l, 'active'); break; }
          if (now >= l.at + LIFE.heal) { this.host.restore(l.eid); this.set(l, 'sleeping'); break; }
          if ((now - l.at) % HEAL_STEP === 0 && now > l.at) this.host.heal(l.eid, HEAL_STEP / LIFE.heal);
          break;
        case 'sleeping':
          if (here) this.rewake(l);
          else if (now >= l.at + LIFE.sleep) { this.host.remove(l.eid); l.eid = -1; this.set(l, 'dormant'); }
          break;
      }
      // (someone new in its system: told where it is in its life, to draw it so)
      if (now % 30 === 0 && (l.state as LifeState) !== 'dormant' && this.host.players(l.num).some((p) => !l.told.has(p))) this.tell(l);
    }
  }
}
