/**
 * The hangar's wire tool, as plain functions: laying a run of segments across
 * the cells the mouse drags over, erasing them, dropping what no longer lies on
 * the hull, what the wiring costs in spools against the saved design (as the
 * server's Hangar charges it), and the power overlay's report: each network in
 * its own colour, its generators and batteries, and what's left without power
 * ("Pip on the left wing has no power").
 */

import { POWER_TYPES, cellKey, cleanWires, isNeighbour, isPowerPart, normWire, wireCells, wireId, wireNetworks, wireSpools, type Blueprint, type Catalog, type PlacedGeom, type ShipDerived, type WireNetworks, type WireSeg } from '@space-game/common';

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

/** (Phase 1's colours by letter: kept for anything still keyed by them) */
export const NET_COLORS = ['#fbbf24', '#38bdf8', '#4ade80', '#f472b6', '#a78bfa', '#fb923c', '#2dd4bf', '#e879f9'];
export const DEAD_NET = '#64748b';
/** The power types' colours (surge.ts POWER_TYPES): the colour is the type, the letter tells same-type circuits apart */
export const STEADY_COLOR: string = POWER_TYPES.steady.color;
export const SURGE_COLOR: string = POWER_TYPES.surge.color;

/** A circuit's colour: every wired circuit is Steady (a Surge bank's is SURGE_COLOR); grey for none */
export function circuitColor(letter: string): string {
  return letter ? STEADY_COLOR : DEAD_NET;
}

export interface PowerNet {
  /** Its letter (circuits.ts: A is the main circuit), '' for a network with nothing on it that uses power */
  letter: string;
  color: string;
  parts: number[];
  generators: number[];
  batteries: number[];
  supply: number;
  demand: number;
  /** A generator on it */
  powered: boolean;
  /** The core's store sits on it */
  main: boolean;
  /** What its stores hold and can give a second (the core's included on the main one) */
  store: number;
  rate: number;
  /** Generation spare after its steady loads, and what its engines, guns and mining lasers draw flat out (per second) */
  spare: number;
  burst: number;
}

/** Each part's power, as the overlay marks it */
export type PartPower = 'none' | 'powered' | 'short' | 'unpowered' | 'stranded' | 'trickle' | 'idle';

/** A weak link: a part a wire runs through whose loss cuts consumers off from every generator */
export interface WeakLink { part: number; cuts: number[]; text: string }

/** A Surge bank (capacitors and Pulse Dynamos touching): what it holds, gives, makes and reaches by touch */
export interface PowerBank {
  store: number;
  label: string;
  parts: number[];
  capacitors: number;
  dynamos: number;
  /** The circuit that charges it (its letter, '' none) */
  circuit: string;
  cap: number;
  rate: number;
  surge: number;
  feeds: number[];
  shields: number[];
}

export interface PowerReport {
  /** By network (ShipDerived.networks order) */
  nets: PowerNet[];
  /**
   * Per part: 'none' (doesn't use power), 'powered', 'short' (a steady load
   * on a circuit that can't meet it all), 'unpowered' (nothing can reach it),
   * 'trickle' (on no circuit, or one with nothing on it: it limps on the core's
   * trickle), 'stranded' (a store with no generator to charge it), 'idle' (a
   * capacitor touching nothing that draws power)
   */
  part: PartPower[];
  /** Per segment: its colour (cut ones null) */
  seg: (string | null)[];
  /** "Pip on the left wing has no power", most important first (weak links are listed apart: an auto-wired tree is full of them) */
  warnings: string[];
  /** Weak links, most cut first */
  weak: WeakLink[];
  /** Surge banks, S1 first */
  banks: PowerBank[];
}

/** Where a part sits on the ship, in a pilot's words (forward is -y) */
export function whereOnShip(at: [number, number], centre: [number, number], half: [number, number]): string {
  const nx = (at[0] - centre[0]) / Math.max(1, half[0]), ny = (at[1] - centre[1]) / Math.max(1, half[1]);
  if (Math.abs(nx) > 0.35 && Math.abs(nx) >= Math.abs(ny) * 0.8) return nx < 0 ? 'on the left wing' : 'on the right wing';
  if (ny < -0.3) return 'at the nose';
  if (ny > 0.3) return 'at the tail';
  return 'amidships';
}

const plural = (s: string, n: number) => (n > 1 ? `${n} ${/(s|sh|ch|x)$/.test(s) ? `${s}es` : `${s}s`}` : s);

/**
 * Weak links (docs/design/energy-system.md §6.3): each part a live wire runs
 * through (not a generator), taken away in turn, and the consumers that then
 * have no generator on their circuit any more. Hangar only (a rebuild of the
 * networks per candidate); big designs skip it.
 */
