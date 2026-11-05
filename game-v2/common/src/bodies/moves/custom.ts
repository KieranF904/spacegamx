/**
 * Custom enemies' moves (docs/enemies/custom-roster.md), the same on both sides (decision-inputs stage 4): when each may
 * start (`pick`: the commander's, the server's alone) and what each step of it does (`step`: k ticks into the move its
 * order carries, from its move, argument and seed). The server runs a step for real; a client running the ship's body
 * (CAPS.PILOTS) runs it from the same order and draws its tells, beams, strikes' looks and straight shots instead of
 * being sent them. Damage, pulls, harpoon strikes, EMP and mines are the server's (`work`). The numbers are factions.json
 * custom's (both sides hold the file). Adding a design is its entry here.
 */
import { datan2, dcos, dhypot, dsin } from '../../math/detTrig.js';
import { hashUnit } from '../../math/rng.js';
import { quantizeCursorAngle, dequantizeCursorAngle } from '../../network/cursorState.js';
import { EffectType, type ServerMessage } from '../../network/protocol.js';
import { launchPattern, type LaunchPattern } from '../../guidance/launch.js';
import { leadFrom, offBy } from '../custom/flight.js';
import { customGroups } from '../custom/index.js';
import { CENSER_WARN, CENSER_BURN } from '../custom/censer.js';
import { LURKER_WARN } from '../custom/mawLurker.js';
import { HOOK_WARN } from '../custom/hookboat.js';
import { BELL_WARN } from '../custom/rimeBell.js';
import { CRAWLER_PULL, CRAWLER_SNAP } from '../custom/scrapCrawler.js';
import { SOWER_AHEAD } from '../custom/rivetSower.js';
import { RAY_PASS, RAY_RUN, RAY_EMBER_SPEED } from '../custom/slagRay.js';
import { CLINKER_WARN, CLINKER_SHELLS, CLINKER_GAP } from '../custom/clinker.js';
import { TORCH_TICKS } from '../custom/heliosDrone.js';
import { DART_IN, DART_WARN, DART_FIRE } from '../custom/scrapDarter.js';
import type { MoveOrder } from '../custom/order.js';
import type { MovePose, MoveShot, MoveHurt } from './host.js';

/** A design's numbers (factions.json custom.designs) */
export interface CustomStats {
  range: number;
  reach: number;
  firepower: number;
  /** Most HP of each destroyable piece at Mk I */
  hp: Record<string, number>;
  /** Each move's numbers (`every`: ticks between its starts at least) */
  moves: Record<string, Record<string, number>>;
  /** Guns that fire between moves, by the piece they're on: a shell kind, ticks between shots, damage scale, reach */
  guns?: Record<string, { kind: string; every: number; damage: number; reach: number }>;
  /** Anything else a design reads (the Censer's brazier, the Sower's panniers) */
  [extra: string]: unknown;
}

/** What a move left behind that its later steps read (each ship's own, on each side) */
export interface CustomMoveState {
  tether?: { target: number; until: number };
  pools?: { x: number; y: number; until: number }[];
  due?: { x: number; y: number; at: number; group: string }[];
  /** A line drawn to rake (the Scrap Darter's burst) */
  aim?: number;
  /** No ember cone before this tick (the Slag Ray's, spat only with its nose on you) */
  coneAt?: number;
}

/** What only the server does */
export interface CustomWork {
  /** Pilots its moves can hurt: its target first, then the rest of the system's (by id) */
  victims(): number[];
  segmentHit(id: number, x0: number, y0: number, x1: number, y1: number, half: number): { part: number; t: number } | null;
  damage(id: number, part: number, amount: number, how: MoveHurt): void;
  splash(x: number, y: number, radius: number, amount: number, source: number): void;
  push(id: number, dx: number, dy: number): void;
  emp(x: number, y: number, radius: number, ticks: number): void;
  launch(kind: string, p: LaunchPattern, scale: number): void;
  has(id: number): boolean;
  /** A ship's pose now (null: gone) */
  pose(id: number): MovePose | null;
  /** A message every client gets (what a hit set off: the harpoon's strike) */
  say(msg: ServerMessage): void;
}

