/**
 * Test-only helpers for the golden tests (refactor safety net, Stage 0): the scripted flight scenarios shared by the
 * golden flight traces (flightTraces.test.ts) and the server / prediction / replica parity harness
 * (server/src/golden/parity.test.ts), and the golden-file helpers. Named testData.ts so the common build leaves it
 * out (tsconfig excludes testData.ts, as for ../testData.ts); only *.test.ts files import it.
 *
 * Scenarios are a ship and one input per tick, in the pilot's terms (keys held, the raw aim angle, the cursor
 * distance), so every path quantises the aim the way it does in the game. Traces are hashed from their quantised
 * numbers (never file paths or names). Changing a scenario moves the pins: regenerate them deliberately with
 * UPDATE_GOLDEN=1 (a missing golden file or entry fails the test, so a pin can't silently start over).
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from '../blueprint.js';
import { SHIP_DATA_DIR } from '../testData.js';
import type { Blueprint, PlacedPart, Rot } from '../types.js';
import type { FlightBody, FlightControls } from '../flight.js';
import type { Charge } from '../energy.js';

/** The keys a tick holds (no aim: that's `aim`) */
export type Keys = Partial<Omit<FlightControls, 'targetAngle' | 'jumpDist'>>;

export interface ScriptTick {
  keys: Keys;
  /** The raw cursor angle (radians), before the 13-bit quantisation every path applies */
  aim: number;
  /** Cursor distance (jump distance); default 0 */
  dist?: number;
}

export interface Scenario {
  name: string;
  ship: () => Blueprint;
  script: ScriptTick[];
  /** Hold mass, flown as cargo from the start (load.ts units). Parity: `cargoOre` iron ore in the pilot's hold gives it */
  cargo?: number;
  cargoOre?: number;
  /** Towing a Corsair wreck `wreckDist` to the pilot's left, the beam switched on before tick `from` (0-based) */
  tow?: { from: number; wreckDist: number };
  /** Ticks (0-based, after the step) whose state a reconciling client / a keyframe replays from */
  replayAt?: number[];
  /**
   * Whether a replica (full charge, no tick, control bits only) is expected to need keyframes on this script (energy
   * limits, Surge kicks, a tow's load arriving, a jump's distance). The exact ticks are pinned in parity.golden.json
   */
  replicaDiverges: boolean;
}

const UP = -Math.PI / 2;

const blueprint = (file: string): Blueprint => parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints', file), 'utf-8'));
const sparrow = () => blueprint('sparrow-t.json');
const withParts = (bp: Blueprint, parts: object[]): Blueprint => ({ ...bp, parts: [...bp.parts, ...(parts as PlacedPart[])] });

/** A strafer on the right flank (dodges the ship left), one on the left (dodges it right), a Tow Beam under the nose */
export const RIGHT_FLANK = { uid: 60, piece: 'sq', fn: 'engine_burst_strafer', material: 'steel', x: 3, y: 0, rot: 0, flip: false, facing: 'E' };
export const LEFT_FLANK = { uid: 61, piece: 'sq', fn: 'engine_burst_strafer', material: 'steel', x: -2, y: 0, rot: 0, flip: false, facing: 'W' };
export const TOW_BEAM = { uid: 62, piece: 'rect2', fn: 'utility_tow_beam', material: 'steel', x: -1, y: 3, rot: 0, flip: false, facing: 'S' };

/** The surge test ship: two Ion Drives with a capacitor against each (they kick while boosting: surge.ts) */
function surgeShip(): Blueprint {
  const p = (uid: number, piece: string, fn: string, x: number, y: number, material: string, extra: Partial<PlacedPart> = {}): PlacedPart =>
    ({ uid, piece, fn, material, x, y, rot: 0 as Rot, flip: false, ...extra });
  return {
    name: 'golden-surge', catalogVersion: 1,
    parts: [
      p(0, 'rect2', 'core', 0, 0, 'alloy'), p(1, 'sq', 'cannon_pip', -1, 0, 'alloy', { facing: 'N' }), p(2, 'sq', 'cannon_pip', 2, 0, 'alloy', { facing: 'N' }),
      p(3, 'sq', 'power_cell_reactor', -1, 1, 'alloy'), p(4, 'sq', 'hull', 0, 1, 'alloy'), p(5, 'sq', 'hull', 1, 1, 'alloy'), p(6, 'sq', 'hull', 2, 1, 'alloy'),
      p(7, 'sq', 'engine_ion_drive', 0, 2, 'alloy', { facing: 'S' }), p(8, 'sq', 'engine_ion_drive', 1, 2, 'alloy', { facing: 'S' }),
      p(9, 'sq', 'power_capacitor', 2, 2, 'composite'), p(10, 'sq', 'power_capacitor', -1, 2, 'composite'),
    ],
  };
}

