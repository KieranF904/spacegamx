/**
 * The hangar's part tooltip: what the part under the mouse is and does (its
 * grade, hit points and mass, and by function its damage, thrust, power,
 * storage...), how it's mounted, and its state: a ghost still to build (and
 * what that takes), new since the last save, or damaged / shot off on the
 * ship you're flying.
 */

import {
  Catalog, Economy, PlacedPart, ShipTuning, ShipDerived, Side, WeaponMods, Bag,
  partStats, partItemId, placeCost, isStructural, outputOf, gradeOf, fnOutput, partGrade, partMaterial, energyTuning, jumpTuning, coilCapacity, CORE_CARGO, PIECE_NAMES, partBuildPoints, DAMAGE_NAMES, isPowerPart, mountingWords, type DamageType } from '@space-game/common';
import { costHtml } from '../ui/windowKit';
import { jumpRatioNote } from './shipSummary';
import { functionColor, numToCss } from './shipColors';
import { MOUNT_TEXT, tradeOff, weaponMount } from './modelCards';

export interface PartTipCtx {
  catalog: Catalog;
  tuning: ShipTuning;
  econ: Economy;
  /** The design's derived state and this part's index in it (power, gun timing, turret window) */
  derived?: ShipDerived | null;
  index?: number;
  /** Where it stands: placed on the grid, or picked from the palette */
  state?: 'built' | 'ghost' | 'new' | 'wrecked' | 'palette';
  /** On the ship you're flying: its HP now, and whether it's been shot off */
  live?: { hp: number; max: number; detached: boolean } | null;
  /** Every part is free (proto/admin): no build costs */
  free?: boolean;
  /** Spare ones in storage (palette) */
  spare?: number;
  /** Why it can't be made yet (a locked model: its level) */
  lock?: string;
  /** The mounting rules this placed part breaks (common partMountingProblems), in words */
  mounting?: string[];
  have(id: string): number;
  canMake(id: string): boolean;
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const n0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : '—');
const FACING: Record<Side, string> = { N: 'forward', E: 'right', S: 'back', W: 'left' };
const KIND: Record<string, string> = { beam: 'beam', projectile: 'shells' };

export const PART_TIP_CSS = `position:fixed; z-index:2100; pointer-events:none; display:none; max-width:270px; background:rgba(13,21,36,0.97);
  border:1px solid #2a3a5a; border-radius:8px; padding:8px 10px; color:#cfd8e6; font:12px 'Segoe UI', system-ui, sans-serif; line-height:1.35;
  box-shadow:0 8px 24px rgba(0,0,0,0.5);`;

function row(k: string, v: string): string {
  return `<div style="display:flex; justify-content:space-between; gap:12px; padding:2px 0; border-bottom:1px solid #18223a"><span style="color:#8ea0bd">${k}</span><b style="color:#e5ecf7; font-weight:600; text-align:right">${v}</b></div>`;
}

/**
 * What a material takes more or less of: "Kinetic −15% · Energy +20%" (green
 * where it shrugs some off, red where it takes more)
 */
export function resistText(r: Partial<Record<DamageType, number>> | undefined): string {
  if (!r) return '';
  return Object.entries(r).map(([t, v]) => {
    const pct = Math.round((v! - 1) * 100);
    return `<span style="color:${pct < 0 ? '#86efac' : '#fca5a5'}">${DAMAGE_NAMES[t as DamageType]} ${pct > 0 ? '+' : '−'}${Math.abs(pct)}%</span>`;
  }).join(' · ');
}

/** "damage +20% · burst +1 · ignite" */
export function modsText(m: WeaponMods | undefined): string {
  if (!m) return '';
  const out: string[] = [];
  for (const [k, v] of Object.entries(m.mul ?? {})) if (v) out.push(`${k} ${v > 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)}%`);
  for (const [k, v] of Object.entries(m.add ?? {})) if (v) out.push(`${k} ${v > 0 ? '+' : '−'}${Math.abs(v)}`);
  for (const k of Object.keys(m.set ?? {})) if (k !== 'color') out.push(k);
  return out.join(' · ');
}

