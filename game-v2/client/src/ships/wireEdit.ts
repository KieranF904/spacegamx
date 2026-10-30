/**
 * The hangar's wire tool, as plain functions: laying a run of segments across
 * the cells the mouse drags over, erasing them, dropping what no longer lies on
 * the hull, what the wiring costs in spools against the saved design (as the
 * server's Hangar charges it), and the power overlay's report: each network in
 * its own colour, its generators and batteries, and what's left without power
 * ("Pip on the left wing has no power").
 */

import { cellKey, cleanWires, isNeighbour, isPowerPart, normWire, wireId, wireSpools, type Blueprint, type Catalog, type PlacedGeom, type ShipDerived, type WireSeg } from '@space-game/common';

export type Cell = [number, number];

/** The cell a grid point is in */
export const cellAt = (x: number, y: number): Cell => [Math.floor(x), Math.floor(y)];

/**
 * The cells from `a` to `b`, each a neighbour of the one before (diagonal
 * steps while both axes are behind, then straight): a fast drag still lays an
 * unbroken run
 */
export function stepCells(a: Cell, b: Cell): Cell[] {
  const out: Cell[] = [[a[0], a[1]]];
  let [x, y] = a;
  for (let k = 0; k < 4096 && (x !== b[0] || y !== b[1]); k++) {
    const dx = b[0] - x, dy = b[1] - y;
    // (along the longer axis, diagonally only while the shorter one is as far behind as a straight line would leave it)
    const ax = Math.abs(dx), ay = Math.abs(dy);
    const sx = Math.sign(dx), sy = Math.sign(dy);
    if (ax > 0 && ay > 0 && Math.min(ax, ay) * 2 >= Math.max(ax, ay)) { x += sx; y += sy; }
    else if (ax >= ay) x += sx;
    else y += sy;
    out.push([x, y]);
  }
  return out;
}

/**
 * Wires with a run along `cells` laid (only between cells under a part: off
 * the hull a wire carries nothing). The same array when nothing was added.
 */
export function layRun(wires: WireSeg[], cells: Cell[], onHull: (x: number, y: number) => boolean): WireSeg[] {
  const have = new Set(wires.map(wireId));
  const add: WireSeg[] = [];
  for (let i = 1; i < cells.length; i++) {
    const [x0, y0] = cells[i - 1], [x1, y1] = cells[i];
    if (!isNeighbour(x0, y0, x1, y1) || !onHull(x0, y0) || !onHull(x1, y1)) continue;
    const w = normWire([x0, y0, x1, y1]), id = wireId(w);
    if (have.has(id)) continue;
    have.add(id);
    add.push(w);
  }
  return add.length ? cleanWires([...wires, ...add]) : wires;
}

/**
 * Wires with what a drag over `cells` erases gone: every segment touching a
 * cell of a single click, and along a drag the segments it runs over (between
 * cells it passed in turn) as well as those touching it
 */
export function eraseRun(wires: WireSeg[], cells: Cell[]): WireSeg[] {
  const at = new Set(cells.map(([x, y]) => cellKey(x, y)));
  const out = wires.filter(([x0, y0, x1, y1]) => !at.has(cellKey(x0, y0)) && !at.has(cellKey(x1, y1)));
  return out.length === wires.length ? wires : out;
}

/** Wires with every segment that has an end off the hull dropped (a part under it taken away) */
export function pruneWires(wires: WireSeg[], onHull: (x: number, y: number) => boolean): WireSeg[] {
  const out = wires.filter(([x0, y0, x1, y1]) => onHull(x0, y0) && onHull(x1, y1));
  return out.length === wires.length ? wires : out;
}

/**
 * What saving this wiring costs, as server/src/game/Hangar.ts charges it:
 * spools for the explicit segments against the saved design's (an auto-wired
 * design's wires are free, and count as none). `spools` < 0 come back.
 */
export function wireBill(saved: WireSeg[] | undefined, now: WireSeg[] | undefined): { segments: number; savedSegments: number; spools: number } {
  const segments = now?.length ?? 0, savedSegments = saved?.length ?? 0;
  return { segments, savedSegments, spools: wireSpools(segments) - wireSpools(savedSegments) };
}

/** Networks' colours in the overlay, in turn; a network with no generator on it is grey */
export const NET_COLORS = ['#fbbf24', '#38bdf8', '#4ade80', '#f472b6', '#a78bfa', '#fb923c', '#2dd4bf', '#e879f9'];
export const DEAD_NET = '#64748b';

export interface PowerNet {
  color: string;
  parts: number[];
  generators: number[];
  batteries: number[];
  supply: number;
  demand: number;
  /** A generator on it */
  powered: boolean;
}

/** Each part's power, as the overlay marks it */
export type PartPower = 'none' | 'powered' | 'short' | 'unpowered' | 'stranded';

export interface PowerReport {
  nets: PowerNet[];
  /**
   * Per part: 'none' (doesn't use power), 'powered', 'short' (a steady load
   * on a network that can't meet it all), 'unpowered' (on no network, or one
   * with nothing to run it on), 'stranded' (a battery with no generator to
   * charge it)
   */
  part: PartPower[];
  /** Per segment: its colour (cut ones null) */
  seg: (string | null)[];
  /** "Pip on the left wing has no power", most important first */
  warnings: string[];
}

