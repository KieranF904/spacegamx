/**
 * @contract server.replication.own
 * owns:       a pilot's own ship as its client steps it (CAPS.OWN_SIM): its shadow's step (stepOwn), its share of a
 *             snapshot (ownFor: its causes, exceptions row, own keyframe) and its pulls told or left to it (ownPulls)
 * needs:      ReplicationCore (shadows, host, ships, ownStats, ownWhy, real), workable (otherBefore, rebuildOk),
 *             env (envOf, clampId), causes/shadowCauses (causeRow, untoldPulls)
 * invariants: its own keyframe versions count down from -1, apart from everyone else's — server/src/golden/clampParity.test.ts
 *             an own ship whose step matches the server sends no keyframe — server/src/net/replication.test.ts
 * extend:     a new reason its client can't work its ship out is one hard('why') in stepOwn
 */
import {
  Position, Velocity, Rotation, Input, ReplicaMode, OWN_CAUSE, jumpBurnAt, jumpTuning, replicaStep, replicaAngle, applyOwnCauses, applyPullRows,
  cargoBefore, packKeyframe, packControlRow, type ShipState, type KeyframeRow, type ControlRow,
} from '@space-game/common';
import { causeRow, untoldPulls, type CauseEvent, type WorkedCauses } from '../causes/shadowCauses.js';
import { OWN_DERIVED_BITS, quantizeOwn, sameBody, sameDock, type Kept, type OwnShadow, type ReplicationCore, type Shadow } from './types.js';
import { otherBefore, rebuildOk } from './workable.js';
import { envOf, clampId } from './env.js';

/**
 * A pilot's own ship, as its client steps it (CAPS.OWN_SIM, network/ownTick.ts): its replica step with the controls
 * it flew, then this tick's causes worked out by the client's own function (applyOwnCauses) from what the server's
 * step had (the other body as the contact pass saw it). Then it is the real ship, or something moved it that its
 * client can't work out (`hard`): a keyframe of its own ship. The others get a keyframe as before whenever anything
 * but its controls moved it.
 */
