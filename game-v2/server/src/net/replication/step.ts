/**
 * @contract server.replication.step
 * owns:       the once-a-tick shadow step (endTick): every ship's shadow stepped with the controls it flew and its causes,
 *             then compared with the real ship; pullers off as a tick began, bodied shadows, clamped followers
 * needs:      ReplicationCore (shadows, host, ships, stats, why, real), ownShip.stepOwn, env (envOf, clampId),
 *             causes/shadowCauses, common ships/replica
 * invariants: a shadow that leaves the real ship is marked diverged the same tick — server/src/net/replication.test.ts
 *             tick order and frame hashes unchanged by the step — server/src/golden/frameHash.test.ts
 *             a clamped follower is never keyframed for itself — server/src/golden/clampParity.test.ts
 * extend:     a new thing that can move a ship besides its controls is a cause (causes/shadowCauses.ts), not a case here
 */
import {
  Position, Velocity, Rotation, InSystem, ReplicaMode, CTL, replicaStep, replicaAngle, flightSignature, applyOwnCauses, applyPullRows,
  cargoBefore, OWN_CAUSE, type ShipState, type FlightBody,
} from '@space-game/common';
import type { OwnCause } from '../../ships/bridge/ownCauses.js';
import { workCauses, recordCauses, settleContacts, type WorkedCauses } from '../causes/shadowCauses.js';
import { SimPass } from '../../sim/SystemClocks.js';
import { sameDock, GONE_CAUSED_TICKS, type ReplicationCore, type Shadow } from './types.js';
import { stepOwn } from './ownShip.js';
import { envOf, clampId } from './env.js';

/**
 * After the tick (bodies rounded): step every shadow and see whether it still
 * matches. Ships in systems nobody is in aren't stepped: they're marked out
 * of step, so whoever arrives gets their real state (keyframes always carry it).
 */
