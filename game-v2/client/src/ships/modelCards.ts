/**
 * How the hangar palette and the fabricator present a model (a fixed named
 * part: docs/parts-redesign.md §1): its family's name, its size (its piece),
 * its key numbers in a line, its trade-off in plain words, and when it's
 * locked, why: the level it's learned at (nothing opens one earlier).
 */

import { coilCapacity, jumpTuning, partGrade, isWeaponFn, mountingOf, mountingWords, partMount, partStats, describeFn, PIECE_NAMES, type Catalog, type FunctionDef, type ItemDef, type Mount, type ShipTuning } from '@space-game/common';
import { chips } from './describe';
import { sizeWordOf } from '../ui/componentShapes';

/** Families by name, in the palette's order within their category (legendaries share one group) */
export const FAMILY_LABEL: Record<string, string> = {
  cannon: 'Cannons', autocannon: 'Autocannons', flak: 'Flak', mortar: 'Mortars', railgun: 'Railguns',
  laser: 'Lasers', pulse: 'Pulse guns', lance: 'Lances', arc: 'Arc projectors',
  missile: 'Missiles', torpedo: 'Torpedoes', emp: 'EMP',
  ion: 'Ion drives', afterburner: 'Burn engines', plasma: 'Plasma drives', jumpcoil: 'Jump coils',
  reactor: 'Generators', dynamo: 'Bank chargers', battery: 'Batteries', capacitor: 'Capacitors', drive_cell: 'Drive cells',
  // (Energy routing's Conduit and Diode: models.mjs)
  relay: 'Relays',
  shield: 'Shields', shieldwall: 'Shield walls', shieldarc: 'Shield arcs', plating: 'Plating',
  mining: 'Mining lasers', demolition: 'Demolition', siphon: 'Siphons', scanner: 'Scanners', constructor: 'Constructors',
  // (Support weapons: common/src/ships/features/support/support.ts)
  repair: 'Repair beams', point_defence: 'Point defence',
  // (Burst Strafer and Tow Beam: ships/strafer.ts, tow.ts)
  strafer: 'Strafers', tow: 'Tow beams',
  // (Gyro and Heavy Gyro: common/src/ships/features/gyro)
  gyro: 'Gyros',
  // (The feed layer's tanks, pipes and Selectors: common/src/ships/power/ports.ts)
  feed: 'Feed',
  // (Field machines: common/src/ships/features/machines)
  fabricator: 'Fabricators', refiner: 'Refiners', minebay: 'Mine Bays', clamp: 'Docking Clamps',
};
export const LEGENDARY = 'Legendary';
const FAMILY_ORDER = Object.keys(FAMILY_LABEL);

/** A model's group in the palette: its family, or Legendary */
export function familyLabel(fn: FunctionDef): string {
  if (fn.rarity === 'legendary') return LEGENDARY;
  return FAMILY_LABEL[fn.family ?? ''] ?? (fn.family ? fn.family.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'Other');
}

/** Sort key for a group (families in FAMILY_LABEL's order, Legendary last) */
export function familyRank(label: string): number {
  if (label === LEGENDARY) return 1000;
  const i = FAMILY_ORDER.findIndex((f) => FAMILY_LABEL[f] === label);
  return i < 0 ? 900 : i;
}

/**
 * Each model's trade-off, as a pilot would put it (docs/parts-redesign.md §3);
 * one not listed says its guide line
 */