/** Build a script from segments: [ticks, keys, aim (a number, or a function of the tick within the segment), dist] */
type Segment = [number, Keys, number | ((i: number) => number), number?];
function script(...segs: Segment[]): ScriptTick[] {
  const out: ScriptTick[] = [];
  for (const [n, keys, aim, dist] of segs) for (let i = 0; i < n; i++) out.push({ keys, aim: typeof aim === 'number' ? aim : aim(i), ...(dist !== undefined ? { dist } : {}) });
  return out;
}

/** Thrust, turns (mouse-steer sweeps and snaps), boost, reverse, the helm with Q/E, a jump charged and let go */
const flyAbout = (): ScriptTick[] => script(
  [50, { forward: true }, UP],
  [60, { forward: true }, (i) => UP + i * 0.021],
  [30, { forward: true, boost: true }, 0.7],
  [40, { right: true, backward: true }, 0.7],
  [30, { helm: true, forward: true, strafeLeft: true }, 0.7],
  [30, { helm: true, left: true, strafeRight: true }, 0.7],
  [25, { helm: true, right: true, backward: true }, 0.7],
  [20, {}, 2.5],
  [30, { jump: true }, 2.5, 3000],
  [45, {}, -2.9],
);

/** A dodge every way the dev test ship can (strafers all round), a press in the cooldown, one held through, the helm's */
const dodgeEveryWay = (): ScriptTick[] => {
  const dodge = (keys: Keys, aim: Segment[2] = UP, hold = 3): Segment[] => [[hold, { ...keys, dodge: true }, aim], [26 - hold, keys, aim]];
  return script(
    [10, { forward: true }, UP],
    ...dodge({}),
    ...dodge({ forward: true }),
    ...dodge({ backward: true }),
    ...dodge({ left: true }),
    ...dodge({ right: true }),
    ...dodge({ forward: true, right: true }, 0.4),
    ...dodge({ backward: true, left: true }, (i) => 0.4 - i * 0.02),
    // Pressed again mid-cooldown (ignored by the sim: the press ends before it's ready), then a fresh one
    [3, { left: true, dodge: true }, UP], [9, { left: true }, UP], [3, { left: true, dodge: true }, UP], [14, {}, UP],
    // Held right through the cooldown: one burst, then held
    [60, { right: true, dodge: true }, UP], [4, {}, UP],
    // At the helm: Q/E and back, ship-relative
    ...dodge({ helm: true, strafeLeft: true }, 1.1),
    ...dodge({ helm: true, backward: true, strafeRight: true }, 1.1),
    // With nothing held twice: the weave (back the other way from the last)
    ...dodge({}, 1.1),
    ...dodge({}, 1.1),
    [20, { forward: true, boost: true }, 1.1],
  );
};

/** One strafer and no bank, dodging as fast as it allows: the circuit browns out and bursts weaken, then get refused */
const dodgeTillDry = (): ScriptTick[] => {
  const out: ScriptTick[] = [];
  for (let n = 0; n < 34; n++) for (let i = 0; i < 24; i++) out.push({ keys: { dodge: i < 4, forward: n % 5 === 4 && i >= 12 }, aim: UP + (n % 3) * 0.05 });
  return out;
};

/** strafer.test.ts's replay script: thrust, a turn, dodges either way (a snapshot mid-burst replays from 14, 47, 100) */
const replayScript = (): ScriptTick[] => {
  const out: ScriptTick[] = [];
  for (let t = 0; t < 160; t++) {
    out.push({
      keys: { forward: t < 60, right: t >= 45 && t < 52, left: t >= 90 && t < 95, dodge: (t >= 10 && t < 20) || (t >= 45 && t < 50) || (t >= 90 && t < 93) || (t >= 120 && t < 125) },
      aim: -1.2 + t * 0.01,
    });
  }
  return out;
};

/** Aim at the wreck, take hold, haul it off to the right with a dodge or two, boost */
const towScript = (): ScriptTick[] => script(
  [3, {}, Math.PI, 300],
  [120, { right: true }, UP],
  [3, { right: true, dodge: true }, UP], [30, { right: true }, UP],
  [40, { forward: true, boost: true }, -0.4],
  [3, { left: true, dodge: true }, -0.4], [40, {}, -0.4],
);

/** Boosting with Surge-fed engines: a kick every kickEvery ticks */
const surgeScript = (): ScriptTick[] => script(
  [90, { forward: true, boost: true }, UP],
  [30, { forward: true }, (i) => UP + i * 0.03],
  [70, { right: true, boost: true }, 0.4],
  [40, {}, 0.4],
);