export function weakLinks(catalog: Catalog, bp: Blueprint, d: ShipDerived, geoms: PlacedGeom[], name: (i: number) => string, where: (i: number) => string): WeakLink[] {
  const n = bp.parts.length;
  if (n > 400 || !d.power) return [];
  const fns = bp.parts.map((p) => catalog.functions.get(p.fn));
  const gen = (i: number) => (fns[i]?.produce ?? 0) > 0;
  const consumer = (i: number) => d.alive[i] && (fns[i]?.demand ?? 0) > 0;
  const fed = (net: WireNetworks | { network: number[]; nets: number[][] }, i: number) => {
    const k = net.network[i];
    return k >= 0 && net.nets[k].some((j) => gen(j));
  };
  const before = { network: d.network, nets: d.networks.map((x) => x.parts) };
  const wanted = bp.parts.map((_, i) => i).filter((i) => consumer(i) && fed(before, i));
  if (!wanted.length) return [];
  // Candidates: alive parts (not generators, not the consumers themselves) under a live wire's end
  const cells = wireCells(catalog, bp, geoms);
  const under = new Set<number>();
  d.wires.forEach(([x0, y0, x1, y1], s) => {
    if (!d.wireLive[s]) return;
    for (const k of [cellKey(x0, y0), cellKey(x1, y1)]) for (const i of cells.get(k) ?? []) under.add(i);
  });
  const out: WeakLink[] = [];
  for (const p of [...under].sort((a, b) => a - b)) {
    if (!d.alive[p] || gen(p) || bp.parts[p].fn === 'core') continue;
    const alive = d.alive.map((a, i) => a && i !== p);
    const net = wireNetworks(catalog, bp, geoms, alive, d.joins.filter(([a, b]) => a !== p && b !== p));
    const cuts = wanted.filter((i) => i !== p && !fed(net, i));
    if (!cuts.length) continue;
    const names = new Map<string, number>();
    for (const i of cuts) names.set(name(i), (names.get(name(i)) ?? 0) + 1);
    const what = [...names].map(([nm, c]) => plural(nm, c)).join(', ');
    out.push({ part: p, cuts, text: `Losing the ${name(p)} ${where(p)} cuts ${what} off from every generator` });
  }
  return out.sort((a, b) => b.cuts.length - a.cuts.length || a.part - b.part);
}

/**
 * The power overlay's report: circuits from the design's derived state
 * (rebuild: its wires, which are live, which circuit each part is on, its
 * stores and banks), each its own letter and colour, and what lacks power or
 * is set up badly, by name and where it sits
 */
