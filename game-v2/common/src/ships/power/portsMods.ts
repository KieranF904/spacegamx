/**
 * Weapon modifiers on the ports core: which gun gets which effect and how strongly (static, at layout build), and what
 * is live when a shot is spent (mount power, hoppers, buffers). docs/design/weapon-modifiers-2026-11.md; the rules are
 * the modifier lab's (prototypes/modifier-lab/treat.js).
 *
 * @contract power.ports-mods
 * owns:       the modifier side of a ports layout (buildPortsMods: sockets, recipes, reach, shares, line-tier limits),
 *             mount upkeep (portsModsTick) and a shot's effect mask (portsFxLive, portsShotFx, portsLastFx), Rapid's cost
 * needs:      portsTypes, portsFrame (part frames), modifiers/types, power/units
 * invariants: a ship with no working mount has no `L.mod` and takes none of these paths: it behaves exactly as before;
 *             effects never pass a store or the core; a hopper is never power —
 *             common/src/ships/power/portsMods.test.ts
 * extend:     a new kind or recipe is a row in tuning.json modifiers (and a part in scripts/econ/models.mjs)
 *
 * - No state of its own: a mount's reserve is its `aug`, a hopper's material and a special's buffer their `held`, an
 *   unpowered mount its PF_LATCH. All of it is packed, hashed and remapped with the rest of PortsState.
 * - Integer maths only at tick and spend time (server, wire and prediction must agree to the eu).
 */
import { partDemand } from '../grades.js';
import { FX_MAX, FX_STEPS, rapidRate, type GunFx, type ModFeed, type PortsMods } from '../modifiers/types.js';
import type { ShipTuning } from '../tuning.js';
import { frameOf, placeEdge } from './portsFrame.js';
import { PF_LATCH, P_WEAPON, type PortsLayout, type PortsLayoutInput, type PortsState } from './portsTypes.js';
import { perTickUp } from './units.js';

/** One mount's claim on one gun: the effect, the treated E a second it brings, and what the line parts leave of it */
interface Claim { mount: number; gun: number; fx: number; amt: number; k: number }

