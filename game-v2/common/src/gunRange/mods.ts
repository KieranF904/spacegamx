/**
 * @contract common.gun-range.mods
 * owns:       the gun range's weapon modifiers: the parts one effect takes (rangeModNeed: its mount, its blocks, a hopper
 *             or a reactor for a special) and the deck of them a cheat ship carries behind its gun (buildModDeck)
 * needs:      ships/{catalog, types, grid}, ships/power/portsFrame (where a placed part's ports and sockets sit),
 *             ships/modifiers/types (the tuning block: kinds, recipes)
 * invariants: every weapon model whose shot spends energy takes every effect, alone and four together, and its layout
 *             gives the gun just the effects asked for; a gun fed by ammunition alone takes none, as on any ship —
 *             common/src/gunRange/mods.test.ts
 * extend:     a new effect needs nothing here (its kind or recipe in tuning.json modifiers says what it takes); a gun
 *             whose power port faces another way is a case in portOf()
 *
 * The deck (north is up, the gun above it): one mount for each effect, in a line out of the gun's power port, each
 * mount's out-port to the gun; its blocks against its sockets on one side, and beyond a special's block the hopper of
 * its material (or, for one that takes power, a reactor into it); a reactor at the line's far end. A port at the gun's
 * back takes the line straight down, one at its side takes it along the gun's back row with the blocks below.
 * How strong an effect is there is not the deck's business: a range ship's are all at full strength (rebuild.ts).
 */

import type { Catalog } from '../ships/catalog.js';
import { SIDE_NORMAL } from '../ships/catalog.js';
import type { PlacedPart, Rot, Side, Vec2 } from '../ships/types.js';
import type { ModifierTuning } from '../ships/modifiers/types.js';
import { placeGeometry } from '../ships/grid.js';
import { frameOf, placeEdge } from '../ships/power/portsFrame.js';

/** The reactor a deck's line ends in, and that feeds a block that takes power */
const REACTOR = 'power_cell_reactor';
const OPPOSITE: Record<Side, Side> = { N: 'S', S: 'N', E: 'W', W: 'E' };

/** A cheat ship's modifiers: the tuning block and the effects wanted (by name, tuning.json modifiers.effects) */
export interface RangeMods { tuning: ModifierTuning; effects: readonly string[] }

/** One block of an effect: its part, and what a special's takes beside it (a hopper, or a reactor into it) */
export interface RangeModBlock { fn: string; feeder?: string; powered?: boolean }
/** The parts one effect takes: a mount with a socket for each of its blocks */
export interface RangeModNeed { mount: string; blocks: RangeModBlock[] }

/** The parts one effect takes (null: no kind or recipe of the tuning's makes it, or a part of it is missing) */
export function rangeModNeed(catalog: Catalog, mt: ModifierTuning, effect: string): RangeModNeed | null {
  const kind = Object.keys(mt.kinds).find((k) => mt.kinds[k].effect === effect);
  const kinds = kind ? [kind] : mt.recipes.find((r) => r.effect === effect)?.parts;
  if (!kinds?.length) return null;
  const fns = [...catalog.functions.values()].filter((f) => f.model && !f.legacy && !f.exclusive);
  const mount = fns.find((f) => f.modMount?.sockets.length === kinds.length);
  if (!mount) return null;
  const blocks: RangeModBlock[] = [];
  for (const k of kinds) {
    const block = fns.find((f) => f.plug === k), needs = mt.kinds[k]?.needs;
    if (!block) return null;
    if (needs?.mat) {
      const hopper = fns.find((f) => f.hopper?.mat === needs.mat);
      if (!hopper) return null;
      blocks.push({ fn: block.id, feeder: hopper.id });
    } else if (needs?.power) {
      if (!catalog.functions.has(REACTOR)) return null;
      blocks.push({ fn: block.id, feeder: REACTOR, powered: true });
    } else blocks.push({ fn: block.id });
  }
  return { mount: mount.id, blocks };
}

/** Every part an effect takes (what a pilot must be able to fit to try it) */
export function rangeModParts(need: RangeModNeed): string[] {
  return [need.mount, ...need.blocks.flatMap((b) => (b.feeder ? [b.fn, b.feeder] : [b.fn]))];
}

/** Does this gun take modifiers at all: they treat the energy of its shot, and one fed by ammunition alone spends none (power/portsBuild.ts) */
export function rangeGunModded(catalog: Catalog, fn: string): boolean {
  const f = catalog.functions.get(fn);
  return !!f?.weapon && !!f.fire && f.fire.model !== 'ammo';
}

interface Edge { x: number; y: number; side: Side; nx: number; ny: number }
/** A part turned as wanted, at the origin: its cells and where its ports and sockets sit */
interface Turned { part: PlacedPart; cells: Vec2[]; in?: Edge; out?: Edge; sockets: Edge[] }

