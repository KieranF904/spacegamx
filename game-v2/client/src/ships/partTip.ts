/**
 * The hangar's part tooltip: what the part under the mouse is and does (its
 * grade, hit points and mass, and by function its damage, thrust, power,
 * storage...), how it's mounted, and its state: a ghost still to build (and
 * what that takes), new since the last save, or damaged / shot off on the
 * ship you're flying.
 */

import {
  Catalog, Economy, FunctionDef, PlacedPart, ShipTuning, ShipDerived, Side, WeaponMods, Bag,
  partStats, describePart, partItemId, placeCost, isStructural, outputOf, gradeOf, fnOutput, partGrade, partMaterial, energyTuning, loadTest, gunDrawFlatOut, circuitTuning, partDischarge, partIntake, bankKind, jumpTuning, coilCapacity, CORE_CARGO, PIECE_NAMES, partBuildPoints, DAMAGE_NAMES, mountingWords, type DamageType } from '@space-game/common';
import { costHtml, resistText } from '../ui/windowKit';

// (resistText lives in windowKit so that file need not import this one)
export { resistText };
import { jumpRatioNote } from './shipSummary';
import { functionColor, numToCss } from './shipColors';
import { tipRows } from './describe';
import { FIRE_SENTENCE, REGROW_SENTENCE, MOUNT_TEXT, tradeOff, weaponMount } from './modelCards';
import { esc } from '../ui/escape';

/** A ship's boost-and-fire load test, kept per derived state: a tooltip reads it for every gun (4 s of power ticks) */
const boostFire = new WeakMap<ShipDerived, ReturnType<typeof loadTest>>();

/**
 * What a gun's power means in shots (rework 2026-11 §2.4): how many reloads, charges or shots its banks cover, and a
 * charge gun's real charge time while the ship boosts with no bank behind it
 */
function powerShots(d: ShipDerived, tuning: ShipTuning, i: number, f: NonNullable<FunctionDef['fire']>): [string, string][] {
  const L = d.power, w = d.weapons.find((x) => x.part === i);
  if (!L || !w) return [];
  const out: [string, string][] = [];
  const fd = L.feedOf[i], banks = fd >= 0 ? L.feeds[fd].banks : [];
  if (banks.length && f.model !== 'ammo') {
    const held = banks.reduce((s, b) => s + L.banks[b].cap, 0);
    const per = f.model === 'clip' ? (f.reloadE ?? 0) : f.model === 'charge' ? (f.chargeE ?? 0) : f.model === 'beam' ? L.draw[i] : (L.draw[i] * w.interval) / 60;
    if (per > 0) {
      const n = held / per;
      const text = f.model === 'beam' ? `${n < 10 ? n.toFixed(1) : n0(n)} s of beam` : `${n < 10 ? n.toFixed(1).replace(/\.0$/, '') : n0(n)} ${f.model === 'clip' ? 'reload' : f.model === 'charge' ? 'charge' : 'shot'}${Math.abs(n - 1) < 0.05 ? '' : 's'}`;
      out.push(['Bank covers', `${text} <span style="color:#8ea0bd; font-weight:400">(Bank ${banks.map((b) => b + 1).join(', ')} pays first, then the ship)</span>`]);
    }
  } else if (f.model === 'charge' && (f.chargeE ?? 0) > 0 && gunDrawFlatOut(w, L.draw[i]) > 0) {
    let r = boostFire.get(d);
    if (!r) boostFire.set(d, r = loadTest(d, tuning, { fire: true, thrust: true, boost: true, seconds: 3 }));
    const share = r.part[i];
    if (share < 0.995 && share > 0.02) out.push(['Boosting', `charge ${((f.charge ?? 0) / 60).toFixed(1)} s becomes <span style="color:#fbbf24">${((f.charge ?? 0) / 60 / share).toFixed(1)} s</span> while you boost and fire with no bank behind it`]);
  }
  return out;
}

