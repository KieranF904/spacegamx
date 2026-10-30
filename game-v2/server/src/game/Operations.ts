/**
 * Operations: jobs that happen out in space rather than at a counter.
 *
 *   courier  a timed run to a station (Quests checks arrival and the clock; we show the timer)
 *   scan     fly close to derelict wrecks and hold steady while the sensors work
 *   escort   meet a freighter at a station and keep it alive until it docks at another;
 *            raiders ambush it along the way
 *   defend   an outpost near a station comes under attack in waves; keep it standing
 *   uplink   (fleet op) relay beacons a few kilometres apart charge only while every one
 *            of them has a pilot on it, so it takes a party; raiders try to break it up
 *   hold     (field task) hold steady inside a spot while a bar fills; leave and it drains;
 *            raiders may come to break it up
 *   course   (field task) a run through rings in order against the clock; out of time,
 *            back to the start
 *   recover  (field task) a container waits at a spot for you alone (guarded, sometimes):
 *            pull it aboard
 *   construct (field task) with a Constructor fitted, build a structure at a site piece by
 *            piece from the parts in your hold; what's built stays built
 *
 * An operation is shared by everyone in the party who holds the same job (solo
 * pilots run their own). It sizes its raids to the pilots taking part, and it
 * waits for them: wander off for too long and the freighter turns back, the
 * outpost's attackers pull out, and you can start again. A fleet op left with
 * too few pilots on it (the party broke up, someone gave up) is called off
 * unless they regroup in time.
 */

import type { Quests } from './Quests.js';
import type { PilotConn } from './Pilots.js';
import { mergeRules, texts, type RulesPatch, type StringsFile, type Texts } from '../data/rules.js';
import type { ServerMessage, OpView, OpMarkerView, QuestStep, QuestTarget } from '@space-game/common';

export interface OpsHost {
  tick(): number;
  now(): number;
  send(conn: PilotConn, msg: ServerMessage): void;
  toast(conn: PilotConn, text: string, kind?: 'info' | 'good' | 'warn' | 'bad'): void;
  /** The pilot's ship, if they're flying */
  pilot(conn: PilotConn): { system: string; x: number; y: number; vx: number; vy: number } | null;
  /** Where a station is now (they orbit) */
  station(id: string): { system: string; x: number; y: number; name: string } | null;
  stationName(id: string): string;
  derelicts(system: string): { eid: number; name: string; x: number; y: number }[];
  /** A pilotless ship players protect (hostiles go for it); returns its entity */
  spawnWard(kind: 'freighter' | 'outpost', system: string, x: number, y: number, angle: number, name: string): number;
  /** Fly a ward towards a point (null: hold) */
  steer(eid: number, to: { x: number; y: number; arrive: number } | null): void;
  removeWard(eid: number): void;
  /** Is this ship still there, where, and how whole (0..1) */
  shipAt(eid: number): { x: number; y: number; hull: number } | null;
  /** Hostiles sent at a point: returns their entities */
  spawnRaid(system: string, x: number, y: number, size: number, at: { x: number; y: number }): number[];
  /** Keep raiders heading for a (moving) point */
  sendRaid(eids: number[], at: { x: number; y: number }): void;
  hostileAlive(eid: number): boolean;
  removeHostile(eid: number): void;
  partyId(conn: PilotConn): number;
  /** Danger of a system (raid size) */
  danger(system: string): number;
  /** A container only this pilot can take (a field task's): its entity, or -1 */
  spawnCargo?(conn: PilotConn, system: string, x: number, y: number, items: Record<string, number>): number;
  /** Is this container still out there */
  podAlive?(eid: number): boolean;
  /** How many of an item the pilot has aboard */
  holds?(conn: PilotConn, item: string): number;
  /** Take items from the pilot's hold (all or none) */
  takeCargo?(conn: PilotConn, items: Record<string, number>): boolean;
  /** Has the pilot's ship a working part of this function fitted */
  fitted?(conn: PilotConn, fn: string): boolean;
}

/** A construct step as it stands for a pilot */
interface Build {
  status: 'away' | 'noTool' | 'noParts' | 'moving' | 'building';
  piece?: string;
  ticks: number;
}

/** A field task in progress, per pilot and job step */
interface Task {
  /** hold: ticks held; course: rings passed */
  ticks: number;
  ring: number;
  /** course: the tick the run runs out (0: not started) */
  deadline: number;
  raiders: number[];
  raided: boolean;
  pod: number;
  guarded: boolean;
}

type Kind = 'escort' | 'defend' | 'uplink';

interface Inst {
  key: string;
  quest: string;
  kind: Kind;
  title: string;
  system: string;
  phase: 'waiting' | 'running' | 'done';
  /** The defence site, uplink centre, or (escorts) where the freighter starts */
  site: { x: number; y: number };
  ward: number;
  wardName: string;
  raiders: number[];
  // defend
  wave: number;
  waves: number;
  nextWave: number;
  // escort
  to?: string;
  from?: string;
  ambushAt: number[];
  totalDist: number;
  // uplink
  beacons: { x: number; y: number }[];
  held: boolean[];
  charge: number;
  need: number;
  nextRaid: number;
  /** Last tick a pilot taking part was close enough */
  seen: number;
  /** When it finished (cleared away a little later) */
  doneAt: number;
  /** Fleet ops: since when it's had too few pilots on it (0: enough) */
  short: number;
  text: string;
}

const STEP = 15;
const SECOND = 60;

