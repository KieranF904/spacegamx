/**
 * The weapon ring's data (docs/design/rework-2026-11.md §3.4): your guns grouped by model, each group's clip, charge,
 * spin and ammo read from the gun state your own client steps (its own ship's whole step on its tick layer, own/OwnTick.ts;
 * the server's ownSync keeps it exact). Pure: no DOM; WeaponRing.ts draws it.
 *
 * The groups and their records are built when the ship's structure changes; `update` then rewrites the same records
 * every frame, so a frame allocates nothing.
 */

import { PF_LIT, clipReloading, gunSelected, inGroup, partWeaponGroups, portsMinePhase, portsPiecesHeld, rightFiresGuns, selLeft, selRight, GROUP_ALL, type Charge, type FireModel, type PortsState, type ShipState } from '@space-game/common';

export interface RingGroup {
  /** The model (the part's function id) these guns are */
  fn: string;
  model: FireModel;
  /** Weapon kind (tuning.weapons key): what its ammo is looked up by */
  kind: string;
  /** The weapon groups the guns are in (ships/weaponGroups.ts, a 4-bit mask; a group is one mask) */
  wg: number;
  /** In neither the left nor the right button's selected group (drawn dim); a mining laser group while the right button is on a group */
  dim: boolean;
  /** In the left button's selected group: shows its state (a chip colour) when a group is selected */
  inLeft: boolean;
  /** Show `state` (a group is selected: with the default selection the ring reads as it always did) */
  showState: boolean;
  /** Ready 0, reloading 1, short of power 2 (any gun of the group) */
  state: 0 | 1 | 2;
  /** Part indices of the guns in the group */
  parts: number[];
  /** The guns' weapon records, parallel to `parts` (resolved at regroup so a frame looks nothing up) */
  ws: Weapon[];
  /** Clip size of one gun (0: not a clip gun) */
  clip: number;
  /** Rounds in the clip, averaged over the group's guns */
  rounds: number;
  /** A reload is under way (a regrowing clip: always while it is short of full) */
  reloading: boolean;
  /** Charge gun charge, or a beam's windup, 0..1 (the fullest gun in the group) */
  charge: number;
  /** A charge gun cooling down after its shot, 0..1 left */
  cooling: number;
  /** Flash strength 0..1: at full charge, and for a moment after the shot */
  flash: number;
  /** Spin 0..1 (a spinning gun's, the fastest in the group) */
  spin: number;
  /** Cycle and ammo guns: how ready the next shot is, 0..1 (the slowest gun's) */
  ready: number;
  /** Ammo guns: rounds left in the open crate (and crates aboard), -1 when the gun takes none */
  ammo: number;
  crates: number;
  /** The previous frame's charge (for the flash after a shot) */
  prevCharge: number;
  /** A beam in pieces (power/ports.ts; the group's first gun): its pieces (0: not one), whole pieces held, how full the next
   * one is 0..1 (a part-filled piece: it can't fire, and is thrown away when a whole one is spent), how much of the piece
   * burning is left 0..1 (0: none burning), and how much of the cooldown is left 0..1 */
  pieces: number;
  piecesFull: number;
  piecePart: number;
  pieceBurn: number;
  pieceCool: number;
  /** A ports ship's mining lasers of one model (power/ports.ts portsMineStep), not a gun: how far through its pulse the first
   * one is 0..1 (-1: none running), its fulfilment 0..1 (the share of its draw it gets), and its buffer 0..1 */
  mine: boolean;
  minePhase: number;
  mineFill: number;
  mineBuffer: number;
}

/** What `update` reads besides the ship: the stored energy, and the rounds a kind of gun has left aboard */
export interface RingSources {
  charge: Charge;
  /** Rounds in the open crate and crates in the hold, for a kind of gun that fires them; null for a gun that takes no ammo (the same record each call) */
  ammoOf(kind: string): { loose: number; crates: number } | null;
  /** The weapon groups selection (packGroupSel; absent: all/all) */
  sel?: number;
}

type Weapon = ShipState['derived']['weapons'][number];

const FLASH_FRAME = 0.1;

export class RingModel {
  groups: RingGroup[] = [];
  private ship: ShipState | null = null;
  private rebuilds = -1;