export function stepOwn(rep: ReplicationCore, eid: number, s: Shadow, mode: ReplicaMode, bits: number, q: number, derived: ShipState['derived'], tick: number, worked: WorkedCauses | null, rawQ = q): void {
  const o = s.own ??= { version: -1, events: [], exc: false, excLast: false, first: null, ctl: [], hard: true, why: 'start' };
  if (!o.first) o.first = [tick, bits, rawQ];
  else if (!o.last || o.last[0] !== bits || o.last[1] !== rawQ) o.ctl.push(tick, bits, rawQ);
  if (o.last) { o.last[0] = bits; o.last[1] = rawQ; } else o.last = [bits, rawQ];
  const hard = (why: string) => { if (!o.hard) o.why = why; o.hard = true; s.diverged = true; s.body = rep.real(eid); };
  // Its controls: what its inputs say, or (the engines short of power, an EMP, the cold, an override) the window's
  // real controls go to it (ownFor)
  // (Its engines' power, share and a refused boost it works out itself, its own step being the whole one, stores and
  // all (common sim/ownStep.ts): no row for those; the held controls, aim and hazard bits it can't)
  // (Its aim: the raw one its step flew, which its inputs say. The applied one, `q`, its client works out from it alike:
  // common sim/aimHold.ts)
  const want = rep.host.ownControls?.(eid);
  o.excLast = !want || want.bits !== (bits & ~OWN_DERIVED_BITS) || want.q !== rawQ;
  if (o.excLast) o.exc = true;
  if (rep.host.ownLate?.(eid)) return hard('late input');
  // (Steering a docked pair its follower's engines held back: its client flew it on its own share)
  if (rep.ships.clamps?.limited(eid, tick)) return hard('clamp power');
  // (Not flown by its pilot: its client has it from its last keyframe, so another only when that's out of date. Docked,
  // its keyframe says where at its station (it rides the station as every client's docked replica does); else when it moved)
  if (mode !== ReplicaMode.Player) {
    const same = o.held === mode && (mode === ReplicaMode.Docked ? sameDock(o.heldDock ?? null, s.dock) : sameBody(s.body, rep.real(eid)));
    // (Its shadow stays what its keyframe carried: what its client has, and checks against. A docked ship's velocity
    // isn't its client's to follow)
    // (Nor its controls: held neutral there, no exceptions row)
    if (same) { if (o.hard) s.body = rep.real(eid); o.exc = o.excLast = false; return; }
    o.held = mode;
    o.heldDock = s.dock;
    return hard('mode');
  }
  // (Flown again (undocked): from a keyframe)
  if (o.held !== undefined) { o.held = undefined; o.heldDock = undefined; return hard('mode'); }
  if (o.hard) { s.body = rep.real(eid); return; }
  if (worked) cargoBefore(s.body, worked.rows);
  // (With the jump distance its client flies, its input's cursor distance: ownStep.ts. The others' replicas don't know
  // it, so theirs waits at the end of the charge: the burn's start is a keyframe for them, not for its own client)
  const jumpWas = s.body.jump ?? 0;
  replicaStep(mode, s.body, { bits, targetAngle: replicaAngle(mode, q), jumpDist: Input.cursorDist[eid] }, derived, rep.ships.tuning, envOf(rep, eid), tick, clampId(rep, eid));
  const burnAt = jumpBurnAt(jumpTuning(rep.ships.tuning));
  if (jumpWas < burnAt && (s.body.jump ?? 0) === burnAt) { if (!s.diverged) rep.why(`${ReplicaMode[mode]}:jump`); s.diverged = true; }
  if (worked) {
    // (Its pulls: part of its step, before its other causes, as its client's own step takes them)
    applyPullRows(s.body, worked.rows);
    s.pre = { ...s.body };
    s.preTick = tick;
    if (!applyOwnCauses(s.body, worked.rows, worked.env)) return hard('cause');
    // (Its own rows are the shadow's window events: the others' CAUSES clients get them too, the rest a keyframe of it)
    for (let i = s.causes.length - worked.rows.length; i < s.causes.length; i++) o.events.push(s.causes[i]);
    if (!s.caused) rep.why(`${ReplicaMode[mode]}:caused`);
    s.caused = true;
  } else {
    quantizeOwn(s.body);
  }
  s.stepped = tick;
  const b = s.body, ship = rep.ships.get(eid)!;
  if (b.x !== Position.x[eid] || b.y !== Position.y[eid] || b.vx !== Velocity.x[eid] || b.vy !== Velocity.y[eid] || b.angle !== Rotation.angle[eid] || b.angVel !== ship.angVel
    || (b.jump ?? 0) !== (ship.jump ?? 0) || (b.jumpScale ?? 1) !== (ship.jumpScale ?? 1) || (b.cargo ?? 0) !== (ship.cargo ?? 0)
    || (b.dodge ?? 0) !== (ship.dodge ?? 0) || (b.dodgeDir ?? 0) !== (ship.dodgeDir ?? 0)
    // (A charging jump's lock, its distance too: its client knows it, ownStep.ts)
    || b.jumpAim !== ship.jumpAim || (b.jumpAim !== undefined && b.jumpTo !== ship.jumpTo)) {
    hard(worked ? 'unexplained, with causes' : 'unexplained');
  }
}