/** The modifier side of a layout, or undefined when the ship has no working mount (called by buildPortsLayout, last) */
export function buildPortsMods(L: PortsLayout, input: PortsLayoutInput, tuning: ShipTuning = input.tuning): PortsMods | undefined {
  const mt = tuning.modifiers;
  if (!mt) return undefined;
  const { parts, fns, alive, cells } = input, n = L.n;
  let any = false;
  for (let i = 0; i < n; i++) if (alive[i] && fns[i].modMount) { any = true; break; }
  if (!any) return undefined;

  // 1. Sockets: a block works for the first mount (part order, then socket order) with a socket facing it
  const occ = new Map<string, number>();
  for (let i = 0; i < n; i++) if (alive[i]) for (const c of cells[i]) occ.set(`${c[0]},${c[1]}`, i);
  const host = new Int32Array(n).fill(-1), hoppers: number[] = [];
  for (let i = 0; i < n; i++) if (alive[i] && fns[i].hopper) hoppers.push(i);
  /** A special's payers: the hoppers of its material on its feed network (it pays from the first that can), or itself */
  const payers = (j: number): number[] | undefined => {
    const needs = mt.kinds[fns[j].plug!]?.needs;
    if (!needs) return [];
    if (needs.mat) { const hs = hoppers.filter((h) => fns[h].hopper!.mat === needs.mat && L.netOf[j] >= 0 && L.netOf[h] === L.netOf[j]); return hs.length ? hs : undefined; }
    return L.inStart[j + 1] > L.inStart[j] && L.cap[j] > 0 ? [j] : undefined;
  };
  const mounts: number[] = [], upkeep: number[] = [], claims: Claim[] = [];
  const onPart: { c: Claim; far: number }[][] = Array.from({ length: n }, () => []);
  // (By mount: its ready blocks that use something up, with their payers)
  const users = new Map<number, { per: number; ready: number; pay: number[] }[]>();
  for (let m = 0; m < n; m++) {
    const mm = fns[m].modMount;
    if (!alive[m] || !mm) continue;
    const F = frameOf(parts[m], cells[m]), blocks: number[] = [];
    for (const s of mm.sockets) {
      const e = placeEdge(parts[m], F, s.side, s.cell ?? 0), j = occ.get(`${e.nx},${e.ny}`);
      if (j === undefined || j === m || host[j] >= 0 || !fns[j].plug || !mt.kinds[fns[j].plug!]) continue;
      host[j] = m; blocks.push(j);
    }
    if (!blocks.length) continue;
    // (One kind, the first in socket order; or exactly one recipe's kinds, which fuse into its effect)
    const first = fns[blocks[0]].plug!, set = [...new Set(blocks.map((j) => fns[j].plug!))];
    const fused = set.length > 1 ? mt.recipes.find((r) => r.parts.length === set.length && set.every((k) => r.parts.includes(k))) : undefined;
    const ok = fused ? blocks : blocks.filter((j) => fns[j].plug === first);
    const fx = mt.effects.indexOf(fused ? fused.effect : mt.kinds[first].effect);
    if (fx < 0) continue;
    // (A special with nothing to pay it treats nothing: one fed of two treats half)
    const use: { per: number; ready: number; pay: number[] }[] = [];
    let ready = 0;
    for (const j of ok) { const pay = payers(j); if (pay) { ready++; if (pay.length) use.push({ per: mt.kinds[fns[j].plug!].needs!.per, ready: 0, pay }); } }
    if (!ready) continue;
    for (const u of use) u.ready = ready;
    mounts.push(m); upkeep.push(perTickUp(mm.upkeep * ok.length)); users.set(m, use);

    // 2. Reach: down the line from the mount to the guns, through line parts and mounts only (never a store or the core)
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
    // (Its treatment shared among the guns it reaches by their sustained load; over-supply never dilutes)
    let sum = 0;
    for (const w of guns) sum += loadOf(input, w);
    if (sum <= 0) continue;
    const f = Math.min(1, (mm.treat * ready) / sum);
    guns.forEach((w, gi) => {
      const load = loadOf(input, w);
      if (load <= 0) return;
      const c: Claim = { mount: m, gun: w, fx, amt: load * f, k: 1 };
      claims.push(c);
      const path: number[] = [];
      for (let a = from[gi]; a >= 0; a = prev.get(a)!) path.push(a);
      path.forEach((a, i) => onPart[a].push({ c, far: path.length - 1 - i }));
    });
  }
  if (!mounts.length) return undefined;

  // 3. Line tiers, in the order power passes the parts (so what one drops is already gone at the next): a part carries
  // `fx` effects (the weakest dropped; ties, the last put in) and `cap` treated E a second (over it, all scale to fit)
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
    const by = new Map<number, { amt: number; far: number }>();
    for (const { c, far } of onPart[p]) {
      const a = c.amt * c.k;
      if (a <= 1e-9) continue;
      const o = by.get(c.fx);
      if (o) { o.amt += a; if (far > o.far) o.far = far; } else by.set(c.fx, { amt: a, far });
    }
    if (by.size > lim.fx) {
      const rank = [...by.entries()].sort((a, b) => Math.round(b[1].amt * 10) - Math.round(a[1].amt * 10) || b[1].far - a[1].far || a[0] - b[0]);
      for (const [fx] of rank.slice(lim.fx)) { by.delete(fx); for (const { c } of onPart[p]) if (c.fx === fx) c.k = 0; }
    }
    let total = 0;
    for (const o of by.values()) total += o.amt;
    if (total > lim.cap + 1e-6) for (const { c } of onPart[p]) c.k *= lim.cap / total;
  }

  // 4. Per gun: strength = treated ÷ load, in steps; the strongest FX_MAX; what each needs live
  const gunFx: (GunFx[] | undefined)[] = new Array(n).fill(undefined), gunMounts: (number[][] | undefined)[] = new Array(n).fill(undefined), gunFeeds: (ModFeed[][] | undefined)[] = new Array(n).fill(undefined);
  const rapid = new Uint8Array(n), rapidCost = new Int32Array(n), rapidFx = mt.effects.indexOf('rapid');
  for (let w = 0; w < n; w++) {
    const mine = claims.filter((c) => c.gun === w && c.amt * c.k > 1e-9);
    if (!mine.length) continue;
    const load = loadOf(input, w), slots: { fx: number; a: number; q: number }[] = [];
    for (const c of mine) { const s = slots.find((x) => x.fx === c.fx); if (s) s.a += c.amt * c.k; else slots.push({ fx: c.fx, a: c.amt * c.k, q: 0 }); }
    for (const s of slots) s.q = Math.round(Math.min(1, s.a / load) * FX_STEPS);
    const kept = slots.filter((s) => s.q > 0).sort((a, b) => b.q - a.q || a.fx - b.fx).slice(0, FX_MAX);
    if (!kept.length) continue;
    gunFx[w] = kept.map((s) => ({ fx: s.fx, q: s.q }));
    gunMounts[w] = kept.map((s) => mine.filter((c) => c.fx === s.fx).map((c) => c.mount));
    gunFeeds[w] = kept.map((s) => {
      const feeds: { part: number; per4096: number; more?: number[] }[] = [];
      for (const c of mine) {
        if (c.fx !== s.fx) continue;
        for (const u of users.get(c.mount)!) {
          const per = Math.round(((u.per * c.amt * c.k) / load / u.ready) * 4096), f = feeds.find((x) => x.part === u.pay[0]);
          if (f) f.per4096 += per; else feeds.push({ part: u.pay[0], per4096: per, ...(u.pay.length > 1 ? { more: u.pay.slice(1) } : {}) });
        }
      }
      return feeds;
    });
    // (Rapid on a gun that fires shots: each costs 1/rate of the gun's)
    const ri = kept.findIndex((s) => s.fx === rapidFx);
    if (ri >= 0 && L.gun[w] !== 3 && !L.pieces[w]) { rapid[w] = ri + 1; rapidCost[w] = Math.round(4096 / rapidRate(mt, kept[ri].q)); }
  }
  return { gunFx, gunMounts, gunFeeds, mounts, upkeep, rapid, rapidCost };
}