/** What a design's moves see this tick */
export interface CustomAct {
  eid: number;
  now: number;
  /** Its target (a pilot's ship, or a ward) */
  target: number;
  /** How far its target is */
  d: number;
  design: string;
  stats: CustomStats;
  /** Its damage scale (its grade's) */
  dmg: number;
  st: CustomMoveState;
  /** Is this piece still on (the structure at this tick) */
  has(group: string): boolean;
  /** Where a piece is in the world (its mount, else its middle) and the way its mount points (null: it's gone, unless `evenGone`) */
  at(group: string, evenGone?: boolean): { x: number; y: number; dir: number } | null;
  /** Its own pose, and its target's, as its step reads them */
  me(): MovePose;
  tpose(): MovePose;
  /** Where its target will be in `ticks` if it keeps on as it's going (its turn as its heading changed lately) */
  ahead(ticks: number): { x: number; y: number };
  fx(msg: ServerMessage): void;
  shoot(s: MoveShot): void;
  /** (the commander's pick) the server's rolls */
  rng(): number;
  /** Can it lay mobs (the server: if it has any; a client: as the server's would) */
  readonly mobs: boolean;
  work?: CustomWork;
}

export interface DesignMoves {
  /** A move to start now (null: none yet): its index in the common module's moves and its argument (the server's) */
  pick(a: CustomAct): { move: number; arg: number } | null;
  /** The move under way, `k` ticks in */
  step?(a: CustomAct, move: MoveOrder, k: number): void;
  /** Every tick it's fighting: its guns (worked out where its body runs too), a tether, pools (the server's) */
  always?(a: CustomAct): void;
  /** Pieces it has just lost (a bit each: the server's) */
  lost?(a: CustomAct, newly: number): void;
}

/** Ticks of a target's velocity kept, to see how it's turning; the most it's taken to turn a tick (radians) */
export const CUSTOM_TRAIL = 10, TURN_MAX = 0.05;

/**
 * Where a target will be `ticks` on: its speed held, its heading turning as it turned over its trail (`tr`: its
 * velocity each tick it was fought, oldest first, at most CUSTOM_TRAIL; at most TURN_MAX a tick)
 */
export function aheadOf(p: MovePose, tr: readonly number[] | undefined, ticks: number): { x: number; y: number } {
  let x = p.x, y = p.y;
  const vx = p.vx, vy = p.vy, s = dhypot(vx, vy);
  let w = 0;
  if (tr && tr.length >= 4 && s > 2) {
    const n = tr.length / 2 - 1, ox = tr[0], oy = tr[1];
    if (dhypot(ox, oy) > 2) w = Math.max(-TURN_MAX, Math.min(TURN_MAX, datan2(ox * vy - oy * vx, ox * vx + oy * vy) / n));
  }
  if (!w) return { x: x + vx * ticks, y: y + vy * ticks };
  let a = datan2(vy, vx);
  for (let k = 0; k < ticks; k++) { a += w; x += dcos(a) * s; y += dsin(a) * s; }
  return { x, y };
}

// ---- The pieces moves are made of ----

/** A line drawn from a point along a world angle, for `ticks` (world space: it doesn't turn with the ship) */
export function lineWarn(a: CustomAct, kind: string, x: number, y: number, angle: number, length: number, width: number, ticks: number): void {
  a.fx({ type: 'bossTelegraph', shape: 'line', kind, x: Math.round(x), y: Math.round(y), angle, length: Math.round(length), width: Math.round(width), ticks });
}

/** A ring round the ship (it moves with it) or round a point in the world */
export function ringWarn(a: CustomAct, kind: string, radius: number, ticks: number, at?: { x: number; y: number }): void {
  a.fx(at
    ? { type: 'bossTelegraph', shape: 'circle', kind, x: Math.round(at.x), y: Math.round(at.y), radius: Math.round(radius), ticks }
    : { type: 'bossTelegraph', shape: 'circle', kind, bodyId: a.eid, x: 0, y: 0, radius: Math.round(radius), ticks });
}

/** A beam's look: from a point on the ship along a world angle (drawn on the ship's frame, as a boss's is) */
export function beamMsg(a: CustomAct, kind: string, from: { x: number; y: number }, angle: number, length: number, width: number, ticks: number): ServerMessage {
  const me = a.me(), c = dcos(-me.angle), s = dsin(-me.angle), dx = from.x - me.x, dy = from.y - me.y;
  const rel = angle - me.angle;
  return { type: 'bossBeam', kind, bodyId: a.eid, x: Math.round(dx * c - dy * s), y: Math.round(dx * s + dy * c), a0: rel, a1: rel, ticks, length: Math.round(length), width: Math.round(width) };
}

