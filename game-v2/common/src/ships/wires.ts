/**
 * Power wires: an overlay drawn over the hull that carries power from the
 * generators to what makes, stores or draws it (docs/parts-redesign.md §4).
 *
 * A wire is segments between neighbouring grid cells (8-neighbour), each end a
 * cell's integer coordinates (Blueprint.wires). A cell is live while an intact
 * part covers it; a segment is live while both its cells are. Live segments
 * join into networks: a part joins every network with a live wire node (a
 * segment's end) inside it, so parts bridge the networks they sit on, and a
 * part touching a generator is plugged straight into it, no wire needed.
 * Modules touching modules share nothing else: destroy the block under a wire
 * and it's cut there, and whatever was beyond it loses its power.
 *
 * A design without wires (enemies' ships, old designs) is auto-wired once:
 * autoWire, a shortest-path tree over the cells under its parts from its
 * generators out to every part that makes, stores or draws power.
 */

import type { Blueprint, FunctionDef, WireSeg } from './types.js';
import type { Catalog } from './catalog.js';
import type { PlacedGeom } from './grid.js';
import { placeGeometry } from './grid.js';

/** Cells are packed as one number: x and y each offset into 0..4095 */
const OFF = 2048, SPAN = 4096;
export const cellKey = (x: number, y: number): number => (x + OFF) * SPAN + (y + OFF);
export const cellOf = (k: number): [number, number] => [Math.floor(k / SPAN) - OFF, (k % SPAN) - OFF];

/** The most segments a design may carry */
export const MAX_WIRES = 2048;

/** Two cells are neighbours (8-neighbour, not the same cell) */
export function isNeighbour(x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  return dx <= 1 && dy <= 1 && dx + dy > 0;
}

/** A segment the same way round whichever end it was drawn from (the lower cell first) */
export function normWire(w: WireSeg): WireSeg {
  const [x0, y0, x1, y1] = w;
  return x0 < x1 || (x0 === x1 && y0 <= y1) ? [x0, y0, x1, y1] : [x1, y1, x0, y0];
}

export const wireId = (w: WireSeg): string => normWire(w).join(',');

/** Wires as saved: whole-number neighbouring ends, each segment once, in a stable order */
export function cleanWires(raw: unknown): WireSeg[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>(), out: WireSeg[] = [];
  for (const w of raw) {
    if (!Array.isArray(w) || w.length !== 4 || !w.every((v) => Number.isInteger(v) && Math.abs(v) < OFF)) continue;
    if (!isNeighbour(w[0], w[1], w[2], w[3])) continue;
    const n = normWire(w as WireSeg), id = n.join(',');
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(n);
    if (out.length >= MAX_WIRES) break;
  }
  return out.sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[3] - b[3] || a[2] - b[2]);
}

/** What wiring costs (wire spools, each laying this many segments) */
export const SEGMENTS_PER_SPOOL = 4;
export const WIRE_ITEM = 'wire_spool';

/** Segments in `next` that `prev` didn't have */
export function addedWires(prev: WireSeg[] | undefined, next: WireSeg[] | undefined): number {
  const had = new Set((prev ?? []).map(wireId));
  return (next ?? []).filter((w) => !had.has(wireId(w))).length;
}

/** Spools to lay `segments` new segments */
export function wireSpools(segments: number): number {
  return Math.ceil(Math.max(0, segments) / SEGMENTS_PER_SPOOL);
}

/** Does this part make, store or draw power (what wires are for) */
export function isPowerPart(fn: FunctionDef | undefined): boolean {
  return !!fn && ((fn.produce ?? 0) > 0 || (fn.store ?? 0) > 0 || (fn.demand ?? 0) > 0);
}

/**
 * Worked out once a layout (designs are edited in place, and a regraded enemy
 * is a new object each spawn laid out the same): the last few, by layout
 */
const CELLS = new Map<string, Map<number, number[]>>();
const AUTO = new Map<string, WireSeg[]>();
const layoutKey = (bp: Blueprint) => bp.parts.map((p) => `${p.fn}:${p.piece}:${p.x}:${p.y}:${p.rot}:${p.flip ? 1 : 0}`).join('|');
function remember<T>(cache: Map<string, T>, key: string, v: T): T {
  cache.set(key, v);
  if (cache.size > 96) cache.delete(cache.keys().next().value!);
  return v;
}