/** Turn (and mirror) a part until its ports and sockets face as wanted, else null */
function turn(catalog: Catalog, fn: string, want: { in?: Side; out?: Side; socket?: Side }): Turned | null {
  const f = catalog.functions.get(fn);
  if (!f || !Array.isArray(f.pieces) || !f.pieces.length || !catalog.pieces.get(f.pieces[0])) return null;
  for (const flip of [false, true]) {
    for (const rot of [0, 1, 2, 3] as Rot[]) {
      const part: PlacedPart = { uid: 0, piece: f.pieces[0], fn, material: f.material ?? 'alloy', x: 0, y: 0, rot, flip };
      const cells = placeGeometry(catalog, part).cells, F = frameOf(part, cells);
      const port = (dir: 'in' | 'out') => { const p = f.ports?.find((q) => q.dir === dir); return p ? placeEdge(part, F, p.side, p.cell ?? 0) : undefined; };
      const t: Turned = { part, cells, in: port('in'), out: port('out'), sockets: (f.modMount?.sockets ?? []).map((s) => placeEdge(part, F, s.side, s.cell ?? 0)) };
      if (want.in && t.in?.side !== want.in) continue;
      if (want.out && t.out?.side !== want.out) continue;
      if (want.socket && !(t.sockets.length && t.sockets.every((s) => s.side === want.socket))) continue;
      return t;
    }
  }
  return null;
}

/** The gun's power port the deck's line comes out of: one at its back, else one at a side of its back row */
function portOf(catalog: Catalog, gun: PlacedPart): Edge | null {
  const f = catalog.functions.get(gun.fn);
  const cells = placeGeometry(catalog, gun).cells, F = frameOf(gun, cells);
  const has = (x: number, y: number) => cells.some((c) => c[0] === x && c[1] === y);
  const back = Math.max(...cells.map((c) => c[1]));
  const ins = (f?.ports ?? []).filter((p) => p.dir === 'in').map((p) => placeEdge(gun, F, p.side, p.cell ?? 0)).filter((e) => !has(e.nx, e.ny));
  return ins.find((e) => e.side === 'S' && e.y === back) ?? ins.find((e) => (e.side === 'W' || e.side === 'E') && e.y === back) ?? null;
}

/**
 * The deck for a placed gun (firing north): its parts, where they go beside it (uids left at 0: the ship numbers them).
 * Null: a gun that takes none, an effect that can't be made, or a gun with no port a line can come out of.
 */
export function buildModDeck(catalog: Catalog, gun: PlacedPart, mods: RangeMods): PlacedPart[] | null {
  const port = rangeGunModded(catalog, gun.fn) ? portOf(catalog, gun) : null;
  if (!port || !mods.effects.length) return null;
  const d = port.side, s: Side = d === 'S' ? 'W' : 'S', sn = SIDE_NORMAL[s];
  const used = new Set(placeGeometry(catalog, gun).cells.map((c) => `${c[0]},${c[1]}`));
  const out: PlacedPart[] = [];
  /** Put a turned part down with its cell `from` on `to` (false: on top of another) */
  const put = (t: Turned | null, from: readonly [number, number], to: readonly [number, number]): { dx: number; dy: number } | null => {
    if (!t) return null;
    const dx = to[0] - from[0], dy = to[1] - from[1];
    for (const c of t.cells) { const k = `${c[0] + dx},${c[1] + dy}`; if (used.has(k)) return null; used.add(k); }
    out.push({ ...t.part, x: t.part.x + dx, y: t.part.y + dy });
    return { dx, dy };
  };
  const cell = (t: Turned | null): readonly [number, number] => (t ? [t.cells[0][0], t.cells[0][1]] : [0, 0]);
  let at: readonly [number, number] = [port.nx, port.ny];
  for (const effect of mods.effects) {
    const need = rangeModNeed(catalog, mods.tuning, effect);
    const mount = need ? turn(catalog, need.mount, { in: d, out: OPPOSITE[d], socket: s }) : null;
    if (!need || !mount?.in || !mount.out) return null;
    const m = put(mount, [mount.out.x, mount.out.y], at);
    if (!m) return null;
    for (let i = 0; i < need.blocks.length; i++) {
      const b = need.blocks[i], sock = mount.sockets[i], to = [sock.nx + m.dx, sock.ny + m.dy] as const;
      const block = turn(catalog, b.fn, b.powered ? { in: s } : {});
      if (!put(block, cell(block), to)) return null;
      if (!b.feeder) continue;
      const feeder = turn(catalog, b.feeder, b.powered ? { out: OPPOSITE[s] } : {});
      if (!put(feeder, cell(feeder), [to[0] + sn[0], to[1] + sn[1]])) return null;
    }
    at = [mount.in.nx + m.dx, mount.in.ny + m.dy];
  }
  const reactor = turn(catalog, REACTOR, { out: OPPOSITE[d] });
  return put(reactor, cell(reactor), at) ? out : null;
}
