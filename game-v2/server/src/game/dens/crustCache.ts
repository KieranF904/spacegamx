/**
 * A den's cache under a crust (systems.json `den` kind `cache`; the Kiln's Slag Crust): a pinned, pilotless body of
 * armour blocks (`material`: the Kiln's is a grade 4 material on the armour function, armour 5, so penetration is what
 * opens it). Pilots' damage to it adds up; at `hp` it cracks (its blocks crumble away) and each pilot who hurt it gets
 * the loot (rolled for each, into station storage), at most once per `everyMinutes`. It grows back `regrowSeconds`
 * later. Left alone as long as a hurt enemy takes to heal (LIFE), a worn crust is whole again.
 *
 * The crust's blocks can break one by one as it's worn (each holds a share of the crust's HP, three times over), but
 * only the total cracks it, so it reads as crumbling without a lucky block deciding anything.
 */

import { LIFE, hashString, type Bag, type Blueprint, type DenCacheData, type PlacedPart } from '@space-game/common';
import type { DenFactory } from './types.js';
import { PayoutDice } from '../payoutDice.js';

/** Its system's den features step every tick; the crust looks after itself this often */
const EVERY = 30;
/** A pilot must have dealt this share of its HP to be paid (not one stray splash) */
const SHARE = 0.01;

/** The crust: a disc of armour blocks `cells` across round a core (the cache) */
export function crustBlueprint(c: DenCacheData): Blueprint {
  const parts: PlacedPart[] = [];
  const r = c.cells / 2, h = Math.floor(r);
  for (let y = -h; y <= h; y++) for (let x = -h; x <= h; x++) {
    if (x * x + y * y > (r - 0.15) * (r - 0.15)) continue;
    parts.push({ uid: parts.length, piece: 'sq', fn: x === 0 && y === 0 ? 'core' : 'armor', material: c.material, x, y, rot: 0, flip: false });
  }
  return { name: c.name, catalogVersion: 1, parts, ...(c.paint ? { paint: c.paint } : {}) } as Blueprint;
}

/** A pilot's loot from the cache, rolled from its seed */
export function rollCache(c: DenCacheData, seed: number): Bag {
  let s = seed >>> 0;
  const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const bag: Bag = {};
  for (const l of c.loot) {
    if (rng() >= l.chance) continue;
    bag[l.item] = (bag[l.item] ?? 0) + l.min + Math.floor(rng() * (l.max - l.min + 1));
  }
  return bag;
}

export const crustCache: DenFactory<DenCacheData> = (host, num, c) => {
  let eid = -1, total = 0, lastHit = 0, regrowAt = 0;
  /** Its crumbled body, to take away once its blocks have gone */
  let husk = -1;
  /** Damage dealt by each pilot (by body) this crust */
  const dealt = new Map<number, number>();
  /** When each pilot (by who they are) was last paid */
  const paid = new Map<string, number>();
  const every = c.everyMinutes * 60 * 60;
  const dice = host.payout ?? new PayoutDice();

  const grow = () => {
    const bp = crustBlueprint(c);
    eid = host.ships.spawnDummy(bp, c.x, c.y, 0, num);
    host.ships.pin(eid);
    // (Each block holds a share of the crust's HP, three times over; the core holds it all twice: only the total cracks it)
    const share = Math.max(150, (c.hp * 3) / bp.parts.length);
    host.ships.setMaxHp(eid, bp.parts.map((p) => (p.fn === 'core' ? c.hp * 2 : share)));
    total = 0;
    dealt.clear();
  };

  const crack = (now: number) => {
    const ship = host.ships.get(eid);
    if (ship) host.ships.shed(eid, ship.blueprint.parts.map((_, i) => [i]), 2.5, 90, true);
    host.send(num, { type: 'detonation', kind: 'eruption', x: c.x, y: c.y, radius: 260 });
    husk = eid;
    eid = -1;
    regrowAt = now + c.regrowSeconds * 60;
    for (const [p, d] of dealt) {
      if (d < c.hp * SHARE || !host.ships.has(p)) continue;
      const who = host.who(p);
      if (!who) continue;
      const last = paid.get(who);
      if (last !== undefined && now - last < every) {
        const mins = Math.ceil((every - (now - last)) / 3600);
        host.toast(p, `The ${c.name} cracks, but you emptied it recently. It refills in ${mins} min.`, 'info');
        continue;
      }
      paid.set(who, now);
      // (its roll's seed from the server's secret, not from who and when, which a client could know: payoutDice.ts)
      host.reward(p, rollCache(c, dice.seed('den cache', hashString(c.id), hashString(who), now)), `You cracked the ${c.name}: what it held is waiting in your station storage`);
    }
    dealt.clear();
  };

  return {
    tick(now, players) {
      if (now % EVERY !== 0) return;
      if (husk >= 0) { if (host.ships.has(husk)) host.ships.removeShip(husk); husk = -1; }
      if (eid >= 0 && !host.ships.has(eid)) { eid = -1; regrowAt = now + c.regrowSeconds * 60; }
      if (eid < 0) { if (players.length && now >= regrowAt) grow(); return; }
      // Left alone as long as a hurt enemy takes to heal whole: grown back whole (a fresh crust, its lost blocks too)
      if (total > 0 && now - lastHit > LIFE.idle + LIFE.heal) { host.ships.removeShip(eid); grow(); }
    },
    onDamage(target, amount, source) {
      if (target !== eid || eid < 0 || !host.who(source)) return;
      total += amount;
      dealt.set(source, (dealt.get(source) ?? 0) + amount);
      lastHit = host.tick();
      if (total >= c.hp) crack(lastHit);
    },
    nameOf(target) {
      return target === eid ? c.name : undefined;
    },
  };
};