/** This tick's burn down a line: the first part of each pilot's ship it crosses takes `damage` (thermal; the server's) */
export function burnLine(a: CustomAct, x0: number, y0: number, angle: number, length: number, width: number, damage: number): void {
  const w = a.work;
  if (!w) return;
  const x1 = x0 + dcos(angle) * length, y1 = y0 + dsin(angle) * length;
  for (const p of w.victims()) {
    const h = w.segmentHit(p, x0, y0, x1, y1, width / 2);
    if (h) w.damage(p, h.part, damage, { type: 'thermal', pen: 1.2 });
  }
}

/** Pull a ship towards a point: `k` world units a tick at its middle, falling to nothing at `r` (the server's) */
export function pullTowards(a: CustomAct, who: number, at: MovePose, x: number, y: number, r: number, k: number): void {
  const dx = x - at.x, dy = y - at.y, d = dhypot(dx, dy);
  if (d > r || d < 1) return;
  const f = k * (1 - d / r);
  a.work?.push(who, (dx / d) * f, (dy / d) * f);
}

/** Splash at a point (the server's), with its look */
export function strikeAt(a: CustomAct, x: number, y: number, radius: number, damage: number, fx = 'eruption'): void {
  a.work?.splash(x, y, radius, damage, a.eid);
  if (fx) a.fx({ type: 'detonation', kind: fx, x: Math.round(x), y: Math.round(y), radius });
}

/** The angle from a point to where a ship will be when a shot `speed` fast gets there */
export function leadAngle(p: MovePose, x: number, y: number, speed: number): number {
  const t = dhypot(p.x - x, p.y - y) / Math.max(1, speed);
  return datan2(p.y + p.vy * t - y, p.x + p.vx * t - x);
}

/**
 * Is a gun `every` ticks apart due this tick: on its own grid (by the ship's id, so a pack's guns don't all go at once),
 * the same on every side, so its shells are worked out where its body runs (decision-inputs stage 4)
 */
export function gunDue(a: CustomAct, every: number): boolean {
  const e = Math.max(1, Math.round(every));
  return (a.now + a.eid * 7) % e === 0;
}

/** A gun on a piece: fires at its target when it's due and in reach (factions.json custom guns) */
export function gun(a: CustomAct, group: string, spread: readonly number[] = [0], speed = 50): void {
  const g = a.stats.guns?.[group];
  if (!g || a.d > g.reach || !gunDue(a, g.every) || !a.has(group)) return;
  const m = a.at(group);
  if (!m) return;
  const aim = leadAngle(a.tpose(), m.x, m.y, speed);
  for (const o of spread) a.shoot({ kind: g.kind, x: m.x, y: m.y, angle: aim + o, scale: g.damage * a.dmg });
}

const num = (a: CustomAct, move: string, key: string, dflt = 0) => a.stats.moves[move]?.[key] ?? dflt;
const due = (a: CustomAct, move: string, next: number) => a.now >= next && a.d <= a.stats.reach;
const nose = (a: CustomAct) => a.me().angle;
/**
 * A line drawn now and fired down `warn` ticks on (a shell `speed` fast, or a beam: Infinity): at where its target will
 * be then if it holds its course. Drawn where it was, a line was dodged by flying on, by anyone moving at all
 */
const lineAt = (a: CustomAct, x: number, y: number, warn: number, speed = Infinity) => {
  const tp = a.tpose();
  // (its time there: the warning, and the shot's flight to where it will be, worked out twice)
  let t = warn + dhypot(tp.x - x, tp.y - y) / speed;
  let p = a.ahead(t);
  t = warn + dhypot(p.x - x, p.y - y) / speed;
  p = a.ahead(t);
  // (at most LEAD_MOST ahead of it)
  const lx = p.x - tp.x, ly = p.y - tp.y, l = dhypot(lx, ly), k = l > LEAD_MOST ? LEAD_MOST / l : 1;
  return datan2(tp.y + ly * k - y, tp.x + lx * k - x);
};
/** The furthest ahead of its target a line or a shell is led (world units) */
const LEAD_MOST = 1400;
/** Ember cones spat only with the Slag Ray's nose this close to where they'd meet its target (radians) */
const CONE_ON = 0.15;
/** The Hookboat's reel draws what it harpooned in no faster than this (world units a tick, closing) */
const REEL_MAX = 5;
/** The Helios Drone's torch burns only pointed this close at what it welds (radians) */
const TORCH_ON = 0.6;
/** The Scrap Darter's rivets' speed (tuning.json weapons rivet) */
const DART_RIVET_SPEED = 34;