export function powerReport(catalog: Catalog, bp: Blueprint, d: ShipDerived, geoms: PlacedGeom[], name: (i: number) => string, opts: { weak?: boolean } = {}): PowerReport {
  const fns = bp.parts.map((p) => catalog.functions.get(p.fn));
  const L = d.power;
  const nets: PowerNet[] = d.networks.map((n, k) => {
    const ci = L?.circuits[k];
    const generators = n.parts.filter((i) => (fns[i]?.produce ?? 0) > 0);
    const batteries = n.parts.filter((i) => (fns[i]?.store ?? 0) > 0);
    // (its own stores: its banks are Surge, listed apart)
    const groups = ci ? [ci.pools.g, ci.pools.d, ci.pools.w].filter((s) => s >= 0) : [];
    const store = groups.reduce((t, s) => t + L!.stores[s].cap, 0) + (ci?.main && L?.core ? L.core.cap : 0);
    const rate = groups.reduce((t, s) => t + L!.stores[s].rate, 0) + (ci?.main && L?.core ? L.core.rate : 0);
    const letter = ci?.letter ?? '';
    return {
      letter, color: n.powered && letter ? circuitColor(letter) : DEAD_NET, parts: n.parts, generators, batteries, supply: n.supply, demand: n.demand,
      powered: n.powered, main: !!ci?.main, store, rate, spare: ci?.spare ?? 0, burst: ci ? ci.engineDraw + ci.gunDraw + ci.minerDraw : 0,
    };
  });
  const bankOf = (i: number) => (L && fns[i]?.bank && L.storeOf[i] >= 0 ? L.stores[L.storeOf[i]] : undefined);
  const part: PartPower[] = bp.parts.map((_, i) => {
    const fn = fns[i];
    if (!d.alive[i] || !isPowerPart(fn) || (fn!.produce ?? 0) > 0) return 'none';
    const net = nets[d.network[i]];
    if ((fn!.demand ?? 0) <= 0) {
      const bank = bankOf(i);
      if (bank && !bank.feeds!.length && !bank.shields?.length) return 'idle';
      // (a capacitor goes by its bank: charged by the bank's circuit or its dynamos, wired itself or not)
      if (bank) return L!.circuits[bank.circuit]?.generators.length || (bank.surge ?? 0) > 0 ? 'powered' : 'stranded';
      return net?.powered ? 'powered' : 'stranded';
    }
    const sat = d.satisfaction[i];
    if (sat <= 0.005) return 'unpowered';
    // (engines, guns and mining lasers on no circuit, or on one with no generator or store: only the core's trickle reaches them)
    const ci = L && L.circuitOf[i] >= 0 ? L.circuits[L.circuitOf[i]] : undefined;
    const banked = L ? L.feedOf[i] >= 0 && L.feeds[L.feedOf[i]].bank >= 0 : false;
    if (L?.feedOf[i] !== undefined && L.feedOf[i] >= 0 && !banked && (!ci || ci.net < 0 || (!ci.generators.length && !ci.storeParts.length && !ci.main))) return 'trickle';
    return sat < 0.995 ? 'short' : 'powered';
  });
  const seg = d.wires.map((_, s) => (d.wireLive[s] && d.wireNet[s] >= 0 ? nets[d.wireNet[s]]?.color ?? DEAD_NET : null));
  // Warnings: like parts in the same place together ("2 Pips on the left wing have no power")
  const xs = geoms.flatMap((g) => g.polygon.map((p) => p[0])), ys = geoms.flatMap((g) => g.polygon.map((p) => p[1]));
  const centre: [number, number] = xs.length ? [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2] : [0, 0];
  const half: [number, number] = xs.length ? [(Math.max(...xs) - Math.min(...xs)) / 2, (Math.max(...ys) - Math.min(...ys)) / 2] : [1, 1];
  const where = (i: number) => (geoms[i] ? whereOnShip(geoms[i].centroid, centre, half) : '');
  const said = new Map<string, { n: number; order: number; text: (n: number) => string }>();
  const say = (key: string, order: number, text: (n: number) => string) => {
    const was = said.get(key);
    if (was) was.n++; else said.set(key, { n: 1, order, text });
  };
  // Circuits with stores but nothing to charge them
  nets.forEach((n) => {
    if (n.powered || !n.letter || !n.batteries.length) return;
    say(`c:${n.letter}`, 1, () => `Circuit ${n.letter} has stores but no generator: nothing charges them`);
  });
  part.forEach((st, i) => {
    if (st === 'none' || st === 'powered' || !geoms[i]) return;
    const nm = name(i), at = where(i);
    if (st === 'unpowered') say(`u:${nm}:${at}`, 0, (n) => `${plural(nm, n)} ${at} ${n > 1 ? 'have' : 'has'} no power`);
    else if (st === 'trickle') say(`t:${nm}:${at}`, 2, (n) => `${plural(nm, n)} ${at} ${n > 1 ? 'aren\'t' : 'isn\'t'} wired to a generator or store: only the core's trickle reaches ${n > 1 ? 'them' : 'it'}`);
    else if (st === 'idle') say(`k:${nm}`, 3, (n) => `${plural(nm, n)} ${n > 1 ? 'touch' : 'touches'} nothing that draws power: a capacitor gives only to what it touches`);
    else if (st === 'stranded') {
      // (the circuit's own warning covers stores on a circuit with no generator)
      if (d.network[i] >= 0 && nets[d.network[i]]?.letter) return;
      say(`s:${nm}:${at}`, 1, (n) => `${plural(nm, n)} ${at} ${n > 1 ? 'aren\'t' : 'isn\'t'} wired to a circuit: nothing charges ${n > 1 ? 'them' : 'it'}`);
    } else say(`h:${nm}:${at}`, 4, (n) => `${plural(nm, n)} ${at} ${n > 1 ? 'get' : 'gets'} only ${Math.round(d.satisfaction[i] * 100)}% of ${n > 1 ? 'their' : 'its'} power`);
  });
  // A generator on a network of its own, wired to nothing
  nets.forEach((n) => {
    if (!n.powered || n.parts.some((i) => isPowerPart(fns[i]) && (fns[i]!.produce ?? 0) <= 0)) return;
    for (const i of n.generators) say(`g:${name(i)}:${where(i)}`, 5, (c) => `${plural(name(i), c)} ${where(i)} ${c > 1 ? 'power' : 'powers'} nothing: wire ${c > 1 ? 'them' : 'it'} to what draws power`);
  });
  // Surge banks, and a Pulse Dynamo whose bank touches nothing that draws power
  const banks: PowerBank[] = (L?.stores ?? []).flatMap((g, s) => g.kind !== 'k' ? [] : [{
    store: s, label: g.label ?? 'S', parts: g.parts, capacitors: g.parts.filter((i) => fns[i]?.bank).length, dynamos: g.parts.filter((i) => (fns[i]?.surge ?? 0) > 0).length,
    circuit: L!.circuits[g.circuit]?.letter ?? '', cap: g.cap, rate: g.rate, surge: g.surge ?? 0, feeds: g.feeds ?? [], shields: g.shields ?? [],
  }]);
  for (const b of banks) {
    if (b.feeds.length || b.shields.length) continue;
    for (const i of b.parts) if ((fns[i]?.surge ?? 0) > 0) say(`k:${name(i)}`, 3, (n) => `${plural(name(i), n)} ${n > 1 ? 'touch' : 'touches'} nothing that draws power, nor its bank: Surge goes only by touch`);
  }
  const weak = opts.weak === false ? [] : weakLinks(catalog, bp, d, geoms, name, where);
  const warnings = [...said.values()].sort((a, b) => a.order - b.order).map((w) => w.text(w.n));
  return { nets, part, seg, warnings, weak, banks };
}