/** A gun's sustained load in E a second (what partRoles sizes its buffer and intake by) */
function loadOf(input: PortsLayoutInput, w: number): number {
  const fn = input.fns[w];
  return fn.infra?.draw ?? partDemand(fn, input.area[w], input.mats[w]);
}

/** A layout's modifier side folded into its signature (buildPortsLayout: only when there is one) */
export function portsModsSig(sig: number, M: PortsMods): number {
  let h = (0x811c9dc5 ^ sig) | 0;
  const mix = (v: number) => { h = Math.imul(h ^ (v | 0), 0x01000193); };
  for (let i = 0; i < M.mounts.length; i++) { mix(M.mounts[i]); mix(M.upkeep[i]); }
  for (let p = 0; p < M.gunFx.length; p++) {
    const g = M.gunFx[p];
    if (!g) continue;
    mix(p);
    g.forEach((x, i) => { mix(x.fx); mix(x.q); for (const m of M.gunMounts[p]![i]) mix(m); for (const f of M.gunFeeds[p]![i]) { mix(f.part); mix(f.per4096); } });
  }
  const s = ((h >>> 16) ^ (h & 0xffff)) & 0xffff;
  return s === 0 ? 1 : s;
}

/** A gun range ship's effects, each at full strength (rebuild.ts: its guns never want for power, nor its mounts for a share of it) */
export function portsModsFull(L: PortsLayout): void {
  const M = L.mod;
  if (!M) return;
  for (const g of M.gunFx) if (g) for (const x of g) (x as GunFx).q = FX_STEPS;
  L.sig = portsModsSig(L.sig, M);
}

/**
 * A tick's upkeep (portsTick, after the power has moved): each working mount tops its reserve up from the power passing
 * and burns its upkeep from it. One that can't pay is unpowered (PF_LATCH): power still passes, its effects are off
 */
