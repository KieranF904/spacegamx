/**
 * What a palette row shows at a glance (no DOM): for a weapon three bars (damage per hit, shots a second, reach), for
 * anything else its one or two headline numbers; and for every part its ammunition (the ammo item and how many a shot)
 * and its power need (how much, and where it is fed). The long text stays in the tooltip and the opened facts.
 *
 * Bars are drawn against the strongest weapon model in the catalogue (square-root scaled so a weak gun still shows a
 * sliver), so rows are comparable down the list. Everything is read from the data and `partStats`, never per part.
 */

import {
  averageInterval, partStats, type Catalog, type FunctionDef, type ShipTuning, type Side,
} from '@space-game/common';
import { SIDE_WORD } from './buildFacts';
import { usesAmmo } from './paletteFilters';

export interface CardBar {
  id: 'hit' | 'rate' | 'range' | 'dps';
  label: string;
  /** The number as shown ("62", "3.3/s", "1,400") */
  text: string;
  /** 0..1 against the strongest weapon */
  frac: number;
}

export interface CardAmmo {
  /** The ammo item's id (its icon) and the rounds a shot spends */
  item: string;
  per: number;
}

export interface CardPower {
  /** 'draw': it runs on power; 'make': it generates it; 'hold': it stores it */
  kind: 'draw' | 'make' | 'hold';
  /** Energy a second (hold: the store) */
  amount: number;
  /** Where it is fed from, in plain words ("back", "left, back"), empty when it has no in ports */
  where: string;
}

export interface CardStats {
  /** A weapon's bars (empty for other parts) */
  bars: CardBar[];
  /** A held beam fires all the time: shown as a word beside the bars */
  held: boolean;
  /** A non-weapon's headline numbers ("Thrust 4.0") */
  heads: string[];
  ammo: CardAmmo | null;
  power: CardPower | null;
}

const n0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');
const rateText = (r: number) => `${r >= 10 ? n0(r) : r.toFixed(1)}/s`;
const sqrtFrac = (v: number, max: number) => (max > 0 && v > 0 ? Math.max(0.06, Math.min(1, Math.sqrt(v / max))) : 0);

interface WeaponNums { hit: number; rate: number; range: number; dps: number; held: boolean }

/** A weapon's raw numbers: damage per trigger event, events a second (clip reloads and charges counted), reach, damage a second */
function weaponNums(catalog: Catalog, tuning: ShipTuning | undefined, fn: FunctionDef, piece: string, material: string): WeaponNums | null {
  const st = partStats(catalog, tuning, { fn: fn.id, piece, material });
  if (!st || !fn.weapon) return null;
  if (st.heal || st.intercept) return { hit: 0, rate: st.intercept?.perSec ?? 0, range: st.range ?? 0, dps: 0, held: false };
  const held = fn.fire?.model === 'beam' && !st.pulse;
  const rate = held ? 0 : 60 / Math.max(1, averageInterval(fn.fire, fn.fireInterval ?? 10));
  const dps = st.dps ?? 0;
  const hit = st.pulse ? st.pulse.damage : rate > 0 ? dps / rate : 0;
  return { hit, rate: st.pulse ? 1 / Math.max(0.05, st.pulse.seconds) : rate, range: st.range ?? 0, dps, held };
}

const maxima = new WeakMap<object, { hit: number; rate: number; range: number; dps: number }>();

/** The strongest figure of each kind among the weapon models, for scaling the bars */
function weaponMax(catalog: Catalog, tuning: ShipTuning | undefined): { hit: number; rate: number; range: number; dps: number } {
  const key = tuning ?? catalog;
  const hit = maxima.get(key);
  if (hit) return hit;
  const m = { hit: 0, rate: 0, range: 0, dps: 0 };
  for (const fn of catalog.functions.values()) {
    if (!fn.model || !fn.weapon) continue;
    const n = weaponNums(catalog, tuning, fn, fn.pieces === '*' ? 'sq' : fn.pieces[0], fn.material ?? 'alloy');
    if (!n) continue;
    m.hit = Math.max(m.hit, n.hit); m.rate = Math.max(m.rate, n.rate); m.range = Math.max(m.range, n.range); m.dps = Math.max(m.dps, n.dps);
  }
  maxima.set(key, m);
  return m;
}

/** The sides a part is fed from ("back", "left, back"), from its in ports */
export function fedFrom(fn: Pick<FunctionDef, 'ports'>): string {
  const sides = new Set<string>();
  for (const p of fn.ports ?? []) if (p.dir === 'in') sides.add(SIDE_WORD[p.side as Side] ?? p.side);
  return [...sides].join(', ');
}

/** Everything a row shows for the part `fn` in `piece` and `material` (a model's own material wins) */
export function cardStats(catalog: Catalog, tuning: ShipTuning | undefined, fn: FunctionDef, piece: string, material: string): CardStats {
  const mat = fn.model && fn.material ? fn.material : material;
  const out: CardStats = { bars: [], held: false, heads: [], ammo: null, power: null };
  const st = partStats(catalog, tuning, { fn: fn.id, piece, material: mat });
  if (!st) return out;

  if (fn.weapon) {
    const n = weaponNums(catalog, tuning, fn, piece, mat);
    if (n && (n.hit > 0 || n.dps > 0)) {
      const max = weaponMax(catalog, tuning);
      out.held = n.held;
      if (n.held) out.bars.push({ id: 'dps', label: 'Damage a second', text: n0(n.dps), frac: sqrtFrac(n.dps, max.dps) });
      else {
        out.bars.push({ id: 'hit', label: 'Damage per hit', text: n0(n.hit), frac: sqrtFrac(n.hit, max.hit) });
        out.bars.push({ id: 'rate', label: 'Shots a second', text: rateText(n.rate), frac: sqrtFrac(n.rate, max.rate) });
      }
      if (n.range > 0) out.bars.push({ id: 'range', label: 'Reach', text: n0(n.range), frac: sqrtFrac(n.range, max.range) });
    } else if (st.heal) out.heads.push(`Mends ${n0(st.heal)}/s`);
    else if (st.intercept) out.heads.push(`${st.intercept.perSec.toFixed(1)} shots/s`);
  } else {
    if (st.thrust) out.heads.push(`Thrust ${st.thrust.toFixed(1)}`);
    if (st.supply) out.heads.push(`Makes ${n0(st.supply)}/s`);
    if ((fn.store ?? 0) > 0) out.heads.push(`Holds ${n0(fn.store! * st.area)}`);
    if (st.shield) out.heads.push(`Shield ${n0(st.shield)}`);
    if (st.cargo) out.heads.push(`Cargo ${n0(st.cargo)}`);
    if ((fn.range ?? 0) > 0) out.heads.push(`Scan ${n0(fn.range!)}`);
    if (!out.heads.length) out.heads.push(`${n0(st.hp)} hp`);
    out.heads.length = Math.min(out.heads.length, 2);
  }

  // Ammunition: the item it fires from and the rounds a shot spends (a gun on ammunition pays with it, never power)
  if (fn.weapon && usesAmmo(fn)) {
    const item = tuning?.weapons?.[fn.weapon]?.ammo?.item;
    if (item) out.ammo = { item, per: fn.fire?.rounds ?? 1 };
  }

  // Power: what it draws, makes or holds, and which side feeds it
  if (st.supply) out.power = { kind: 'make', amount: st.supply, where: '' };
  else if (st.draw) out.power = { kind: 'draw', amount: st.draw, where: fedFrom(fn) };
  else if ((fn.store ?? 0) > 0) out.power = { kind: 'hold', amount: fn.store! * st.area, where: '' };
  return out;
}