export function endTick(rep: ReplicationCore): void {
  const tick = rep.host.tick();
  notePullers(rep, tick);
  for (const [id, s] of rep.shadows) {
    if (rep.ships.has(id)) continue;
    // (Gone with causes this window, which then never go: what clients have of it at its end is off, causedInWindow)
    if (s.causes.length) rep.goneCaused.set(id, tick);
    rep.shadows.delete(id);
  }
  for (const [id, t] of rep.goneCaused) if (t < tick - GONE_CAUSED_TICKS) rep.goneCaused.delete(id);
  const docks = rep.host.docks?.();
  const occupied = rep.host.occupied?.();
  for (const [eid, ship] of rep.ships.bodies) {
    // (Another pass's: crowd dilation, sim/SystemClocks.ts)
    if (!SimPass.on(InSystem.systemId[eid])) continue;
    // Distant (ships/SimLod.ts): no client has it in view (it wakes before it can be); whoever gets it next gets its real state
    if (rep.ships.isDormant(eid)) {
      const s = rep.shadows.get(eid);
      if (s) s.diverged = true;
      continue;
    }
    const rec = rep.ships.replicaCtl.get(eid);
    // (What moved a pilot's ship besides its controls this tick: taken whoever's client it is, so none are left over)
    const causes = ship.kind === 'ship' ? rep.ships.ownCauses.take(eid) : undefined;
    const dock = docks ? docks.get(eid) ?? null : rep.host.dockOf(eid);
    // (A piece of debris spawned this tick had no step yet: it drifts from the next, so it starts as Drift, not a keyframe later)
    const mode = dock ? ReplicaMode.Docked : rec?.mode ?? (ship.kind === 'debris' ? ReplicaMode.Drift : ReplicaMode.Pilotless);
    // (Debris drifts with no controls: 0, as flight.ts records it from its first step; hold here sent a control row next tick)
    const bits = dock ? 0 : rec?.bits ?? (ship.kind === 'debris' ? 0 : CTL.hold);
    const q = dock ? 0 : rec?.q ?? 0;
    let s = rep.shadows.get(eid);
    if (!s) {
      rep.shadows.set(eid, { mode, body: rep.real(eid), bits, q, version: 1, cver: 1, gen: 1, dver: 1, diverged: false, caused: false, causes: [], rebuilds: ship.rebuilds, sig: flightSignature(ship.derived), dock, events: [], qSent: q });
      continue;
    }
    if (mode !== s.mode || !sameDock(dock, s.dock)) { if (!s.diverged) rep.why('mode'); s.diverged = true; s.mode = mode; s.dock = dock; if (s.bodied) s.bodied.diverged = true; }
    if (bits !== s.bits || q !== s.q) {
      s.bits = bits;
      s.q = q;
      s.events.push(tick, bits, q);
    }
    // This tick's causes as rows, once for every client that takes them (a pilot's own, CAPS.OWN_SIM; any, CAPS.CAUSES)
    const worked = causes?.length ? rep.work(eid, s, causes, tick) : null;
    // A rebuild that changes how it flies: clients get the new structure with the next snapshot, so resend its state
    // too, unless it went as a cause (its clients fly the old structure until its tick)
    if (ship.rebuilds !== s.rebuilds) {
      s.rebuilds = ship.rebuilds;
      const sig = flightSignature(ship.derived);
      // (A piece of debris rebuilt: clients running it (CAPS.DEBRIS) worked its crumbling out, recentring and all, and
      // clients keeping each structure by tick (CAPS.STRUCTS) recentre it from its sync; the rest get a keyframe)
      if (mode === ReplicaMode.Drift) { s.sig = sig; s.lived = true; }
      else if (sig !== s.sig) {
        s.sig = sig;
        if (!worked?.rows.some((r) => r[0] === OWN_CAUSE.REBUILD)) { if (!s.diverged) rep.why('rebuild'); s.diverged = true; if (s.bodied) s.bodied.diverged = true; }
      }
    }
    // (Flown by its body: the shadow its body-running clients have, whatever the others need)
    if (rec?.body && mode === ReplicaMode.Pilotless) stepBodied(rep, eid, s, rec.body, rec.derived ?? ship.derived, tick, worked);
    else if (s.bodied) s.bodied.diverged = true;
    // (Docking Clamps: a follower sits where its leader puts it, on every client that has the link, clampFollower)
    if (clampFollower(rep, eid, s, tick)) continue;
    // A pilot whose client steps its own ship: its shadow is that, whatever the others need (stepOwn)
    if (ship.kind === 'ship' && rep.host.ownSim?.(eid)) { stepOwn(rep, eid, s, mode, bits, q, rec?.derived ?? ship.derived, tick, worked, dock ? q : rec?.rawQ ?? q); continue; }
    if (s.own) s.own = undefined;
    if (s.diverged || mode === ReplicaMode.Docked) continue;
    if (occupied && !occupied.has(InSystem.systemId[eid])) { s.diverged = true; continue; }
    // Debris is stepped as a world (drift and knocks, common ships/debris.ts), alike by clients: only a piece something
    // else moved (bridge/debrisNet.ts) is off what they have
    if (mode === ReplicaMode.Drift) {
      if (rep.ships.debrisNet.touched.has(eid)) { s.diverged = true; rep.why('Drift:moved'); }
      continue;
    }
    // (The hold's mass it flew this step with, if that changed: a CARGO cause goes in first)
    if (worked) cargoBefore(s.body, worked.rows);
    replicaStep(mode, s.body, { bits, targetAngle: replicaAngle(mode, q) }, rec?.derived ?? ship.derived, rep.ships.tuning, envOf(rep, eid), tick, clampId(rep, eid));
    // (Its pulls are part of its step, before every other cause: what a client works out or is told, common sim/pulls.ts)
    if (worked) applyPullRows(s.body, worked.rows);
    s.stepped = tick;
    // Its causes, worked out as its clients work them out (ones that can't be: a keyframe for everyone)
    if (causes?.length) {
      if (!worked) { if (!s.diverged) rep.why(`${ReplicaMode[mode]}:uncaused`); s.diverged = true; continue; }
      s.pre = { ...s.body };
      s.preTick = tick;
      if (!applyOwnCauses(s.body, worked.rows, worked.env)) { if (!s.diverged) rep.why(`${ReplicaMode[mode]}:cause`); s.diverged = true; continue; }
      s.caused = true;
    }
    // (The real state, as real() has it, read in place: this runs for every ship every tick)
    const rx = Position.x[eid], ry = Position.y[eid], rvx = Velocity.x[eid], rvy = Velocity.y[eid], ra = Rotation.angle[eid];
    const b = s.body;
    if (b.x !== rx || b.y !== ry || b.vx !== rvx || b.vy !== rvy || b.angle !== ra || b.angVel !== ship.angVel
      || (b.jump ?? 0) !== (ship.jump ?? 0) || (b.jumpScale ?? 1) !== (ship.jumpScale ?? 1)
      // (A charging jump's locked heading: its distance a replica doesn't know, -1, unless a keyframe told it)
      || b.jumpAim !== ship.jumpAim
      // (The hold's mass: a load taken on or off needs a keyframe carrying it)
      || (b.cargo ?? 0) !== (ship.cargo ?? 0)
      // (A Burst Strafer's counter and way: ships/features/strafer)
      || (b.dodge ?? 0) !== (ship.dodge ?? 0) || (b.dodgeDir ?? 0) !== (ship.dodgeDir ?? 0)) {
      s.diverged = true;
      rep.why(`${ReplicaMode[mode]}:${causes?.length ? 'caused:' : ''}${(b.cargo ?? 0) !== (ship.cargo ?? 0) ? 'cargo' : (b.dodge ?? 0) !== (ship.dodge ?? 0) || (b.dodgeDir ?? 0) !== (ship.dodgeDir ?? 0) ? 'dodge' : b.x !== rx || b.y !== ry ? 'pos' : b.vx !== rvx || b.vy !== rvy ? 'vel' : b.angle !== ra || b.angVel !== ship.angVel ? 'turn' : 'jump'}`);
    }
  }
  rep.ships.replicaCtl.clear();
  rep.ships.ownCauses.clear();
  for (const pair of rep.ships.debrisNet.pairs) rep.knocks.push(pair);
  // Contacts this tick: whether a client's replica of the other, before the tick's causes, was the contact pass's
  // (stepped this tick, in step, the very numbers): then the row needn't carry the other's state
  const other = (id: number) => rep.shadows.get(id);
  for (const s of rep.shadows.values()) if (s.causes.length) settleContacts(s.causes, tick, other);
}