  /** Regroup after the ship (or its structure) changed */
  private regroup(ship: ShipState): void {
    this.ship = ship;
    this.rebuilds = ship.rebuilds;
    const by = new Map<string, RingGroup>();
    const out: RingGroup[] = [];
    for (const w of ship.derived.weapons) {
      // (Mining lasers and tools aren't guns here: only what stepGuns steps)
      const fn = ship.blueprint.parts[w.part]?.fn ?? w.kind;
      const mask = partWeaponGroups(ship.blueprint.parts[w.part]);
      const key = `${fn}|${w.fire.model}|${mask}`;
      let g = by.get(key);
      if (!g) {
        g = {
          fn, model: w.fire.model, kind: w.kind, wg: mask, dim: false, inLeft: true, showState: false, state: 0, parts: [], ws: [], clip: w.fire.model === 'clip' ? (w.fire.clip ?? 1) : 0,
          rounds: 0, reloading: false, charge: 0, cooling: 0, flash: 0, spin: 0, ready: 1, ammo: -1, crates: 0, prevCharge: 0,
          pieces: 0, piecesFull: 0, piecePart: 0, pieceBurn: 0, pieceCool: 0, mine: false, minePhase: -1, mineFill: 1, mineBuffer: 1,
        };
        by.set(key, g);
        out.push(g);
      }
      g.parts.push(w.part);
      g.ws.push(w);
    }
    // (A ports ship's mining lasers: one group a model, after the guns, for their pulse and fulfilment)
    if (ship.derived.ports) for (const m of ship.derived.miners) {
      const fn = ship.blueprint.parts[m.part]?.fn ?? 'miner', key = `${fn}|mine`;
      let g = by.get(key);
      if (!g) {
        g = {
          fn, model: 'beam', kind: fn, wg: 1, dim: false, inLeft: false, showState: false, state: 0, parts: [], ws: [], clip: 0, rounds: 0, reloading: false, charge: 0, cooling: 0, flash: 0, spin: 0, ready: 1, ammo: -1, crates: 0, prevCharge: 0,
          pieces: 0, piecesFull: 0, piecePart: 0, pieceBurn: 0, pieceCool: 0, mine: true, minePhase: -1, mineFill: 1, mineBuffer: 1,
        };
        by.set(key, g);
        out.push(g);
      }
      g.parts.push(m.part);
    }
    this.groups = out;
    this.multi = ship.derived.weapons.some((w) => partWeaponGroups(ship.blueprint.parts[w.part]) !== 1);
  }

  /** Some weapon is in a group other than 1 (the chip is worth showing before anything is selected) */
  private multi = false;

  /** The HUD chip, "L: 2  R: all": when a group is selected or a weapon has been put in another group; else empty */
  chip(sel: number): string {
    if (!this.groups.length || (sel === 0 && !this.multi)) return '';
    const n = (g: number) => (g === GROUP_ALL ? 'all' : String(g));
    return `L: ${n(selLeft(sel))}  R: ${n(selRight(sel))}`;
  }