/** Operation tuning (data/rules.json `operations`; these are the defaults) */
export interface OpsRules {
  /** Scans: how close, how steady, how long (ticks) */
  scanRange: number;
  scanSpeed: number;
  scanTicks: number;
  /** Pilots further than this from an operation for this long: it stands down */
  awayRange: number;
  awaySeconds: number;
  /** A finished operation is cleared away this long after */
  doneSeconds: number;
  /** Raid size: base + floor(danger / dangerPer) (+ wave / defendWavesPer for defences) + extra pilots */
  raid: { base: number; dangerPer: number; defendWavesPer: number };
  escort: {
    /** Meet the freighter within this of the station; she launches this far out */
    meetRange: number;
    launchDistance: number;
    /** She slows to dock this far out, and the job's done within arriveRange */
    arrive: number;
    arriveRange: number;
    /** Ambushes spread from `ambushStart` over `ambushSpan` of the way; from this far out, this far off her heading */
    ambushStart: number;
    ambushSpan: number;
    ambushRing: number;
    ambushAngleMin: number;
    ambushAngleExtra: number;
    freighterNames: string[];
  };
  defend: { siteDistance: number; arriveRange: number; firstWaveSeconds: number; waveGapSeconds: number; ring: number };
  uplink: { siteDistance: number; beaconRing: number; holdRange: number; decay: number; raidGapSeconds: number; ring: number };
  /** Field tasks: how close is in, how still is steady, how fast leaving drains it (× the fill rate), where raiders come from */
  hold: { radius: number; speed: number; drain: number; raidRing: number };
  course: { startRange: number; ringRadius: number; spacing: number };
  recover: { appearRange: number; guardRing: number; markerRadius: number };
  /** Construction: how close, how still, seconds a piece, and the part that does it */
  construct: { range: number; speed: number; seconds: number; tool: string };
}

export const DEFAULT_OPS_RULES: OpsRules = {
  scanRange: 700,
  scanSpeed: 4,
  scanTicks: 150,
  awayRange: 12000,
  awaySeconds: 50,
  doneSeconds: 6,
  raid: { base: 2, dangerPer: 3, defendWavesPer: 2 },
  escort: {
    meetRange: 2600, launchDistance: 1100, arrive: 650, arriveRange: 1200,
    ambushStart: 0.18, ambushSpan: 0.62, ambushRing: 3600, ambushAngleMin: 0.6, ambushAngleExtra: 0.6,
    freighterNames: ['Ceres Dawn', 'Marigold', 'Long Haul', 'Quiet Ledger', 'Pale Mule', 'Brightwater'],
  },
  defend: { siteDistance: 4500, arriveRange: 3200, firstWaveSeconds: 8, waveGapSeconds: 10, ring: 3800 },
  uplink: { siteDistance: 5200, beaconRing: 2200, holdRange: 480, decay: 3, raidGapSeconds: 22, ring: 3400 },
  hold: { radius: 600, speed: 4, drain: 2, raidRing: 4200 },
  course: { startRange: 700, ringRadius: 320, spacing: 1700 },
  recover: { appearRange: 9000, guardRing: 2200, markerRadius: 450 },
  construct: { range: 700, speed: 6, seconds: 5, tool: 'constructor' },
};

