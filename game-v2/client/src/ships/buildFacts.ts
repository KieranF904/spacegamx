/**
 * The hangar palette's opened row: what a part means for building a ship, read from the data and the rules (no DOM,
 * plain text): its footprint in the shape in hand, toughness and mass, what it does (damage, fire, thrust, shields...),
 * its power (generates, draws, holds) and its ports, where and how it fits (mounting rules, facing, exhaust), and any
 * limit on it. The component guide's opened row is the reading version; this is the building one.
 */

import {
  describeFn, mountingWords, partBuildPoints, partFacingRule, partStats, CORE_CARGO, DAMAGE_NAMES, isWeaponFn,
  type Catalog, type FunctionDef, type ShipTuning, type Side,
} from '@space-game/common';
import { footprint, footprintText } from '../ui/componentShapes';
import { fireChip } from './modelCards';
import { tipRows } from './describe';

export type FactGroup = 'Shape' | 'Build' | 'Does' | 'Power' | 'Fitting' | 'Limits';

export interface BuildFact { group: FactGroup; label: string; value: string; warn?: boolean }

const n0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');
const n1 = (v: number) => (Math.round(v * 10) / 10).toString();

/** A port's side on the part as drawn unturned */
export const SIDE_WORD: Record<Side, string> = { N: 'front', S: 'back', E: 'right', W: 'left' };

/** Its ports (the ports power core: functions.json / models.json `ports`): "in at the back 29/s" */
export function portsText(fn: Pick<FunctionDef, 'ports'>): string[] {
  return (fn.ports ?? []).map((p) => `${p.dir} at the ${SIDE_WORD[p.side as Side] ?? p.side} ${n0(p.rate)}/s`);
}

