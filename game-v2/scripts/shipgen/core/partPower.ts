// What one part does in the power core, read from a one-part layout (power/layout.ts), so the legend's numbers are the
// core's own: a new store, generator or consumer kind shows up with no edit here.
import type { Blueprint, FunctionDef, Side } from '../../../common/src/ships/index';
import {
  GUN_BEAM, GUN_CLIP, ROLE_DYNAMO, ROLE_GEN, ROLE_RELAY, ROLE_THRUSTER, ROLE_TOOL, ROLE_WEAPON, fromEu, partNeedsFacing,
} from '../../../common/src/ships/index';
import type { ShipgenContext } from './context';
import { shipEnergy } from './sim';
import { pieceShapes } from './shapes';

export type PowerRole = 'generator' | 'store' | 'conduit' | 'diode' | 'dynamo' | 'weapon' | 'thruster' | 'tool' | 'core' | 'none';

export interface PartPower {
  role: PowerRole;
  /** E/s made (generators, dynamos) */
  makes?: number;
  /** Relays: E held, and E/s it can give and take */
  holds?: number;
  gives?: number;
  takes?: number;
  /** Consumers: E/s it uses flat out (a gun firing on its beat, a beam lit, an engine cruising, a tool working) */
  uses?: number;
  /** Engines: E/s while boosting */
  boostUses?: number;
  /** Consumers: E/s it can take in, and E it buffers */
  intake?: number;
  buffer?: number;
  /** Guns: 'shot' | 'clip' | 'beam' */
  gun?: 'shot' | 'clip' | 'beam';
}

const perSec = (euTick: number) => Math.round(fromEu(euTick) * 60 * 10) / 10;
const cache = new WeakMap<ShipgenContext, Map<string, PartPower>>();

export function partPower(ctx: ShipgenContext, fn: FunctionDef, piece: string, material: string): PartPower {
  let m = cache.get(ctx);
  if (!m) cache.set(ctx, (m = new Map()));
  const key = `${fn.id}|${piece}|${material}`;
  const hit = m.get(key);
  if (hit) return hit;
  const out = compute(ctx, fn, piece, material);
  m.set(key, out);
  return out;
}

function compute(ctx: ShipgenContext, fn: FunctionDef, piece: string, material: string): PartPower {
  if (fn.id === 'core') {
    // (The core's numbers are the tuning's, given only to a live core: a core touching a generator)
    const L = shipEnergy(ctx, { name: 'x', catalogVersion: ctx.catalog.version, parts: [{ uid: 0, piece, fn: 'core', material, x: 0, y: 0, rot: 0, flip: false }] }).L;
    return { role: 'core', holds: Math.round(fromEu(L.cap[0])), gives: perSec(L.give[0]), takes: perSec(L.take[0]) };
  }
  // (Beside a core, at its west: a part with no core is cut off and dead)
  // (facing a straight side of the piece as placed: N if it has one)
  const flat = pieceShapes(ctx.catalog, piece).classes[0].flat;
  const facing: Side | undefined = partNeedsFacing(fn.id) ? (flat.includes('N') ? 'N' : flat[0] ?? 'N') : undefined;
  const bp: Blueprint = { name: 'x', catalogVersion: ctx.catalog.version, parts: [
    { uid: 0, piece: 'sq', fn: 'core', material: 'alloy', x: -1, y: 0, rot: 0, flip: false },
    { uid: 1, piece, fn: fn.id, material, x: 0, y: 0, rot: 0, flip: false, ...(facing ? { facing } : {}) },
  ] };
  let se;
  try { se = shipEnergy(ctx, bp); } catch { return { role: 'none' }; }
  const L = se.L;
  const r = L.role[1];
  if (r === ROLE_GEN) return { role: 'generator', makes: perSec(L.rate[1]) };
  if (r === ROLE_DYNAMO) return { role: 'dynamo', makes: perSec(L.rate[1]) };
  if (r === ROLE_RELAY) {
    const role: PowerRole = fn.oneWay ? 'diode' : fn.relayOnly ? 'conduit' : 'store';
    return { role, holds: Math.round(fromEu(L.cap[1])), gives: perSec(L.give[1]), takes: perSec(L.take[1]) };
  }
  if (r === ROLE_THRUSTER) {
    return { role: 'thruster', uses: perSec(L.burn[1]), ...(L.bBurn[1] > L.burn[1] ? { boostUses: perSec(L.bBurn[1]) } : {}), intake: perSec(L.rate[1]), buffer: Math.round(fromEu(L.cap[1])) };
  }
  if (r === ROLE_TOOL) return { role: 'tool', uses: perSec(L.rate[1]) };
  if (r === ROLE_WEAPON) {
    const g = L.gun[1];
    const interval = se.interval.get(1) ?? fn.fireInterval ?? 60;
    const uses = g === GUN_BEAM ? perSec(L.shot[1]) : Math.round((fromEu(L.shot[1]) * 60 / interval) * 10) / 10;
    return { role: 'weapon', gun: g === GUN_BEAM ? 'beam' : g === GUN_CLIP ? 'clip' : 'shot', uses, intake: perSec(L.rate[1]), buffer: Math.round(fromEu(L.cap[1])) };
  }
  return { role: 'none' };
}