/** Operation text (data/strings.json; these are the defaults) */
export const OPS_STRINGS = {
  'ops.relayBeacons': 'Relay beacons',
  'ops.outpost': 'Mining outpost',
  'ops.theFreighter': 'the freighter',
  'ops.courier.text': 'Deliver to {station}',
  'ops.scan.target': 'Scan {name}',
  'ops.scan.marker': 'Scan: {name}',
  'ops.scan.done': 'Scan complete: {name} ({n} of {count})',
  'ops.scan.progress': 'Scanning… {pct}% (hold steady)',
  'ops.scan.hint': 'Scan {n} more wreck{s}: fly within {range} m and hold still',
  'ops.escort.meet': 'Meet {ward} outside {station}',
  'ops.escort.meetMarker': 'Meet {ward}',
  'ops.escort.freighterName': '{kind} {name}',
  'ops.escort.freighter': 'Freighter',
  'ops.escort.heavyFreighter': 'Heavy freighter',
  'ops.escort.underWay': '{ward} is under way. Keep her alive!',
  'ops.escort.destroyed': '{ward} was destroyed',
  'ops.escort.ambush': 'Ambush! Raiders closing on {ward}',
  'ops.escort.ambushText': 'Ambush: {n} raider{s} on {ward}',
  'ops.escort.progress': 'Escorting to {station} · {km} km',
  'ops.escort.destination': 'Destination: {station}',
  'ops.escort.turnedBack': 'With no escort, {ward} turned back. Meet her at {station} again',
  'ops.defend.flyTo': 'Fly to the outpost',
  'ops.defend.inbound': 'Raiders inbound. First wave in {secs} seconds',
  'ops.defend.destroyed': 'The outpost was destroyed',
  'ops.defend.wave': 'Wave {wave} of {waves} · {n} raider{s} left',
  'ops.defend.broken': 'Wave {wave} broken. Next one in {secs} seconds',
  'ops.defend.next': 'Wave {wave} of {waves} in {secs}s',
  'ops.defend.incoming': 'Wave {wave} of {waves} incoming!',
  'ops.defend.abandoned': 'You left the outpost undefended. Head back to hold it again',
  'ops.uplink.jammers': 'Jammers inbound! Keep the beacons held',
  'ops.uplink.charging': 'Uplink charging · {pct}%',
  'ops.uplink.hold': 'Hold every beacon at once: {held} of {total} held',
  'ops.uplink.beacon': 'Beacon {letter}',
  'ops.fleet.short': '{op} needs {n} pilots. Regroup within {secs} seconds or it is called off',
  'ops.fleet.calledOff': 'Too few pilots stayed on it',
  'ops.hold.hint': 'Fly to {label} and hold steady for {secs}s',
  'ops.hold.progress': 'Holding… {pct}% (stay inside the ring, keep still)',
  'ops.hold.underFire': 'Under fire! {pct}%: hold on, or drive them off',
  'ops.hold.raid': 'Something heard you at {label}. Contacts inbound!',
  'ops.hold.done': 'Done at {label}',
  'ops.course.hint': 'Fly to {label} to start the run: {n} rings in {secs}s',
  'ops.course.start': 'Run started: {n} rings in {secs} seconds. Go!',
  'ops.course.ring': 'Ring {n} of {of}',
  'ops.course.progress': 'Ring {n} of {of}',
  'ops.course.failed': 'Out of time. Back to {label} to run it again',
  'ops.course.done': 'Run complete, with {secs}s to spare',
  'ops.recover.hint': 'Find it at {label} and fly into it to pull it aboard',
  'ops.recover.guarded': 'It\'s guarded: deal with them, then pull it aboard',
  'ops.recover.done': 'Recovered from {label}',
  'construct.away': 'Fly to {label} with its parts in your hold: {n} of {of} built',
  'construct.noTool': 'Fit a Constructor to your ship to build here (station: Ships)',
  'construct.noParts': 'Out of parts. Still to build: {need}',
  'construct.moving': 'Hold steady to build',
  'construct.building': 'Constructing the {piece}… {pct}%',
  'construct.piece': '{piece} built ({n} of {of})',
  'construct.done': '{label} complete',
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class Operations {
  private insts = new Map<string, Inst>();
  /** Scans in progress: pilot → wreck and how long they've held on it */
  private scanning = new Map<PilotConn, { wreck: number; ticks: number }>();
  /** Field tasks in progress (hold, course, recover), by pilot, job and step */
  private tasks = new Map<string, Task>();
  /** Construction in progress, by pilot, job and step: what's holding it up, or the piece going on */
  private building = new Map<string, Build>();
  /** Pilots we sent operations to last time (so they get an empty list when they're done) */
  private shown = new Set<PilotConn>();
  private rand = 1;

  readonly rules: OpsRules;
  private t: Texts<keyof typeof OPS_STRINGS>;

  /** `rules`: data/rules.json `operations` (over the defaults); `strings`: data/strings.json */
  constructor(private host: OpsHost, private quests: Quests, private connections: () => PilotConn[], rules?: RulesPatch<OpsRules>, strings?: StringsFile) {
    this.rules = mergeRules(DEFAULT_OPS_RULES, rules);
    this.t = texts(OPS_STRINGS, strings);
  }

  private rng(): number {
    this.rand = (Math.imul(this.rand, 1103515245) + 12345) >>> 0;
    return this.rand / 4294967296;
  }

  private keyOf(conn: PilotConn, quest: string): string {
    const party = this.host.partyId(conn);
    return party ? `p${party}:${quest}` : `u${conn.username}:${quest}`;
  }

  /** Raiders in a pack: base + floor(danger / dangerPer) */
  private raidSize(system: string): number {
    const r = this.rules.raid;
    return r.base + Math.floor(this.host.danger(system) / r.dangerPer);
  }

  tick(): void {
    const now = this.host.tick();
    if (now % STEP) return;
    // Who's doing what
    const groups = new Map<string, { kind: Kind; quest: string; title: string; step: QuestStep; need: number; conns: PilotConn[] }>();
    for (const conn of this.connections()) {
      for (const op of this.quests.opSteps(conn)) {
        if (op.step.type === 'scan') { this.stepScan(conn, op.id, op.step, op.state.data); continue; }
        if (op.step.type === 'hold' || op.step.type === 'course' || op.step.type === 'recover') { this.stepTask(conn, op.id, op.state.stage, op.step); continue; }
        if (op.step.type === 'construct') { this.stepConstruct(conn, op.id, op.state, op.step); continue; }
        if (op.step.type === 'courier') continue;
        const key = this.keyOf(conn, op.id);
        const g = groups.get(key) ?? { kind: op.step.type as Kind, quest: op.id, title: op.q.name, step: op.step, need: op.q.party ?? 0, conns: [] };
        g.conns.push(conn);
        groups.set(key, g);
      }
    }
    for (const [key, g] of groups) {
      let inst = this.insts.get(key);
      if (!inst) {
        inst = this.create(key, g.kind, g.quest, g.title, g.step) ?? undefined;
        if (!inst) continue;
        this.insts.set(key, inst);
        // Their job markers can point at the site now
        for (const c of g.conns) this.quests.send(c);
      }
      if (this.shortHanded(inst, g.title, g.need, g.conns)) continue;
      const phase = inst.phase;
      this.drive(inst, g.step, g.conns);
      if (inst.phase !== phase && inst.phase !== 'done') for (const c of g.conns) this.quests.send(c);
    }
    // Operations nobody holds any more (abandoned, party changed): clear them away
    const linger = this.rules.doneSeconds * SECOND;
    for (const [key, inst] of this.insts) {
      if (!groups.has(key) && (inst.phase !== 'done' || now - inst.doneAt > linger)) this.dispose(inst);
      else if (inst.phase === 'done' && now - inst.doneAt > linger) this.dispose(inst);
    }
    // Field tasks nobody's on any more
    if (now % (SECOND * 5) === 0) {
      const live = new Set<string>();
      for (const conn of this.connections()) for (const op of this.quests.opSteps(conn)) live.add(this.taskKey(conn, op.id, op.state.stage));
      for (const [k, t] of this.tasks) if (!live.has(k)) { this.clearTask(t); this.tasks.delete(k); }
    }
    if (now % 30 === 0) this.sendViews();
  }

  /** Where an operation step is happening (quest marker and autopilot) */
  target(conn: PilotConn, quest: string): QuestTarget | undefined {
    const inst = this.insts.get(this.keyOf(conn, quest));
    if (!inst) {
      const op = this.quests.opSteps(conn).find((o) => o.id === quest);
      if (op?.step.type === 'scan') {
        const w = this.nextWreck(conn, op.step.system, op.state.data);
        return w ? { system: op.step.system, x: w.x, y: w.y, label: this.t('ops.scan.target', { name: w.name }) } : undefined;
      }
      if (op && (op.step.type === 'hold' || op.step.type === 'recover' || op.step.type === 'construct')) return { system: op.step.system, x: op.step.x, y: op.step.y, label: op.step.label };
      if (op?.step.type === 'course') {
        const t = this.tasks.get(this.taskKey(conn, op.id, op.state.stage));
        const at = t && t.deadline ? this.ringsOf(op.id, op.step)[t.ring] : null;
        return at ? { system: op.step.system, x: at.x, y: at.y, label: this.t('ops.course.ring', { n: t!.ring + 1, of: op.step.rings }) } : { system: op.step.system, x: op.step.x, y: op.step.y, label: op.step.label };
      }
      return undefined;
    }
    if (inst.kind === 'escort' && inst.phase === 'running') {
      const at = this.host.shipAt(inst.ward);
      if (at) return { system: inst.system, x: at.x, y: at.y, label: inst.wardName };
    }
    if (inst.kind === 'escort') return undefined;
    return { system: inst.system, x: inst.site.x, y: inst.site.y, label: inst.kind === 'uplink' ? this.t('ops.relayBeacons') : this.t('ops.outpost') };
  }

  // ---------------------------------------------------------------------------
  // Scans
  // ---------------------------------------------------------------------------

  private nextWreck(conn: PilotConn, system: string, data: Record<string, number | string | boolean> | undefined) {
    const me = this.host.pilot(conn);
    const left = this.host.derelicts(system).filter((w) => !data?.[`w:${w.name}`]);
    if (!me || me.system !== system) return left[0];
    left.sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
    return left[0];
  }

  private stepScan(conn: PilotConn, quest: string, step: Extract<QuestStep, { type: 'scan' }>, data: Record<string, number | string | boolean> | undefined): void {
    const me = this.host.pilot(conn);
    if (!me || me.system !== step.system) { this.scanning.delete(conn); return; }
    let near: { eid: number; name: string } | null = null;
    for (const w of this.host.derelicts(step.system)) {
      if (data?.[`w:${w.name}`]) continue;
      if (Math.hypot(w.x - me.x, w.y - me.y) < this.rules.scanRange) { near = w; break; }
    }
    const steady = Math.hypot(me.vx, me.vy) < this.rules.scanSpeed;
    if (!near || !steady) {
      const cur = this.scanning.get(conn);
      if (cur && near && cur.wreck === near.eid) return; // drifting a little: keep the progress, don't add to it
      this.scanning.delete(conn);
      return;
    }
    const cur = this.scanning.get(conn);
    const ticks = (cur?.wreck === near.eid ? cur.ticks : 0) + STEP;
    if (ticks < this.rules.scanTicks) { this.scanning.set(conn, { wreck: near.eid, ticks }); return; }
    this.scanning.delete(conn);
    const p = this.quests.opSteps(conn).find((o) => o.id === quest);
    if (!p) return;
    p.state.data = { ...(p.state.data ?? {}), [`w:${near.name}`]: true };
    this.host.toast(conn, this.t('ops.scan.done', { name: near.name, n: p.state.progress + 1, count: step.count }), 'good');
    this.quests.opCount(conn, quest, 1);
  }

  // ---------------------------------------------------------------------------
  // Field tasks: hold, course, recover
  // ---------------------------------------------------------------------------

  private taskKey(conn: PilotConn, quest: string, stage: number): string {
    return `${conn.username}:${quest}:${stage}`;
  }

  private clearTask(t: Task): void {
    for (const r of t.raiders) if (this.host.hostileAlive(r)) this.host.removeHostile(r);
    t.raiders = [];
  }

  /** A course's rings: a winding line out from its start, the same every time for this job */
  private ringsOf(quest: string, step: Extract<QuestStep, { type: 'course' }>): { x: number; y: number }[] {
    let h = hash(quest), a = (h % 6283) / 1000;
    const out: { x: number; y: number }[] = [];
    let x = step.x, y = step.y;
    for (let i = 0; i < step.rings; i++) {
      h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
      a += ((i % 2 ? 1 : -1) * (0.5 + ((h % 1000) / 1000) * 0.7));
      const d = step.spacing ?? this.rules.course.spacing;
      x += Math.cos(a) * d; y += Math.sin(a) * d;
      out.push({ x: Math.round(x), y: Math.round(y) });
    }
    return out;
  }

  private stepTask(conn: PilotConn, quest: string, stage: number, step: Extract<QuestStep, { type: 'hold' | 'course' | 'recover' }>): void {
    const key = this.taskKey(conn, quest, stage);
    let t = this.tasks.get(key);
    if (!t) this.tasks.set(key, (t = { ticks: 0, ring: 0, deadline: 0, raiders: [], raided: false, pod: -1, guarded: false }));
    t.raiders = t.raiders.filter((r) => this.host.hostileAlive(r));
    const me = this.host.pilot(conn);
    const now = this.host.tick();
    const R = this.rules;
    if (step.type === 'recover') {
      // Already aboard (picked up, or carried over): done
      if ((this.host.holds?.(conn, step.item) ?? 0) > 0) { this.finishTask(conn, quest, key, t, this.t('ops.recover.done', { label: step.label })); return; }
      if (!me || me.system !== step.system || Math.hypot(me.x - step.x, me.y - step.y) > R.recover.appearRange) return;
      if (t.pod < 0 || !this.host.podAlive?.(t.pod)) t.pod = this.host.spawnCargo?.(conn, step.system, step.x, step.y, { [step.item]: 1 }) ?? -1;
      if (step.guard && !t.guarded) {
        t.guarded = true;
        const a = this.rng() * Math.PI * 2;
        t.raiders = this.host.spawnRaid(step.system, step.x + Math.cos(a) * R.recover.guardRing, step.y + Math.sin(a) * R.recover.guardRing, step.guard, { x: step.x, y: step.y });
      }
      return;
    }
    if (!me || me.system !== step.system) return;
    if (step.type === 'hold') {
      const r = step.radius ?? R.hold.radius;
      const inside = Math.hypot(me.x - step.x, me.y - step.y) < r;
      const steady = Math.hypot(me.vx, me.vy) < R.hold.speed;
      if (inside && steady) t.ticks += STEP;
      else if (!inside) t.ticks = Math.max(0, t.ticks - STEP * R.hold.drain);
      // Once you've started, whatever doesn't want it done comes for you
      if (inside && t.ticks > 0 && step.raid && !t.raided) {
        t.raided = true;
        const a = this.rng() * Math.PI * 2;
        t.raiders = this.host.spawnRaid(step.system, step.x + Math.cos(a) * R.hold.raidRing, step.y + Math.sin(a) * R.hold.raidRing, step.raid, { x: step.x, y: step.y });
        this.host.toast(conn, this.t('ops.hold.raid', { label: step.label }), 'warn');
      }
      if (t.ticks >= step.seconds * SECOND) this.finishTask(conn, quest, key, t, this.t('ops.hold.done', { label: step.label }));
      return;
    }
    // A course: start at its spot, then each ring in turn before the clock runs out
    const rings = this.ringsOf(quest, step);
    if (!t.deadline) {
      if (Math.hypot(me.x - step.x, me.y - step.y) < R.course.startRange) {
        t.deadline = now + step.seconds * SECOND;
        t.ring = 0;
        this.host.toast(conn, this.t('ops.course.start', { n: step.rings, secs: step.seconds }), 'info');
        this.quests.send(conn);
      }
      return;
    }
    const next = rings[t.ring];
    if (next && Math.hypot(me.x - next.x, me.y - next.y) < R.course.ringRadius) {
      t.ring++;
      if (t.ring >= rings.length) { this.finishTask(conn, quest, key, t, this.t('ops.course.done', { secs: Math.max(0, Math.round((t.deadline - now) / SECOND)) })); return; }
      this.quests.send(conn);
    }
    if (now > t.deadline) {
      t.deadline = 0;
      t.ring = 0;
      this.host.toast(conn, this.t('ops.course.failed', { label: step.label }), 'warn');
      this.quests.send(conn);
    }
  }

  /**
   * A structure going up: close by, a Constructor fitted, keeping fairly still,
   * the next piece whose part is in the hold is built over `seconds` (the part
   * used up as it goes on). Each piece is kept in the job's state.
   */
  private stepConstruct(conn: PilotConn, quest: string, state: { stage: number; data?: Record<string, number | string | boolean> }, step: Extract<QuestStep, { type: 'construct' }>): void {
    const key = this.taskKey(conn, quest, state.stage);
    const me = this.host.pilot(conn);
    const R = this.rules.construct;
    const status = (s: Build['status'], piece?: string, ticks = 0) => this.building.set(key, { status: s, piece, ticks });
    const cur = this.building.get(key);
    if (!me || me.system !== step.system || Math.hypot(me.x - step.x, me.y - step.y) > R.range) { status('away'); return; }
    if (!this.host.fitted?.(conn, R.tool)) { status('noTool'); return; }
    const left = step.pieces.filter((pc) => !state.data?.[`b:${pc.id}`]);
    const next = left.find((pc) => (this.host.holds?.(conn, pc.item) ?? 0) > 0);
    if (!next) { status('noParts'); return; }
    if (Math.hypot(me.vx, me.vy) > R.speed) { status('moving', next.id, cur?.piece === next.id ? cur.ticks : 0); return; }
    const ticks = (cur?.piece === next.id ? cur.ticks : 0) + STEP;
    if (ticks < (step.seconds ?? R.seconds) * SECOND) { status('building', next.id, ticks); return; }
    // The piece goes on
    if (!this.host.takeCargo?.(conn, { [next.item]: 1 })) { status('noParts'); return; }
    state.data = { ...(state.data ?? {}), [`b:${next.id}`]: true };
    const built = step.pieces.length - left.length + 1;
    this.building.delete(key);
    if (built >= step.pieces.length) {
      this.host.toast(conn, this.t('construct.done', { label: step.label }), 'good');
      this.quests.opAdvance(conn, quest);
      return;
    }
    this.host.toast(conn, this.t('construct.piece', { piece: next.name, n: built, of: step.pieces.length }), 'good');
    this.quests.markDirty(conn);
    this.quests.send(conn);
  }

  private finishTask(conn: PilotConn, quest: string, key: string, t: Task, text: string): void {
    this.clearTask(t);
    this.tasks.delete(key);
    this.host.toast(conn, text, 'good');
    this.quests.opAdvance(conn, quest);
  }

  /** A field task's card and rings */
  private taskView(conn: PilotConn, op: { id: string; q: { name: string }; state: { stage: number }; step: Extract<QuestStep, { type: 'hold' | 'course' | 'recover' }> }): OpView {
    const s = op.step, R = this.rules;
    const t = this.tasks.get(this.taskKey(conn, op.id, op.state.stage));
    const danger = !!t?.raiders.length;
    if (s.type === 'hold') {
      const r = s.radius ?? R.hold.radius;
      const pct = Math.min(1, (t?.ticks ?? 0) / (s.seconds * SECOND));
      const text = danger ? this.t('ops.hold.underFire', { pct: Math.round(pct * 100) }) : pct > 0 ? this.t('ops.hold.progress', { pct: Math.round(pct * 100) }) : this.t('ops.hold.hint', { label: s.label, secs: s.seconds });
      return { quest: op.id, kind: 'hold', title: op.q.name, text, progress: pct, system: s.system, markers: [{ x: s.x, y: s.y, r, label: s.label, state: danger ? 'danger' : pct > 0 ? 'active' : 'idle' }] };
    }
    if (s.type === 'recover') {
      const text = danger ? this.t('ops.recover.guarded', { label: s.label }) : this.t('ops.recover.hint', { label: s.label });
      return { quest: op.id, kind: 'recover', title: op.q.name, text, progress: 0, system: s.system, markers: [{ x: s.x, y: s.y, r: R.recover.markerRadius, label: s.label, state: danger ? 'danger' : 'idle' }] };
    }
    const rings = this.ringsOf(op.id, s);
    if (!t?.deadline) {
      return { quest: op.id, kind: 'course', title: op.q.name, text: this.t('ops.course.hint', { label: s.label, n: s.rings, secs: s.seconds }), progress: 0, system: s.system,
        markers: [{ x: s.x, y: s.y, r: R.course.startRange, label: s.label, state: 'idle' }] };
    }
    const left = Math.max(0, Math.ceil((t.deadline - this.host.tick()) / SECOND));
    const markers: OpMarkerView[] = [];
    for (let i = t.ring; i < Math.min(rings.length, t.ring + 2); i++) markers.push({ x: rings[i].x, y: rings[i].y, r: R.course.ringRadius, label: this.t('ops.course.ring', { n: i + 1, of: s.rings }), state: i === t.ring ? 'active' : 'idle' });
    return { quest: op.id, kind: 'course', title: op.q.name, text: this.t('ops.course.progress', { n: t.ring + 1, of: s.rings }), progress: t.ring / s.rings, system: s.system, markers, timer: left };
  }

  // ---------------------------------------------------------------------------
  // Escorts, defences and uplinks
  // ---------------------------------------------------------------------------

  private create(key: string, kind: Kind, quest: string, title: string, step: QuestStep): Inst | null {
    const near = step.type === 'escort' ? step.from : step.type === 'defend' || step.type === 'uplink' ? step.near : '';
    const st = this.host.station(near);
    if (!st) return null;
    const a = (hash(quest) % 6283) / 1000;
    const inst: Inst = {
      key, quest, kind, title, system: st.system, phase: 'waiting', site: { x: st.x, y: st.y }, ward: -1, wardName: '', raiders: [],
      wave: 0, waves: step.type === 'defend' ? step.waves : 0, nextWave: 0,
      ambushAt: [], totalDist: 0, beacons: [], held: [], charge: 0, need: 0, nextRaid: 0,
      seen: this.host.tick(), doneAt: 0, short: 0, text: '',
    };
    if (step.type === 'escort') { inst.from = step.from; inst.to = step.to; }
    if (step.type === 'defend') {
      const d = this.rules.defend.siteDistance;
      inst.site = { x: st.x + Math.cos(a) * d, y: st.y + Math.sin(a) * d };
    }
    if (step.type === 'uplink') {
      const U = this.rules.uplink;
      inst.site = { x: st.x + Math.cos(a) * U.siteDistance, y: st.y + Math.sin(a) * U.siteDistance };
      for (let i = 0; i < step.beacons; i++) {
        const b = a + Math.PI / 2 + (i / step.beacons) * Math.PI * 2;
        inst.beacons.push({ x: inst.site.x + Math.cos(b) * U.beaconRing, y: inst.site.y + Math.sin(b) * U.beaconRing });
      }
      inst.held = inst.beacons.map(() => false);
      inst.need = step.seconds * 60;
      inst.phase = 'running';
    }
    return inst;
  }

  private drive(inst: Inst, step: QuestStep, conns: PilotConn[]): void {
    const now = this.host.tick();
    if (inst.phase === 'done') return;
    const here = conns.map((c) => ({ c, p: this.host.pilot(c) })).filter((x) => x.p && x.p.system === inst.system) as { c: PilotConn; p: NonNullable<ReturnType<OpsHost['pilot']>> }[];
    const centre = inst.kind === 'escort' && inst.phase === 'running' ? this.host.shipAt(inst.ward) ?? inst.site : inst.site;
    if (here.some((x) => Math.hypot(x.p.x - centre.x, x.p.y - centre.y) < this.rules.awayRange)) inst.seen = now;
    const size = Math.max(1, conns.length);
    if (inst.kind === 'escort') this.driveEscort(inst, step as Extract<QuestStep, { type: 'escort' }>, conns, here, size);
    else if (inst.kind === 'defend') this.driveDefend(inst, conns, here, size);
    else this.driveUplink(inst, conns, here, size);
  }

  private driveEscort(inst: Inst, step: Extract<QuestStep, { type: 'escort' }>, conns: PilotConn[], here: { c: PilotConn; p: { x: number; y: number } }[], size: number): void {
    const now = this.host.tick();
    const E = this.rules.escort;
    const from = this.host.station(step.from), to = this.host.station(step.to);
    if (!from || !to) return;
    const ward = step.ward ?? this.t('ops.theFreighter');
    if (inst.phase === 'waiting') {
      inst.site = { x: from.x, y: from.y };
      // A job's own ship (Dr. Osei's shuttle) has its name; bounty freighters get one
      inst.wardName = step.ward ?? '';
      inst.text = this.t('ops.escort.meet', { ward, station: from.name });
      if (!here.some((x) => Math.hypot(x.p.x - from.x, x.p.y - from.y) < E.meetRange)) return;
      const ang = Math.atan2(to.y - from.y, to.x - from.x);
      inst.wardName = step.ward ?? this.t('ops.escort.freighterName', {
        kind: size > 1 ? this.t('ops.escort.heavyFreighter') : this.t('ops.escort.freighter'),
        name: E.freighterNames[hash(inst.quest) % E.freighterNames.length],
      });
      inst.ward = this.host.spawnWard('freighter', inst.system, from.x + Math.cos(ang) * E.launchDistance, from.y + Math.sin(ang) * E.launchDistance, ang, inst.wardName);
      inst.totalDist = Math.hypot(to.x - from.x, to.y - from.y);
      inst.ambushAt = Array.from({ length: step.ambushes }, (_, i) => E.ambushStart + (E.ambushSpan * (i + 0.5)) / step.ambushes);
      inst.phase = 'running';
      inst.seen = now;
      for (const c of conns) this.host.toast(c, this.t('ops.escort.underWay', { ward: inst.wardName }), 'info');
      return;
    }
    const at = this.host.shipAt(inst.ward);
    if (!at) return this.finish(inst, conns, false, this.t('ops.escort.destroyed', { ward: inst.wardName }));
    const dist = Math.hypot(to.x - at.x, to.y - at.y);
    this.host.steer(inst.ward, { x: to.x, y: to.y, arrive: E.arrive });
    inst.raiders = inst.raiders.filter((e) => this.host.hostileAlive(e));
    if (inst.raiders.length) this.host.sendRaid(inst.raiders, at);
    const progress = Math.max(0, Math.min(1, 1 - dist / Math.max(1, inst.totalDist)));
    if (inst.ambushAt.length && progress >= inst.ambushAt[0]) {
      inst.ambushAt.shift();
      const dir = Math.atan2(to.y - at.y, to.x - at.x) + (this.rng() < 0.5 ? -1 : 1) * (E.ambushAngleMin + this.rng() * E.ambushAngleExtra);
      const n = this.raidSize(inst.system) + (size - 1);
      inst.raiders.push(...this.host.spawnRaid(inst.system, at.x + Math.cos(dir) * E.ambushRing, at.y + Math.sin(dir) * E.ambushRing, n, at));
      for (const c of conns) this.host.toast(c, this.t('ops.escort.ambush', { ward }), 'warn');
    }
    const n = inst.raiders.length;
    inst.text = n ? this.t('ops.escort.ambushText', { n, s: n > 1 ? 's' : '', ward }) : this.t('ops.escort.progress', { station: to.name, km: (dist / 1000).toFixed(1) });
    if (dist < E.arriveRange) {
      this.finish(inst, conns, true);
      return;
    }
    if (now - inst.seen > this.rules.awaySeconds * SECOND) {
      // Nobody's with her: she turns back to dock and waits for you
      this.host.removeWard(inst.ward);
      inst.ward = -1;
      for (const e of inst.raiders) this.host.removeHostile(e);
      inst.raiders = [];
      inst.phase = 'waiting';
      for (const c of conns) this.host.toast(c, this.t('ops.escort.turnedBack', { ward: inst.wardName, station: from.name }), 'warn');
    }
  }

  private driveDefend(inst: Inst, conns: PilotConn[], here: { c: PilotConn; p: { x: number; y: number } }[], size: number): void {
    const now = this.host.tick();
    const D = this.rules.defend;
    if (inst.phase === 'waiting') {
      inst.text = this.t('ops.defend.flyTo');
      if (!here.some((x) => Math.hypot(x.p.x - inst.site.x, x.p.y - inst.site.y) < D.arriveRange)) return;
      inst.wardName = this.t('ops.outpost');
      inst.ward = this.host.spawnWard('outpost', inst.system, inst.site.x, inst.site.y, 0, inst.wardName);
      inst.phase = 'running';
      inst.wave = 0;
      inst.nextWave = now + SECOND * D.firstWaveSeconds;
      for (const c of conns) this.host.toast(c, this.t('ops.defend.inbound', { secs: D.firstWaveSeconds }), 'warn');
      return;
    }
    if (!this.host.shipAt(inst.ward)) return this.finish(inst, conns, false, this.t('ops.defend.destroyed'));
    inst.raiders = inst.raiders.filter((e) => this.host.hostileAlive(e));
    if (inst.raiders.length) {
      this.host.sendRaid(inst.raiders, inst.site);
      const n = inst.raiders.length;
      inst.text = this.t('ops.defend.wave', { wave: inst.wave, waves: inst.waves, n, s: n > 1 ? 's' : '' });
    } else if (inst.wave >= inst.waves) {
      return this.finish(inst, conns, true);
    } else {
      if (inst.nextWave === Infinity) {
        inst.nextWave = now + SECOND * D.waveGapSeconds;
        for (const c of conns) this.host.toast(c, this.t('ops.defend.broken', { wave: inst.wave, secs: D.waveGapSeconds }), 'good');
      }
      inst.text = this.t('ops.defend.next', { wave: inst.wave + 1, waves: inst.waves, secs: Math.max(0, Math.ceil((inst.nextWave - now) / 60)) });
      if (now >= inst.nextWave) {
        inst.wave++;
        inst.nextWave = Infinity;
        const a = this.rng() * Math.PI * 2;
        const n = this.rules.raid.base + Math.floor(inst.wave / this.rules.raid.defendWavesPer) + Math.floor(this.host.danger(inst.system) / this.rules.raid.dangerPer) + (size - 1);
        inst.raiders = this.host.spawnRaid(inst.system, inst.site.x + Math.cos(a) * D.ring, inst.site.y + Math.sin(a) * D.ring, n, inst.site);
        for (const c of conns) this.host.toast(c, this.t('ops.defend.incoming', { wave: inst.wave, waves: inst.waves }), 'warn');
      }
    }
    if (now - inst.seen > this.rules.awaySeconds * SECOND) {
      // Left it to its fate: the raiders pull out, the outpost waits for you to come back
      for (const e of inst.raiders) this.host.removeHostile(e);
      this.host.removeWard(inst.ward);
      Object.assign(inst, { ward: -1, raiders: [], wave: 0, phase: 'waiting' });
      for (const c of conns) this.host.toast(c, this.t('ops.defend.abandoned'), 'warn');
    }
  }

  private driveUplink(inst: Inst, conns: PilotConn[], here: { c: PilotConn; p: { x: number; y: number } }[], size: number): void {
    const now = this.host.tick();
    const U = this.rules.uplink;
    inst.held = inst.beacons.map((b) => here.some((x) => Math.hypot(x.p.x - b.x, x.p.y - b.y) < U.holdRange));
    const all = inst.held.every(Boolean);
    inst.charge = all ? inst.charge + STEP : Math.max(0, inst.charge - STEP / U.decay);
    inst.raiders = inst.raiders.filter((e) => this.host.hostileAlive(e));
    if (inst.charge > 0 && now >= inst.nextRaid) {
      inst.nextRaid = now + SECOND * U.raidGapSeconds;
      const b = inst.beacons[Math.floor(this.rng() * inst.beacons.length)];
      const a = this.rng() * Math.PI * 2;
      const n = this.raidSize(inst.system) + Math.max(0, size - 2);
      inst.raiders.push(...this.host.spawnRaid(inst.system, b.x + Math.cos(a) * U.ring, b.y + Math.sin(a) * U.ring, n, b));
      for (const c of conns) this.host.toast(c, this.t('ops.uplink.jammers'), 'warn');
    }
    const heldN = inst.held.filter(Boolean).length;
    inst.text = all ? this.t('ops.uplink.charging', { pct: Math.floor((inst.charge / inst.need) * 100) }) : this.t('ops.uplink.hold', { held: heldN, total: inst.beacons.length });
    if (inst.charge >= inst.need) this.finish(inst, conns, true);
  }

  /** A fleet op with fewer pilots on it than it needs: a grace period, then it's called off */
  private shortHanded(inst: Inst, title: string, need: number, conns: PilotConn[]): boolean {
    if (inst.phase === 'done' || conns.length >= need) { inst.short = 0; return false; }
    const now = this.host.tick();
    if (!inst.short) {
      inst.short = now;
      for (const c of conns) this.host.toast(c, this.t('ops.fleet.short', { op: title, n: need, secs: this.rules.awaySeconds }), 'warn');
    } else if (now - inst.short > this.rules.awaySeconds * SECOND) {
      this.finish(inst, conns, false, this.t('ops.fleet.calledOff'));
      return true;
    }
    return false;
  }

  private finish(inst: Inst, conns: PilotConn[], ok: boolean, why = ''): void {
    inst.phase = 'done';
    inst.doneAt = this.host.tick();
    if (inst.ward >= 0 && !ok) inst.ward = -1;
    for (const c of conns) {
      if (ok) this.quests.opAdvance(c, inst.quest);
      else this.quests.fail(c, inst.quest, why);
    }
    this.sendViews();
  }

  private dispose(inst: Inst): void {
    if (inst.ward >= 0) this.host.removeWard(inst.ward);
    for (const e of inst.raiders) if (this.host.hostileAlive(e)) this.host.removeHostile(e);
    this.insts.delete(inst.key);
  }

  // ---------------------------------------------------------------------------
  // What each pilot sees
  // ---------------------------------------------------------------------------

  private sendViews(): void {
    for (const conn of this.connections()) {
      const ops = this.views(conn);
      if (!ops.length && !this.shown.has(conn)) continue;
      if (ops.length) this.shown.add(conn); else this.shown.delete(conn);
      this.host.send(conn, { type: 'ops', ops });
    }
  }

  views(conn: PilotConn): OpView[] {
    const out: OpView[] = [];
    const R = this.rules;
    for (const op of this.quests.opSteps(conn)) {
      const s = op.step;
      if (s.type === 'courier') {
        const left = Math.max(0, Math.ceil((Number(op.state.data?.since ?? 0) + s.seconds * 1000 - this.host.now()) / 1000));
        const st = this.host.station(s.station);
        out.push({ quest: op.id, kind: 'courier', title: op.q.name, text: this.t('ops.courier.text', { station: this.host.stationName(s.station) }), progress: 1 - left / s.seconds, system: st?.system ?? '', markers: [], timer: left });
        continue;
      }
      if (s.type === 'hold' || s.type === 'course' || s.type === 'recover') {
        out.push(this.taskView(conn, { ...op, step: s }));
        continue;
      }
      if (s.type === 'construct') {
        const b = this.building.get(this.taskKey(conn, op.id, op.state.stage));
        const built = s.pieces.filter((pc) => op.state.data?.[`b:${pc.id}`]);
        const left = s.pieces.filter((pc) => !op.state.data?.[`b:${pc.id}`]);
        const piece = s.pieces.find((pc) => pc.id === b?.piece);
        const need = left.map((pc) => pc.name).join(', ');
        const text = !b || b.status === 'away' ? this.t('construct.away', { label: s.label, n: built.length, of: s.pieces.length })
          : b.status === 'noTool' ? this.t('construct.noTool')
          : b.status === 'noParts' ? this.t('construct.noParts', { need })
          : b.status === 'moving' ? this.t('construct.moving')
          : this.t('construct.building', { piece: piece?.name ?? '', pct: Math.round((b.ticks / ((s.seconds ?? R.construct.seconds) * SECOND)) * 100) });
        out.push({ quest: op.id, kind: 'construct', title: op.q.name, text, progress: built.length / s.pieces.length, system: s.system,
          markers: [{ x: s.x, y: s.y, r: R.construct.range, label: s.label, state: b?.status === 'building' ? 'active' : 'idle' }] });
        continue;
      }
      if (s.type === 'scan') {
        const cur = this.scanning.get(conn);
        const markers: OpMarkerView[] = this.host.derelicts(s.system).filter((w) => !op.state.data?.[`w:${w.name}`])
          .map((w) => ({ x: Math.round(w.x), y: Math.round(w.y), r: R.scanRange, label: this.t('ops.scan.marker', { name: w.name }), state: cur?.wreck === w.eid ? 'active' : 'idle' }));
        const more = s.count - op.state.progress;
        const text = cur ? this.t('ops.scan.progress', { pct: Math.round((cur.ticks / R.scanTicks) * 100) }) : this.t('ops.scan.hint', { n: more, s: more > 1 ? 's' : '', range: R.scanRange });
        out.push({ quest: op.id, kind: 'scan', title: op.q.name, text, progress: op.state.progress / s.count, system: s.system, markers });
        continue;
      }
      const inst = this.insts.get(this.keyOf(conn, op.id));
      if (!inst) continue;
      const markers: OpMarkerView[] = [];
      let ward: OpView['ward'];
      let progress = 0;
      if (inst.kind === 'escort') {
        const at = inst.phase === 'running' ? this.host.shipAt(inst.ward) : null;
        if (at) {
          ward = { eid: inst.ward, name: inst.wardName, hull: Math.round(at.hull * 100) };
          markers.push({ x: Math.round(at.x), y: Math.round(at.y), r: 0, label: inst.wardName, state: inst.raiders.length ? 'danger' : 'active' });
          const to = inst.to ? this.host.station(inst.to) : null;
          if (to) {
            markers.push({ x: Math.round(to.x), y: Math.round(to.y), r: R.escort.arriveRange, label: this.t('ops.escort.destination', { station: to.name }), state: 'idle' });
            progress = Math.max(0, Math.min(1, 1 - Math.hypot(to.x - at.x, to.y - at.y) / Math.max(1, inst.totalDist)));
          }
        } else {
          markers.push({ x: Math.round(inst.site.x), y: Math.round(inst.site.y), r: R.escort.meetRange, label: this.t('ops.escort.meetMarker', { ward: inst.wardName || this.t('ops.theFreighter') }), state: 'idle' });
        }
      } else if (inst.kind === 'defend') {
        const at = inst.phase === 'running' ? this.host.shipAt(inst.ward) : null;
        if (at) ward = { eid: inst.ward, name: inst.wardName, hull: Math.round(at.hull * 100) };
        markers.push({ x: Math.round(inst.site.x), y: Math.round(inst.site.y), r: R.defend.arriveRange, label: this.t('ops.outpost'), state: inst.raiders.length ? 'danger' : inst.phase === 'running' ? 'active' : 'idle' });
        progress = inst.waves ? (inst.wave - (inst.raiders.length ? 1 : 0)) / inst.waves : 0;
      } else {
        inst.beacons.forEach((b, i) => markers.push({ x: Math.round(b.x), y: Math.round(b.y), r: R.uplink.holdRange, label: this.t('ops.uplink.beacon', { letter: String.fromCharCode(65 + i) }), state: inst.held[i] ? 'active' : 'idle' }));
        progress = inst.need ? inst.charge / inst.need : 0;
      }
      if (inst.phase === 'done') continue;
      out.push({ quest: op.id, kind: inst.kind, title: inst.title, text: inst.text, progress, system: inst.system, markers, ward });
    }
    return out;
  }
}
