/**
 * The enemy AI's lead (bodies/aiLead.ts): by its main gun's real round, carried in its order as whole numbers, read the
 * same by every end that flies its body (bodies/aiPilot.ts).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from '../ships/blueprint.js';
import { createShipState } from '../ships/state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../ships/testData.js';
import type { ShipTuning, WeaponTuning } from '../ships/tuning.js';
import { partWeaponDef } from '../ships/launch.js';
import { AI_BEAM_REACH, LEGACY_LEAD, LEAD_MAX_TICKS, aiLoadout, leadAt, leadPlaces, leadTicks, roundLead, ENGAGE_MATES, ORDER_LEAD } from './aiLead.js';
import { AI_ORDER, aiPilot, orderEngage, orderHaul, orderPack } from './aiPilot.js';
import { bodyStateOfSync, syncArgs } from './decisions.js';
import { bodyKindOf } from './registry.js';
import { customOrder, CO } from './custom/order.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const sparrowText = readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8');

/** A Sparrow with its Pips made `model` */
function armed(model: string) {
  const bp = parseBlueprint(sparrowText);
  for (const q of bp.parts) if (q.fn === 'cannon_pip') q.fn = model;
  return createShipState(catalog, tuning, 1, bp, 0);
}
const defOf = (model: string): WeaponTuning => { const s = armed(model), w = s.derived.weapons[0]; return partWeaponDef(tuning, w.kind, s.blueprint.parts[w.part], { model: w.model }); };

describe('the AI leads by its main gun\'s round', () => {
  it('a straight round\'s flight is its distance over its speed, up to the cap', () => {
    expect(leadTicks(900, { v: 150, a: 0, max: 150 })).toBeCloseTo(6, 12);
    expect(leadTicks(900, { v: 38, a: 0, max: 38 })).toBeCloseTo(900 / 38, 12);
    expect(leadTicks(5000, { v: 10, a: 0, max: 10 })).toBe(LEAD_MAX_TICKS);
    // (an order without a lead: as before, every shell at 45)
    expect(leadTicks(900, LEGACY_LEAD)).toBe(Math.min(40, 900 / 45));
  });

  it('a round that speeds up takes as long as its speeding-up flight does', () => {
    // (a missile from 14 gaining 0.9 a tick to 44: stepped tick by tick, about what leadTicks says)
    const l = { v: 14, a: 0.9, max: 44 };
    for (const d of [200, 600, 1200]) {
      let x = 0, v = l.v, t = 0;
      while (x < d) { x += v; v = Math.min(l.max, v + l.a); t++; }
      expect(Math.abs(leadTicks(d, l) - t)).toBeLessThan(1.5);
    }
    // (faster than at its launch speed, slower than at its top)
    expect(leadTicks(1200, l)).toBeLessThan(1200 / 14);
    expect(leadTicks(1200, l)).toBeGreaterThan(1200 / 44);
  });

  it('a gun\'s round: a straight shell at its launch speed, a homing one speeding up as it flies, a beam at once', () => {
    const rail = defOf('railgun_rail_driver');
    expect(roundLead(rail)).toEqual({ v: rail.speed, a: 0, max: rail.speed });
    expect(roundLead({ speed: 14, homing: 3, accel: 0.9, maxSpeed: 44 } as WeaponTuning)).toEqual({ v: 14, a: 0.9, max: 44 });
    // (a torpedo that neither homes nor steers never speeds up: server Weapons flies it at its launch speed)
    expect(roundLead({ speed: 6, accel: 0.12, maxSpeed: 15 } as WeaponTuning)).toEqual({ v: 6, a: 0, max: 6 });
    expect(leadTicks(900, roundLead({ type: 'beam', dps: 50 } as WeaponTuning))).toBeLessThan(1);
  });

  it('a loadout leads by its main gun, and its reach and lobs are as before', () => {
    const l = aiLoadout(tuning, armed('railgun_rail_driver'), AI_BEAM_REACH);
    const rail = defOf('railgun_rail_driver');
    expect(l.lead?.v).toBe(rail.speed);
    expect(l.reach).toBe((rail.maxSpeed ?? rail.speed ?? 30) * (rail.life ?? 60));
    expect(l.lobs).toBe(false);
    const pip = aiLoadout(tuning, armed('cannon_pip'), AI_BEAM_REACH);
    expect(pip.lead?.v).toBe(defOf('cannon_pip').speed);
  });

  it('the lead rides the order as whole numbers, the mates after it, and every end reads it back alike', () => {
    const lead = { v: 150, a: 0, max: 150 };
    const want = orderEngage(4250, 700, 1800, false, 0.05, 9, 0.5, -0.6, [4252, 4249], false, lead);
    for (const v of want) expect(Number.isInteger(v)).toBe(true);
    expect(want.slice(ORDER_LEAD, ENGAGE_MATES)).toEqual(leadPlaces(lead));
    expect(leadAt(want, ORDER_LEAD)).toEqual(lead);
    expect(orderPack(4250, want)).toEqual([4249, 4250, 4252]);
    // (a custom enemy's order keeps the mates, not the lead)
    const c = customOrder(want, AI_ORDER.CUSTOM, 0, 0, null);
    expect(c.slice(CO.MATES)).toEqual(want.slice(ENGAGE_MATES));
    // (a freighter's too)
    expect(leadAt(orderHaul(null, 1500, 0.05, 9, false, lead), ORDER_LEAD)).toEqual(lead);
    expect(leadAt(orderHaul(null, 1500, 0.05, 9), ORDER_LEAD)).toEqual(LEGACY_LEAD);
  });

  it('the pilot leads a crossing target by its own round: a fast round less, a slow round more', () => {
    const kind = bodyKindOf('ai');
    const me = { x: 0, y: 0, angle: 0, vx: 0, vy: 0 }, tg = { x: 1000, y: 0, angle: 0, vx: 0, vy: 12 };
    const fly = (lead?: { v: number; a: number; max: number }) => {
      const s = bodyStateOfSync(syncArgs({ kind, homeX: 0, homeY: 0, stage: 1, side: 1, target: 2, want: orderEngage(1, 700, 3000, false, 0, 0, 0, undefined, undefined, false, lead), wantAt: 0, on: true }), 0);
      return aiPilot(s, me, tg, null, 10, 1, 0);
    };
    const fast = fly({ v: 150, a: 0, max: 150 }), slow = fly({ v: 38, a: 0, max: 38 }), old = fly();
    // (the lead is the target's crossing over the flight: atan(12 t / 1000))
    expect(fast.tof).toBeCloseTo(1000 / 150, 9);
    expect(slow.tof).toBeCloseTo(1000 / 38, 9);
    expect(old.tof).toBeCloseTo(1000 / 45, 9);
    expect(fast.aim!).toBeLessThan(old.aim!);
    expect(slow.aim!).toBeGreaterThan(old.aim!);
    expect(fast.aim!).toBeCloseTo(Math.atan2(12 * (1000 / 150), 1000), 3);
  });
});