export function portsModsTick(L: PortsLayout, e: PortsState): void {
  const M = L.mod;
  if (!M) return;
  for (let i = 0; i < M.mounts.length; i++) {
    const m = M.mounts[i], u = M.upkeep[i], room = L.augCap[m] - e.aug[m], h = e.held[m], take = h < room ? h : room;
    if (take > 0) { e.held[m] = h - take; e.aug[m] += take; }
    if (e.aug[m] >= u) { e.aug[m] -= u; e.flags[m] &= ~PF_LATCH; } else e.flags[m] |= PF_LATCH;
  }
}

/** What a feed asks of its payers for `eu` of gun energy (rounded up: never free) */
function needOf(f: ModFeed, eu: number): number {
  return Math.floor((eu * f.per4096 + 4095) / 4096);
}
/** What a feed's payers hold between them */
function heldOf(e: PortsState, f: ModFeed): number {
  let h = e.held[f.part];
  if (f.more) for (const p of f.more) h += e.held[p];
  return h;
}
/** Gun p's effect slot is live for `eu` of gun energy: its mounts hold power and its specials can pay */
function slotLive(M: PortsMods, e: PortsState, p: number, slot: number, eu: number): boolean {
  for (const m of M.gunMounts[p]![slot]) if (e.flags[m] & PF_LATCH) return false;
  for (const f of M.gunFeeds[p]![slot]) if (heldOf(e, f) < needOf(f, eu)) return false;
  return true;
}

/** The mask of gun p's effects (bit i = L.mod.gunFx[p][i]) that are live right now; spends nothing */
export function portsFxLive(L: PortsLayout, e: PortsState, p: number): number {
  const M = L.mod, g = M?.gunFx[p];
  if (!M || !g) return 0;
  let mask = 0;
  for (let i = 0; i < g.length; i++) if (slotLive(M, e, p, i, L.shot[p])) mask |= 1 << i;
  return mask;
}

let lastFx = 0;
/**
 * Gun p spends a shot of `eu`: the mask of its effects that go on that shot. Uses up what the specials among them need
 * (hopper material, buffered power); an effect whose need can't be met is left off the mask and pays nothing.
 */
export function portsShotFx(L: PortsLayout, e: PortsState, p: number, eu: number): number {
  const M = L.mod, g = M?.gunFx[p];
  lastFx = 0;
  if (!M || !g) return 0;
  let mask = 0;
  for (let i = 0; i < g.length; i++) {
    if (!slotLive(M, e, p, i, eu)) continue;
    mask |= 1 << i;
    for (const f of M.gunFeeds[p]![i]) {
      let need = needOf(f, eu);
      const h = e.held[f.part], t = h < need ? h : need;
      e.held[f.part] = h - t; need -= t;
      if (f.more) for (const q of f.more) { if (need <= 0) break; const hq = e.held[q], tq = hq < need ? hq : need; e.held[q] = hq - tq; need -= tq; }
    }
  }
  return (lastFx = mask);
}

/** The effect mask of the last shot or beam step spent (read right after portsSpendShot / portsBeamStep) */
export function portsLastFx(): number {
  return lastFx;
}
/** No shot was spent (portsBeamStep on a tick the beam doesn't burn) */
export function portsNoFx(): void {
  lastFx = 0;
}

/** A shot of `shot` eu on gun p with Rapid live: 1/rate of it (energy neutral: the shots come that much sooner) */
export function portsRapidShot(L: PortsLayout, e: PortsState, p: number, shot: number): number {
  const M = L.mod, r = M?.rapid?.[p];
  if (!M || !r || !slotLive(M, e, p, r - 1, L.shot[p])) return shot;
  const s = Math.round((shot * M.rapidCost![p]) / 4096);
  return s > 1 ? s : 1;
}
/** Whether Rapid is live on gun p now, and its strength step (0: not): the gun's beat is its own ÷ rapidRate(mt, q) */
export function portsRapidStep(L: PortsLayout, e: PortsState, p: number): number {
  const M = L.mod, r = M?.rapid?.[p];
  return M && r && slotLive(M, e, p, r - 1, L.shot[p]) ? M.gunFx[p]![r - 1].q : 0;
}
