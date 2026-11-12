/**
 * Weapon modifiers explained for the hangar: what each mount took and reaches, why a block does nothing, what a hopper
 * feeds, what each line part carries and drops. Read-only: it follows portsMods.ts buildPortsMods step for step and keeps
 * the workings that the layout throws away. docs/design/weapon-modifiers-2026-11.md.
 *
 * @contract power.ports-mods-explain
 * owns:       explainPortsMods: the modifier side of a design in words-ready form (mounts, blocks, hoppers, lines, guns)
 * needs:      portsTypes, portsFrame (part frames), modifiers/types, grades (a gun's load)
 * invariants: the guns' effects it works out are the layout's own (`L.mod.gunFx`), on every test ship and the showcase;
 *             it never writes to the layout — common/src/ships/power/portsModsExplain.test.ts
 * extend:     a new reason a block is idle is a ModIdle value set where buildPortsMods skips it
 *
 * - UI only (the hangar): it allocates freely and is never run by the tick.
 * - A rule change in buildPortsMods is made here too; the test above fails when the two disagree.
 */
import { placeGeometry } from '../grid.js';
import { partDemand, partMaterial } from '../grades.js';
import { FX_MAX, FX_STEPS } from '../modifiers/types.js';
import type { Catalog } from '../catalog.js';
import type { PlacedPart, Side } from '../types.js';
import type { ShipTuning } from '../tuning.js';
import { frameOf, placeEdge } from './portsFrame.js';
import { P_WEAPON, type PortsLayout, type PortsLayoutInput } from './portsTypes.js';

/**
 * Why a modifier block does nothing: no mount's socket faces it; its mount took another kind; its special has no hopper
 * of its material (or no power line of its own); its mount's line reaches no gun
 */
export type ModIdle = 'noSocket' | 'wrongKind' | 'noHopper' | 'noPower' | 'noGuns';

/** One socket of a mount, placed: its cell and side, the cell across, and the block this mount holds there (-1: empty) */
export interface ModSocket { x: number; y: number; side: Side; nx: number; ny: number; block: number }

export interface ModMountInfo {
  part: number;
  sockets: ModSocket[];
  /** The blocks that work for it, in socket order */
  blocks: number[];
  /** The kinds it took: one, or a recipe's (then `fused` is the recipe's effect) */
  kinds: string[];
  fused: boolean;
  /** Its effect (index in modifiers.effects), -1 when it has none */
  fx: number;
  /** E a second it treats (its working sockets), and burns as upkeep */
  treat: number;
  upkeep: number;
  /** The guns down its line, and the share of their load its treatment covers (1: all of it) */
  guns: number[];
  cover: number;
  /** In `L.mod.mounts`: it burns upkeep */
  working: boolean;
}

export interface ModBlockInfo {
  part: number;
  kind: string;
  /** The mount that holds it (-1: none) */
  mount: number;
  idle?: ModIdle;
  /** A special's hoppers (in the order they pay) */
  hoppers: number[];
}

export interface ModHopperInfo {
  part: number;
  mat: string;
  /** The special blocks it pays for */
  blocks: number[];
}

export interface ModLineInfo {
  part: number;
  tier: number;
  /** Its limits (modifiers.lines): effects, treated E a second */
  max: number;
  cap: number;
  /** What it carries on: each effect and its treated E a second, strongest first */
  carried: { fx: number; amt: number }[];
  /** Effects it dropped (too many for its tier) */
  dropped: number[];
  /** What it left of the rest when over its cap (1: all) */
  scale: number;
}

export interface ModGunInfo {
  part: number;
  /** Its sustained load, E a second */
  load: number;
  /** Its effects as the layout has them (`L.mod.gunFx` order), with the treated E a second behind each */
  slots: { fx: number; q: number; amt: number }[];
  /** Effects a mount sent that never arrived: dropped by line part `by` (-1: the gun's own limit of FX_MAX, or too weak to count) */
  lost: { fx: number; by: number }[];
}

export interface ModsExplain {
  mounts: Map<number, ModMountInfo>;
  blocks: Map<number, ModBlockInfo>;
  hoppers: Map<number, ModHopperInfo>;
  lines: Map<number, ModLineInfo>;
  guns: Map<number, ModGunInfo>;
}

interface Claim { mount: number; gun: number; fx: number; amt: number; k: number; by: number }

