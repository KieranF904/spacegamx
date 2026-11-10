/**
 * The part-feature contract (features/README.md): `runPartContract('<feature id>', opts)` registers a vitest suite that
 * every converted feature must pass, so a new feature is held to the same rules as Tow, Strafer and Support:
 *
 *   plan        it is in the registry, its folder matches its id, its wire slots are the pinned ones (features.wire.json)
 *               and none of its pinned slots has been dropped, its inputs' control bits are pinned to it
 *   catalogue   every function it applies to is a player model with a recipe; every weapon role picks a weapon kind
 *   describe    facts have finite numbers, labels, valid tiers, unique keys, its own id, and repeat exactly
 *   energy      a burst feature's parts are no steady load (energy.demand), and the ship's power tick stays finite
 *   parity      a fixture ship flown through stepShipPhysics and through replicaStep (the control bits a replica gets)
 *               stays bit for bit equal for the whole script, feature inputs included
 *   replicate   its keyframe and pilot-row slots round-trip at the pinned indices
 *   hot path    a ship without its part carries nothing of the feature
 *
 * (The full server / client / replica parity runs on the golden scenarios: server/src/golden/parity.test.ts. How facts
 * render is client/src/ships/features/contract.test.ts.)
 *
 * TEST HELPER: excluded from the build (tsconfig.json); imports vitest.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from '../blueprint.js';
import { createShipState } from '../state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../testData.js';
import type { ShipTuning } from '../tuning.js';
import type { FlightBody, FlightControls } from '../flight.js';
import { stepShipPhysics } from '../physics.js';
import { FULL_CHARGE, CHARGE_GROUPS_AT, chargeTotal, fullPortsCharge, powerTick } from '../energy.js';
import { partDemand } from '../grades.js';
import { gunDef } from '../launch.js';
import { CTL, ReplicaMode, controlBits, flightControls, replicaStep } from '../replica.js';
import { gridAim } from '../../sim/a-adapt.js';
import { newFlightControls } from '../flightInputs.js';
import { NO_FIELDS } from '../jumpFields.js';
import { packKeyframe, unpackKeyframe } from '../../network/replication.js';
import { getPlan, featureFacts, setPlanForTests, type WireManifest } from './plan.js';
import { pilotExtras } from './strafer/strafer.js';
import type { Fact } from './types.js';
import WIRE from './features.wire.json' with { type: 'json' };
import { dsin } from '../../math/detTrig.js';

type Keys = Partial<Omit<FlightControls, 'targetAngle' | 'jumpDist'>>;

export interface PartContractOptions {
  /** Parts a fixture ship (sparrow-t) is given to have the feature: placed parts as in a blueprint (none: the feature has no part of its own) */
  parts?: object[];
  /** The scripted pilot: the keys held on a tick (0-based) and the aim; default: a steady run with turns and, on ticks 20-60 and 90-110, every input this feature declares held */
  script?: (tick: number) => { keys: Keys; aim: number };
  /** Ticks flown (default 150) */
  ticks?: number;
  /** The fixture ship's body on tick 0 */
  startAngle?: number;
}

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const FEATURES_DIR = __dirname;
const W = WIRE as WireManifest;

const ship = (extra: object[] = []) => {
  const bp = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8'));
  bp.parts.push(...(extra as never[]));
  return createShipState(catalog, tuning, 1, bp, 0);
};