const TRADE_OFF: Record<string, string> = {
  cannon_pip: 'light and quick',
  utility_repair_beam: "mends allies' parts; nothing for you, big draw",
  point_defence_turret: 'shoots down missiles on its own; never ships',
  engine_burst_strafer: 'a hard dodge away from its nozzle, short cooldown; no cruising push, big draw',
  utility_tow_beam: 'tows wrecks and pods to salvage; slows you by their mass',
  cannon_hammer: 'slow heavy shell, punches plate',
  cannon_twinlink: 'the only cannon turret: 8 heavy rounds, then a short reload',
  cannon_longbarrel: "a sniper's cannon: far, slow to fire",
  cannon_bastion: 'two huge dodgeable shells, then a long reload',
  autocannon_rattler: 'a steady stream of shells',
  autocannon_chainsaw: 'a hose: hard to dodge, harder to power',
  autocannon_stinger: 'fast, accurate needles in short bursts',
  flak_cloudmaker: 'placed clouds at your aim distance, slow reload',
  mortar_lobber: 'lands where you aim · ammo',
  mortar_quake: 'huge splash, slow · ammo',
  laser_glint: 'a long pulse you time, reaches far',
  laser_cutter: 'burns deeper the longer it stays on one part, short reach',
  laser_searchlight: 'reaches furthest, marks what it lights for 20% more damage',
  legendary_frostbite: 'a held freeze beam; slows what it lights by 40% (thrust and turning)',
  pulse_strobe: 'steady bursts that strip shields',
  pulse_overpulse: 'dumps a clip of bolts into shields, barely scratches hull',
  missile_dart: 'locks on · ammo',
  missile_swarm: 'six small rockets a salvo, floods point defence · ammo',
  missile_hammerhead: 'a huge slow warhead · ammo',
  railgun_needle: 'fast slugs through two ships · ammo',
  railgun_coilgun: 'three heavy slugs in a cone, close range · no ammo',
  railgun_spear: 'three ships at full damage, 120 E a shot',
  railgun_rail_driver: 'semi-auto rifle: four heavy shots, then a 1.5 s reload',
  emp_hush: 'switches one ship off for 2 s',
  emp_blackout: 'charged area blackout, 2.8 s',
  arc_spark: 'instant zap, chains to 3 more ships',
  arc_tesla: 'held storm: 5 zaps a second, chains to 5',
  torpedo_eel: 'slow, huge, through shields · ammo',
  torpedo_leviathan: 'ends a fight, slow · ammo',
  lance_lance: 'the heaviest held beam at point blank; sputters short of power',
  engine_ion_drive: 'efficient, low top speed',
  engine_vernier: 'cheap corner push, no boost',
  engine_afterburner: 'weak cruise, huge boost; wants a Drive Cell touching it',
  engine_torch: 'full thrust all the time, no boost, burns energy',
  engine_plasma_drive: 'the balanced main engine',
  engine_drift_sail: 'near-free cruising, slow',
  engine_fusion_torch: 'the long-haul racer, heavy',
  power_cell_reactor: 'the starter; explodes when destroyed',
  power_isotope_pile: 'weak but tough, never explodes',
  power_fusion_plant: 'plenty of power, heavy, big blast',
  power_overclock_reactor: 'most power, fragile, biggest blast',
  power_battery: 'the ship\'s pool: holds and gives quickly',
  power_capacitor: 'touching Capacitors form a bank that feeds the guns, beams, miners and Flash Screens it touches first; it does not feed engines',
  power_drive_cell: 'touching Drive Cells form a bank that feeds the engines and strafers it touches first',
  power_heavy_bank: 'deep but slow: endurance, not alpha strikes',
  power_pulse_dynamo: 'puts 10 a second into each bank it touches, no wires',
  utility_mining_laser: 'cuts ore, a poor weapon',
  utility_bore: 'cuts harder rock',
  utility_demolition_launcher: 'cracks rock wide open',
  utility_siphon: 'draws gas from pockets',
  utility_scanner: 'reads rocks, finds seams',
  utility_long_range_array: 'twice the reach, twice the power',
  utility_constructor: 'builds structures',
  shield_deflector: 'soaks hits before the hull',
  shield_flash_screen: 'no slow refill, back whole after a break',
  shield_flicker_screen: 'thin and cheap, back in a second',
  shield_bulwark_projector: 'deep, slow to refill',
  utility_jump_coil: 'more jump for a bigger hull',
  utility_heavy_coil: 'more jump per cell, and 20% faster to cool',
  plating_reactive_armour: 'blunts small fast hits',
  plating_spaced_plating: 'half damage from blasts',
};

/** How a weapon is mounted: its model's own (common partMount: not the pilot's choice); a legacy part's as placed */
export function weaponMount(catalog: Catalog, p: { fn: string; mount?: Mount }): Mount {
  return partMount(catalog, p);
}

/** "Turret" / "Fixed: aim with the ship" */
export const MOUNT_TEXT: Record<Mount, string> = { turret: 'Turret', fixed: 'Fixed: aim with the ship' };

/**
 * A weapon's mounting rules in plain words (common mountingWords): "Turret, 270°", "Side mount (flippable)",
 * "Bolts on from behind only", "Needs 3 clear cells ahead"
 */
export function mountingText(catalog: Catalog, p: { fn: string; mount?: Mount }, tuning?: ShipTuning): string[] {
  const f = catalog.functions.get(p.fn);
  if (!f || !isWeaponFn(p.fn)) return [];
  return mountingWords(catalog, f.mount ? f : { ...f, mount: weaponMount(catalog, p) }, tuning);
}

const BADGE = "font:600 9px 'Segoe UI',sans-serif; letter-spacing:0.5px; padding:0 4px; border-radius:3px; white-space:nowrap; flex-shrink:0;";