/** Each cell under a part: the parts covering it (indices) */
export function wireCells(catalog: Catalog, bp: Blueprint, geoms?: PlacedGeom[], key = layoutKey(bp)): Map<number, number[]> {
  const known = CELLS.get(key);
  if (known) return known;
  const cells = new Map<number, number[]>();
  const gs = geoms ?? bp.parts.map((p) => placeGeometry(catalog, p));
  gs.forEach((g, i) => {
    for (const [x, y] of g.cells) {
      const k = cellKey(x, y), list = cells.get(k);
      if (list) { if (!list.includes(i)) list.push(i); } else cells.set(k, [i]);
    }
  });
  return remember(CELLS, key, cells);
}

/** The 8 neighbours, the straight ones first (and cheaper: a wire runs straight where it can) */
const STEPS: [number, number, number][] = [[1, 0, 2], [0, 1, 2], [-1, 0, 2], [0, -1, 2], [1, 1, 3], [-1, 1, 3], [-1, -1, 3], [1, -1, 3]];


/**
 * A design's wiring as the hangar's Auto-wire button lays it: from the biggest
 * generator, the nearest part that makes, stores or draws power is reached by
 * the shortest run over the cells under the ship's parts, then the next nearest
 * from anything already wired (other generators too), until every one is. The
 * same object each time for the same layout.
 */
export function autoWire(bp: Blueprint, catalog: Catalog, key = layoutKey(bp)): WireSeg[] {
  const done = AUTO.get(key);
  if (done) return done;
  const cells = wireCells(catalog, bp, undefined, key);
  const fns = bp.parts.map((p) => catalog.functions.get(p.fn));
  const partCells: number[][] = bp.parts.map(() => []);
  for (const [k, list] of cells) for (const i of list) partCells[i].push(k);
  const gens = bp.parts.map((_, i) => i).filter((i) => (fns[i]?.produce ?? 0) > 0)
    .sort((a, b) => partCells[b].length - partCells[a].length || a - b);
  const out: WireSeg[] = [];
  if (gens.length) {
    const wanted = new Set(bp.parts.map((_, i) => i).filter((i) => i !== gens[0] && isPowerPart(fns[i]) && partCells[i].length));
    const tree = new Set<number>(partCells[gens[0]]);
    const seen = new Set<string>();
    const lay = (a: number, b: number) => {
      const [x0, y0] = cellOf(a), [x1, y1] = cellOf(b), w = normWire([x0, y0, x1, y1]), id = w.join(',');
      if (!seen.has(id)) { seen.add(id); out.push(w); }
    };
    while (wanted.size) {
      // A part sharing a cell with what's wired already (a bespoke hull's overlapping pieces): a stub from that cell to
      // the next makes it a wire node, joining it
      for (const i of [...wanted]) {
        const c = partCells[i].find((k) => tree.has(k));
        if (c === undefined) continue;
        const [x, y] = cellOf(c);
        const next = STEPS.map(([dx, dy]) => cellKey(x + dx, y + dy)).filter((k) => cells.has(k));
        const to = next.find((k) => tree.has(k)) ?? next[0];
        if (to !== undefined) { lay(c, to); tree.add(to); }
        wanted.delete(i);
        for (const k of partCells[i]) tree.add(k);
      }
      if (!wanted.size) break;
      // Dial's algorithm out from the tree (costs 2 straight, 3 diagonal) until a wanted part's cell is reached
      const dist = new Map<number, number>(), from = new Map<number, number>();
      const buckets: number[][] = [[...tree].sort((a, b) => a - b)];
      for (const k of tree) dist.set(k, 0);
      let hit = -1;
      for (let d = 0; d < buckets.length && hit < 0; d++) {
        for (const k of buckets[d] ?? []) {
          if (dist.get(k) !== d) continue;
          if (!tree.has(k) && cells.get(k)!.some((i) => wanted.has(i))) { hit = k; break; }
          const [x, y] = cellOf(k);
          for (const [dx, dy, c] of STEPS) {
            const n = cellKey(x + dx, y + dy);
            if (!cells.has(n) || (dist.get(n) ?? Infinity) <= d + c) continue;
            dist.set(n, d + c);
            from.set(n, k);
            (buckets[d + c] ??= []).push(n);
          }
        }
      }
      if (hit < 0) break;
      // Its run back to the tree; it and the part(s) it reached join the tree
      for (let k = hit; !tree.has(k); k = from.get(k)!) lay(from.get(k)!, k);
      for (let k = hit; !tree.has(k); k = from.get(k)!) tree.add(k);
      for (const i of cells.get(hit)!) if (wanted.delete(i)) for (const c of partCells[i]) tree.add(c);
    }
  }
  return remember(AUTO, key, cleanWires(out));
}

