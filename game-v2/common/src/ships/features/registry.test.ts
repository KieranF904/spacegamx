import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from '../blueprint.js';
import { createShipState } from '../state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../testData.js';
import type { ShipTuning } from '../tuning.js';
import { flightSignature, CTL } from '../replica.js';
import { pilotExtras } from './strafer/strafer.js';
import { CHARGE_GROUPS_AT } from '../energy.js';
import { packKeyframe } from '../../network/replication.js';
import { FEATURES } from './registry.js';
import { compilePlan, getPlan, setPlanForTests, featureFacts, featureList, MAX_FEATURES, type WireManifest } from './plan.js';
import type { PartFeature } from './types.js';
import WIRE from './features.wire.json' with { type: 'json' };

const ROOT = join(__dirname, '../../../..');
const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const TOW_PART = { uid: 70, piece: 'rect2', fn: 'utility_tow_beam', material: 'steel', x: -3, y: 0, rot: 0, flip: false, facing: 'W' };
const SCANNER_PART = { ...TOW_PART, uid: 71, fn: 'scanner' };
const sparrow = (extra: object[] = []) => {
  const bp = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8'));
  bp.parts.push(...(extra as never[]));
  return createShipState(catalog, tuning, 1, bp, 0);
};
const feature = (o: Partial<PartFeature> & { id: string }): PartFeature => ({ applies: () => false, order: 0, ...o });
const strip = <T extends object>(d: T) => { const { fxMask, fxList, fx, ...rest } = d as T & { fxMask?: unknown; fxList?: unknown; fx?: unknown }; return rest; };

declare module './types.js' {
  interface FeatureDerived { towProbe?: { parts: number[] } }
}

/** A stand-in that re-derives the Tow Beam's `derived.fx.tow` through the seam (the real Tow feature is tow/) */
const towProbe = feature({
  id: 'towProbe',
  order: 10,
  applies: (fn) => !!fn.tow,
  burst: true,
  derive(c) {
    for (const i of c.parts) {
      const t = c.out.towProbe ??= { parts: [] };
      t.parts.push(i);
    }
  },
  describe: (c) => [{ feature: 'towProbe', key: 'range', label: 'Range', value: c.fn.id, tier: 'stat' }],
});

afterEach(() => setPlanForTests(null));

describe('part features: the registry', () => {
  it('registry.ts is what scripts/features/gen.mjs writes (regenerating gives no diff)', () => {
    expect(() => execFileSync(process.execPath, [join(ROOT, 'scripts/features/gen.mjs'), '--check'], { stdio: 'pipe' })).not.toThrow();
  });

  it('the registry compiles into the plan', () => {
    expect(getPlan().features.length).toBe(FEATURES.length);
    expect(getPlan()).toBe(getPlan());
  });

  it('features.wire.json pins the slots where they are today (protocol 16)', () => {
    const W = WIRE as WireManifest;
    // Pilot extras, in order after the charge groups (strafer.ts pilotExtras)
    const data = new Array(CHARGE_GROUPS_AT).fill(0);
    W.pilotExtra.forEach((_, k) => data.push(101 + k));
    const x = pilotExtras(data) as Record<string, number>;
    W.pilotExtra.forEach((e, k) => expect(x[e.name]).toBe(101 + k));
    // Keyframe tail (network/replication.ts packKeyframe)
    const row = packKeyframe({ id: 2, mode: 0, body: { x: 1, y: 2, vx: 3, vy: 4, angle: 0.5, angVel: 0, jump: 0, cargo: 6, dodge: 7, dodgeDir: 8 }, ctl: { bits: 16, targetAngle: 0 }, q: 4000 }) as number[];
    for (const e of W.keyframe) expect(row[e.index]).toBe(e.name === 'dodge' ? 7 : 8);
    // Control bits (replica.ts CTL)
    for (const e of W.ctl) expect((CTL as Record<string, number>)[e.name]).toBe(e.bit);
    // No slot twice
    for (const list of [W.status, W.keyframe]) expect(new Set(list.map((e) => e.index)).size).toBe(list.length);
    expect(new Set(W.ctl.map((e) => e.bit)).size).toBe(W.ctl.length);
    expect(new Set(W.pilotExtra.map((e) => e.name)).size).toBe(W.pilotExtra.length);
  });
});