/** A weapon's mount as a small read-only badge, its arc on a turret's, and SIDE for a side mount (nothing for anything else) */
export function mountBadge(catalog: Catalog, p: { fn: string; mount?: Mount }): string {
  if (!isWeaponFn(p.fn)) return '';
  const t = weaponMount(catalog, p) === 'turret';
  const m = mountingOf(catalog, p.fn, undefined, p.mount);
  const words = mountingText(catalog, p).join(' · ');
  const title = `${t ? 'Turret: swivels to the cursor within its arc' : 'Fixed: fires where it points, so you aim with the ship'}${words ? ` · ${words}` : ''}`;
  return `<span title="${title.replace(/"/g, '&quot;')}" style="${BADGE} color:${t ? '#fcd9a8' : '#a7b4c8'}; border:1px solid ${t ? '#b7793a' : '#3a4a66'}; background:${t ? 'rgba(183,121,58,0.18)' : 'transparent'}">${t ? `TURRET${m?.rules ? ` ${m.arc}°` : ''}` : 'FIXED'}</span>`
    + (m?.angle === 'right' ? `<span title="Side mount: fires at right angles to the edge it bolts on at (F mirrors which side)" style="${BADGE} color:#bae6fd; border:1px solid #2f6f8f">SIDE</span>` : '');
}

/** A flak shell that ends at the aim point (weaponMods.set.endAtAim) bursts there, or sooner near a target: read from the data, so it stays true */
function aimBurstNote(fn: FunctionDef): string {
  if ((fn as { weapon?: string }).weapon !== 'flak' || !(fn.weaponMods?.set as { endAtAim?: boolean } | undefined)?.endAtAim) return '';
  return `bursts at your aim distance, or sooner near a target${fn.fire?.model === 'ammo' ? ' · ammo' : ''}`;
}

export function tradeOff(fn: FunctionDef): string {
  return (Object.hasOwn(TRADE_OFF, fn.id) ? TRADE_OFF[fn.id] : undefined) ?? (aimBurstNote(fn) || fn.guide?.blurb) ?? (fn.description ?? '').split(/[.:]/)[0];
}

/** Its size, by its piece: Small (a square, wedge or round), Medium (a panel), Large (a block) */
export function sizeWord(catalog: Catalog, piece: string): string {
  return sizeWordOf(catalog.variants.get(piece)?.[0]?.area ?? 1);
}

/** "Small · square" */
export function sizeText(catalog: Catalog, fn: FunctionDef): string {
  const pieces = fn.pieces === '*' ? ['sq'] : fn.pieces;
  return pieces.map((pc) => `${sizeWord(catalog, pc)} · ${PIECE_NAMES[pc] ?? pc}`).join(' / ');
}

const n0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : '—');

/** Each firing model's one-sentence hangar description (design section 3) */
export const FIRE_SENTENCE: Record<string, string> = {
  cycle: "Fires on a fixed beat while held; each shot's energy is drawn as it reloads.",
  clip: 'Fires n rounds fast, then reloads from energy when empty, or 1 s after you let go.',
  charge: 'Hold to charge; it fires itself at full charge, then cools down. Let go early and nothing fires.',
  ammo: 'Fires rounds from your hold on a fixed beat; costs no energy; empty means weak plain rounds (40% damage).',
  beam: 'Burns energy every second you hold it.',
  auto: 'Fires on its own at incoming ordnance.',
};

/** A clip with regrow never reloads: it spends its stock and one round grows back at a time */
export const REGROW_SENTENCE = 'Fires a salvo from its stock; one round grows back at a time, each drawing a little energy.';

/** A gun's firing model as a chip ("cycle", "clip 6 · 1.5s reload", "charge 2.0s", "held beam", "auto") */
export function fireChip(fn: FunctionDef): string {
  const f = fn.fire;
  if (!f) return '';
  switch (f.model) {
    case 'clip': return f.regrow ? `clip ${f.clip} · regrows` : `clip ${f.clip} · ${((f.reload ?? 0) / 60).toFixed(1)}s reload`;
    case 'charge': return `charge ${((f.charge ?? 0) / 60).toFixed(1)}s`;
    case 'beam': return f.windup ? 'held beam · winds up' : (fn.weaponMods?.set as { ramp?: unknown } | undefined)?.ramp ? 'held beam · ramps up' : 'held beam';
    case 'ammo': return 'ammo';
    case 'auto': return 'auto';
    default: return f.spin ? 'cycle · spins up' : 'cycle';
  }
}