  /** This frame's values (the same records, rewritten). Returns the groups, empty without a gun */
  update(ship: ShipState | null, src: RingSources): RingGroup[] {
    if (!ship || ship.kind !== 'ship') { this.ship = null; this.groups.length = 0; return this.groups; }
    if (ship !== this.ship || ship.rebuilds !== this.rebuilds) this.regroup(ship);
    const d = ship.derived, sel = src.sel ?? 0, hasMiners = d.miners.length > 0;
    for (const g of this.groups) {
      g.showState = sel !== 0;
      if (g.mine) {
        this.mine(g, ship, src.charge);
        g.dim = rightFiresGuns(sel, true);
        continue;
      }
      g.dim = !gunSelected(g.wg, sel, hasMiners);
      g.inLeft = selLeft(sel) === GROUP_ALL || inGroup(g.wg, selLeft(sel));
      let rounds = 0, n = 0, reloading = false, charge = 0, cooling = 0, spin = 0, ready = 1;
      for (let gi = 0; gi < g.parts.length; gi++) {
        const part = g.parts[gi], w = g.ws[gi];
        n++;
        const f = w.fire;
        if (f.model === 'clip') {
          rounds += ship.rounds[part] ?? 0;
          const regrowing = !!f.regrow && (ship.rounds[part] ?? 0) < (f.clip ?? 1);
          if (clipReloading(ship, w) || regrowing) reloading = true;
        } else if (f.model === 'charge') {
          const c = Math.max(0, (ship.charge[part] ?? 0) / Math.max(1, f.charge ?? 60));
          if (c > charge) charge = c;
          const cd = Math.max(0, ship.cooldown[part] ?? 0) / Math.max(1, f.cooldown ?? 1);
          if (cd > cooling) cooling = cd;
        } else if (f.model === 'beam' && f.windup) {
          const c = Math.min(1, (ship.charge[part] ?? 0) / f.windup);
          if (c > charge) charge = c;
        }
        if (f.spin) spin = Math.max(spin, ship.spin[part] ?? 0);
        if (f.model === 'cycle' || f.model === 'ammo' || f.model === 'auto') {
          ready = Math.min(ready, 1 - Math.min(1, Math.max(0, ship.cooldown[part] ?? 0) / Math.max(1, w.interval)));
        }
      }
      this.pieces(g, ship, src.charge);
      g.rounds = n ? rounds / n : 0;
      g.reloading = reloading;
      g.state = reloading || cooling > 0 ? 1 : 0;
      g.charge = Math.min(1, charge);
      g.cooling = Math.min(1, cooling);
      g.spin = spin;
      g.ready = ready;
      // The flash: full charge, and a fading burst after the shot (the charge dropping from near full with the gun cooling)
      if (charge >= 0.98 || (g.prevCharge > 0.85 && charge < 0.5 && cooling > 0.5)) g.flash = 1;
      else g.flash = Math.max(0, g.flash - FLASH_FRAME);
      g.prevCharge = charge;
      // (A cycle gun of a kind that fires rounds, too; a model that pays in power has no ammo entry)
      const a = g.model === 'ammo' || g.model === 'cycle' ? src.ammoOf(g.kind) : null;
      g.ammo = a ? a.loose : -1;
      g.crates = a ? a.crates : 0;
    }
    return this.groups;
  }

  /** Mining lasers on a ports ship: the first one's pulse, fulfilment and buffer, as your predicted ports state has them */
  private mine(g: RingGroup, ship: ShipState, charge: Charge): void {
    const L = ship.derived.ports, e = charge.e as PortsState | undefined, p = g.parts[0];
    if (!L || !e || e.held.length !== L.n || p === undefined) { g.minePhase = -1; g.mineFill = 1; g.mineBuffer = 1; return; }
    const ph = portsMinePhase(L, e, p);
    g.minePhase = ph >= 0 ? Math.min(1, (ph + 1) / Math.max(1, L.minePulse[p])) : -1;
    g.mineFill = ph >= 0 ? e.sat[p] / 255 : 1;
    g.mineBuffer = L.cap[p] > 0 ? Math.max(0, Math.min(1, e.held[p] / L.cap[p])) : 1;
  }

  /** A beam in pieces: its group's first gun's pieces, as your predicted ports state has them */
  private pieces(g: RingGroup, ship: ShipState, charge: Charge): void {
    const L = ship.derived.ports, e = charge.e as PortsState | undefined, p = g.parts[0];
    if (g.model !== 'beam' || !L || !e || e.held.length !== L.n || p === undefined || !L.pieces[p]) { g.pieces = 0; return; }
    const N = L.pieces[p], pe = Math.max(1, L.pieceE[p]), full = portsPiecesHeld(L, e, p), lit = (e.flags[p] & PF_LIT) !== 0;
    g.pieces = N;
    g.piecesFull = full;
    g.piecePart = full < N ? Math.max(0, Math.min(0.999, (e.held[p] - full * pe) / pe)) : 0;
    g.pieceBurn = lit ? Math.max(0, Math.min(1, e.closed[p] / Math.max(1, L.pieceT[p]))) : 0;
    g.pieceCool = !lit && e.closed[p] > 0 ? Math.min(1, e.closed[p] / Math.max(1, L.rest[p])) : 0;
  }
}