/** The modifier side of a design, explained; undefined when it has no mount, block or hopper at all */
export function explainPortsMods(L: PortsLayout, input: PortsLayoutInput, tuning: ShipTuning = input.tuning): ModsExplain | undefined {
  const mt = tuning.modifiers;
  if (!mt) return undefined;
  const { parts, fns, alive, cells } = input, n = L.n;
  let any = false;
  for (let i = 0; i < n; i++) if (alive[i] && (fns[i].modMount || fns[i].plug || fns[i].hopper)) { any = true; break; }
  if (!any) return undefined;
  const out: ModsExplain = { mounts: new Map(), blocks: new Map(), hoppers: new Map(), lines: new Map(), guns: new Map() };
  const loadOf = (w: number) => fns[w].infra?.draw ?? partDemand(fns[w], input.area[w], input.mats[w]);

  // 1. Sockets (as buildPortsMods: a block works for the first mount with a socket facing it)
  const occ = new Map<string, number>();
  for (let i = 0; i < n; i++) if (alive[i]) for (const c of cells[i]) occ.set(`${c[0]},${c[1]}`, i);
  const host = new Int32Array(n).fill(-1), hoppers: number[] = [];
  for (let i = 0; i < n; i++) if (alive[i] && fns[i].hopper) { hoppers.push(i); out.hoppers.set(i, { part: i, mat: fns[i].hopper!.mat, blocks: [] }); }
  const payers = (j: number): number[] | undefined => {
    const needs = mt.kinds[fns[j].plug!]?.needs;
    if (!needs) return [];
    if (needs.mat) { const hs = hoppers.filter((h) => fns[h].hopper!.mat === needs.mat && L.netOf[j] >= 0 && L.netOf[h] === L.netOf[j]); return hs.length ? hs : undefined; }
    return L.inStart[j + 1] > L.inStart[j] && L.cap[j] > 0 ? [j] : undefined;
  };
  for (let j = 0; j < n; j++) {
    const kind = fns[j].plug;
    if (!alive[j] || !kind || !mt.kinds[kind]) continue;
    const hs = mt.kinds[kind].needs?.mat ? payers(j) ?? [] : [];
    out.blocks.set(j, { part: j, kind, mount: -1, idle: 'noSocket', hoppers: hs });
    for (const h of hs) out.hoppers.get(h)!.blocks.push(j);
  }
  const claims: Claim[] = [];
  const onPart: { c: Claim; far: number }[][] = Array.from({ length: n }, () => []);
  for (let m = 0; m < n; m++) {
    const mm = fns[m].modMount;
    if (!alive[m] || !mm) continue;
    const F = frameOf(parts[m], cells[m]), blocks: number[] = [];
    const info: ModMountInfo = { part: m, sockets: [], blocks: [], kinds: [], fused: false, fx: -1, treat: 0, upkeep: 0, guns: [], cover: 0, working: false };
    out.mounts.set(m, info);
    for (const s of mm.sockets) {
      const e = placeEdge(parts[m], F, s.side, s.cell ?? 0), j = occ.get(`${e.nx},${e.ny}`);
      const sock: ModSocket = { x: e.x, y: e.y, side: e.side, nx: e.nx, ny: e.ny, block: -1 };
      info.sockets.push(sock);
      if (j === undefined || j === m || host[j] >= 0 || !fns[j].plug || !mt.kinds[fns[j].plug!]) continue;
      host[j] = m; blocks.push(j); sock.block = j;
      const b = out.blocks.get(j)!;
      b.mount = m; b.idle = undefined;
    }
    if (!blocks.length) continue;
    const first = fns[blocks[0]].plug!, set = [...new Set(blocks.map((j) => fns[j].plug!))];
    const fused = set.length > 1 ? mt.recipes.find((r) => r.parts.length === set.length && set.every((k) => r.parts.includes(k))) : undefined;
    const ok = fused ? blocks : blocks.filter((j) => fns[j].plug === first);
    for (const j of blocks) if (!ok.includes(j)) out.blocks.get(j)!.idle = 'wrongKind';
    info.kinds = fused ? [...fused.parts] : [first];
    info.fused = !!fused;
    const fx = mt.effects.indexOf(fused ? fused.effect : mt.kinds[first].effect);
    if (fx < 0) continue;
    info.fx = fx;
    let ready = 0;
    for (const j of ok) {
      if (payers(j)) { ready++; info.blocks.push(j); } else out.blocks.get(j)!.idle = mt.kinds[fns[j].plug!].needs?.mat ? 'noHopper' : 'noPower';
    }
    if (!ready) continue;
    info.working = true;
    info.treat = mm.treat * ready;
    info.upkeep = mm.upkeep * ok.length;

    // 2. Reach
    const prev = new Map<number, number>([[m, -1]]), queue = [m], guns: number[] = [], from: number[] = [];
    for (let q = 0; q < queue.length; q++) {
      const a = queue[q];
      for (let x = L.outStart[a]; x < L.outStart[a + 1]; x++) {
        const l = L.outLink[x], b = L.linkTo[l];
        if (L.linkAug[l] || prev.has(b)) continue;
        if (L.role[b] === P_WEAPON) { if (L.shot[b] > 0 && !guns.includes(b)) { guns.push(b); from.push(a); } continue; }
        if (b === input.core || !(fns[b].lineTier || fns[b].modMount)) continue;
        prev.set(b, a); queue.push(b);
      }
    }
    let sum = 0;
    for (const w of guns) sum += loadOf(w);
    if (sum <= 0) { for (const j of info.blocks) out.blocks.get(j)!.idle = 'noGuns'; continue; }
    const f = Math.min(1, (mm.treat * ready) / sum);
    info.cover = f;
    guns.forEach((w, gi) => {
      const load = loadOf(w);
      if (load <= 0) return;
      info.guns.push(w);
      const c: Claim = { mount: m, gun: w, fx, amt: load * f, k: 1, by: -1 };
      claims.push(c);
      const path: number[] = [];
      for (let a = from[gi]; a >= 0; a = prev.get(a)!) path.push(a);
      path.forEach((a, i) => onPart[a].push({ c, far: path.length - 1 - i }));
    });
  }

  // 3. Line tiers, in the order power passes the parts
  const line: number[] = [];
  for (let i = 0; i < n; i++) if (onPart[i].length) line.push(i);
  const deg = new Map<number, number>(line.map((q) => [q, 0]));
  for (const q of line) for (let x = L.outStart[q]; x < L.outStart[q + 1]; x++) { const b = L.linkTo[L.outLink[x]]; if (deg.has(b)) deg.set(b, deg.get(b)! + 1); }
  const order: number[] = [], open = line.filter((q) => !deg.get(q)), done = new Set<number>();
  while (open.length) {
    const a = open.shift()!; order.push(a); done.add(a);
    for (let x = L.outStart[a]; x < L.outStart[a + 1]; x++) { const b = L.linkTo[L.outLink[x]]; if (!deg.has(b)) continue; deg.set(b, deg.get(b)! - 1); if (deg.get(b) === 0) open.push(b); }
  }
  for (const q of line) if (!done.has(q)) order.push(q);
  for (const p of order) {
    const tier = fns[p].lineTier;
    if (!tier || fns[p].modMount) continue;
    const lim = mt.lines[Math.min(mt.lines.length, tier) - 1];
    if (!lim) continue;
    const info: ModLineInfo = { part: p, tier, max: lim.fx, cap: lim.cap, carried: [], dropped: [], scale: 1 };
    const by = new Map<number, { amt: number; far: number }>();
    for (const { c, far } of onPart[p]) {
      const a = c.amt * c.k;
      if (a <= 1e-9) continue;
      const o = by.get(c.fx);
      if (o) { o.amt += a; if (far > o.far) o.far = far; } else by.set(c.fx, { amt: a, far });
    }
    if (by.size > lim.fx) {
      const rank = [...by.entries()].sort((a, b) => Math.round(b[1].amt * 10) - Math.round(a[1].amt * 10) || b[1].far - a[1].far || a[0] - b[0]);
      for (const [fx] of rank.slice(lim.fx)) {
        by.delete(fx); info.dropped.push(fx);
        for (const { c } of onPart[p]) if (c.fx === fx) { if (c.k > 0) c.by = p; c.k = 0; }
      }
    }
    let total = 0;
    for (const o of by.values()) total += o.amt;
    if (total > lim.cap + 1e-6) { info.scale = lim.cap / total; for (const { c } of onPart[p]) c.k *= info.scale; }
    info.carried = [...by.entries()].map(([fx, o]) => ({ fx, amt: o.amt * info.scale })).sort((a, b) => b.amt - a.amt || a.fx - b.fx);
    if (by.size || info.dropped.length) out.lines.set(p, info);
  }

  // 4. Per gun
  for (let w = 0; w < n; w++) {
    const all = claims.filter((c) => c.gun === w);
    if (!all.length) continue;
    const mine = all.filter((c) => c.amt * c.k > 1e-9), load = loadOf(w), slots: { fx: number; q: number; amt: number }[] = [];
    for (const c of mine) { const s = slots.find((x) => x.fx === c.fx); if (s) s.amt += c.amt * c.k; else slots.push({ fx: c.fx, amt: c.amt * c.k, q: 0 }); }
    for (const s of slots) s.q = Math.round(Math.min(1, s.amt / load) * FX_STEPS);
    const kept = slots.filter((s) => s.q > 0).sort((a, b) => b.q - a.q || a.fx - b.fx).slice(0, FX_MAX);
    const lost: { fx: number; by: number }[] = [];
    for (const c of all) if (!kept.some((s) => s.fx === c.fx) && !lost.some((x) => x.fx === c.fx)) lost.push({ fx: c.fx, by: c.by });
    out.guns.set(w, { part: w, load, slots: kept, lost });
  }
  return out;
}

/** The same for a built ship: its parts and what the rebuild found alive (`derived.ports`, `derived.alive`, `derived.root`) */
export function explainShipMods(catalog: Catalog, tuning: ShipTuning, parts: readonly PlacedPart[], derived: { ports?: PortsLayout; alive: boolean[]; root: number }): ModsExplain | undefined {
  const L = derived.ports;
  if (!L || !tuning.modifiers || L.n !== parts.length) return undefined;
  const fns = parts.map((p) => catalog.functions.get(p.fn)!);
  if (!fns.some((f) => f.modMount || f.plug || f.hopper)) return undefined;
  const geoms = parts.map((p) => placeGeometry(catalog, p));
  const core = derived.root >= 0 && parts[derived.root].fn === 'core' ? derived.root : -1;
  return explainPortsMods(L, { parts, fns, area: geoms.map((g) => g.area), mats: parts.map((p) => partMaterial(catalog, p) ), alive: derived.alive, cells: geoms.map((g) => g.cells), core, tuning });
}