export function partTipHtml(p: Pick<PlacedPart, 'fn' | 'material' | 'piece'> & Partial<PlacedPart>, c: PartTipCtx): string {
  const { catalog, tuning, econ } = c;
  const fn = catalog.functions.get(p.fn), mat = partMaterial(catalog, p);
  const st = partStats(catalog, tuning, p);
  if (!fn || !st) return esc(p.fn);
  const id = partItemId(p);
  const name = econ.items.name(id);
  const piece = PIECE_NAMES[p.piece] ?? p.piece;
  const d = c.derived, i = c.index ?? -1;
  let html = `<div style="display:flex; gap:6px; align-items:center"><span style="width:9px; height:9px; border-radius:2px; flex:none; background:${numToCss(functionColor(p.fn))}"></span>`
    + `<b style="color:#e5ecf7; font-size:13px">${esc(name)}</b></div>`;
  html += `<div style="color:#ffb547; font-size:11px; margin:1px 0 5px">${st.mark}${st.size ? ` · ${st.size}` : ''}${name.endsWith(piece) ? '' : ` · ${esc(piece)}`} · ${Math.round(st.area * 10) / 10} cell${st.area === 1 ? '' : 's'}</div>`;

  // State first: it's what matters most when it isn't simply fitted
  const live = c.live;
  if (c.state === 'ghost') html += `<div style="color:#7dd3fc; margin-bottom:4px">Ghost: not built yet</div>`;
  else if (c.state === 'new') html += `<div style="color:#fbbf24; margin-bottom:4px">New: save to build it in</div>`;
  else if (c.state === 'wrecked' || live?.detached || (live && live.hp <= 0)) html += `<div style="color:#f87171; margin-bottom:4px">${live?.detached ? 'Shot off' : 'Destroyed'}: the station rebuilds it</div>`;
  else if (live && live.hp < live.max - 1e-6) html += `<div style="color:#fbbf24; margin-bottom:4px">Damaged: ${Math.round((live.hp / live.max) * 100)}% (${n0(live.hp)} / ${n0(live.max)} hp)</div>`;

  html += row('Hull · mass', `${n0(st.hp)} hp · ${st.mass.toFixed(1)}`);
  html += row('Armour · build', `${st.armour} · ${Math.round(partBuildPoints(catalog, p) * 10) / 10} pts`);
  const res = resistText(st.resist);
  if (res) html += row('Takes', res);
  if (fn.weapon) {
    const def = tuning.weapons?.[fn.weapon];
    const w = d?.weapons.find((x) => x.part === i);
    const rate = 60 / (fn.fireInterval ?? 10);
    // (A fading beam: full strength to its effective range, then weaker out to its full one)
    html += row('Damage', `${n0(st.dps ?? 0)}/s${st.range ? ` · reach ${st.effectiveRange ? `${n0(st.effectiveRange)}, fading out to ${n0(st.range)}` : n0(st.range)}` : ''}`);
    if (st.damageType) html += row('Hits with', `${DAMAGE_NAMES[st.damageType]} · penetration ${Math.round((st.pen ?? 1) * 10) / 10}`);
    // A pulse laser: a pulse's damage, and how long it takes to charge the next
    if (st.pulse) html += row('Pulse', `${n0(st.pulse.damage)} a pulse · charges in ${st.pulse.seconds.toFixed(1)}s · no heat`);
    else html += row('Fire rate', `${rate >= 10 ? n0(rate) : rate.toFixed(1)}/s · ${esc(KIND[def?.type ?? ''] ?? def?.type ?? fn.weapon)}${def?.ammo ? ` · ${esc(econ.items.name(def.ammo.item))}` : ''}`);
    if (w && w.satisfaction < 0.995) html += row('Under-powered', `<span style="color:#fbbf24">${Math.round(w.satisfaction * 100)}%: fires slower</span>`);
    // (Its model's mount: not a choice)
    const facing = p.facing ? FACING[p.facing] : '';
    const arc = w?.window ? ` · ${Math.round((w.window.open.reduce((s, [lo, hi]) => s + hi - lo, 0) * 180) / Math.PI)}° clear` : '';
    // Its rules ("Turret, 270°", "Side mount (flippable)", "Needs 3 clear cells ahead"): the first is the mount
    const words = mountingWords(catalog, { ...fn, ...(fn.mount ? {} : { mount: weaponMount(catalog, p) }) }, tuning);
    html += row('Mount', `${esc(words[0] ?? MOUNT_TEXT[weaponMount(catalog, p)])}${facing ? `, facing ${facing}` : ''}${arc}`);
    if (words.length > 1) html += row('Fitting', esc(words.slice(1).join(' · ')));
    for (const m of c.mounting ?? []) html += `<div style="color:#f87171; font-size:11px; margin-top:3px">✕ ${esc(m)}</div>`;
  } else if (p.facing) html += row('Facing', FACING[p.facing]);
  if (st.thrust) html += row('Thrust', `${st.thrust.toFixed(1)}${st.boost ? ` · boost ×${st.boost}` : ''}`);
  if (st.supply) html += row('Power out', `<span style="color:#86efac">+${n0(st.supply)}/s</span>`);
  if (st.draw) {
    const sat = d && i >= 0 ? d.satisfaction[i] : 1;
    html += row('Power draw', `${n0(st.draw)}/s${sat < 0.995 ? ` <span style="color:#fbbf24">(${Math.round(sat * 100)}% met)</span>` : ''}`);
  }
  if ((fn.store ?? 0) > 0) html += row(fn.pool === 'drive' ? 'Holds (engines)' : fn.pool === 'weapon' ? 'Holds (guns)' : 'Holds', `${n0(fn.store! * st.area * fnOutput(fn, mat))} energy`);
  if (fn.rated) html += row('Rated speed', `${n0(fn.rated * 60)} m/s <span style="color:#8ea0bd; font-weight:400">(its push fades out near it)</span>`);
  // On the design: the power network it's wired into (wires.ts)
  if (d && i >= 0 && isPowerPart(fn)) {
    const k = d.network[i], net = d.networks[k];
    html += row('Wired', k < 0 ? '<span style="color:#f87171">to nothing: no power</span>' : net?.powered ? `network ${k + 1}` : `<span style="color:#fbbf24">network ${k + 1}: no generator</span>`);
  }
  if (st.shield) html += row('Shield', n0(st.shield));
  if (st.cargo) html += row('Cargo', n0(st.cargo));
  if ((fn.range ?? 0) > 0 && !fn.weapon) html += row('Scan range', `${n0(fn.range!)} m`);
  // Jump coils (and the core's own): cells of hull served, and how the ship's coils stand against its hull
  const coilCells = p.fn === 'core' ? jumpTuning(tuning).coreCapacity : (fn.jumpCapacity ?? 0) * st.area;
  if (coilCells > 0) {
    html += row('Jump coil', `serves ${n0(coilCapacity(coilCells, partGrade(catalog, p), jumpTuning(tuning)))} cells of hull`);
    if (d?.jumpRatio !== undefined) {
      const note = jumpRatioNote(d.jumpRatio);
      html += row("Ship's coils", `${d.jumpRatio.toFixed(2)}× its hull · <span style="color:${note.color}">${note.word}</span>`);
    }
  }
  if (p.fn === 'core') {
    const jt = jumpTuning(tuning);
    html += row('Battery', n0(energyTuning(tuning).coreCapacity));
    html += row('Steering', `gyro ${n0(tuning.flight.gyroTorque)} · strafe ${tuning.flight.coreManeuverForce.toFixed(1)}`);
    html += row('Jump drive', d ? `${(d.jumpRange / 1000).toFixed(1)} km · ${Math.round(d.jumpCooldown / 60)} s` : `${(jt.baseRange / 1000).toFixed(0)} km · ${Math.round(jt.cooldownTicks / 60)} s when its coils suit the hull`);
    html += row('Cargo', n0(CORE_CARGO));
  }
  const mods = modsText(p.mods);
  if (mods) html += row('Mods', `<span style="color:#c4b5fd">${esc(mods)}</span>`);
  if (c.state === 'palette' && fn.model && !(fn.description ?? '').toLowerCase().includes(tradeOff(fn).toLowerCase())) html += `<div style="color:#cbd5e1; font-size:11px; font-style:italic; margin-top:5px">${esc(tradeOff(fn))}</div>`;
  if (fn.description && c.state === 'palette') html += `<div style="color:#8ea0bd; font-size:11px; margin-top:5px">${esc(fn.description)}</div>`;

  // What building it takes (a ghost, or one you'd place without a spare)
  if (c.free) { /* nothing to build */ } else if (c.state === 'ghost' || (c.state === 'palette' && !c.spare)) {
    const bag: Bag = placeCost(econ, p);
    const stored = !isStructural(p.fn) && c.have(id) > 0;
    const r = isStructural(p.fn) || stored ? null : econ.recipes.recipeFor(id);
    const can = isStructural(p.fn) || c.canMake(id);
    html += `<div style="color:#8ea0bd; font-size:11px; margin-top:6px">${stored ? 'One is in storage: it goes in when you build' : !can ? `<span style="color:#f87171">${esc(c.lock || "You can't make this yet")}</span>` : 'Building it takes'}</div>`;
    if (!stored && can) {
      const cost = r ? r.inputs : bag;
      html += `<div style="font-size:11px; margin-top:3px; white-space:normal">${costHtml(econ, cost, c.have)}${r ? (r.time > 0 ? ` <span style="color:#fbbf24">⏳ ${r.time}s</span>` : ' <span style="color:#a5f3a1">instant</span>') : ''}</div>`;
    }
  } else if (c.state === 'palette' && c.spare) html += `<div style="color:#4ade80; font-size:11px; margin-top:6px">${c.spare} on hand</div>`;
  return html;
}