/** Its key numbers at its own size, short: "62 dmg/s · reach 1,400", "thrust 4.0 · top 4,200 m/s · draws 68" (a boost is in its trade-off); structure in its material */
export function keyStats(catalog: Catalog, tuning: ShipTuning | undefined, fn: FunctionDef, piece?: string, material?: string): string {
  const pc = piece ?? (fn.pieces === '*' ? 'sq' : fn.pieces[0]);
  const st = partStats(catalog, tuning, { fn: fn.id, material: fn.model ? fn.material ?? 'alloy' : material ?? fn.material ?? 'alloy', piece: pc });
  if (!st) return '';
  const out: string[] = [];
  if (st.pulse) out.push(`${n0(st.pulse.damage)} a pulse`);
  // (Support weapons: support.ts)
  else if (st.heal) out.push(`mends ${n0(st.heal)} hp/s`);
  else if (st.intercept) out.push(`${st.intercept.perSec.toFixed(1)} shots/s at missiles`);
  else if (st.dps !== undefined && fn.weapon) out.push(`${n0(st.dps)} dmg/s`);
  if (st.range && fn.weapon) out.push(`reach ${n0(st.range)}`);
  const fm = fn.weapon && !st.heal ? fireChip(fn) : '';
  if (fm) out.push(fm);
  if (st.thrust) out.push(`thrust ${st.thrust.toFixed(1)}`);
  if (fn.rated) out.push(`top ${n0(fn.rated * 60)} m/s`);
  if (st.supply) out.push(`+${n0(st.supply)} power`);
  if ((fn.dynamo ?? 0) > 0) out.push(`+${n0(fn.dynamo!)}/s into each bank it touches`);
  if ((fn.store ?? 0) > 0) {
    out.push(`holds ${n0(fn.store! * st.area)}${fn.bank ? (fn.pool === 'drive' ? ' (engines)' : ' (guns)') : ''}`);
  }
  if (st.shield) out.push(`shield ${n0(st.shield)}`);
  if (st.shield && fn.shieldRegen) out.push(`refills ${n0(fn.shieldRegen * st.area)}/s after ${(fn.shieldDelay ?? 0) / 60} s`);
  if (fn.splashTaken !== undefined && fn.splashTaken < 1) out.push(`${Math.round((1 - fn.splashTaken) * 100)}% less from blasts`);
  if (fn.jumpCooldown !== undefined && fn.jumpCooldown < 1) out.push(`jump cooldown −${Math.round((1 - fn.jumpCooldown) * 100)}%`);
  if ((fn.range ?? 0) > 0 && !fn.weapon) out.push(`scan ${n0(fn.range!)} m`);
  if ((fn.jumpCapacity ?? 0) > 0) out.push(`jump ${n0(coilCapacity(fn.jumpCapacity! * st.area, partGrade(catalog, { fn: fn.id, material: fn.model ? fn.material ?? 'alloy' : material ?? fn.material ?? 'alloy' }), jumpTuning(tuning ?? ({} as ShipTuning))))} cells`);
  if (st.dodge) out.push(`dodge ${st.dodge.force.toFixed(1)} push · every ${st.dodge.cooldown.toFixed(1)} s · ${n0(st.dodge.energy)} energy a burst`);
  // (What the part features it gives say: chips, and what its power draw applies to: a Tow Beam's "towing")
  const facts = describeFn(catalog, tuning, fn.id, pc, material);
  out.push(...chips(facts));
  const drawWhen = facts.find((f) => f.drawWhen)?.drawWhen;
  if (st.draw && !st.supply) out.push(st.dodge ? `draws ${n0(st.draw)} bursting` : drawWhen ? `draws ${n0(st.draw)} ${drawWhen}` : `draws ${n0(st.draw)}`);
  if (!out.length || (fn.category === 'shields' && !st.shield)) out.push(`${n0(st.hp)} hp · armour ${st.armour}`);
  return out.join(' · ');
}

export interface ModelLock {
  /** You can make it */
  open: boolean;
  /** "Lv 12" */
  badge: string;
  /** "Learned at level 12 (you're 5)" */
  why: string;
}

/** Whether a pilot of this level can make a model, and if not, the level that will (`items`: unused now, kept for callers) */
export function modelLock(fn: FunctionDef, can: boolean, level: number, _items?: readonly ItemDef[]): ModelLock {
  const lv = fn.unlock?.level;
  if (can) return { open: true, badge: lv !== undefined ? `Lv ${lv}` : '', why: '' };
  if (lv === undefined) return { open: false, badge: 'Unavailable', why: 'No pilot can make this' };
  return { open: false, badge: `Lv ${lv}`, why: `Learned at level ${lv} (you're ${level})` };
}