/**
 * The pullers of this tick's pull fields (common sim/pullFields.ts), as every client has them as the tick begins: one
 * whose shadow (any: its clients' view of it) left the real ship before this tick is off for it. Before any shadow is
 * stepped this tick, so the shadows are as they ended the tick before
 */
export function notePullers(rep: ReplicationCore, tick: number): void {
  const pulls = rep.ships.pulls;
  if (!pulls.any) return;
  const same = (b: FlightBody, u: { x: number; y: number; angle: number; vx: number; vy: number }) => b.x === u.x && b.y === u.y && b.angle === u.angle && b.vx === u.vx && b.vy === u.vy;
  for (const f of pulls.declarer.activeAt(tick)) {
    if (f.sys === undefined || !SimPass.on(f.sys) || !pulls.needsPuller(f.from)) continue;
    // (As the pulls read it: its clients' replica of it, each shadow as it ended the tick before, must be that. Moved
    // since its shadow was last stepped (between ticks, a blink), it isn't, though no shadow has seen it go off yet)
    const s = rep.shadows.get(f.from), u = pulls.usedAt(f.from, tick);
    if (!u) continue;
    if (s && !s.diverged && same(s.body, u) && (!s.bodied || (!s.bodied.diverged && same(s.bodied.body, u)))) continue;
    let set = rep.pullOff.get(f.from);
    if (!set) rep.pullOff.set(f.from, (set = new Set()));
    set.add(tick);
  }
  if (tick % 60 === 0) for (const [id, set] of rep.pullOff) { for (const t of set) if (t < tick - 120) set.delete(t); if (!set.size) rep.pullOff.delete(id); }
}