/** The wires a design runs on: its own, or auto-wired */
export function wiresOf(bp: Blueprint, catalog: Catalog, key?: string): WireSeg[] {
  return bp.wires ?? autoWire(bp, catalog, key);
}

export interface WireNetworks {
  wires: WireSeg[];
  /** Per part: its network, -1 for none (no live wire in it, no generator beside it) */
  network: number[];
  /** Each network's parts */
  nets: number[][];
  /** Per segment: live, and its network (-1: cut) */
  live: boolean[];
  segNet: number[];
}

/**
 * Which parts share power: the networks the live wires make, the parts on
 * them, and what's plugged straight into a generator. `alive`: parts still on
 * the ship; `joins`: which touch.
 */
export function wireNetworks(catalog: Catalog, bp: Blueprint, geoms: PlacedGeom[], alive: boolean[], joins: [number, number][]): WireNetworks {
  const n = bp.parts.length, key = layoutKey(bp);
  const wires = wiresOf(bp, catalog, key);
  const cells = wireCells(catalog, bp, geoms, key);
  const fns = bp.parts.map((p) => catalog.functions.get(p.fn));
  // Union-find over parts (0..n-1) and wire nodes (n..)
  const parent: number[] = Array.from({ length: n }, (_, i) => i);
  const node = new Map<number, number>();
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };
  const nodeOf = (k: number) => { let i = node.get(k); if (i === undefined) { i = parent.length; parent.push(i); node.set(k, i); } return i; };
  const liveCell = (k: number) => cells.get(k)?.some((i) => alive[i]) ?? false;
  const live = wires.map(([x0, y0, x1, y1]) => liveCell(cellKey(x0, y0)) && liveCell(cellKey(x1, y1)));
  wires.forEach(([x0, y0, x1, y1], s) => { if (live[s]) union(nodeOf(cellKey(x0, y0)), nodeOf(cellKey(x1, y1))); });
  // Every part with a live wire node in it joins that node's network
  for (const [k, i] of node) for (const p of cells.get(k) ?? []) if (alive[p]) union(p, i);
  // Plugged straight into a generator
  const gen = (i: number) => (fns[i]?.produce ?? 0) > 0;
  for (const [a, b] of joins) if (alive[a] && alive[b] && (gen(a) || gen(b))) union(a, b);
  // A network: what a wire node or a generator joins (a part on its own, unwired, is on none)
  const wired = new Set<number>();
  for (const i of node.values()) wired.add(find(i));
  for (let i = 0; i < n; i++) if (alive[i] && gen(i)) wired.add(find(i));
  const index = new Map<number, number>();
  const network = new Array<number>(n).fill(-1);
  const nets: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    const r = find(i);
    if (!wired.has(r)) continue;
    let k = index.get(r);
    if (k === undefined) { k = nets.length; index.set(r, k); nets.push([]); }
    nets[k].push(i);
    network[i] = k;
  }
  const segNet = wires.map(([x0, y0], s) => (live[s] ? index.get(find(node.get(cellKey(x0, y0))!)) ?? -1 : -1));
  return { wires, network, nets, live, segNet };
}

/** Joins between parts on the same network (what the hangar draws power along) */
export function netJoins(joins: [number, number][], network: number[]): [number, number][] {
  return joins.filter(([a, b]) => network[a] >= 0 && network[a] === network[b]);
}