export function runPartContract(id: string, opts: PartContractOptions = {}): void {
  describe(`part contract: ${id}`, () => {
    setPlanForTests(null);
    const P = getPlan();
    const index = P.byId.get(id) ?? -1;
    const feature = P.features[index];
    const parts = opts.parts ?? [];
    const applying = [...catalog.functions.values()].filter((f) => feature?.applies(f));
    // (A role may be picked by a kind's own tuning, or by a weapon model's: its kind's with its model's changes, launch.ts gunDef)
    const weaponKinds = (role: { applies(d: never): boolean }) => [
      ...Object.entries(tuning.weapons ?? {}),
      ...[...catalog.functions.values()].filter((f) => f.weapon && f.model).map((f) => [f.id, gunDef(tuning, f.weapon!, { model: f.weaponMods })] as const),
    ].filter(([, def]) => role.applies(def as never));

    it('plan: registered under its folder name, with its wire slots as pinned', () => {
      expect(index, `${id} is not in the registry (npm run features:gen)`).toBeGreaterThanOrEqual(0);
      expect(existsSync(join(FEATURES_DIR, id, 'index.ts'))).toBe(true);
      const mine = P.replicate.filter((r) => r.feature === id);
      for (const r of mine) expect(r.slot, `${r.where} ${r.name}`).toBeGreaterThanOrEqual(0);
      // Nothing pinned to it has gone (the manifest is append-only: dropping a slot would shift the wire)
      const have = new Set(mine.map((r) => `${r.where}:${r.name}`));
      for (const where of ['pilotExtra', 'status', 'keyframe', 'ctl'] as const) {
        for (const e of W[where] as { name: string; feature: string }[]) if (e.feature === id) expect(have.has(`${where}:${e.name}`), `pinned ${where} ${e.name} dropped`).toBe(true);
      }
      for (const inp of P.inputs.filter((i) => i.feature === id && i.ctlBit)) {
        expect(W.ctl.find((e) => e.name === inp.name)?.feature, `control bit of ${inp.name}`).toBe(id);
        expect(Object.values(CTL)).toContain(inp.ctlBit);
      }
      expect(index).toBeLessThan(31);
    });

    it('catalogue: what it applies to are player models with recipes; its weapon roles pick weapon kinds', () => {
      const recipes = JSON.parse(readFileSync(join(SHIP_DATA_DIR, '../recipes.json'), 'utf-8')).models;
      for (const fn of applying) {
        expect(fn.model, `${fn.id} is not a player model`).toBe(true);
        expect(recipes[fn.id], `${fn.id} has no recipe`).toBeTruthy();
      }
      for (const role of feature.weapon ?? []) expect(weaponKinds(role as never).length, `weapon role ${role.id} picks no weapon`).toBeGreaterThan(0);
      // Gives a ship something: a function it applies to, or a weapon role
      expect(applying.length + (feature.weapon?.length ?? 0), 'applies to nothing').toBeGreaterThan(0);
    });

    it('describe: finite, labelled, unique facts of its own, repeating exactly', () => {
      const tiers = new Set<Fact['tier']>(['headline', 'stat', 'detail', 'warning']);
      for (const fn of applying) {
        const facts = featureFacts({ catalog, tuning, fn }).filter((f) => f.feature === id);
        const keys = new Set<string>();
        for (const f of facts) {
          expect(tiers.has(f.tier), `${fn.id} ${f.key} tier`).toBe(true);
          expect(f.label.trim().length, `${fn.id} ${f.key} label`).toBeGreaterThan(0);
          expect(f.key.length).toBeGreaterThan(0);
          expect(keys.has(f.key), `${fn.id} duplicate fact ${f.key}`).toBe(false);
          keys.add(f.key);
          if (typeof f.value === 'number') expect(Number.isFinite(f.value), `${fn.id} ${f.key} value`).toBe(true);
          else expect(String(f.value).length, `${fn.id} ${f.key} value`).toBeGreaterThan(0);
        }
        expect(featureFacts({ catalog, tuning, fn }).filter((f) => f.feature === id)).toEqual(facts);
      }
      // Other functions get none of its facts
      for (const fn of catalog.functions.values()) if (!feature.applies(fn)) expect(featureFacts({ catalog, tuning, fn }).filter((f) => f.feature === id), fn.id).toEqual([]);
    });

    it('energy: a burst feature\'s parts are no steady load; the ship\'s power tick stays finite', () => {
      const s = ship(parts);
      const d = s.derived;
      if (feature.burst) {
        expect(parts.length, 'a burst feature needs fixture parts').toBeGreaterThan(0);
        const without = ship().derived.energy.demand;
        let seen = 0;
        const placed = s.blueprint.parts.map((p) => catalog.functions.get(p.fn)!);
        for (let i = 0; i < placed.length; i++) {
          if (!feature.applies(placed[i])) continue;
          seen++;
          const dem = partDemand(placed[i], 1, catalog.materials.get(placed[i].material ?? 'alloy')!);
          expect(Number.isFinite(dem) && dem >= 0, `part ${i} draw`).toBe(true);
        }
        expect(seen).toBeGreaterThan(0);
        expect(d.energy.demand, 'its parts are not a steady load').toBe(without);
      }
      let c = fullPortsCharge(d);
      for (let t = 0; t < 30; t++) c = powerTick(d, c, { thrusting: true, boosting: t % 2 === 0 }).charge;
      expect(Number.isFinite(chargeTotal(d, c))).toBe(true);
    });

    it('parity: stepShipPhysics and replicaStep on the control bits agree bit for bit', () => {
      const ticks = opts.ticks ?? 150;
      const mine = P.inputs.filter((i) => i.feature === id).map((i) => i.name);
      const script = opts.script ?? ((t: number) => {
        const featureOn = (t >= 20 && t < 60) || (t >= 90 && t < 110);
        const keys: Record<string, boolean> = { forward: t < 100, left: t >= 40 && t < 55, right: t >= 120, boost: t >= 70 && t < 85, strafeLeft: t >= 100 && t < 112 };
        for (const n of mine) keys[n] = featureOn;
        return { keys: keys as Keys, aim: -Math.PI / 2 + dsin(t / 20) * 0.8 };
      });
      const fly = (replica: boolean, off = false) => {
        const s = ship(parts), d = s.derived;
        const body: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle: opts.startAngle ?? -Math.PI / 2, angVel: 0, jump: 0, cargo: 0 };
        const rows: number[][] = [];
        for (let t = 0; t < ticks; t++) {
          const { keys, aim: raw } = script(t);
          const aim = gridAim(raw); // (aims come on the grid: sim/input.ts simAim)
          if (off) for (const n of mine) (keys as Record<string, boolean>)[n] = false;
          if (replica) {
            // (What a replica has: the control bits and the aim, not the keys)
            replicaStep(ReplicaMode.Player, body, { bits: controlBits(keys), targetAngle: aim }, d, tuning, { gravity: null, central: null, ...NO_FIELDS }, t + 1);
          } else {
            const c = { ...newFlightControls(), ...keys, targetAngle: aim, jumpDist: 0 };
            // (The same controls the bits give back)
            const back = flightControls({ bits: controlBits(c), targetAngle: aim }, body);
            stepShipPhysics(body, back, d, tuning, { charge: FULL_CHARGE, drainRate: 0 }, null, 1, undefined, null);
          }
          rows.push([body.x, body.y, body.vx, body.vy, body.angle, body.angVel, body.dodge ?? 0, body.dodgeDir ?? 0]);
        }
        return rows;
      };
      const a = fly(false), b = fly(true);
      for (const row of a) for (const v of row) expect(Number.isFinite(v)).toBe(true);
      expect(b).toEqual(a);
      // Repeatable
      expect(fly(false)).toEqual(a);
      // Its inputs matter: with them never held, the ship flies otherwise
      if (mine.length && parts.length) expect(fly(false, true)).not.toEqual(a);
      // It flew somewhere
      expect(a[a.length - 1][0] !== 0 || a[a.length - 1][1] !== 0).toBe(true);
    });

    it('replicate: keyframe and pilot-row slots round-trip at the pinned indices', () => {
      for (const e of W.keyframe.filter((k) => k.feature === id)) {
        const body: Record<string, number> = { x: 1, y: 2, vx: 3, vy: 4, angle: 0.5, angVel: 0, jump: 0, cargo: 6, dodge: 0, dodgeDir: 0 };
        body[e.name] = 7;
        const row = packKeyframe({ id: 2, mode: 0, body: body as never, ctl: { bits: 16, targetAngle: 0 }, q: 4000 }) as number[];
        expect(row[e.index], `keyframe ${e.name}`).toBe(7);
        expect((unpackKeyframe(row).body as Record<string, number>)[e.name]).toBe(7);
      }
      const data = new Array(CHARGE_GROUPS_AT).fill(0);
      W.pilotExtra.forEach((_, k) => data.push(101 + k));
      const x = pilotExtras(data) as Record<string, number>;
      W.pilotExtra.forEach((e, k) => { if (e.feature === id) expect(x[e.name], `pilot row ${e.name}`).toBe(101 + k); });
      for (const e of W.status.filter((s) => s.feature === id)) expect(P.replicate.some((r) => r.feature === id && r.where === 'status' && r.slot === e.index)).toBe(true);
    });

    it('hot path: a ship without the part carries nothing of the feature', () => {
      const d = ship().derived;
      if (feature.global) return;
      expect((d.fxMask ?? 0) & (1 << index)).toBe(0);
      expect([...(d.fxList ?? [])]).not.toContain(index);
      expect(Object.keys(d.fx ?? {})).toEqual([]);
      if (parts.length && applying.length) {
        const withPart = ship(parts).derived;
        expect((withPart.fxMask ?? 0) & (1 << index), 'the fixture ship has the feature').not.toBe(0);
        expect([...(withPart.fxList ?? [])]).toContain(index);
      }
    });
  });
}