/** Where a part sits on the ship, in a pilot's words (forward is -y) */
export function whereOnShip(at: [number, number], centre: [number, number], half: [number, number]): string {
  const nx = (at[0] - centre[0]) / Math.max(1, half[0]), ny = (at[1] - centre[1]) / Math.max(1, half[1]);
  if (Math.abs(nx) > 0.35 && Math.abs(nx) >= Math.abs(ny) * 0.8) return nx < 0 ? 'on the left wing' : 'on the right wing';
  if (ny < -0.3) return 'at the nose';
  if (ny > 0.3) return 'at the tail';
  return 'amidships';
}

/**
 * The power overlay's report: networks from the design's derived state
 * (rebuild: its wires, which are live, which network each part is on), each
 * its own colour, and what lacks power, by name and where it sits
 */
export function powerReport(catalog: Catalog, bp: Blueprint, d: ShipDerived, geoms: PlacedGeom[], name: (i: number) => string): PowerReport {
  const fns = bp.parts.map((p) => catalog.functions.get(p.fn));
  let k = 0;
  const nets: PowerNet[] = d.networks.map((n) => {
    const generators = n.parts.filter((i) => (fns[i]?.produce ?? 0) > 0);
    const batteries = n.parts.filter((i) => (fns[i]?.store ?? 0) > 0);
    return { color: n.powered ? NET_COLORS[k++ % NET_COLORS.length] : DEAD_NET, parts: n.parts, generators, batteries, supply: n.supply, demand: n.demand, powered: n.powered };
  });
  const part: PartPower[] = bp.parts.map((_, i) => {
    const fn = fns[i];
    if (!d.alive[i] || !isPowerPart(fn) || (fn!.produce ?? 0) > 0) return 'none';
    const net = nets[d.network[i]];
    if (!net) return 'unpowered';
    if ((fn!.demand ?? 0) <= 0) return net.powered ? 'powered' : 'stranded';
    // (as rebuild has it: engines and guns run on a network with a generator or a battery, steady loads on its supply)
    const sat = d.satisfaction[i];
    return sat <= 0.005 ? 'unpowered' : sat < 0.995 ? 'short' : 'powered';
  });
  const seg = d.wires.map((_, s) => (d.wireLive[s] && d.wireNet[s] >= 0 ? nets[d.wireNet[s]]?.color ?? DEAD_NET : null));
  // Warnings: like parts in the same place together ("2 Pips on the left wing have no power")
  const xs = geoms.flatMap((g) => g.polygon.map((p) => p[0])), ys = geoms.flatMap((g) => g.polygon.map((p) => p[1]));
  const centre: [number, number] = xs.length ? [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2] : [0, 0];
  const half: [number, number] = xs.length ? [(Math.max(...xs) - Math.min(...xs)) / 2, (Math.max(...ys) - Math.min(...ys)) / 2] : [1, 1];
  const said = new Map<string, { n: number; order: number; text: (n: number) => string }>();
  const say = (key: string, order: number, text: (n: number) => string) => {
    const was = said.get(key);
    if (was) was.n++; else said.set(key, { n: 1, order, text });
  };
  const plural = (s: string, n: number) => (n > 1 ? `${n} ${/(s|sh|ch|x)$/.test(s) ? `${s}es` : `${s}s`}` : s);
  part.forEach((st, i) => {
    if (st === 'none' || st === 'powered' || !geoms[i]) return;
    const nm = name(i), where = whereOnShip(geoms[i].centroid, centre, half);
    if (st === 'unpowered') say(`u:${nm}:${where}`, 0, (n) => `${plural(nm, n)} ${where} ${n > 1 ? 'have' : 'has'} no power`);
    else if (st === 'stranded') say(`s:${nm}:${where}`, 1, (n) => `${plural(nm, n)} ${where} ${n > 1 ? 'have' : 'has'} no generator to charge ${n > 1 ? 'them' : 'it'}`);
    else say(`h:${nm}:${where}`, 2, (n) => `${plural(nm, n)} ${where} ${n > 1 ? 'get' : 'gets'} only ${Math.round(d.satisfaction[i] * 100)}% of ${n > 1 ? 'their' : 'its'} power`);
  });
  // A generator on a network of its own, wired to nothing
  nets.forEach((n) => {
    if (!n.powered || n.parts.some((i) => isPowerPart(fns[i]) && (fns[i]!.produce ?? 0) <= 0)) return;
    for (const i of n.generators) say(`g:${name(i)}:${whereOnShip(geoms[i].centroid, centre, half)}`, 3, (c) => `${plural(name(i), c)} ${whereOnShip(geoms[i].centroid, centre, half)} ${c > 1 ? 'power' : 'powers'} nothing: wire ${c > 1 ? 'them' : 'it'} to what draws power`);
  });
  const warnings = [...said.values()].sort((a, b) => a.order - b.order).map((w) => w.text(w.n));
  return { nets, part, seg, warnings };
}