/** A jump charged to the full, the burn (aim held, 20000 out), and the cooldown's start */
const jumpScript = (): ScriptTick[] => script(
  [20, { forward: true }, UP],
  [100, { jump: true }, UP + 0.3, 20000],
  [100, { forward: true }, UP + 0.3],
);

export const SCENARIOS: Scenario[] = [
  { name: 'plain-thrust-turn', ship: sparrow, script: flyAbout(), replayAt: [77, 200], replicaDiverges: false },
  { name: 'heavy-cargo', ship: sparrow, script: flyAbout(), cargo: 6, cargoOre: 60, replayAt: [120], replicaDiverges: false },
  // (The dev ship's circuit browns out by its tenth dodge (tick ~317): from there the server's thrust and pushes are
  // energy-limited and a replica, on full charge, needs keyframes)
  { name: 'strafer-every-way', ship: () => blueprint('dev/test-strafer.json'), script: dodgeEveryWay(), replayAt: [12, 40, 200, 330], replicaDiverges: true },
  { name: 'strafer-replay', ship: () => withParts(sparrow(), [RIGHT_FLANK, LEFT_FLANK]), script: replayScript(), replayAt: [14, 47, 100], replicaDiverges: false },
  { name: 'strafer-heavy', ship: () => withParts(sparrow(), [RIGHT_FLANK, LEFT_FLANK]), script: replayScript(), cargo: 4, cargoOre: 40, replayAt: [47], replicaDiverges: false },
  { name: 'strafer-energy-short', ship: () => withParts(sparrow(), [RIGHT_FLANK]), script: dodgeTillDry(), replayAt: [501, 700], replicaDiverges: true },
  { name: 'tow', ship: () => withParts(sparrow(), [RIGHT_FLANK, LEFT_FLANK, TOW_BEAM]), script: towScript(), tow: { from: 2, wreckDist: 300 }, replayAt: [125, 200], replicaDiverges: true },
  { name: 'surge-kick', ship: surgeShip, script: surgeScript(), replayAt: [41, 150], replicaDiverges: true },
  { name: 'jump-burn', ship: sparrow, script: jumpScript(), replayAt: [95, 150], replicaDiverges: true },
];

/** The Corsair (towed as a wreck) */
export const corsair = () => blueprint('corsair.json');

export const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === '1';

/** A body as the wire and every path compare it: absent counters as their defaults */
export function bodyRow(b: FlightBody): number[] {
  return [b.x, b.y, b.vx, b.vy, b.angle, b.angVel, b.jump ?? 0, b.jumpScale ?? 1, b.cargo ?? 0, b.dodge ?? 0, b.dodgeDir ?? 0];
}

export const BODY_FIELDS = ['x', 'y', 'vx', 'vy', 'angle', 'angVel', 'jump', 'jumpScale', 'cargo', 'dodge', 'dodgeDir'] as const;

export function chargeRow(c: Charge): number[] {
  return [c.core, ...c.s];
}

/** sha256 of the rows (numbers written exactly), first 16 hex digits */
export function hashRows(rows: number[][]): string {
  const h = createHash('sha256');
  for (const r of rows) h.update(r.map((v) => (Object.is(v, -0) ? '0' : String(v))).join(',') + '\n');
  return h.digest('hex').slice(0, 16);
}

/** Sorted integers as compact ranges ("3,7-9"), for pins that list ticks */
export function ranges(xs: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < xs.length; i++) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
    out.push(j > i ? `${xs[i]}-${xs[j]}` : `${xs[i]}`);
    i = j;
  }
  return out.join(',');
}

/**
 * A golden file of pins by scenario. `check(name, actual)` returns what's pinned for it (or, with UPDATE_GOLDEN=1,
 * `actual`, collected); `save()` (afterAll) writes the collected pins when updating. A missing file or entry fails.
 */
export function goldenFile<T>(file: string) {
  const pinned: Record<string, T> = !UPDATE_GOLDEN && existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : {};
  const seen: Record<string, T> = {};
  return {
    check(name: string, actual: T): T {
      seen[name] = actual;
      if (UPDATE_GOLDEN) return actual;
      if (!(name in pinned)) throw new Error(`No pin for "${name}" in ${file}: run with UPDATE_GOLDEN=1 to create it`);
      return pinned[name];
    },
    save(): void {
      if (!UPDATE_GOLDEN) return;
      const out = Object.fromEntries(Object.keys(seen).sort().map((k) => [k, seen[k]]));
      writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
    },
  };
}