describe('part features: compiling a plan', () => {
  it('orders by (order, id) and numbers the features so', () => {
    const P = compilePlan([feature({ id: 'b', order: 1 }), feature({ id: 'c', order: 0 }), feature({ id: 'a', order: 1 })]);
    expect(P.features.map((f) => f.id)).toEqual(['c', 'a', 'b']);
    expect(P.byId.get('b')).toBe(2);
    expect(Object.isFrozen(P) && Object.isFrozen(P.features) && Object.isFrozen(P.flight.steer)).toBe(true);
  });

  it('masks, per-phase flight hooks sorted by (order, feature)', () => {
    const step = () => {};
    const P = compilePlan([
      feature({ id: 'x', order: 0, burst: true, flight: [{ phase: 'damp', order: 5, step }] }),
      feature({ id: 'y', order: 1, global: true, flight: [{ phase: 'damp', order: 1, step }, { phase: 'preJump', order: 0, step }] }),
      feature({ id: 'z', order: 2 }),
    ]);
    expect(P.burstMask).toBe(1);
    expect(P.globalMask).toBe(2);
    expect(P.flightMask).toBe(3);
    expect(P.flight.damp.map((e) => e.feature)).toEqual([1, 0]);
    expect(P.flight.preJump.length).toBe(1);
    expect(P.flight.steer.length).toBe(0);
    expect([...featureList(0b10110)]).toEqual([1, 2, 4]);
  });

  it('refuses duplicates, unpinned wire slots, a new input bit and too many features', () => {
    expect(() => compilePlan([feature({ id: 'a' }), feature({ id: 'a' })])).toThrow(/duplicate id/);
    expect(() => compilePlan([feature({ id: 'a', flight: [{ phase: 'nope' as never, order: 0, step: () => {} }] })])).toThrow(/unknown flight phase/);
    const inp = { name: 'go', kind: 'held' as const, label: 'Go', defaultKey: 'KeyG' };
    expect(() => compilePlan([feature({ id: 'a', inputs: [inp] }), feature({ id: 'b', inputs: [inp] })])).toThrow(/already a\.go's/);
    expect(() => compilePlan([feature({ id: 'a', inputs: [{ ...inp, ctlBit: 4096 }] })])).toThrow(/longer binary input form/);
    // (A pinned bit is fine for its own feature, refused for another)
    expect(compilePlan([feature({ id: 'strafer', inputs: [{ ...inp, ctlBit: CTL.dodge }] })]).inputs[0].ctlBit).toBe(CTL.dodge);
    expect(() => compilePlan([feature({ id: 'tow', inputs: [{ ...inp, ctlBit: CTL.dodge }] })])).toThrow(/not pinned/);
    expect(() => compilePlan([feature({ id: 'a', replicate: [{ name: 'tow', where: 'status', who: 'all', default: 0 }] })])).toThrow(/no status slot/);
    const P = compilePlan([feature({ id: 'tow', replicate: [{ name: 'tow', where: 'status', who: 'all', default: 0 }, { name: 'tow', where: 'pilotExtra', who: 'self', default: 0 }] })]);
    expect(P.replicate.map((r) => r.slot)).toEqual([6, 2]);
    const many = Array.from({ length: MAX_FEATURES + 1 }, (_, i) => feature({ id: `f${i}` }));
    expect(() => compilePlan(many)).toThrow(/at most/);
  });
});

describe('part features: the seam (rebuild, describe, flight signature)', () => {
  it('with no features, a rebuild carries no feature fields at all', () => {
    setPlanForTests(compilePlan([]));
    const d = sparrow([TOW_PART]).derived;
    expect('fxMask' in d || 'fxList' in d || 'fx' in d).toBe(false);
  });

  it('a feature derives its own fx, in plan order, and nothing else changes', () => {
    const before = sparrow([TOW_PART]).derived, plain = sparrow().derived;
    setPlanForTests(compilePlan([towProbe]));
    const d = sparrow([TOW_PART]).derived;
    expect(d.fx!.towProbe).toEqual(before.fx!.tow);
    expect(d.fxMask).toBe(1);
    expect([...d.fxList!]).toEqual([0]);
    expect(strip(d)).toEqual(strip(before));
    expect(flightSignature(d)).toBe(flightSignature(before));
    // (A ship without the part doesn't have it)
    const p = sparrow().derived;
    expect('fx' in p).toBe(false);
    expect(p).toEqual(plain);
    // (The real Tow feature gives the same thing under its own key)
    expect(before.fxMask).toBe(1);
  });

  it('burst: a feature makes its parts draw by the tick, not as a steady load (energy.demand)', () => {
    setPlanForTests(compilePlan([]));
    const plain = sparrow().derived.energy.demand;
    const steady = sparrow([SCANNER_PART]);
    expect(catalog.functions.get('scanner')!.demand).toBeGreaterThan(0);
    expect(steady.derived.energy.demand).toBeGreaterThan(plain);
    setPlanForTests(compilePlan([feature({ id: 'scanBurst', burst: true, applies: (fn) => fn.id === 'scanner' })]));
    const burst = sparrow([SCANNER_PART]);
    expect(burst.derived.energy.demand).toBe(plain);
    expect(burst.derived.fxMask).toBe(1);
    expect(burst.derived.fx).toEqual({});
  });

  it('a feature with flight hooks is folded into the flight signature (so replicas re-key); one without is not', () => {
    setPlanForTests(compilePlan([towProbe]));
    const sig = flightSignature(sparrow([TOW_PART]).derived);
    setPlanForTests(compilePlan([{ ...towProbe, flight: [{ phase: 'damp', order: 0, step: () => {} }] }]));
    expect(flightSignature(sparrow([TOW_PART]).derived)).toBe(`${sig}|fx1`);
  });

  it('describe(): facts from the features a function gives, none from others', () => {
    setPlanForTests(compilePlan([towProbe]));
    expect(featureFacts({ catalog, tuning, fn: catalog.functions.get('utility_tow_beam')! })).toEqual([
      { feature: 'towProbe', key: 'range', label: 'Range', value: 'utility_tow_beam', tier: 'stat' },
    ]);
    expect(featureFacts({ catalog, tuning, fn: catalog.functions.get('scanner')! })).toEqual([]);
  });
});

describe('part features: import rules (no cycles through the registry)', () => {
  const SHIPS = join(__dirname, '..');
  const imports = (file: string) => [...readFileSync(file, 'utf-8').matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?from\s+'([^']+)'/gms)]
    .map((m) => ({ type: !!m[2] || /^\s*import\s+type\b/.test(m[0]), from: m[3] }));

  it('types.ts imports types only', () => {
    expect(imports(join(__dirname, 'types.ts')).filter((i) => !i.type)).toEqual([]);
  });

  it('outside features/, ships code reaches features only through plan.ts (values), types.ts (types) or its own pure helper file (tow/tow.ts); the barrel excepted', () => {
    const bad: string[] = [];
    for (const name of readdirSync(SHIPS)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name === 'index.ts') continue;
      for (const i of imports(join(SHIPS, name))) {
        if (!i.from.startsWith('./features/')) continue;
        if (i.from === './features/plan.js' || (i.type && i.from === './features/types.js')) continue;
        // (A feature's own pure helper file, e.g. features/tow/tow.ts: it imports nothing that leads back to the registry)
        if (/^\.\/features\/\w+\/(?!index)[\w.]+$/.test(i.from)) continue;
        bad.push(`${name}: ${i.from}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
