/**
 * @contract server.enemies.steering
 * owns:       one hostile's pilot: patrol, engage, flee, return, target choice, and the coarse intent for a distant one
 * needs:      Enemies (enemies, packs, wards, ships, host, data), ./placement, common/bodies orders; npm: bitecs
 * invariants: behaviour unchanged from Enemies.ts, which it was split from — none pinned
 * extend:     a new behaviour is a state in fly()
 */

import { hasComponent } from 'bitecs';
import { Position, Velocity, Rotation, InSystem, Player, Dead, Radius, ShipState, aiLoadout, AI_BEAM_REACH, dcos, dhypot, dsin, orderEngage, orderFlee, orderPatrol, orderReturn, aiAimError, type WantRec } from '@space-game/common';
import { anchoredWaypoint, PATROL_STALL } from '../Roaming.js';
import type { PilotOrders } from '../../ships/ShipBridge.js';
import type { Intent, Plan } from '../../ships/SimLod.js';
import type { Enemies } from '../Enemies.js';
import type { Behaviour, Enemy, Pack } from './model.js';
import * as placement from './placement.js';

/** Drawn more than twice its leash from home, a hostile breaks off once its target hasn't shot the pack for this long (ticks) */
const CHASE_GRACE = 60 * 10;

export function fly(self: Enemies, e: Enemy, ship: ShipState, asBody = true): PilotOrders {
  const now = self.host.tick();
  const eid = e.eid;
  const f = self.data.factions[e.faction];
  const b = e.behaviour ?? f.behaviour;
  const pack = self.packs.get(e.pack);
  const home = pack?.home ?? { x: Position.x[eid], y: Position.y[eid] };
  const x = Position.x[eid], y = Position.y[eid];

  if (now >= e.nextThink) {
    e.nextThink = now + 12 + (eid % 7);
    const fromHome = dhypot(x - home.x, y - home.y);
    // Hurt? run (if the faction does); and when most of the pack is gone, its nerve breaks
    const broken = b.flee > 0 && !e.boss && pack && (pack.size0 ?? 1) >= 3 && pack.members.size <= (pack.size0 ?? 1) * 0.4 && self.ships.coreFraction(eid) < 0.75;
    // Passive packs (safe systems) only fight once one of them has been shot (a wingmate of their own faction bumping
    // into them doesn't count)
    if (pack?.passive && pack.members.size && [...pack.members].some((m) => now - self.ships.lastDamagedTick(m) < 30 && self.enemies.get(self.ships.lastHitter(m))?.faction !== e.faction)) pack.angryUntil = now + 60 * (f.angrySeconds ?? 45);
    const calm = !!pack?.passive && now >= (pack.angryUntil ?? 0);
    // Whoever's been hurting the pack, from however far off
    const hitter = calm ? -1 : packHitter(self, e, pack, now);
    if (b.flee > 0 && (self.ships.coreFraction(eid) < b.flee || broken) && e.target >= 0) e.state = 'flee';
    else if (e.state === 'engage' && gaveUp(self, e, b, fromHome, hitter, now)) { e.state = 'return'; e.target = -1; }
    else if (e.state !== 'engage' && fromHome > b.leash && hitter < 0) { e.state = 'return'; e.target = -1; }
    else if (e.state !== 'return' || fromHome < b.leash * 0.5 || hitter >= 0) {
      // Nearest player in range (a packmate's target counts too), or a ward: defenders who get in the way draw the fire
      let best = -1, bd = calm ? 0 : b.aggro;
      for (const p of self.host.players(InSystem.systemId[eid])) {
        if (self.host.sheltered?.(p) || spared(self, e, p, now)) continue;
        const d = dhypot(Position.x[p] - x, Position.y[p] - y);
        if (d < bd) { bd = d; best = p; }
      }
      for (const w of self.wards) {
        if (!self.ships.has(w) || InSystem.systemId[w] !== InSystem.systemId[eid]) continue;
        const d = dhypot(Position.x[w] - x, Position.y[w] - y);
        if (!calm && d < bd) { bd = d; best = w; }
      }
      // Whoever's been hurting the pack gets its attention
      if (hitter >= 0) best = hitter;
      // ...unless it has its prey (gone: it's back to the usual)
      if (e.prey !== undefined) {
        if (!targetable(self, e.prey)) e.prey = undefined;
        else if (e.preyOnly || hitter < 0) best = e.prey;
      }
      if (best < 0 && pack && !calm) {
        for (const m of pack.members) {
          const o = self.enemies.get(m);
          if (o && o.target >= 0 && targetable(self, o.target)) { best = o.target; break; }
        }
      }
      if (best >= 0) {
        if (best !== e.target || best === hitter) e.engagedAt = now;
        e.target = best; e.state = 'engage';
      }
      else if (e.state === 'engage' || e.state === 'flee') { e.state = 'patrol'; e.target = -1; }
      else if (e.state === 'return' && fromHome < b.leash * 0.5) e.state = 'patrol';
    }
    // (Among rock (a den), a patrol is kept clear of it, and one held up on it is given up: clearRun, stalled)
    const clear = e.state === 'patrol' ? placement.clearRun(self, eid) : undefined;
    if (e.state === 'patrol' && pack?.nestDef && pack.style !== 'anchored') {
      // Loose and nomad packs wander as one: each to its own spot round the pack's waypoint
      const lead = pack.members.values().next().value ?? eid;
      const wp = placement.wander(self, pack, lead, now), k = [...pack.members].indexOf(eid);
      e.waypoint = k <= 0 ? wp : { x: wp.x + dcos(k * 2.4) * 380, y: wp.y + dsin(k * 2.4) * 380 };
    } else if (e.state === 'patrol' && (dhypot(x - e.waypoint.x, y - e.waypoint.y) < 300 || (clear && stalled(self, e, x, y, now, pack?.pauseUntil ?? 0)))) {
      e.waypoint = anchoredWaypoint({ x, y }, home, pack?.roam ?? 2400, self.rng, clear);
      e.wpBest = undefined;
    }
    if (self.rng() < 0.04) e.strafe = -e.strafe;
    // Nobody shoots perfectly: its aim's off by up to this much either way, re-rolled as it goes from a seed it rolled
    // once (common bodies/aiPilot.ts aiAimError: its pilot's body, on the clients that run it too)
    const acc = (b.accuracy ?? 0.85) + (e.elite ? 0.05 : 0);
    e.aimErr = (1 - acc) * 0.45;
    const roll = self.rng();
    e.aimSeed ??= Math.floor(roll * 256);
  }

  const t = e.target;
  // Gone, or safe at a station or in safe space: break off (every tick, not just when thinking)
  if ((e.state === 'engage' || e.state === 'flee') && (!targetable(self, t) || (now % 20 === 0 && spared(self, e, t, now)))) { e.state = 'return'; e.target = -1; }

  // Its order, flown by the shared pilot (common bodies/aiPilot.ts): on the clients that run its body too
  let want: WantRec, cent: [number, number] | null = null, reach = 0;
  // (A custom enemy: its range and reach are its design's, and its order carries its move and lost pieces: custom/)
  const cs = self.custom.has(eid) ? self.custom.statsOf(e.type) : undefined;
  if (e.state === 'engage') {
    if (e.reach === undefined) { if (cs) e.reach = cs.reach; else learnLoadout(self, e, ship); }
    reach = Math.round(e.reach ?? Math.max(b.range * 1.8, 900));
    // (shot at lately by its target: its commander's to know, from the damage ledger)
    const hitBy = now - self.ships.lastDamagedTick(eid) < 150 && self.ships.lastHitter(eid) === t;
    const c = pack?.cent, mates = c && c.ids.includes(eid) ? c.ids.filter((m) => m !== eid) : undefined;
    if (c && mates?.length) cent = [c.x, c.y];
    // (whether one of its guns lobs: its trigger fires from further off, common bodies/aiPilot.ts aiFires)
    want = orderEngage(eid, cs?.range ?? b.range, reach, hitBy, e.aimErr, e.aimSeed ?? 0, b.strafe, cent ? e.flank : undefined, cent ? mates : undefined, !cs && e.lobs === true, cs ? undefined : e.lead);
    if (cs) want = self.custom.order(eid, want, t);
  } else if (e.state === 'flee') want = orderFlee();
  else if (e.state === 'return') want = orderReturn(home.x, home.y);
  else want = orderPatrol(e.waypoint.x, e.waypoint.y, pack?.pace ?? 0.58, pack?.pauseUntil ?? 0);
  const fights = e.state === 'engage' || e.state === 'flee';
  const pose = (id: number) => ({ x: Position.x[id], y: Position.y[id], angle: Rotation.angle[id], vx: Velocity.x[id], vy: Velocity.y[id] });
  // (its target with its size, as its trigger reads it: aiFires)
  const tpose = (id: number) => ({ ...pose(id), r: self.ships.get(id)?.derived.radius ?? Radius.value[id] ?? 60 });
  // (its body flies it while what it fights is a pilot's ship, or nothing: brains/aiPilot.ts)
  // (Pinned (a fixed boss, a range target): it only turns, its thrust dropped (bridge/pilotless.ts), which its body doesn't know: the rows fly it)
  const bodied = asBody && !self.ships.isPinned(eid) && (!fights || hasComponent(self.host.world, Player, t));
  const out = self.pilots.fly(eid, fights ? t : -1, e.strafe, want, pose(eid), fights ? tpose(t) : null, cent, bodied);
  // (Its moves and guns: what they do this tick, common bodies/moves/custom.ts; it fires no part guns)
  if (cs) { if (asBody) self.custom.step(eid, t, e.state === 'engage'); }
  // Its trigger is its pilot's (common bodies/aiPilot.ts aiFires: within its guns' real reach, when a hit is likely),
  // so a client flying its body fires it too (sim/otherGuns.ts)
  return self.pilots.orders(eid, out, !cs && e.state === 'engage' && out.fire, t);
}