/** One pilot's own ship (CAPS.OWN_SIM): see forClient */
export function ownFor(rep: ReplicationCore, eid: number, s: Shadow, o: OwnShadow, known: Map<number, number>, snapshotTick: number, ships: KeyframeRow[], ctl: ControlRow[], out: { own?: number[][]; ownRebuild?: number; ownEvents?: CauseEvent[] }, synced?: (id: number) => number | undefined, kept?: Kept, bodied?: (id: number) => boolean): void {
  // (A contact whose other it can't have as the pass had it: rebuilt since, or a ship this client doesn't have)
  for (const e of o.events) {
    const c = e.contact;
    if (!c) continue;
    // (Rebuilt since, while its client still had it as it was: it keeps that structure when the new one comes, OTHER_BEFORE)
    const now = rep.ships.get(c.other)?.rebuilds ?? -1;
    c.before = otherBefore(rep, c, synced);
    if (!known.has(c.other) || (now !== c.rebuilds && !c.before && !kept?.(c.other)?.includes(c.rebuilds))) { o.version--; rep.ownWhy('contact: other not had'); break; }
  }
  // (A rebuild it can't work out from the structures it has either side of this frame's sync)
  for (const e of o.events) if (e.rebuild && !rebuildOk(rep, eid, e, o.events, synced, kept)) { o.version--; rep.ownWhy('rebuild not had'); break; }
  if (known.get(eid) !== o.version) {
    known.set(eid, o.version);
    ships.push(s.keyRow ??= packKeyframe({ id: eid, mode: s.mode, body: rep.real(eid), ctl: { bits: s.bits, targetAngle: 0 }, q: s.q, dock: s.dock ?? undefined }));
    rep.keyframes++;
    return;
  }
  if (o.exc && o.first) {
    // The window's real controls from its first tick (the client puts them in place of its inputs'), from aim 0
    const ev: [number, number, number][] = [[snapshotTick - o.first[0], o.first[1], o.first[2]]];
    for (let i = 0; i < o.ctl.length; i += 3) ev.push([snapshotTick - o.ctl[i], o.ctl[i + 1], o.ctl[i + 2]]);
    ctl.push(packControlRow(eid, ev, 0));
    rep.ownStats.exc++;
  }
  if (!o.events.length) return;
  const rows: number[][] = [];
  for (const e of o.events) {
    const c = e.contact;
    // (Its replica of the other is what the contact pass had: the state stays out. Not if the other gets a keyframe
    // now or had one since (the client's replica of it moved), nor if it was rebuilt since: its client steps it with
    // the new structure from its last keyframe on. Its versions: the ones this client goes by)
    const os = c && rep.shadows.get(c.other), v = c && c.cver;
    const rekeyed = !!c && os?.cver !== v;
    // (One flown by its body on this client (CAPS.BODIES): its bodied shadow is what the client has of it, its own
    // versions counting down; in step then and not keyframed since, the state stays out too)
    const ran = !!c && !!os?.bodied && (bodied?.(c.other) ?? false) && (known.get(c.other) ?? 0) < 0;
    const stateless = !!c && (ran ? !!c.bodyPreStep && os!.bodied!.cver === c.bcver && known.get(c.other) === c.bcver
      : !!c.preStep && !rekeyed && known.get(c.other) === v);
    const r = causeRow(e, snapshotTick, stateless);
    rows.push(r);
    rep.ownStats.causes++;
    if (r[1] === OWN_CAUSE.PULL) rep.ownStats.pull++;
    else if (r[1] === OWN_CAUSE.CONTACT) { rep.ownStats.contact++; if (r.length > 4) rep.ownStats.contactState++; }
    else if (r[1] === OWN_CAUSE.CARGO) rep.ownStats.cargo++;
    else { rep.ownStats.rebuild++; out.ownRebuild = Math.max(out.ownRebuild ?? -Infinity, e.tick); }
  }
  out.own = rows;
  out.ownEvents = o.events;
}

/**
 * Its own ship's pulls this window (pull fields, common sim/pullFields.ts): a tick whose pulls are all fields' it can
 * work out goes untold; any other tick's go whole. And a tick a field might have pulled it on, from a puller it can't
 * have as the server had it, with no pull of the server's: a zero PULL row, so its step doesn't work one out from
 * that puller (it would from the wrong place). Its rows and events go in step (`out.own`, `out.ownEvents`)
 */
export function ownPulls(rep: ReplicationCore, out: { own?: number[][]; ownEvents?: CauseEvent[] }, self: number, snapshotTick: number, since: number, derivable: (from: number, t: number) => boolean, whole: (id: number, t: number) => boolean): void {
  if (out.own && out.ownEvents) {
    const d = untoldPulls(out.ownEvents, derivable, (t) => whole(self, t));
    if (d) {
      const keep = out.ownEvents.map((e) => !d.has(e));
      out.own = out.own.filter((_, i) => keep[i]);
      out.ownEvents = out.ownEvents.filter((_, i) => keep[i]);
      rep.ownStats.pullDerived += d.size;
      rep.ownStats.pull -= d.size;
      if (!out.own.length) { out.own = undefined; out.ownEvents = undefined; }
    }
  }
  if (!Number.isFinite(since)) return;
  const told = new Set<number>();
  for (const e of out.ownEvents ?? []) if (e.row[0] === OWN_CAUSE.PULL) told.add(e.tick);
  let zero: number[] | null = null;
  for (let t = since + 1; t <= snapshotTick; t++) if (!told.has(t) && whole(self, t)) (zero ??= []).push(t);
  if (!zero) return;
  // (Each first among its tick's rows: a pull is the step's, before every other cause)
  const rows = out.own ?? [], evs = out.ownEvents ?? [];
  for (const t of zero) {
    let i = 0;
    while (i < rows.length && snapshotTick - rows[i][0] < t) i++;
    rows.splice(i, 0, [snapshotTick - t, OWN_CAUSE.PULL, 0, 0]);
    evs.splice(i, 0, { tick: t, seq: -1, row: [OWN_CAUSE.PULL, 0, 0] });
    rep.ownStats.pullZero++;
  }
  out.own = rows;
  out.ownEvents = evs;
}