/** The facts, by group, for a part of `fn` in `piece` and `material` (a model's own material wins) */
export function buildFacts(catalog: Catalog, tuning: ShipTuning | undefined, fn: FunctionDef, piece: string, material: string): BuildFact[] {
  const mat = fn.model && fn.material ? fn.material : material;
  const p = { fn: fn.id, piece, material: mat };
  const st = partStats(catalog, tuning, p);
  const out: BuildFact[] = [];
  const add = (group: FactGroup, label: string, value: string, warn?: boolean) => { if (value) out.push(warn ? { group, label, value, warn } : { group, label, value }); };

  // Shape: its footprint in this piece
  const fp = footprint(catalog, piece);
  add('Shape', fp.name, `${fp.size} · ${footprintText(fp)}`);
  if (!st) return out;

  // Build: toughness, mass, build points
  add('Build', 'Hull · armour', `${n0(st.hp)} hp · armour ${st.armour}`);
  add('Build', 'Mass', n1(st.mass));
  add('Build', 'Build points', n1(partBuildPoints(catalog, p)));

  // Does: weapon numbers, thrust, shields, cargo...
  if (fn.weapon) {
    if (st.heal) add('Does', 'Mends', `${n0(st.heal)} hp/s`);
    else if (st.intercept) add('Does', 'Intercepts', `${st.intercept.perSec.toFixed(1)} shots/s at ordnance`);
    else if (st.pulse) add('Does', 'Damage', `${n0(st.pulse.damage)} a pulse · every ${st.pulse.seconds.toFixed(1)} s`);
    else if (st.dps !== undefined) add('Does', 'Damage', `${n0(st.dps)}/s${st.damageType ? ` ${DAMAGE_NAMES[st.damageType].toLowerCase()}` : ''}`);
    if (st.range) add('Does', 'Reach', st.effectiveRange ? `${n0(st.effectiveRange)}, fading to ${n0(st.range)}` : n0(st.range));
    const rate = 60 / (fn.fireInterval ?? 10);
    const chip = fireChip(fn);
    add('Does', 'Fires', `${chip || 'cycle'}${fn.fire?.model === 'beam' ? '' : ` · ${rate >= 10 ? n0(rate) : rate.toFixed(1)}/s`}`);
  }
  if (st.thrust) add('Does', 'Thrust', `${st.thrust.toFixed(1)}${(st.boost ?? 1) > 1 ? ` · boost ×${st.boost}` : ' · no boost'}`);
  if (fn.rated) add('Does', 'Top speed', `${n0(fn.rated * 60)} m/s`);
  if (st.shield) add('Does', 'Shield', `${n0(st.shield)}${fn.shieldRegen ? ` · refills ${n0(fn.shieldRegen * st.area)}/s` : ''}`);
  if (fn.splashTaken !== undefined && fn.splashTaken < 1) add('Does', 'Blasts', `${Math.round((1 - fn.splashTaken) * 100)}% less`);
  if (st.cargo) add('Does', 'Cargo', n0(st.cargo));
  if (fn.id === 'core') add('Does', 'Cargo', n0(CORE_CARGO));
  if ((fn.range ?? 0) > 0 && !fn.weapon) add('Does', 'Scan range', `${n0(fn.range!)} m`);
  if (st.dodge) add('Does', 'Dodge', `${st.dodge.force.toFixed(1)} push · every ${st.dodge.cooldown.toFixed(1)} s`);
  // (What its features say: a Gyro's turn, a Tow Beam's tow...; its warnings stay warnings)
  for (const r of tipRows(describeFn(catalog, tuning, fn.id, piece, mat), true)) add('Does', r.label, r.text, r.warn);

  // Power: makes, draws, holds; and its ports
  if (st.supply) add('Power', 'Generates', `+${n0(st.supply)}/s`);
  // (When it draws: a Burst Strafer only bursting, a Gyro only turning (in proportion), a shield all the time, refilling only as it is fed)
  const when = fn.strafe ? ' during a burst' : (fn.gyro ?? 0) > 0 ? ' turning flat out' : (fn.shield ?? 0) > 0 && !fn.flash ? ' always; refills only as fed' : '';
  if (st.draw) add('Power', 'Draws', `${n0(st.draw)}/s${when}`);
  // (Its own buffer, filled over its in ports: what a burst or a turn runs on)
  if ((fn.strafe || (fn.gyro ?? 0) > 0) && fn.buffer !== undefined && st.draw && fn.demand) {
    const buf = fn.buffer * st.area * (st.draw / (fn.demand * st.area)), secs = buf / st.draw;
    const bursts = fn.strafe ? Math.floor((secs * 60) / Math.max(1, fn.strafe.ticks) + 1e-9) : 0;
    add('Power', 'Buffer', `${n0(buf)} · ${fn.strafe ? `${bursts} burst${bursts === 1 ? '' : 's'}` : `${secs.toFixed(1)} s turning`} held`);
  }
  if ((fn.store ?? 0) > 0) add('Power', 'Holds', n0(fn.store! * st.area));
  if ((fn.dynamo ?? 0) > 0) add('Power', 'Charges banks', `${n0(fn.dynamo!)}/s each`);
  const ports = portsText(fn);
  if (ports.length) add('Power', 'Ports', ports.join(' · '));

  // Fitting: a weapon's mounting rules; which way it points; an engine's exhaust
  if (isWeaponFn(fn.id)) add('Fitting', 'Mount', mountingWords(catalog, fn, tuning).join(' · '));
  const facing = partFacingRule(fn.id);
  if (facing === 'free') add('Fitting', 'Facing', 'out of a free straight edge (T picks the side)');
  else if (facing === 'joined') add('Fitting', 'Facing', 'its front must touch a part (T picks the side)');
  if ((fn.thrust ?? 0) > 0) add('Fitting', 'Exhaust', 'needs a clear line out behind it; each blocked lane costs thrust');

  // Limits: the rules on how many (blueprint validation)
  if (fn.id === 'core') add('Limits', 'Per ship', 'exactly one; every part must join back to it');
  return out;
}