/** How far an enemy's guns really reach (its longest), whether any lob shells, and the round it leads by (common bodies/aiLead.ts) */
export function learnLoadout(self: Enemies, e: Enemy, ship: ShipState): void {
  const l = aiLoadout(self.ships.tuning, ship, AI_BEAM_REACH);
  e.reach = l.reach > 0 ? l.reach : undefined;
  e.lobs = l.lobs;
  e.lead = l.lead;
}

/** Alive, and not sheltering at a station */
/**
 * A pilot in safe space (inner Sol) is left alone by hostile packs, unless
 * they've been shooting this pack in the last few seconds; passive packs
 * provoked there fight back as anywhere.
 */
export function spared(self: Enemies, e: Enemy, p: number, now: number): boolean {
  if (e.boss || !self.host.safeAt?.(InSystem.systemId[e.eid], Position.x[p], Position.y[p])) return false;
  const pack = self.packs.get(e.pack);
  if (pack?.passive) return false;
  for (const m of pack?.members ?? [e.eid]) if (self.ships.lastHitter(m) === p && now - self.ships.lastDamagedTick(m) < 60 * 8) return false;
  return true;
}

/** The pilot (or ward) who most recently shot one of its pack in the last few seconds, wherever they are in the system; -1 if none */
export function packHitter(self: Enemies, e: Enemy, pack: Pack | undefined, now: number): number {
  let best = -1, last = -Infinity;
  for (const m of pack?.members ?? [e.eid]) {
    const h = self.ships.lastHitter(m), at = self.ships.lastDamagedTick(m);
    if (h < 0 || now - at > 240 || at <= last || !targetable(self, h) || InSystem.systemId[h] !== InSystem.systemId[e.eid]) continue;
    best = h; last = at;
  }
  return best;
}

