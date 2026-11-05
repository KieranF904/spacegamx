/**
 * The hangar's power overlay, as plain functions: each network in its own
 * colour, its generators and batteries, and what's left without power ("Pip on
 * the left wing has no power"); and dropping saved wire that no longer lies on
 * the hull. The wire tool is retired (docs/design/energy-routing-impl.md D1):
 * nothing here lays wire or bills spools. The networks are the old energy
 * system's (it still auto-wires inside until the switch-over); P5 replaces
 * this report with the energy overlay.
 */

import { isPowerPart, type Blueprint, type Catalog, type PlacedGeom, type ShipDerived, type WireSeg } from '@space-game/common';

/** Wires with every segment that has an end off the hull dropped (a part under it taken away) */
export function pruneWires(wires: WireSeg[], onHull: (x: number, y: number) => boolean): WireSeg[] {
  const out = wires.filter(([x0, y0, x1, y1]) => onHull(x0, y0) && onHull(x1, y1));
  return out.length === wires.length ? wires : out;
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
  const offGrid = new Map<number, { dynamo: number }>(), feedOf = new Set<number>();
  for (const B of d.power?.banks ?? []) {
    for (const i of B.parts) if (!nets[d.network[i]]) offGrid.set(i, B);
    for (const i of B.feeds) feedOf.add(i);
    for (const i of B.shields) feedOf.add(i);
  }
  const part: PartPower[] = bp.parts.map((_, i) => {
    const fn = fns[i];
    if (!d.alive[i] || !isPowerPart(fn) || (fn!.produce ?? 0) > 0) return 'none';
    const net = nets[d.network[i]];
    if (!net) {
      // Off the wire grid: a Capacitor or Drive Cell bank runs on its own (a Pulse Dynamo touching it charges it), and the guns or
      // engines a bank feeds run on it (rebuild gives them satisfaction 1)
      const own = offGrid.get(i);
      if (own) return own.dynamo > 0 ? 'powered' : 'stranded';
      if (feedOf.has(i) && d.satisfaction[i] >= 0.995) return 'powered';
      return 'unpowered';
    }
    if ((fn!.demand ?? 0) <= 0) return net.powered ? 'powered' : 'stranded';
    // (as rebuild has it: engines and guns run on a network with a generator or a battery, steady loads on its supply)
    const sat = d.satisfaction[i];
    return sat <= 0.005 ? 'unpowered' : sat < 0.995 ? 'short' : 'powered';
  });
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
    else if (st === 'stranded' && offGrid.has(i)) say(`b:${nm}:${where}`, 1, (n) => `${plural(nm, n)} ${where} never ${n > 1 ? 'refill' : 'refills'}: no generator feeds ${n > 1 ? 'them' : 'it'}, nor a Pulse Dynamo touching ${n > 1 ? 'them' : 'it'}`);
    else if (st === 'stranded') say(`s:${nm}:${where}`, 1, (n) => `${plural(nm, n)} ${where} ${n > 1 ? 'have' : 'has'} no generator to charge ${n > 1 ? 'them' : 'it'}`);
    else say(`h:${nm}:${where}`, 2, (n) => `${plural(nm, n)} ${where} ${n > 1 ? 'get' : 'gets'} only ${Math.round(d.satisfaction[i] * 100)}% of ${n > 1 ? 'their' : 'its'} power`);
  });
  // A generator on a network of its own, with nothing on it that draws power
  nets.forEach((n) => {
    if (!n.powered || n.parts.some((i) => isPowerPart(fns[i]) && (fns[i]!.produce ?? 0) <= 0)) return;
    for (const i of n.generators) say(`g:${name(i)}:${whereOnShip(geoms[i].centroid, centre, half)}`, 3, (c) => `${plural(name(i), c)} ${whereOnShip(geoms[i].centroid, centre, half)} ${c > 1 ? 'power' : 'powers'} nothing: nothing on ${c > 1 ? 'them' : 'it'} draws power`);
  });
  const warnings = [...said.values()].sort((a, b) => a.order - b.order).map((w) => w.text(w.n));
  return { nets, part, warnings };
}