export interface PartTipCtx {
  catalog: Catalog;
  tuning: ShipTuning;
  econ: Economy;
  /** The design's derived state and this part's index in it (power, gun timing, turret window) */
  derived?: ShipDerived | null;
  index?: number;
  /** Where it stands: placed on the grid, or picked from the palette */
  state?: 'built' | 'ghost' | 'new' | 'wrecked' | 'palette';
  /** Planned only: nothing joins it to the core yet, so nothing builds it */
  loose?: boolean;
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

const n0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : '—');
const FACING: Record<Side, string> = { N: 'forward', E: 'right', S: 'back', W: 'left' };
const KIND: Record<string, string> = { beam: 'beam', projectile: 'shells' };

export const PART_TIP_CSS = `position:fixed; z-index:2100; pointer-events:none; display:none; max-width:270px; background:rgba(13,21,36,0.97);
  border:1px solid #2a3a5a; border-radius:8px; padding:8px 10px; color:#cfd8e6; font:12px 'Segoe UI', system-ui, sans-serif; line-height:1.35;
  box-shadow:0 8px 24px rgba(0,0,0,0.5);`;

function row(k: string, v: string): string {
  return `<div style="display:flex; justify-content:space-between; gap:12px; padding:2px 0; border-bottom:1px solid #18223a"><span style="color:#8ea0bd">${k}</span><b style="color:#e5ecf7; font-weight:600; text-align:right">${v}</b></div>`;
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
  const dp = describePart(catalog, tuning, p);
  const st = dp?.base;
  if (!fn || !dp || !st) return esc(p.fn);
  const id = partItemId(p);
  const name = econ.items.name(id);
  const piece = PIECE_NAMES[p.piece] ?? p.piece;
  const d = c.derived, i = c.index ?? -1;
  let html = `<div style="display:flex; gap:6px; align-items:center"><span style="width:9px; height:9px; border-radius:2px; flex:none; background:${numToCss(functionColor(p.fn))}"></span>`
    + `<b style="color:#e5ecf7; font-size:13px">${esc(name)}</b></div>`;
  html += `<div style="color:#ffb547; font-size:11px; margin:1px 0 5px">${st.mark}${st.size ? ` · ${st.size}` : ''}${name.endsWith(piece) ? '' : ` · ${esc(piece)}`} · ${Math.round(st.area * 10) / 10} cell${st.area === 1 ? '' : 's'}</div>`;

  // State first: it's what matters most when it isn't simply fitted
  const live = c.live;
  if (c.loose) html += `<div style="color:#c4b5fd; margin-bottom:4px">Not connected: it builds once something joins it to the core</div>`;
  else if (c.state === 'ghost') html += `<div style="color:#7dd3fc; margin-bottom:4px">Ghost: not built yet</div>`;
  else if (c.state === 'new') html += `<div style="color:#fbbf24; margin-bottom:4px">New: save to build it in</div>`;
  else if (c.state === 'wrecked' || live?.detached || (live && live.hp <= 0)) html += `<div style="color:#f87171; margin-bottom:4px">${live?.detached ? 'Shot off' : 'Destroyed'}: the station rebuilds it</div>`;
  else if (live && live.hp < live.max - 1e-6) html += `<div style="color:#fbbf24; margin-bottom:4px">Damaged: ${Math.round((live.hp / live.max) * 100)}% (${n0(live.hp)} / ${n0(live.max)} hp)</div>`;

  html += row('Hull · mass', `${n0(st.hp)} hp · ${st.mass.toFixed(1)}`);
  html += row('Armour · build', `${st.armour} · ${Math.round(partBuildPoints(catalog, p) * 10) / 10} pts`);
  const res = resistText(st.resist);
  if (res) html += row('Takes', res);
  // (Cold builds up slower through it: ships/warmth.ts)
  const ins = mat?.insulation;
  if (ins) html += row('Insulation', `${Math.round(ins * 100)}% of the cold kept out`);
  if (fn.weapon) {
    const def = tuning.weapons?.[fn.weapon];
    const w = d?.weapons.find((x) => x.part === i);
    const rateOf = fn.fireInterval ?? 10, rate = 60 / rateOf;
    const f = fn.fire;
    // (A ramping beam, the Cutter's: its set dps is where it starts)
    const rampSet = fn.weaponMods?.set as { ramp?: { to: number; ticks: number }; dps?: number } | undefined, ramp = rampSet?.ramp;
    // (A fading beam: full strength to its effective range, then weaker out to its full one)
    // (Support weapons do no damage: what they do instead, support.ts)
    if (st.heal) html += row('Mends', `<span style="color:#5eead4">${n0(st.heal)} hp/s</span> into an ally's damaged parts where it lands · reach ${n0(st.range ?? 0)} · not your own ship, not destroyed parts`);
    else if (st.intercept) html += row('Intercepts', `<span style="color:#fdba74">${st.intercept.perSec.toFixed(1)} shots/s</span> at missiles, torpedoes, mortar shells and seekers · reach ${n0(st.intercept.range)} · on its own, never at ships`);
    else html += row('Damage', `${ramp ? `${n0(rampSet?.dps ?? 0)} rising to ` : ''}${n0(st.dps ?? 0)}/s${st.range ? ` · reach ${st.effectiveRange ? `${n0(st.effectiveRange)}, fading out to ${n0(st.range)}` : n0(st.range)}` : ''}`);
    if (st.damageType && !st.heal && !st.intercept) html += row('Hits with', `${DAMAGE_NAMES[st.damageType]} · penetration ${Math.round((st.pen ?? 1) * 10) / 10}`);
    // A pulse laser: a pulse's damage, and how long it takes to charge the next
    if (st.pulse) html += row('Pulse', `${n0(st.pulse.damage)} a pulse · charges in ${st.pulse.seconds.toFixed(1)}s`);
    else if (st.heal) html += row('Beam', 'held while you fire · draws its power while it\'s on');
    else if (st.intercept) html += row('Fire', 'fires itself at what comes in · a little power a shot');
    // Its firing model (common/src/ships/guns.ts): how it fires and what it pays with
    else if (f?.model === 'beam') html += row('Beam', `held while you fire · draws its power while it's on${f.windup ? ` · winds up over ${(f.windup / 60).toFixed(1)}s` : ''}${ramp ? ` · burns deeper over ${(ramp.ticks / 60).toFixed(1)}s on one part, starting over if it slips off` : ''}`);
    else if (f?.model === 'clip') html += row('Clip', f.regrow
      ? `holds ${f.clip} · ${f.rounds ?? 1} a shot, every ${(rateOf / 60).toFixed(1)}s · regrows one every ${(f.regrow / 60).toFixed(2)}s (${n0((f.reloadE ?? 0) / (f.clip ?? 1))} energy each)`
      : `${f.clip} rounds at ${rate >= 10 ? n0(rate) : rate.toFixed(1)}/s · reloads in ${((f.reload ?? 0) / 60).toFixed(1)}s from energy (${n0(f.reloadE ?? 0)} a clip), when empty or a second after you let go`);
    else if (f?.model === 'charge') html += row('Charge', `hold ${((f.charge ?? 0) / 60).toFixed(1)}s: it fires itself, then ${((f.cooldown ?? 0) / 60).toFixed(1)}s to cool · let go early and nothing fires · ${n0(f.chargeE ?? 0)} energy a charge`);
    else html += row('Fire rate', `${f?.spin ? `${(60 / f.spin.from).toFixed(1)}/s spinning up to ${60 / f.spin.to >= 10 ? n0(60 / f.spin.to) : (60 / f.spin.to).toFixed(1)}/s` : rate >= 10 ? n0(rate) : rate.toFixed(1)}${f?.spin ? '' : '/s'} · ${esc(KIND[def?.type ?? ''] ?? def?.type ?? fn.weapon)}${def?.ammo && (!f || f.model === 'ammo') ? ` · ${esc(econ.items.name(def.ammo.item))}${(f?.rounds ?? 1) > 1 ? ` (${f!.rounds} a shot, no energy)` : f ? ' (no energy)' : ''}` : ''}`);
    if (f && FIRE_SENTENCE[f.model]) html += row('Model', `${esc(f.model)}: ${esc(f.model === 'clip' && f.regrow ? REGROW_SENTENCE : FIRE_SENTENCE[f.model])}`);
    if (w && w.satisfaction < 0.995) html += row('Under-powered', `<span style="color:#fbbf24">${Math.round(w.satisfaction * 100)}%: fires slower</span>`);
    if (d && i >= 0 && f) for (const [a, b] of powerShots(d, tuning, i, f)) html += row(a, b);
    // (Its model's mount: not a choice)
    const facing = p.facing ? FACING[p.facing] : '';
    const arc = w?.window ? ` · ${Math.round((w.window.open.reduce((s, [lo, hi]) => s + hi - lo, 0) * 180) / Math.PI)}° clear` : '';
    // Its rules ("Turret, 270°", "Side mount (flippable)", "Needs 3 clear cells ahead"): the first is the mount
    const words = mountingWords(catalog, { ...fn, ...(fn.mount ? {} : { mount: weaponMount(catalog, p) }) }, tuning);
    html += row('Mount', `${esc(words[0] ?? MOUNT_TEXT[weaponMount(catalog, p)])}${facing ? `, facing ${facing}` : ''}${arc}`);
    if (words.length > 1) html += row('Fitting', esc(words.slice(1).join(' · ')));
    for (const m of c.mounting ?? []) html += `<div style="color:#f87171; font-size:11px; margin-top:3px">✕ ${esc(m)}</div>`;
  } else if (p.facing) html += row('Facing', FACING[p.facing]);
  if (st.thrust) html += row('Thrust', `${st.thrust.toFixed(1)}${(st.boost ?? 1) > 1 ? ` · boost ×${st.boost}, drain ×${st.boostDrain ?? 1}` : ' · no boost'}`);
  if (st.supply) html += row('Power out', `<span style="color:#86efac">+${n0(st.supply)}/s</span>`);
  if (st.draw) {
    const sat = d && i >= 0 ? d.satisfaction[i] : 1;
    html += row('Power draw', `${n0(st.draw)}/s${sat < 0.995 ? ` <span style="color:#fbbf24">(${Math.round(sat * 100)}% met)</span>` : ''}`);
  }
  if ((fn.store ?? 0) > 0) {
    const kind = bankKind(fn);
    html += row(kind === 'drive' ? 'Holds (engines it touches)' : kind === 'cap' ? 'Holds (guns it touches)' : 'Holds', `${n0(fn.store! * st.area * fnOutput(fn, mat))} energy`);
    // The most it gives a second (circuits.ts): a pool battery into the ship's Output, a bank member only into what its bank touches
    const rate = partDischarge(fn, st.area, mat, circuitTuning(tuning));
    html += row('Gives', `up to ${n0(rate)}/s${kind ? ` <span style="color:#8ea0bd; font-weight:400">first to the ${kind === 'drive' ? 'engines and strafers' : 'guns, beams, mining lasers and Flash Screens'} its bank touches; touching ${kind === 'drive' ? 'Drive Cells' : 'Capacitors'} are one bank</span>` : fn.oneWay || fn.relayOnly ? ' <span style="color:#8ea0bd; font-weight:400">on to the parts it touches</span>' : ' <span style="color:#8ea0bd; font-weight:400">into the ship\'s pool, on a powered network</span>'}`);
    // (A bank asks the ship's Output for its intake while not full, sharing it by what each asks: energy.ts powerTick)
    if (kind) html += row('Takes', `up to ${n0(partIntake(fn, st.area, mat, circuitTuning(tuning)))}/s <span style="color:#8ea0bd; font-weight:400">while not full, from the ship's Output; short of power, it shares by what it asks, so more raises its parts' share</span>`);
  }
  if ((fn.dynamo ?? 0) > 0) html += row('Charges', `${n0(fn.dynamo!)}/s into each Capacitor or Drive Cell bank it touches <span style="color:#8ea0bd; font-weight:400">(no wires; it powers nothing itself)</span>`);
  if (fn.rated) html += row('Rated speed', `${n0(fn.rated * 60)} m/s <span style="color:#8ea0bd; font-weight:400">(its push fades out near it)</span>`);
  // On the design: a bank member's bank (circuits.ts), and the bank(s) feeding a consumer
  if (d && i >= 0 && d.power) {
    const L = d.power, amber = (t: string) => `<span style="color:#fbbf24">${t}</span>`;
    const b = L.bankOf[i];
    if (b >= 0) {
      const B = L.banks[b];
      html += row('Bank', `<b>${b + 1}</b> · ${B.parts.length} part${B.parts.length > 1 ? 's' : ''} · holds ${n0(B.cap)} · gives ${n0(B.rate)}/s${B.feeds.length + B.shields.length ? ` · feeds ${B.feeds.length + B.shields.length} it touches` : ` · ${amber('feeds nothing')}`}${!B.refills && B.dynamo <= 0 ? ` · ${amber('never refills')}` : ''}`);
    }
    const f = L.feedOf[i];
    if (f >= 0 && L.feeds[f].banks.length) html += row('Fed by', `Bank ${L.feeds[f].banks.map((x) => x + 1).join(', ')} first, then the ship`);
  }
  if (st.shield) html += row('Shield', n0(st.shield));
  if (st.shield && fn.shieldRegen) html += row('Refills', `${n0(fn.shieldRegen * st.area)}/s after ${(fn.shieldDelay ?? 0) / 60} s unhit`);
  if (fn.splashTaken !== undefined && fn.splashTaken < 1) html += row('Blasts', `${Math.round((1 - fn.splashTaken) * 100)}% less damage`);
  if (fn.jumpCooldown !== undefined && fn.jumpCooldown < 1) html += row('Jump cooldown', `−${Math.round((1 - fn.jumpCooldown) * 100)}%`);
  if (st.cargo) html += row('Cargo', `${n0(st.cargo)} <span style="color:#8ea0bd; font-weight:400">(what you carry weighs the ship down)</span>`);
  // Burst Strafer (strafer.ts): a dodge, not thrust; on a design, which way it dodges
  if (st.dodge) {
    const o = st.dodge;
    html += row('Dodge', `<span style="color:#f9a8d4">${o.force.toFixed(1)} push for ${o.secs.toFixed(2)} s</span> away from its nozzle · again after ${o.cooldown.toFixed(2)} s · <span style="color:#8ea0bd; font-weight:400">no push for cruising</span>`);
    html += row('A burst costs', `${n0(o.energy)} energy straight out (less at an angle) <span style="color:#8ea0bd; font-weight:400">(from a Drive Cell bank it touches first, then the ship: dodging often needs Drive Cells, batteries and generation behind it)</span>`);
    if (d && i >= 0) {
      const p = d.fx?.strafe?.parts.find((x) => x.part === i);
      // (Ship-local: x right, y back)
      const way = p ? (Math.abs(p.push[0]) >= Math.abs(p.push[1]) ? (p.push[0] > 0 ? 'right' : 'left') : p.push[1] > 0 ? 'back' : 'forward') : '';
      html += row('On this ship', way ? `pushes ${way}: it helps any dodge with some ${way} in it` : '<span style="color:#fbbf24">has no power: it does nothing</span>');
    }
  }
  // What the part features it gives say (common ships/features describe): a Tow Beam's Tows row
  for (const r of tipRows(dp.facts)) {
    const text = (r.warn ? `<span style="color:#fbbf24">${esc(r.text)}</span>` : esc(r.text)) + (r.dim ? ` · <span style="color:#8ea0bd; font-weight:400">${esc(r.dim)}</span>` : '');
    html += row(esc(r.label), text);
  }
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
    html += row('Battery', `${n0(energyTuning(tuning).coreCapacity)} in the ship's pool · gives up to ${n0(circuitTuning(tuning).coreDischarge)}/s`);
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
