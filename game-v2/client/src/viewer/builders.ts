/**
 * Blueprints for the viewer's synthetic assets: a part model on a stub of hull (or alone), a material's test block,
 * a piece alone. Pure (common only): what they are is decided here, the page just draws them.
 */

import { attachSide, createShipState, mountingOf, placeGeometry, rebuild, type Blueprint, type Catalog, type PlacedPart, type ShipState, type ShipTuning, type Side, coreIndex } from '@space-game/common';
import type { AssetRef } from './assets';

const STEP: Record<Side, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const OPPOSITE: Record<Side, Side> = { N: 'S', E: 'W', S: 'N', W: 'E' };

const part = (uid: number, piece: string, fn: string, material: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart =>
  ({ uid, piece, fn, material, x, y, rot: 0, flip: false, ...extra });

/** Does a function point (weapons, engines, mining and such), and which way by default (engines' exhaust: S) */
export function defaultFacing(catalog: Catalog, fnId: string): Side | null {
  const f = catalog.functions.get(fnId);
  if (!f) return null;
  if (f.weapon) return 'N';
  return f.pointing ?? null;
}

/**
 * A model alone, or bolted to a row of hull along the edge it attaches by (its mounting rules' attach side; else
 * opposite its facing; unpointed parts sit on hull below them)
 */
export function modelBlueprint(catalog: Catalog, fnId: string, opts: { facing?: Side | 'auto'; stub?: boolean } = {}): Blueprint {
  const f = catalog.functions.get(fnId);
  if (!f) throw new Error(`no model "${fnId}"`);
  const piece = f.pieces?.[0] ?? 'sq';
  const facing = opts.facing && opts.facing !== 'auto' && defaultFacing(catalog, fnId) ? opts.facing : defaultFacing(catalog, fnId);
  const p = part(0, piece, fnId, f.material ?? 'alloy', 0, 0, facing ? { facing } : {});
  const parts: PlacedPart[] = [p];
  if (opts.stub !== false) {
    const m = mountingOf(catalog, f);
    const attach: Side = facing ? (m?.rules ? attachSide(facing, m.angle, false) : OPPOSITE[facing]) : 'S';
    const cells = placeGeometry(catalog, p).cells;
    const own = new Set(cells.map(([x, y]) => `${x},${y}`));
    const [dx, dy] = STEP[attach];
    const seen = new Set<string>();
    for (const [x, y] of cells) {
      const k = `${x + dx},${y + dy}`;
      if (own.has(k) || seen.has(k)) continue;
      seen.add(k);
      parts.push(part(parts.length, 'sq', 'hull', 'alloy', x + dx, y + dy));
    }
  }
  return { name: f.name ?? fnId, catalogVersion: 1, parts };
}

/** A material's test block: a capped 2×2 of hull with a strip of armour under it, all in it */
export function materialBlueprint(catalog: Catalog, matId: string): Blueprint {
  const m = catalog.materials.get(matId);
  if (!m) throw new Error(`no material "${matId}"`);
  return {
    name: m.name ?? matId, catalogVersion: 1,
    parts: [part(0, 'cap', 'hull', matId, 0, -1), part(1, 'block2', 'hull', matId, 0, 0), part(2, 'rect2', 'armor', matId, 0, 2)],
  };
}

/** A piece alone, in alloy hull */
export function pieceBlueprint(catalog: Catalog, pieceId: string): Blueprint {
  if (!catalog.pieces.has(pieceId)) throw new Error(`no piece "${pieceId}"`);
  return { name: pieceId, catalogVersion: 1, parts: [part(0, pieceId, 'hull', 'alloy', 0, 0)] };
}

/** The blueprint a ref shows (ships come from `ships`, by path); null if it names nothing */
export function refBlueprint(catalog: Catalog, ref: AssetRef, ships: Map<string, Blueprint>, opts: { facing?: Side | 'auto'; stub?: boolean } = {}): Blueprint | null {
  try {
    if (ref.kind === 'ship') return ships.get(ref.key) ?? null;
    if (ref.kind === 'model') return modelBlueprint(catalog, ref.key, { ...opts, facing: ref.facing ?? opts.facing });
    if (ref.kind === 'material') return materialBlueprint(catalog, ref.key);
    return pieceBlueprint(catalog, ref.key);
  } catch {
    return null;
  }
}

/** A blueprint uses a design's own pieces (data/ships/bespoke) */
export function usesBespoke(catalog: Catalog, bp: Blueprint): boolean {
  return bp.parts.some((p) => catalog.pieces.get(p.piece)?.bespoke);
}

/** A ship to show: as the game makes it, but held together from its biggest piece when it has no core (a model, block or piece) */
export function viewerShip(catalog: Catalog, tuning: ShipTuning, id: number, bp: Blueprint): ShipState {
  const ship = createShipState(catalog, tuning, id, bp, 0);
  if (coreIndex(bp.parts) < 0) {
    ship.derived = rebuild({ catalog, tuning, blueprint: ship.blueprint, hp: ship.hp, maxHp: ship.maxHp, detached: ship.detached, rootMode: 'largest' });
  }
  // (flames are a look here: an engine with no power to push gets a token push along its facing, so it can burn)
  for (const t of ship.derived.thrusters) {
    const f = bp.parts[t.part].facing;
    if (t.force[0] === 0 && t.force[1] === 0 && f) t.force = [-STEP[f][0], -STEP[f][1]];
  }
  return ship;
}