/**
 * A chase ends when its target has got well away (out past twice its sight, and past its
 * guns' reach), or when it's been drawn far past its leash and hasn't been shot at for a while
 */
export function gaveUp(self: Enemies, e: Enemy, b: Behaviour, fromHome: number, hitter: number, now: number): boolean {
  const t = e.target;
  if (!targetable(self, t)) return true;
  if (hitter === t || t === e.prey) return false;
  const d = dhypot(Position.x[t] - Position.x[e.eid], Position.y[t] - Position.y[e.eid]);
  if (d > Math.max(b.aggro * 2, e.reach ?? b.range * 1.8)) return true;
  return fromHome > b.leash * 2 && now - (e.engagedAt ?? 0) > CHASE_GRACE;
}

export function targetable(self: Enemies, eid: number): boolean {
  return alive(self, eid) && !self.host.sheltered?.(eid);
}

export function alive(self: Enemies, eid: number): boolean {
  if (eid >= 0 && self.wards.has(eid)) return self.ships.has(eid);
  return eid >= 0 && hasComponent(self.host.world, Player, eid) && !hasComponent(self.host.world, Dead, eid);
}

/**
 * A patrolling ship among rock that hasn't got any nearer its waypoint for PATROL_STALL (holding still doesn't count):
 * held up on a wall (or a boulder its straight run didn't see). In open space nothing holds a patrol up for good
 */