/** A group's bit (its design's order: common bodies/custom/roster.json) */
function groupBit(a: CustomAct, group: string): number {
  const i = customGroups(a.design).indexOf(group);
  return i < 0 ? 0 : 1 << i;
}

/** A gun firing a fan of its kind (the Rime Bell's splinters; the server's) */
function gunFrom(a: CustomAct, group: string, fan: number[]): void {
  const g = a.stats.guns?.[group];
  if (!g || a.d > g.reach || !gunDue(a, g.every)) return;
  const me = a.me(), aim = leadAngle(a.tpose(), me.x, me.y, 40);
  for (const o of fan) a.shoot({ kind: g.kind, x: me.x, y: me.y, angle: aim + o, scale: g.damage * a.dmg });
}

/** Every design's moves (`next`: the tick its next move may start, the commander's) */
export function customMoves(next: (a: CustomAct) => number): Record<string, DesignMoves> {
  const may = (a: CustomAct, move: string) => due(a, move, next(a));
  return {
    censer: {
      pick: (a) => (may(a, 'lance') && a.has('lance') ? { move: 0, arg: quantizeCursorAngle(lineAt(a, a.me().x, a.me().y, CENSER_WARN + CENSER_BURN / 2)) } : null),
      step(a, m, k) {
        const line = dequantizeCursorAngle(m.arg), tip = a.at('lance');
        if (!tip) return;
        const L = num(a, 'lance', 'length', 1800), W = num(a, 'lance', 'width', 46);
        if (k === 0) lineWarn(a, 'lance', tip.x, tip.y, line, L, W, CENSER_WARN);
        if (k === CENSER_WARN) a.fx(beamMsg(a, 'lance', tip, line, L, W, CENSER_BURN));
        if (k >= CENSER_WARN && k < CENSER_WARN + CENSER_BURN) burnLine(a, tip.x, tip.y, line, L, W, num(a, 'lance', 'damage', 7) * a.dmg);
      },
    },

    maw_lurker: {
      pick: (a) => (may(a, 'aim') && a.has('rail') ? { move: 0, arg: quantizeCursorAngle(lineAt(a, a.me().x, a.me().y, LURKER_WARN, 150)) } : null),
      step(a, m, k) {
        const tip = a.at('rail');
        if (!tip) return;
        // (No eye: its line wanders, and so does its slug: off by the move's seed)
        const wobble = a.has('eye') ? 0 : (hashUnit(m.seed, a.eid, 7) * 2 - 1) * num(a, 'aim', 'spread', 0.12);
        const line = dequantizeCursorAngle(m.arg) + wobble;
        if (k === 0) lineWarn(a, 'rail', tip.x, tip.y, line, 2800, 18, LURKER_WARN);
        if (k === LURKER_WARN) a.shoot({ kind: 'railgun', x: tip.x, y: tip.y, angle: line, scale: num(a, 'aim', 'damage', 2.6) * a.dmg });
      },
    },

    hookboat: {
      pick: (a) => (may(a, 'harpoon') && a.has('harpoon') && !a.st.tether && a.d < num(a, 'harpoon', 'length', 1300) ? { move: 0, arg: quantizeCursorAngle(lineAt(a, a.me().x, a.me().y, HOOK_WARN)) } : null),
      step(a, m, k) {
        const tip = a.at('harpoon');
        if (!tip) return;
        const line = dequantizeCursorAngle(m.arg), L = num(a, 'harpoon', 'length', 1300);
        if (k === 0) lineWarn(a, 'harpoon', tip.x, tip.y, line, L, 30, HOOK_WARN);
        const w = a.work;
        if (k !== HOOK_WARN || !w) return;
        // (What it strikes is the server's: the harpoon's look and its tether go from there)
        const x1 = tip.x + dcos(line) * L, y1 = tip.y + dsin(line) * L;
        let hit: { who: number; t: number; part: number } | null = null;
        for (const p of w.victims()) {
          const h = w.segmentHit(p, tip.x, tip.y, x1, y1, 15);
          if (h && (!hit || h.t < hit.t)) hit = { who: p, t: h.t, part: h.part };
        }
        w.say(beamMsg(a, 'harpoon', tip, line, hit ? hit.t * L : L, 14, 10));
        if (!hit) return;
        w.damage(hit.who, hit.part, 14 * num(a, 'harpoon', 'damage', 1.2) * a.dmg, { type: 'kinetic', pen: 1 });
        a.st.tether = { target: hit.who, until: a.now + num(a, 'harpoon', 'reel', 150) };
      },
      always(a) {
        gun(a, 'outrigger', [0], 54);
        // The reel: what it struck is drawn in (thrust away to beat it), while its harpoon's still on
        const t = a.st.tether, w = a.work;
        if (!t || !w) return;
        if (a.now >= t.until || !a.has('harpoon') || !w.has(t.target)) { a.st.tether = undefined; return; }
        const tp = w.pose(t.target), me = a.me();
        if (!tp) return;
        const d = dhypot(tp.x - me.x, tp.y - me.y);
        // (a tow, not a sling: no more pull once it's coming in at REEL_MAX, so it isn't hurled into the boat's hull)
        const ux = (me.x - tp.x) / (d || 1), uy = (me.y - tp.y) / (d || 1);
        const closing = (tp.vx - me.vx) * ux + (tp.vy - me.vy) * uy;
        if (d > num(a, 'harpoon', 'slack', 320) && closing < REEL_MAX) pullTowards(a, t.target, tp, me.x, me.y, num(a, 'harpoon', 'length', 1300) * 1.6, num(a, 'harpoon', 'pull', 0.4) * 1.6);
      },
    },

    rime_bell: {
      pick: (a) => (may(a, 'pulse') && a.has('frill') && a.d < num(a, 'pulse', 'radius', 520) * 1.4 ? { move: 0, arg: 0 } : null),
      step(a, _m, k) {
        const R = num(a, 'pulse', 'radius', 520);
        if (k === 0) ringWarn(a, 'emp', R, BELL_WARN);
        if (k === BELL_WARN && a.has('frill')) {
          const me = a.me();
          a.work?.emp(me.x, me.y, R, num(a, 'pulse', 'emp', 75));
          a.fx({ type: 'detonation', kind: 'emp', x: Math.round(me.x), y: Math.round(me.y), radius: R });
        }
      },
      always(a) {
        // Ice splinters at what comes close: one a tendril still on, in a fan
        const fan = (['tendril_l', 'tendril_c', 'tendril_r'] as const).map((g, i) => (a.has(g) ? (i - 1) * 0.22 : null)).filter((o): o is number => o !== null);
        if (fan.length) gunFrom(a, 'tendrils', fan);
      },
    },

    scrap_crawler: {
      pick: (a) => (may(a, 'pull') && a.has('magnet') && a.d < num(a, 'pull', 'radius', 1300) ? { move: 0, arg: 0 } : null),
      step(a, _m, k) {
        const R = num(a, 'pull', 'radius', 1300), me = a.me();
        if (k === 0) ringWarn(a, 'magnet', R, CRAWLER_PULL);
        if (a.has('magnet') && k >= 18) pullTowards(a, a.target, a.tpose(), me.x, me.y, R, num(a, 'pull', 'pull', 0.45));
        // The claws snap shut just ahead of it (each one on, half the bite)
        const claws = (a.has('claw_l') ? 0.5 : 0) + (a.has('claw_r') ? 0.5 : 0), ahead = num(a, 'pull', 'snap', 150);
        const x = me.x + dcos(nose(a)) * ahead, y = me.y + dsin(nose(a)) * ahead;
        if (k === CRAWLER_SNAP - 24 && claws) ringWarn(a, 'claw', num(a, 'pull', 'snapRadius', 150), 24, { x, y });
        if (k === CRAWLER_SNAP && claws) strikeAt(a, x, y, num(a, 'pull', 'snapRadius', 150), num(a, 'pull', 'damage', 50) * claws * a.dmg, 'snap');
      },
    },

    rivet_sower: {
      pick: (a) => {
        if (!may(a, 'lay') || !a.has('drum')) return null;
        // Its line goes across the way its target flies (or across its line to it, when it's still)
        const tp = a.tpose(), me = a.me(), v = dhypot(tp.vx, tp.vy);
        const heading = v > 1 ? datan2(tp.vy, tp.vx) : datan2(tp.y - me.y, tp.x - me.x);
        return { move: 0, arg: quantizeCursorAngle(heading + Math.PI / 2) };
      },
      step(a, m, k) {
        if (k !== SOWER_AHEAD || !a.has('drum') || !a.mobs) return;
        const drum = a.at('drum');
        if (!drum) return;
        // Along the line across your path, or (blind: no sensors) in a ring round itself; one LAUNCH row to its clients
        const ring = !a.has('sensors');
        const p = launchPattern(drum.x, drum.y, m.arg, Math.round(num(a, 'lay', 'mines', 6)), ring, ring ? num(a, 'lay', 'ring', 260) : num(a, 'lay', 'gap', 170));
        a.work?.launch('rivet_mine', p, a.dmg);
        a.fx({ type: 'effect', effectType: EffectType.WarpOut, x: Math.round(drum.x), y: Math.round(drum.y), data: [0] });
      },
      lost(a, newly) {
        // A pannier shot off: its mines go off on the spot, hurting the Sower and anything near it
        const p = a.stats.pannier as { radius: number; damage: number } | undefined, w = a.work;
        if (!w) return;
        for (const g of ['pannier_l', 'pannier_r']) {
          if (!(newly & groupBit(a, g))) continue;
          const at = a.at(g, true);
          if (at) { w.splash(at.x, at.y, p?.radius ?? 220, (p?.damage ?? 60) * a.dmg, -1); w.say({ type: 'detonation', kind: 'eruption', x: Math.round(at.x), y: Math.round(at.y), radius: p?.radius ?? 220 }); }
        }
      },
    },

    slag_ray: {
      pick: (a) => (may(a, 'pass') && a.d < a.stats.reach * 1.6 ? { move: 0, arg: a.rng() < 0.5 ? 0 : 1 } : null),
      step(a, _m, k) {
        // Embers spat ahead in a cone (its horns), slag left in its wake (its tail)
        // (on its run only, its nose on where they'd meet its target, in reach: a cone spat across its turn away was wasted)
        const horns = a.at('horns');
        if (horns && k < RAY_RUN && a.now >= (a.st.coneAt ?? 0) && a.d <= a.stats.reach && offBy(nose(a), leadFrom(horns.x, horns.y, a.tpose(), RAY_EMBER_SPEED)) < CONE_ON) {
          a.st.coneAt = a.now + num(a, 'pass', 'cone', 30);
          for (const o of [-0.22, 0, 0.22]) a.shoot({ kind: 'cannon', x: horns.x, y: horns.y, angle: nose(a) + o, scale: num(a, 'pass', 'damage', 0.9) * a.dmg });
        }
        const tail = a.at('tail');
        if (tail && k % num(a, 'pass', 'wake', 20) === 0 && k < RAY_PASS - 10) {
          const R = num(a, 'pass', 'pool', 140), T = num(a, 'pass', 'poolTicks', 150);
          (a.st.pools ??= []).push({ x: tail.x, y: tail.y, until: a.now + T });
          ringWarn(a, 'pool', R, T, tail);
        }
      },
      always(a) {
        // Its pools burn what sits in them (the server's)
        const pools = a.st.pools, w = a.work;
        if (!pools?.length) return;
        for (let i = pools.length - 1; i >= 0; i--) if (a.now >= pools[i].until) pools.splice(i, 1);
        if (a.now % 15 || !w) return;
        for (const p of pools) w.splash(p.x, p.y, num(a, 'pass', 'pool', 140), num(a, 'pass', 'burn', 3) * 15 * a.dmg, a.eid);
      },
    },

    clinker: {
      pick: (a) => (may(a, 'volley') && (a.has('chimney_l') || a.has('chimney_r')) ? { move: 0, arg: 0 } : null),
      step(a, m, k) {
        const R = num(a, 'volley', 'radius', 170), S = num(a, 'volley', 'spread', 220);
        if (k === 0) a.st.due = [];
        // Each shell aimed as it's lobbed, left chimney then right, at where its target will be when it comes down if it
        // holds its course: the first dead on that, the next where it is now (for one that stops), the last two scattered
        // round where it's going by the move's seed. (All four picked at the first lob, round where it had been, the
        // rest came down behind anyone moving)
        const i = k / CLINKER_GAP, group = i % 2 ? 'chimney_r' : 'chimney_l';
        // (Lobbed only from a chimney still on: rule 6)
        if (Number.isInteger(i) && i < CLINKER_SHELLS && a.has(group)) {
          const tp = a.tpose();
          const t = hashUnit(m.seed, i, 1) * Math.PI * 2, r = i < 2 ? 0 : (0.4 + 0.6 * hashUnit(m.seed, i, 2)) * S;
          const p = i === 1 ? { x: tp.x, y: tp.y } : a.ahead(CLINKER_WARN);
          let lx = p.x - tp.x, ly = p.y - tp.y;
          const l = dhypot(lx, ly), most = num(a, 'volley', 'lead', 900);
          if (l > most) { lx *= most / l; ly *= most / l; }
          const s = { x: tp.x + lx + dcos(t) * r, y: tp.y + ly + dsin(t) * r, at: a.now + CLINKER_WARN, group };
          (a.st.due ??= []).push(s);
          const c = a.at(group);
          if (c) a.fx({ type: 'effect', effectType: EffectType.WarpOut, x: Math.round(c.x), y: Math.round(c.y), data: [0] });
          ringWarn(a, 'impact', R, CLINKER_WARN, s);
        }
        for (const s of a.st.due ?? []) if (a.now === s.at && a.has(s.group)) strikeAt(a, s.x, s.y, R, num(a, 'volley', 'damage', 60) * a.dmg, 'eruption');
      },
    },

    helios_drone: {
      // (it welds only what comes within its torch's reach: it never closes in to do it)
      pick: (a) => (may(a, 'torch') && a.has('torch') && a.d < num(a, 'torch', 'reach', 230) + 140 ? { move: 0, arg: 0 } : null),
      step(a, _m, k) {
        const tip = a.at('torch');
        if (!tip || k < 10 || k >= TORCH_TICKS) return;
        const tp = a.tpose(), R = num(a, 'torch', 'reach', 230), aim = datan2(tp.y - tip.y, tp.x - tip.x);
        // (lit only near enough, and pointed at what it welds: not burning sideways as it comes round)
        if (dhypot(tp.x - tip.x, tp.y - tip.y) > R + 120 || offBy(nose(a), aim) > TORCH_ON) return;
        if (k % 15 === 10) a.fx(beamMsg(a, 'weld', tip, aim, R, 10, 15));
        burnLine(a, tip.x, tip.y, aim, R, 14, num(a, 'torch', 'damage', 0.25) * a.dmg);
      },
      always(a) {
        // Sparks plinked from its torch, from off at its range: only with its nose on you (never as it comes round)
        const tip = a.at('torch'), tp = a.tpose();
        if (tip && offBy(nose(a), datan2(tp.y - tip.y, tp.x - tip.x)) < TORCH_ON) gun(a, 'torch', [0], 54);
      },
    },

    scrap_darter: {
      // (it darts only while its gun's on: without it, it rams, by its range alone)
      pick: (a) => (may(a, 'dart') && a.has('gun') && a.d < a.stats.reach * 1.5 ? { move: 0, arg: a.rng() < 0.5 ? 0 : 1 } : null),
      step(a, _m, k) {
        const gunAt = a.at('gun');
        if (!gunAt) return;
        // On the flank: its line drawn at where you'll be when its rivets get there if you hold your course, then a short
        // burst raked down it (drawn where you were, flying on took you off it)
        if (k === DART_IN) {
          a.st.aim = lineAt(a, gunAt.x, gunAt.y, DART_WARN + DART_FIRE / 2, DART_RIVET_SPEED);
          lineWarn(a, 'rivet', gunAt.x, gunAt.y, a.st.aim, num(a, 'dart', 'length', 1800), 40, DART_WARN);
        }
        const f = k - DART_IN - DART_WARN;
        if (f >= 0 && f < DART_FIRE && f % 4 === 0 && a.st.aim !== undefined) a.shoot({ kind: 'rivet', x: gunAt.x, y: gunAt.y, angle: a.st.aim, scale: num(a, 'dart', 'damage', 0.8) * a.dmg });
      },
      lost(a, newly) {
        // Its fuel pod shot through: it bursts, hurting it and anything beside it (a packmate it was passing)
        const w = a.work;
        if (!w || !(newly & groupBit(a, 'pod'))) return;
        const p = a.stats.pod as { radius: number; damage: number } | undefined, at = a.at('pod', true);
        if (!at) return;
        w.splash(at.x, at.y, p?.radius ?? 260, (p?.damage ?? 70) * a.dmg, -1);
        w.say({ type: 'detonation', kind: 'eruption', x: Math.round(at.x), y: Math.round(at.y), radius: p?.radius ?? 260 });
      },
    },
  };
}