/**
 * A ship's causes this tick as rows, recorded for the window once (every path that steps a shadow of it works them
 * out from these); null: they can't be sent (why: causeStats), every shadow of it is off (a keyframe)
 */
export function work(rep: ReplicationCore, eid: number, s: Shadow, causes: OwnCause[], tick: number): WorkedCauses | null {
  const w = workCauses(causes, s.causes, rep.ships.tuning.cellSize, rep.ships.tuning.collision?.restitution ?? 0.3);
  if (typeof w === 'string') {
    rep.causeStats.failed[w] = (rep.causeStats.failed[w] ?? 0) + 1;
    s.diverged = true;
    if (s.bodied) s.bodied.diverged = true;
    if (s.own && !s.own.hard) { s.own.why = w; s.own.hard = true; }
    if (s.own) s.body = rep.real(eid);
    return null;
  }
  recordCauses(s.causes, w, tick);
  s.worked = w;
  s.workedTick = tick;
  rep.causeStats.worked++;
  return w;
}

/**
 * A clamped follower's shadows (its clients' replica of it, its own client's): it sits where its leader puts it
 * (common sim/clampPair.ts placeFollower), which every client holding the link works out from the leader as it has it,
 * so they are the real ship whenever the leader's are (a leader keyframed, its follower is where it puts it). Not
 * stepped, never keyframed for it. True: the shadow is done for this tick
 */
export function clampFollower(rep: ReplicationCore, eid: number, s: Shadow, tick: number): boolean {
  const c = rep.ships.clamps;
  if (!c?.links.length) return false;
  const k = c.at(eid, tick);
  if (!k || k.follower !== eid || s.mode !== ReplicaMode.Player) return false;
  s.body = rep.real(eid);
  s.stepped = tick;
  if (s.own) { s.own.hard = false; s.own.exc = s.own.excLast = false; s.own.held = undefined; s.own.heldDock = undefined; }
  return true;
}

/** Bodies' clients' shadow of a ship its body flies (Shadow.bodied): stepped as their tick layer steps it */
export function stepBodied(rep: ReplicationCore, eid: number, s: Shadow, by: { bits: number; q: number; ix: number; iy: number }, derived: ShipState['derived'], tick: number, worked: WorkedCauses | null): void {
  const ship = rep.ships.get(eid)!;
  const sb = s.bodied ??= { body: rep.real(eid), version: -1, cver: -1, gen: -1, diverged: true, caused: false, rebuilds: ship.rebuilds };
  const rebuilt = sb.rebuilds !== ship.rebuilds;
  sb.rebuilds = ship.rebuilds;
  if (sb.diverged) return;
  const b = sb.body;
  b.vx += by.ix; b.vy += by.iy;
  if (worked) cargoBefore(b, worked.rows);
  replicaStep(ReplicaMode.Pilotless, b, { bits: by.bits, targetAngle: replicaAngle(ReplicaMode.Pilotless, by.q) }, derived, rep.ships.tuning, rep.host.env(eid), tick);
  if (worked) applyPullRows(b, worked.rows);
  rep.bodyStats.stepped++;
  sb.stepped = tick;
  // (Its causes: CAUSES clients running it work them out; the rest are sent a keyframe of it)
  if (worked) {
    sb.pre = { ...b };
    sb.preTick = sb.workedTick = tick;
    sb.worked = worked;
    if (!applyOwnCauses(b, worked.rows, worked.env)) { sb.diverged = true; return; }
    sb.caused = true;
  }
  if (b.x !== Position.x[eid] || b.y !== Position.y[eid] || b.vx !== Velocity.x[eid] || b.vy !== Velocity.y[eid] || b.angle !== Rotation.angle[eid] || b.angVel !== ship.angVel) {
    sb.diverged = true;
    const w = (rebuilt ? 'rebuilt:' : '') + (b.x !== Position.x[eid] || b.y !== Position.y[eid] ? 'pos' : b.vx !== Velocity.x[eid] || b.vy !== Velocity.y[eid] ? 'vel' : 'turn');
    rep.bodyStats.why[w] = (rep.bodyStats.why[w] ?? 0) + 1;
  }
}