export function stalled(self: Enemies, e: Enemy, x: number, y: number, now: number, pauseUntil: number): boolean {
  const d = dhypot(x - e.waypoint.x, y - e.waypoint.y);
  if (now < pauseUntil || e.wpRef !== e.waypoint || e.wpBest === undefined || d < e.wpBest - 150) {
    e.wpRef = e.waypoint; e.wpBest = d; e.wpSince = now;
    return false;
  }
  return now - (e.wpSince ?? now) >= PATROL_STALL;
}

/**
 * What a hostile is doing, coarsely, for a distant one (ships/SimLod.ts),
 * from where its route has it (`at`, at the tick its last leg ended, with
 * its own dice): on patrol, flying from point to point round its home at
 * its pack's pace (as fly() picks them; a home that stays put, a patrol the
 * map can follow on its own), a loose or nomad pack's lead
 * on the pack's shared wander and the rest keeping their places off it;
 * going home, flying straight back inside its leash; fighting or fleeing,
 * null (it stays live). undefined: not a hostile.
 */
export function intent(self: Enemies, eid: number, at: Plan): Intent | null | undefined {
  const e = self.enemies.get(eid);
  if (!e) return undefined;
  if (e.dummy) return null;
  if (e.state === 'engage' || e.state === 'flee' || e.target >= 0) return null;
  const now = at.tick;
  const b = e.behaviour ?? self.data.factions[e.faction].behaviour;
  const pack = self.packs.get(e.pack);
  const x = at.x, y = at.y;
  const home = pack ? placement.homeAt(self, pack, now) : { x, y };
  if (e.state === 'return') {
    if (dhypot(x - home.x, y - home.y) >= b.leash * 0.5) return { kind: 'goto', x: home.x, y: home.y, arrive: b.leash * 0.5 };
    e.state = 'patrol';
  }
  let until: number | undefined;
  if (pack?.nestDef && pack.style !== 'anchored') {
    const lead = pack.members.values().next().value ?? eid, k = [...pack.members].indexOf(eid);
    const off = { x: dcos(k * 2.4) * 380, y: dsin(k * 2.4) * 380 };
    if (k > 0 && self.ships.isDormant(lead)) return { kind: 'follow', lead, dx: off.x, dy: off.y };
    const wp = placement.wander(self, pack, lead, now, k <= 0 ? at : undefined, at.rng);
    e.waypoint = k <= 0 ? wp : { x: wp.x + off.x, y: wp.y + off.y };
    until = pack.wpUntil;
  } else if (!pack?.nestDef) {
    // Round a home that stays put: a patrol worked out by its own dice (the map's told it once: SimLod, common farRoute.ts)
    return { kind: 'patrol', x: home.x, y: home.y, roam: pack?.roam ?? 2400, pace: pack?.pace ?? 0.58, wp: e.waypoint };
  } else if (dhypot(x - e.waypoint.x, y - e.waypoint.y) < 300) {
    e.waypoint = anchoredWaypoint({ x, y }, home, pack?.roam ?? 2400, at.rng, placement.clearRun(self, eid));
  }
  // (Packs cruise in pulses at their own pace, and a loose one stops a while now and then)
  const paused = now < (pack?.pauseUntil ?? 0);
  if (paused) return { kind: 'hold', until: pack!.pauseUntil };
  return { kind: 'goto', x: e.waypoint.x, y: e.waypoint.y, arrive: 300, pace: pack?.pace ?? 0.58, until };
}
