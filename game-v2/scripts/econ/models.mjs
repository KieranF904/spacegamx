// Ship models (docs/parts-redesign.md §3): the fixed, named modules pilots build, each its own piece, material and
// numbers. This is their source of truth: it writes data/ships/models.json, their recipes (data/recipes.json
// `models`), and the components they're made from (data/items.json, data/recipes.json `craft`). Edit this, not the
// JSON, then run it:   node scripts/econ/models.mjs
//
// A model's numbers start from the legacy function of its kind at its base size (functions.json: what a Mk I one
// does), then its own trade-offs. Weapons keep their kind's tuning (tuning.json weapons) and carry `weaponMods`
// (the WeaponMods format: mul is × (1 + v), add adds, set gives a field). Its draw follows its damage: a gun that
// hits harder per second draws that much more, so energy per point of damage stays its kind's (× its own `draw`).

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '../../data');
const read = (f) => JSON.parse(readFileSync(join(DATA, f), 'utf8'));
const FNS = new Map(read('ships/functions.json').functions.map((f) => [f.id, f]));
const TUNING = read('ships/tuning.json');
const PIECE_AREA = { sq: 1, tri: 0.5, round: Math.PI / 4, rect2: 2, block2: 4, round2: Math.PI };

/** Build points per cell by grade (as grades.ts GRADE_BUILD_COST) */
const GRADE_POINTS = [1, 1.6, 2.5, 3.8, 5.5];
/** A model's tier from its unlock level: about level / 8 */
const gradeAt = (level) => Math.max(1, Math.min(5, Math.round(level / 8)));
/** What it's built of, by level (the heavy and the light say otherwise) */
const materialAt = (level) => (level < 10 ? 'alloy' : level < 20 ? 'steel' : level < 30 ? 'titanium' : 'cobalt');
const PLATE = { alloy: 'alloy_plate', composite: 'composite_sheet', steel: 'steel_plate', titanium: 'titanium_plate', cobalt: 'cobalt_alloy', neutronium: 'neutronium_plate' };
/** × k as a WeaponMods mul */
const x = (k) => Math.round((k - 1) * 1000) / 1000;
/** × k as a WeaponMods mul, to the digit (a cannon's exact 48, not 48.006) */
const xp = (k) => Math.round((k - 1) * 1e9) / 1e9;
const r2 = (v) => Math.round(v * 100) / 100;

/** The legacy function each family grew from (its base numbers and look), and which legacy functions migrate to it */
const KIND_BASE = {
  cannon: 'weapon', autocannon: 'autocannon', flak: 'flak', mortar: 'mortar', laser: 'laser', pulse: 'pulse', missile: 'missile',
  railgun: 'railgun', emp: 'emp', arc: 'arc', torpedo: 'torpedo', lance: 'lance',
  hive: 'hive', frostbite: 'frostbite', cinder_bloom: 'cinder_bloom', prism: 'prism', phase: 'phase', singularity: 'singularity',
  ion: 'thruster', afterburner: 'afterburner', plasma: 'plasma_drive',
  reactor: 'generator', battery: 'battery', capacitor: 'weapon_battery', drive_cell: 'drive_battery',
  mining: 'miner', demolition: 'charge_launcher', siphon: 'siphon', scanner: 'scanner', shield: 'shield', jumpcoil: 'jumpcoil',
  constructor: 'constructor', plating: 'armor',
};
/** What a legacy part becomes: its function's family (plating is new: legacy armour stays armour) */
const LEGACY = Object.fromEntries(Object.entries(KIND_BASE).filter(([fam]) => fam !== 'plating').map(([fam, fn]) => [fn, fam]));

// ---------------------------------------------------------------------------
// Weapons: [id, name, family, piece, level, { dmg, burst, int, draw, ... }, mods, description]
//   dmg, burst (shells a volley, × its kind's), int (× its interval) and draw set its power; mods its shells
// ---------------------------------------------------------------------------

const W = [
  // (A fixed gun at the rate and draw the starter's legacy fixed cannons had, a shell every 15 ticks: the starter rates as it did)
  // (Section 4's cannon rows, rework-2026-11: Pip 14 dmg every 15 t for 2 E; Hammer 48 dmg every 42 t for 7 E; Twinlink a clip of 16
  // at 6 t, 12 dmg; Longbarrel a 120 t charge, 170 dmg, speed 140, life 60, no spread; Bastion a clip of 2, 18 t apart, 180 dmg.
  // `demand` is the draw a cell gives while its beat runs (a clip or charge gun draws by its fire block instead: reloadE, chargeE).)
  ['cannon_pip', 'Pip', 'cannon', 'sq', 0, { int: 1.5, draw: 1.5, blurb: 'The reliable starter' }, {}, 'The starter gun: four reliable amber shells a second, and no tricks.'],
  ['cannon_hammer', 'Hammer', 'cannon', 'rect2', 6, { int: 4.2, demand: 5, blurb: 'The breacher' }, { mul: { damage: xp(48 / 14), speed: xp(38 / 48), size: xp(1.6) }, add: { pen: 1 } }, 'The breacher: one slow, armour-piercing slug at a steady rhythm.'],
  ['cannon_twinlink', 'Twinlink', 'cannon', 'rect2', 12, { demand: 3.87, blurb: 'Paired autoloader turret' }, { mul: { damage: xp(12 / 14), spread: x(3.3 / 1.8) } }, 'A paired autoloader turret: a rattling stream of sixteen rounds, then a pause to reload.'],
  ['cannon_longbarrel', 'Longbarrel', 'cannon', 'rect2', 20, { demand: 5.14, blurb: 'The sniper' }, { mul: { damage: xp(170 / 14), speed: xp(140 / 48), life: xp(60 / 150) }, add: { pen: 1 }, set: { spread: 0 } }, 'The sniper: it charges while you hold and fires itself at full, one telegraphed shot that picks a part off.'],
  ['cannon_bastion', 'Bastion', 'cannon', 'block2', 30, { hp: 1.3, mass: 1.6, demand: 4.17, blurb: 'The ship-killer double tap' }, { mul: { damage: xp(180 / 14), speed: xp(32 / 48), size: xp(2.2) }, add: { pen: 1 } }, 'The ship-killer double tap: two huge, slow cannonballs you can dodge, then a long wait.'],
  ['autocannon_rattler', 'Rattler', 'autocannon', 'sq', 3, {}, {}, 'The steady hose: a stream of small yellow shells at a fixed rhythm.'],
  ['autocannon_chainsaw', 'Chainsaw', 'autocannon', 'rect2', 14, { int: 0.55, demand: 10.5 }, { mul: { spread: x(1.5) } }, 'The minigun: it spins up from four shots a second to sixteen while you hold the trigger, and is useless on a tap.'],
  ['autocannon_stinger', 'Stinger', 'autocannon', 'sq', 24, { dmg: 1.5, int: 1.25 }, { mul: { damage: x(1.6), spread: x(0.4) } }, 'The marksman SMG: twelve accurate needles in a burst, then a pause to reload.'],
  ['flak_burst', 'Burst', 'flak', 'sq', 4, {}, {}, 'The sky-filler: a canister shell that bursts on its own near whatever it passes.'],
  ['flak_cloudmaker', 'Cloudmaker', 'flak', 'rect2', 16, { dmg: 1.7, int: 1.4 }, { mul: { splashRadius: x(250 / 170), splashDamage: x(26 / 16) } }, 'The wall you place: four shells that burst where you aim, or sooner near a target, in wide clouds.'],
  // (Section 4's ordnance rows, rework-2026-11. Mortars: the Lobber lands at the cursor (out to 2,640), splash r220 / 70, a shell every 90 t, 40 a
  // crate; the Quake walks three shells at 0.7, 1.0 and 1.3 of the aim distance, 15 t apart, r260 / 60 each, a salvo every 180 t (3 rounds).
  // Missiles: the Dart 24 a crate, 108 t, homing 0.07 on the ship nearest the cursor, 30 + r120 / 34; the Swarm six rockets over 30 t, a salvo
  // every 180 t (6 rounds), 10 + r60 / 12, homing x1.3; the Hammerhead 198 t, 105 + r150 / 54, guided, 2 PD hits. Torpedoes: the Eel 240 t, 420 dmg,
  // through shields, r90 / 80, gentle homing, 3 PD hits; the Leviathan 2 rounds a shot, 360 t, 1,000 dmg, through shields, r200 / 200, no
  // homing, armed after 60 t, 5 PD hits. `intercept` is a shell's point-defence hits; the kinds give 1.)
  ['mortar_lobber', 'Lobber', 'mortar', 'sq', 7, { blurb: 'Artillery that lands where you click' }, {}, 'Artillery that lands where you click: one shell every second and a half, lobbed over everything to burst at your cursor (out to 2,640) in a 220 blast. Forty shells a crate.'],
  ['mortar_quake', 'Quake', 'mortar', 'rect2', 24, { dmg: 2, int: 2, blurb: 'The walking barrage' }, { set: { splash: { radius: 260, damage: 60 } } }, 'The walking barrage: a salvo of three shells every three seconds that land at 70%, 100% and 130% of your aim distance, a quarter second apart, each a 260 blast. It covers a lane, not a point. Uses three rounds a salvo.'],
  // (Section 4's lasers and pulse guns, rework-2026-11 (family-beams-pulse). Glint: the pulse you time, 27 E a pulse. Cutter: a short held beam, 60 dps
  // rising to 150 over 1.5 s on one part, 32 E/s. Searchlight: a long thin beam, 25 dps, 15 E/s, that marks. Strobe: a burst of 3 every 0.5 s, 9 dmg,
  // x1.6 vs shields, x0.6 vs hull, 6 E a burst. Overpulse: a clip of 12 single bolts at 10/s, x1.9 vs shields, x0.5 vs hull. A beam's `demand` is its
  // E/s spread over its cells; a pulse gun's, its E a burst x 60 / interval.)
  ['laser_glint', 'Glint', 'laser', 'sq', 9, {}, {}, 'The long pulse: it charges for 1.8 s, then a 1.4 s pulse peaking at 96 damage reaches 5,100 units. Time it; 27 E a pulse.'],
  ['laser_cutter', 'Cutter', 'laser', 'rect2', 18, { demand: r2(32 / PIECE_AREA.rect2) }, { set: { dps: 60, range: 900, width: 14, pulse: null, falloff: null, ramp: { to: 150, ticks: 90 } } }, 'The welding torch: a short held beam that burns deeper the longer it stays on one part, 60 rising to 150 damage a second over 1.5 s (it starts over if it slips off). 32 E a second.'],
  ['laser_searchlight', 'Searchlight', 'laser', 'round', 26, { demand: r2(15 / PIECE_AREA.round) }, { set: { dps: 25, range: 7650, width: 8, pulse: null, falloff: null } }, 'The spotter: a thin beam that reaches furthest and barely hurts, but what it lights takes 20% more damage from everyone for 2 s after. 15 E a second.'],
  ['pulse_strobe', 'Strobe', 'pulse', 'sq', 10, { demand: r2((6 * 60) / 30) }, {}, 'Steady shield pressure: a burst of 3 bolts every half second, 9 damage each, 1.6 times against shields and 0.6 against hull. 6 E a burst.'],
  ['pulse_overpulse', 'Overpulse', 'pulse', 'rect2', 25, { demand: r2((36 * 60) / (90 + 12 * 6) / PIECE_AREA.rect2) }, { set: { burst: 1, vsShield: 1.9, vsHull: 0.5 } }, 'The shield shredder: a clip of 12 bolts at 10 a second, then a 1.5 s reload drawing 36 E. 1.9 times against shields and half against hull.'],
  ['missile_dart', 'Dart', 'missile', 'sq', 11, { blurb: 'Lock and forget' }, {}, 'Lock and forget: a missile every couple of seconds that homes on the ship nearest your cursor, 30 damage and a 120 blast. Twenty-four missiles a crate. Point defence kills it in one hit.'],
  ['missile_swarm', 'Swarm', 'missile', 'rect2', 21, { dmg: 0.5, burst: 6, int: 1.64, blurb: 'The ripple that floods point defence' }, { mul: { homing: x(1.3) }, set: { damage: 10, splash: { radius: 60, damage: 12 } } }, 'The ripple that floods point defence: six small rockets in half a second, every three seconds, spreading and then converging on the ship nearest your cursor. Each is 10 damage and a 60 blast and dies to one point-defence hit. Uses six rounds a salvo.'],
  ['missile_hammerhead', 'Hammerhead', 'missile', 'block2', 33, { dmg: 3.5, int: 1.8, hp: 1.2, mass: 1.4, blurb: 'The steered warhead' }, { mul: { damage: xp(3.5), speed: x(0.7), maxSpeed: x(0.7), size: x(1.5) }, set: { splash: { radius: 150, damage: 54 }, intercept: 2 } }, 'The steered warhead: a slow, heavy missile, 105 damage and a 150 blast. While you hold fire it flies toward your cursor; let go and it flies straight. Point defence needs two hits.'],
  // (Railguns, rework section 4: the Needle's slug 62 dmg, pierce 2, speed 150, 75 ticks; the Coilgun five slugs of 16 in a 12 degree cone, pierce 1,
  // life 18 (2,700 reach), 54 ticks, 14 E a shot; the Spear 160 dmg through three hulls at full damage, 114 ticks, 120 E. The energy a cycle gun
  // draws is its draw x its interval, so RAIL_E sets each demand to give 14 E and 120 E a shot)
  ['railgun_needle', 'Needle', 'railgun', 'rect2', 13, {}, {}, 'The cheap rail: a long thin slug that goes through two ships. It fires slugs from the hold and needs no power.'],
  ['railgun_coilgun', 'Coilgun', 'railgun', 'rect2', 22, { dmg: 0.7, int: 0.72, draw: 1.8 }, { set: { ammo: null, damage: 16, burst: 5, spread: 6, jitter: 0, life: 18, pierce: 1 } }, 'The rail shotgun: five slugs in a tight cone, a finisher for close range that is spent past 2,700. It throws its own slugs for 14 E a shot, so it needs no ammo.'],
  ['railgun_spear', 'Spear', 'railgun', 'block2', 28, { dmg: 2.6, int: 1.52, draw: 2.2, hp: 1.2 }, { set: { damage: 160, pierce: 3, pierceKeep: 1 } }, 'The capital rail: one slug every couple of seconds that goes through three ships at full damage, a ring of shock at each. It costs 120 E a shot and needs no ammo.'],
  ['emp_hush', 'Hush', 'emp', 'sq', 15, { blurb: 'Switch one ship off' }, {}, 'Switches one ship off: an orb that bursts on its fuse or beside a ship, and 2 s of dead engines and guns.'],
  ['emp_blackout', 'Blackout', 'emp', 'block2', 35, { int: 1.5, dmg: 1.6, blurb: 'The charged area blackout' }, { set: { emp: { radius: 320, ticks: 168 } }, mul: { size: x(1.4) } }, 'Hold to charge, then it fires itself: an orb that bursts where you aimed, or beside a ship, for a wide 2.8 s blackout.'],
  ['arc_spark', 'Spark', 'arc', 'sq', 17, { blurb: 'The chain zap' }, {}, 'A bolt that strikes at once, out to 660, and leaps to 3 more ships nearby, weaker each hop.'],
  ['arc_tesla', 'Tesla', 'arc', 'round', 29, { dmg: 1.4, blurb: 'The held storm' }, { set: { chain: { count: 5, radius: 300, falloff: 0.5 } } }, 'Hold to keep zapping, five times a second: each zap leaps to 5 more ships nearby, weaker each hop.'],
  ['torpedo_eel', 'Eel', 'torpedo', 'rect2', 19, { blurb: 'The stalker' }, { set: { homing: 0.02 } }, 'The stalker: a slow, fat torpedo that creeps after its prey, 420 damage straight through shields and a 90 blast. Six torpedoes a crate, one every four seconds. Point defence needs three hits.'],
  ['torpedo_leviathan', 'Leviathan', 'torpedo', 'block2', 38, { dmg: 2.4, hp: 1.2, mass: 1.3, blurb: 'The fight-ender' }, { mul: { speed: x(0.8), maxSpeed: x(0.8), size: x(1.4) }, set: { damage: 1000, splash: { radius: 200, damage: 200 }, intercept: 5, arm: 60 } }, 'The fight-ender: a huge torpedo, 1,000 damage straight through shields and a 200 blast, one every six seconds. It flies straight and does not home, and arms a second after launch. Two rounds a shot (three shots a crate). Point defence needs five hits.'],
  ['lance_lance', 'Lance', 'lance', 'rect2', 32, { demand: 45 }, {}, 'The heavy held beam: 210 damage a second at 500 units after a 0.3 s windup, piercing, 20% more against plating. 90 E a second; short of power it sputters.'],
];

/**
 * Each weapon's mount, its own and not the pilot's (rebuild.ts via partMount): 'fixed' fires out of its facing and is
 * aimed with the ship (a small gimbal: tuning.json fixedGun); 'turret' aims itself within a window. Heavy shells,
 * homing and piercing rounds, and the held lance are fixed; light, quick and area guns turret. A model's numbers are
 * the whole of it: tuning.fixedGun's slower, bigger legacy shells (intervalScale, speedScale, sizeScale) don't apply.
 */
const MOUNT = {
  cannon_pip: 'fixed', cannon_hammer: 'fixed', cannon_twinlink: 'turret', cannon_longbarrel: 'fixed', cannon_bastion: 'fixed',
  autocannon_rattler: 'turret', autocannon_chainsaw: 'turret', autocannon_stinger: 'turret',
  flak_burst: 'turret', flak_cloudmaker: 'turret', mortar_lobber: 'turret', mortar_quake: 'turret',
  laser_glint: 'turret', laser_cutter: 'fixed', laser_searchlight: 'turret', pulse_strobe: 'turret', pulse_overpulse: 'turret',
  missile_dart: 'fixed', missile_swarm: 'fixed', missile_hammerhead: 'fixed',
  railgun_needle: 'fixed', railgun_coilgun: 'fixed', railgun_spear: 'fixed',
  emp_hush: 'turret', emp_blackout: 'turret', arc_spark: 'turret', arc_tesla: 'turret',
  torpedo_eel: 'fixed', torpedo_leviathan: 'fixed', lance_lance: 'fixed',
  // Seekers home and the phase round runs a line through ships: fixed. A held freezing beam, shells and a crystal
  // bolt you place, and a collapsing star dropped where you aim: turret
  legendary_hive: 'fixed', legendary_frostbite: 'turret', legendary_cinder_bloom: 'turret', legendary_prism: 'turret',
  legendary_phase: 'fixed', legendary_singularity: 'turret',
  // (A mining tool: point the ship at the rock, as with a mining laser)
  utility_demolition_launcher: 'fixed',
};
const MOUNT_NOTE = { fixed: 'Fixed: aim with the ship.', turret: 'Turret: turns to your aim.' };

/**
 * Each weapon's mounting rules (common/src/ships/mounting.ts; docs/parts-redesign.md §Mounting):
 *   attach 'back': its attach edge (opposite where it fires; a side mount's, its side) must be what bolts it on
 *   angle 'right': a side mount, firing at right angles to its attach edge (the part's flip mirrors which side)
 *   arc: a turret's traverse in degrees (fixed guns keep their gimbal); clear: [right, ahead] cells its barrel needs
 * Long barrels, heavy shells and launch tubes bolt on from behind and want room ahead; light turrets go anywhere and
 * turn far; area guns lob over everything (360°); heavy turrets turn little; round emitters and flak are side mounts.
 */
const ahead = (n) => Array.from({ length: n }, (_, i) => [0, i + 1]);
const MOUNTING = {
  // Cannons: the Pip and Hammer bolt on behind; long and heavy barrels want room
  cannon_pip: { attach: 'back' },
  cannon_hammer: { attach: 'back', clear: ahead(1) },
  cannon_twinlink: { arc: 180 },
  cannon_longbarrel: { attach: 'back', clear: ahead(3) },
  cannon_bastion: { attach: 'back', clear: ahead(2) },
  // Autocannons: light, fast turrets
  autocannon_rattler: { arc: 270 },
  autocannon_chainsaw: { attach: 'back', arc: 240 },
  autocannon_stinger: { arc: 200 },
  // Flak: side mounts, sweeping the sky along the hull
  flak_burst: { attach: 'back', angle: 'right', arc: 200 },
  flak_cloudmaker: { attach: 'back', angle: 'right', arc: 240 },
  // Mortars lob over the hull: all the way round
  mortar_lobber: { arc: 360 },
  mortar_quake: { attach: 'back', arc: 360 },
  // Lasers: the Searchlight's round emitter is a side mount that turns all the way round
  laser_glint: { arc: 240 },
  laser_cutter: { attach: 'back', clear: ahead(1) },
  laser_searchlight: { attach: 'back', angle: 'right', arc: 360 },
  pulse_strobe: { arc: 220 },
  pulse_overpulse: { attach: 'back', arc: 120 },
  // Missiles: launch tubes out of the back of the rack; the Swarm's pods ride the flanks
  missile_dart: { attach: 'back', clear: ahead(1) },
  missile_swarm: { attach: 'back', angle: 'right', clear: ahead(1) },
  missile_hammerhead: { attach: 'back', clear: ahead(2) },
  // Railguns: long rails, a long way clear
  railgun_needle: { attach: 'back', clear: ahead(2) },
  railgun_coilgun: { attach: 'back', clear: ahead(2) },
  railgun_spear: { attach: 'back', clear: ahead(3) },
  emp_hush: { arc: 360 },
  emp_blackout: { attach: 'back', arc: 120 },
  arc_spark: { arc: 270 },
  arc_tesla: { attach: 'back', angle: 'right', arc: 300 },
  // Torpedoes: tubes that need room to launch
  torpedo_eel: { attach: 'back', clear: ahead(2) },
  torpedo_leviathan: { attach: 'back', clear: ahead(3) },
  lance_lance: { attach: 'back', clear: ahead(4) },
  legendary_hive: { attach: 'back', clear: ahead(1) },
  legendary_frostbite: { attach: 'back', arc: 150 },
  legendary_cinder_bloom: { arc: 360 },
  legendary_prism: { arc: 270 },
  legendary_phase: { attach: 'back', clear: ahead(3) },
  legendary_singularity: { attach: 'back', arc: 180 },
  // (A mining tool: anywhere it points out)
  utility_demolition_launcher: {},
};
/** Its mount and mounting rules, and its description with a line saying so */
function mounted(id, description) {
  const mount = MOUNT[id], mounting = MOUNTING[id];
  if (!mount) throw new Error(`no mount for weapon ${id}`);
  if (!mounting) throw new Error(`no mounting rules for weapon ${id}`);
  if (mount === 'fixed' && mounting.arc !== undefined) throw new Error(`${id}: a fixed gun has no arc`);
  if (mount === 'turret' && mounting.arc === undefined) throw new Error(`${id}: a turret needs its arc`);
  // (Its rules in words are the hangar's: common mountingWords, on its card and tooltip)
  return { mount, mounting, description: `${description} ${MOUNT_NOTE[mount]}` };
}

/** The bosses' legendaries: one model each, learned at its level (a few above its boss), made from its boss's artefact */
// (No schematic, Kieran 2026-10-30: the artefact is the gate, a very rare boss drop; data/bosses.json has the chances)
const LEGENDARY = [
  ['legendary_hive', "Rustjaw's Hive", 'hive', 'sq', 12],
  ['legendary_frostbite', 'Frostbite Lance', 'frostbite', 'rect2', 12],
  ['legendary_cinder_bloom', 'Cinder Bloom', 'cinder_bloom', 'sq', 22],
  ['legendary_prism', 'Prism Splitter', 'prism', 'sq', 10],
  ['legendary_phase', 'Phase Cannon', 'phase', 'rect2', 26],
  ['legendary_singularity', 'Singularity Launcher', 'singularity', 'sq', 30],
];

// Engines: [id, name, family, piece, level, thrust, draw, rated, boost, boostDrain, material, description]
// (The spec's table, but the Ion Drive pushes 2.26, as the thruster it replaces did: the starter flies as it always has)
const E = [
  ['engine_ion_drive', 'Ion Drive', 'ion', 'sq', 0, 2.26, 9, 34, 2.0, 1.0, 'alloy', 'Efficient and steady, with a low top speed.'],
  ['engine_vernier', 'Vernier', 'ion', 'tri', 2, 1.2, 4, 40, 1, 0, 'alloy', 'A cheap little thruster for corner push. It has no boost: boosting gives it no extra thrust and no extra drain.'],
  ['engine_afterburner', 'Afterburner', 'afterburner', 'sq', 5, 1.6, 8, 50, 3.6, 3.0, 'alloy', 'Weak at cruise, a huge burst when boosting. Best with a Drive Cell touching it.'],
  ['engine_torch', 'Torch', 'afterburner', 'rect2', 8, 4.0, 34, 70, 1, 0, 'alloy', 'Brutal thrust at full power all the time, and a brutal drain. It has no boost: nothing is held back to give.'],
  ['engine_plasma_drive', 'Plasma Drive', 'plasma', 'rect2', 16, 3.1, 20, 55, 1.8, 0.8, 'steel', 'The balanced main engine.'],
  ['engine_drift_sail', 'Drift Sail', 'ion', 'round', 22, 0.9, 3, 26, 1.3, 0.5, 'titanium', 'Near-free cruising, never in a hurry.'],
  ['engine_fusion_torch', 'Fusion Torch', 'plasma', 'block2', 30, 3.6, 28, 85, 1.7, 1.0, 'cobalt', 'The long-haul racer: fast, and faster still.'],
];

const BLAST = TUNING.partBlast;

function legacyLook(fn) {
  const f = FNS.get(fn);
  const out = { color: f.color, decor: f.decor };
  for (const k of ['glow', 'sfx', 'sfxTurret', 'sfxLoop']) if (f[k] !== undefined) out[k] = f[k];
  return out;
}

const models = [];
let guideOrder = 100;
const order = { weapons: 100, engines: 100, power: 100, utility: 100, shields: 100 };
const next = (cat) => order[cat]++;

function base(id, name, family, pieces, level, material, extra) {
  const grade = extra.grade ?? gradeAt(level ?? 24);
  return {
    id, name, model: true, family, pieces, material, grade, points: r2(GRADE_POINTS[grade - 1] * (extra.pointsMul ?? 1)),
    ...(level !== null ? { unlock: { level } } : {}),
  };
}

for (const [id, name, family, piece, level, k, mods, description] of W) {
  const lf = FNS.get(KIND_BASE[family]);
  const area = PIECE_AREA[piece], baseArea = Math.min(...lf.pieces.filter((p) => PIECE_AREA[p] >= 1).map((p) => PIECE_AREA[p]));
  const dps = (k.dmg ?? 1) * (k.burst ?? 1) / (k.int ?? 1);
  // Its draw: its kind's at its base size, × how much harder it hits a second, × its own appetite; spread over its cells
  const demand = k.demand ?? r2(lf.demand * baseArea * dps * (k.draw ?? 1) / area);
  models.push({
    ...base(id, name, family, [piece], level, k.material ?? materialAt(level), k),
    weapon: lf.weapon, ...mounted(id, description), hpScale: r2(lf.hpScale * (k.hp ?? 1)), ...(k.mass ? { massScale: k.mass } : {}),
    demand, priority: 2, ...(lf.fireInterval ? { fireInterval: Math.max(2, Math.round(lf.fireInterval * (k.int ?? 1))) } : {}),
    weaponMods: mods, ...(family === 'cannon' ? { blast: BLAST.weapon } : {}),
    rarity: level >= 30 ? 'epic' : level >= 12 ? 'rare' : level >= 3 ? 'uncommon' : 'common',
    category: 'weapons', fabOrder: next('weapons'), ...legacyLook(KIND_BASE[family]),
    guide: { name, blurb: k.blurb ?? description.split(':')[0].replace(/\.$/, ''), ...(piece !== 'sq' ? { piece } : {}), order: guideOrder++ },
  });
}
for (const [id, name, family, piece, level] of LEGENDARY) {
  const lf = FNS.get(family);
  models.push({
    ...base(id, name, family, [piece], null, 'cobalt', { grade: 4 }), unlock: { level },
    weapon: lf.weapon, ...mounted(id, lf.description), hpScale: lf.hpScale, demand: lf.demand, priority: 2, ...(lf.fireInterval ? { fireInterval: lf.fireInterval } : {}),
    weaponMods: {}, rarity: 'legendary', category: 'weapons', fabOrder: next('weapons'), ...legacyLook(family),
  });
}
for (const [id, name, family, piece, level, thrust, draw, rated, boost, boostDrain, material, description] of E) {
  const lf = FNS.get(KIND_BASE[family]);
  const blast = BLAST[KIND_BASE[family]];
  models.push({
    ...base(id, name, family, [piece], level, material, {}),
    hpScale: lf.hpScale, demand: draw, priority: 1, thrust, rated, boost, boostDrain, ...(blast ? { blast } : {}),
    rarity: level >= 20 ? 'rare' : level >= 5 ? 'uncommon' : 'common', description, category: 'engines', fabOrder: next('engines'),
    ...legacyLook(KIND_BASE[family]), guide: { name, blurb: description.replace(/\.$/, ''), ...(piece !== 'sq' ? { piece } : {}), order: guideOrder++ },
  });
}

// Power, utility, shields and plating: [id, name, family, piece(s), level, material, fields, description, category]
const OTHER = [
  ['power_cell_reactor', 'Cell Reactor', 'reactor', ['sq'], 0, 'alloy', { produce: 35, hpScale: 0.8, blast: BLAST.generator }, 'The starter generator. It explodes when destroyed.', 'power'],
  ['power_isotope_pile', 'Isotope Pile', 'reactor', ['round'], 9, 'steel', { produce: 18, hpScale: 1.6 }, 'A weak generator, but tough, and it never explodes.', 'power'],
  ['power_fusion_plant', 'Fusion Plant', 'reactor', ['block2'], 18, 'steel', { produce: 48, hpScale: 0.9, massScale: 2, blast: { radius: 3, damage: 70, delayTicks: [4, 16] } }, 'A heavy plant with plenty of power, and a big blast.', 'power'],
  ['power_overclock_reactor', 'Overclock Reactor', 'reactor', ['rect2'], 24, 'titanium', { produce: 62, hpScale: 0.4, blast: { radius: 3.6, damage: 95, delayTicks: [3, 12] } }, 'The most power for its size: fragile, and the biggest blast.', 'power'],
  ['power_battery', 'Battery', 'battery', ['sq'], 0, 'alloy', { store: 200, discharge: 600, hpScale: 0.6 }, 'Adds to the ship\'s pool on a powered network: holds 200 and gives it quickly.', 'power'],
  ['power_capacitor', 'Capacitor', 'capacitor', ['sq'], 7, 'composite', { store: 160, pool: 'weapon', bank: true, discharge: 2000, hpScale: 0.6 }, 'Touching Capacitors form a bank that feeds the guns, beams, miners and Flash Screen it touches before the ship does; it does not feed engines.', 'power'],
  ['power_drive_cell', 'Drive Cell', 'drive_cell', ['sq'], 10, 'steel', { store: 320, pool: 'drive', bank: true, discharge: 1400, hpScale: 0.6 }, 'Touching Drive Cells form a bank that feeds the engines and Burst Strafers it touches before the ship does; it does not feed guns.', 'power'],
  ['power_heavy_bank', 'Heavy Bank', 'battery', ['block2'], 20, 'titanium', { store: 300, discharge: 150, hpScale: 0.7, massScale: 1.6 }, 'A deep, heavy battery for the ship\'s pool: holds a lot, but gives it slowly.', 'power'],
  ['utility_mining_laser', 'Mining Laser', 'mining', ['sq'], 0, 'alloy', { demand: 12, priority: 2, facing: true, mining: true, hpScale: 0.7 }, 'A pulsed cutter that takes ore from rock, and a poor weapon.', 'utility'],
  ['utility_bore', 'Bore', 'mining', ['rect2'], 10, 'steel', { demand: 9, priority: 2, facing: true, mining: true, hpScale: 0.8 }, 'A heavy cutter that breaks harder rock than a mining laser.', 'utility'],
  ['utility_demolition_launcher', 'Demolition Launcher', 'demolition', ['sq'], 8, 'alloy', { weapon: 'charge', demand: 8, priority: 2, fireInterval: 120, hpScale: 0.8, weaponMods: {} }, 'Fires mining charges (30 a crate, one every 2 seconds) that stick to rock, blink for a second, then blow it open. Harmless to ships.', 'utility'],
  ['utility_siphon', 'Siphon', 'siphon', ['sq'], 12, 'steel', { demand: 10, priority: 2, facing: true, siphon: true, hpScale: 0.7 }, 'Drinks gas from gas pockets and sends it back to the ship.', 'utility'],
  ['utility_scanner', 'Scanner', 'scanner', ['sq'], 5, 'alloy', { demand: 4, priority: 3, range: 2400, hpScale: 0.6 }, 'A quick short sweep that reads rocks and finds seams.', 'utility'],
  ['utility_long_range_array', 'Long-Range Array', 'scanner', ['round2'], 20, 'titanium', { demand: r2(8 / PIECE_AREA.round2), priority: 3, range: 4800, hpScale: 0.6 }, 'A slow sweep that reaches twice as far as a scanner.', 'utility'],
  // (Level 2, Kieran 2026-10-30: the lane-clearance job, offered at 2, has you build one, and nothing opens early now; still a Mk III titanium rig)
  ['utility_constructor', 'Constructor', 'constructor', ['sq'], 2, 'titanium', { demand: 4, priority: 3, hpScale: 0.6, grade: 3 }, 'Builds structures piece by piece.', 'utility'],
  ['shield_deflector', 'Deflector', 'shield', ['sq'], 11, 'steel', { shield: 40, shieldRegen: 8, shieldDelay: 180, demand: 16, priority: 2, hpScale: 0.6 }, 'The standard shield, which soaks damage before the hull and refills 8 a second per cell after 3 seconds unhit.', 'shields'],
  ['shield_flicker_screen', 'Flicker Screen', 'shield', ['round'], 19, 'steel', { shield: 20, shieldRegen: 20, shieldDelay: 60, demand: r2(16 * 0.4), priority: 2, hpScale: 0.6 }, 'A thin, cheap shield that refills 20 a second per cell after only 1 second unhit.', 'shields'],
  ['shield_bulwark_projector', 'Bulwark Projector', 'shield', ['block2'], 27, 'titanium', { shield: 45, shieldRegen: 5, shieldDelay: 240, demand: r2(16 * 1.2), priority: 2, hpScale: 0.7 }, 'A deep shield that soaks an alpha strike but refills only 5 a second per cell after 4 seconds unhit.', 'shields'],
  ['utility_jump_coil', 'Jump Coil', 'jumpcoil', ['sq'], 14, 'steel', { jumpCapacity: 12, demand: 8, priority: 3, hpScale: 0.8 }, 'More jump drive for a bigger hull.', 'engines'],
  ['utility_heavy_coil', 'Heavy Coil', 'jumpcoil', ['block2'], 30, 'cobalt', { jumpCapacity: 16, jumpCooldown: 0.8, demand: 8, priority: 3, hpScale: 0.8 }, 'A dense coil with more jump drive per cell that also cuts the jump cooldown by a fifth.', 'engines'],
  ['plating_reactive_armour', 'Reactive Armour', 'plating', ['sq', 'rect2'], 12, 'steel', { armour: 2, hpScale: 2, massScale: 1.6 }, 'Plate that blunts small fast hits, so it beats streams of fire.', 'shields'],
  ['plating_spaced_plating', 'Spaced Plating', 'plating', ['sq', 'rect2'], 22, 'titanium', { armour: 1, splashTaken: 0.5, hpScale: 3.2, massScale: 1.3 }, 'Layered plate with room between that takes half damage from blasts.', 'shields'],
];
const LOOK = {
  reactor: 'generator', battery: 'battery', capacitor: 'weapon_battery', drive_cell: 'drive_battery', mining: 'miner', demolition: 'charge_launcher',
  siphon: 'siphon', scanner: 'scanner', constructor: 'constructor', shield: 'shield', jumpcoil: 'jumpcoil', plating: 'armor',
};
/** Families with no legacy function: their own look (client/src/ships/partDecor.ts DECOR_SHAPES) */
const OWN_LOOK = { constructor: { color: '#f5b942', decor: 'none' } };
for (const [id, name, family, pieces, level, material, fields, description, category] of OTHER) {
  const look = OWN_LOOK[family] ?? legacyLook(LOOK[family]);
  models.push({
    ...base(id, name, family, pieces, level, material, { grade: fields.grade }), ...fields, ...(fields.weapon ? mounted(id, description) : { description }),
    rarity: level >= 20 ? 'rare' : level >= 5 ? 'uncommon' : 'common', category, fabOrder: next(category), ...look,
    ...(family === 'plating' ? { color: level > 15 ? '#7d8796' : '#857462' } : {}),
    guide: { name, blurb: description.split(/[.:]/)[0], ...(pieces[0] !== 'sq' ? { piece: pieces[0] } : {}), order: guideOrder++ },
  });
}
// ---- The Pulse Dynamo, the Flash Screen and the Rail Driver (docs/design/rework-2026-11.md §2.6) ----------
// The Pulse Dynamo charges the banks it touches (circuits.ts `dynamo`: a second, into each), with no wires; the Flash Screen's
// return is its own feature (features/flash) and the Rail Driver a plain heavy rail (their own behaviour comes later in the rework). Appended
// last, so no other model's order moves.
{
  const DYNAMO_LOOK = { color: '#6d3fb3', decor: 'battery', glow: '#b57cff' };
  const LATE_OTHER = [
    ['power_pulse_dynamo', 'Pulse Dynamo', 'dynamo', ['sq'], 18, 'titanium', { dynamo: 10, hpScale: 0.6 }, 'Puts 10 a second into each Capacitor or Drive Cell bank it touches, split evenly. It needs no wires and powers nothing itself.', 'power', DYNAMO_LOOK],
    ['shield_flash_screen', 'Flash Screen', 'shield', ['sq'], 13, 'steel', { shield: 36, shieldRegen: 0, shieldDelay: 0, flash: true, demand: 16, priority: 2, hpScale: 0.6 }, 'A shield with no slow refill that returns whole 4 seconds after it breaks, or at once for 4 E a point from a Capacitor bank touching it.', 'shields', legacyLook('shield')],
  ];
  for (const [id, name, family, pieces, level, material, fields, description, category, look] of LATE_OTHER) {
    models.push({
      ...base(id, name, family, pieces, level, material, { grade: fields.grade }), ...fields, description,
      rarity: level >= 20 ? 'rare' : level >= 5 ? 'uncommon' : 'common', category, fabOrder: next(category), ...look,
      guide: { name, blurb: description.split(/[.:]/)[0], ...(pieces[0] !== 'sq' ? { piece: pieces[0] } : {}), order: guideOrder++ },
    });
  }
  MOUNT.railgun_rail_driver = 'fixed';
  MOUNTING.railgun_rail_driver = { attach: 'back', clear: ahead(3) };
  // (The semi-automatic rifle, its own numbers: a clip of 6 at 10 ticks, 40 dmg, pierce 1, speed 150; reloading itself for 90 ticks draws 48 E,
  // the bank first. Its demand is that reload's draw spread over a clip's whole cycle; the fire block below gives the rest.)
  const desc = 'The semi-automatic rifle: a clip of six sharp shots at six a second, then it reloads itself in a second and a half for 48 E, from its bank first. It needs no ammo.';
  models.push({
    ...base('railgun_rail_driver', 'Rail Driver', 'railgun', ['block2'], 29, 'titanium', { grade: 4 }),
    weapon: 'railgun', ...mounted('railgun_rail_driver', desc), hpScale: 0.96, demand: r2((48 * 60) / (90 + 6 * 10) / PIECE_AREA.block2), priority: 2, fireInterval: 10,
    weaponMods: { set: { ammo: null, damage: 40, pierce: 1, speed: 150, life: 60 } },
    rarity: 'rare', category: 'weapons', fabOrder: next('weapons'), ...legacyLook('railgun'),
    guide: { name: 'Rail Driver', blurb: 'The semi-automatic rifle', piece: 'block2', order: guideOrder++ },
  });
}
// ---- (end Pulse Dynamo, Flash Screen, Rail Driver)
// ---- Support weapons: the Repair Beam and the Point Defence Turret (common/src/ships/features/support/support.ts; build-archetypes.md §5 #6, #7) ----
// The Repair Beam (band L16-23, Steady: the Warden's) is a held turret beam that mends friendly ships' parts where it lands, at a
// big steady draw while it's on; the Point Defence Turret (band L8-15: the Interceptor's, Bulwark's and Freighter's) is a quick
// turret that fires on its own at incoming missiles, torpedoes, mortar shells and seekers, a little power a shot. Appended last,
// so no other model's order moves.
{
  const SUPPORT_LOOK = {
    repair: { color: '#2f9e7a', decor: 'laser', glow: '#5eead4', sfxLoop: 'laser_loop' },
    point_defence: { color: '#c86a2a', decor: 'cannon', sfx: 'shot', sfxTurret: 'turret_shot' },
  };
  MOUNT.utility_repair_beam = 'turret';
  MOUNTING.utility_repair_beam = { arc: 240 };
  MOUNT.point_defence_turret = 'turret';
  MOUNTING.point_defence_turret = { arc: 300 };
  const SUPPORT = [
    ['utility_repair_beam', 'Repair Beam', 'repair', ['rect2'], 17, 'steel', { weapon: 'repair', demand: 14, priority: 2, hpScale: 0.7, weaponMods: {} },
      "Mends 42 HP a second into the friendly part its beam lands on (range 520, 28 power a second): hold fire with it on a party member or an ally. It can't mend your own ship, a destroyed part or a shield, and does nothing to an enemy.", 'utility'],
    ['point_defence_turret', 'Point Defence Turret', 'point_defence', ['sq'], 10, 'steel', { weapon: 'point_defence', demand: 10, priority: 2, fireInterval: 12, hpScale: 0.6, weaponMods: {} },
      'Shoots down incoming missiles, torpedoes, mortar shells and seekers on its own: 5 shots a second out to 560, 2 power a shot. One hit kills a missile, mortar shell or seeker; a Hammerhead takes 2, an Eel 3, a Leviathan 5. It never fires at ships, and a boss\'s rings of shots are yours to dodge.', 'weapons'],
  ];
  for (const [id, name, family, pieces, level, material, fields, description, category] of SUPPORT) {
    const m = mounted(id, description);
    models.push({
      ...base(id, name, family, pieces, level, material, { grade: fields.grade }), ...fields, ...m,
      // (It turns on its own, not to your aim)
      ...(family === 'point_defence' ? { description: `${description} Turret: aims itself.` } : {}),
      rarity: level >= 20 ? 'rare' : level >= 5 ? 'uncommon' : 'common', category, fabOrder: next(category), ...SUPPORT_LOOK[family],
      guide: { name, blurb: description.split(/[.:]/)[0], ...(pieces[0] !== 'sq' ? { piece: pieces[0] } : {}), order: guideOrder++ },
    });
  }
}
// ---- (end support weapons)
// ---- Burst Strafer and Tow Beam (common/src/ships/strafer.ts, tow.ts; build-archetypes.md §5 #1, #8; both band L8-15) ----
// The Burst Strafer (the Dancer's, Interceptor's, Blinker's): no cruising thrust at all, only a dodge. A fixed sharp burst
// (`strafe.ticks`) of `strafe.kick` push per cell out of its facing's opposite side, the next `strafe.cooldown` ticks after
// one starts (no charges: energy is the limit); while a burst runs it draws `demand` per cell a second (140 a burst for its
// one cell: several times an engine's energy per push, so dodging as often as it allows browns the ship out unless Drive Cells,
// batteries and generation back it), from the Drive Cell bank it touches first. (Kieran 2026-10-31, after playtesting:
// any direction, stronger, short cooldown, energy-limited; was a quarter-second sideways burst with three slow charges.) The Tow Beam (the Salvage Tug's): latches onto
// a wreck, debris or a pod and pulls it on a tether (tuning.json `tow`), drawing `demand` per cell a second while it tows.
// Appended last, so no other model's order moves.
{
  const TUG_LOOK = {
    strafer: { color: '#8a94a6', decor: 'afterburner', glow: '#f472b6' },
    tow: { color: '#8a8f6a', decor: 'miner', glow: '#facc15' },
  };
  const TUG = [
    ['engine_burst_strafer', 'Burst Strafer', 'strafer', ['sq'], 10, 'steel',
      { strafe: { kick: 14, ticks: 12, cooldown: 24 }, demand: 700, priority: 1, facing: true, hpScale: 0.6 },
      'A dodge thruster: a hard fifth-of-a-second burst away from its nozzle, ready again in under half a second, and a lot of energy every time. Fit them facing different ways to dodge any way. It draws from a Drive Cell bank touching it first. No push at all for cruising.', 'engines'],
    ['utility_tow_beam', 'Tow Beam', 'tow', ['rect2'], 12, 'steel',
      { tow: true, demand: 12, priority: 2, facing: true, hpScale: 0.9, massScale: 1.2 },
      'Latches onto a wreck, debris or a loot pod and drags it on a tether to a station to salvage, and never takes hold of a working ship.', 'utility'],
  ];
  for (const [id, name, family, pieces, level, material, fields, description, category] of TUG) {
    models.push({
      ...base(id, name, family, pieces, level, material, { grade: fields.grade }), ...fields, description,
      rarity: level >= 20 ? 'rare' : level >= 5 ? 'uncommon' : 'common', category, fabOrder: next(category), ...TUG_LOOK[family],
      guide: { name, blurb: description.split(/[.:]/)[0], ...(pieces[0] !== 'sq' ? { piece: pieces[0] } : {}), order: guideOrder++ },
    });
  }
}
// ---- (end Burst Strafer and Tow Beam)
// ---- Firing models (docs/design/rework-2026-11.md §3, §4): every weapon model's `fire` block, read by
// common/src/ships/guns.ts stepGuns through WeaponInfo.fire. model: 'cycle' fires on a beat while held, its energy drawn
// as it reloads; 'clip' fires `clip` rounds, then reloads `reload` ticks drawing `reloadE` (or, with `regrow`, one round
// back every `regrow` ticks); 'charge' fills over `charge` ticks drawing `chargeE`, fires itself, then `cooldown`;
// 'ammo' fires `rounds` from the hold on a beat, no energy; 'beam' burns energy every tick held (`windup`: damage ramps
// in over that many ticks); 'auto' fires on its own (Point Defence). `interval` is today's fireInterval (ticks between
// shots; a clip's is section 4's beat within the clip); a family unit of the rework retunes the numbers. `spin` {from, to, up, down}: the interval eases from `from`
// to `to` ticks over `up` ticks of fire, back over `down`. Weapons whose kind fires ammunition but whose model pays
// with power stop taking it (set: { ammo: null }); a held-beam model of a kind that isn't a beam gets its dps and range.
{
  const FIRE = {
    cannon_pip: { model: 'cycle' },
    cannon_hammer: { model: 'cycle' },
    cannon_twinlink: { model: 'clip', interval: 6, clip: 16, reload: 90, reloadE: 24 },
    cannon_longbarrel: { model: 'charge', charge: 120, cooldown: 90, chargeE: 36 },
    cannon_bastion: { model: 'clip', interval: 18, clip: 2, reload: 180, reloadE: 60 },
    autocannon_rattler: { model: 'cycle' },
    autocannon_chainsaw: { model: 'cycle', spin: { from: 15, to: 3.75, up: 60, down: 30 } },
    autocannon_stinger: { model: 'clip', interval: 7.5, clip: 12, reload: 72, reloadE: 20 },
    flak_burst: { model: 'ammo' },
    flak_cloudmaker: { model: 'clip', interval: 30, clip: 4, reload: 150, reloadE: 30 },
    mortar_lobber: { model: 'ammo' },
    mortar_quake: { model: 'ammo', rounds: 3, interval: 180 },
    laser_glint: { model: 'cycle' },
    laser_cutter: { model: 'beam' },
    laser_searchlight: { model: 'beam' },
    pulse_strobe: { model: 'cycle' },
    pulse_overpulse: { model: 'clip', interval: 6, clip: 12, reload: 90, reloadE: 36 },
    missile_dart: { model: 'ammo', interval: 108 },
    missile_swarm: { model: 'ammo', rounds: 6, interval: 180 },
    missile_hammerhead: { model: 'ammo' },
    railgun_needle: { model: 'ammo' },
    railgun_coilgun: { model: 'cycle', interval: 54 },
    railgun_spear: { model: 'cycle', interval: 114 },
    railgun_rail_driver: { model: 'clip', interval: 10, clip: 6, reload: 90, reloadE: 48 },
    emp_hush: { model: 'cycle', interval: 162 },
    emp_blackout: { model: 'charge', charge: 90, cooldown: 240, chargeE: 90 },
    arc_spark: { model: 'cycle', interval: 45 },
    arc_tesla: { model: 'beam' },
    torpedo_eel: { model: 'ammo' },
    torpedo_leviathan: { model: 'ammo', rounds: 2, interval: 360 },
    lance_lance: { model: 'beam', windup: 18 },
    // (The Hive's salvo of four seekers (tuning.json weapons.hive salvo) takes four of its eight rounds, 0.5 s apart at most; it regrows one a 0.75 s drawing 6 E)
    legendary_hive: { model: 'clip', interval: 30, clip: 8, regrow: 45, reloadE: 48, rounds: 4 },
    legendary_frostbite: { model: 'beam' },
    legendary_cinder_bloom: { model: 'cycle', interval: 72 },
    legendary_prism: { model: 'cycle', interval: 96 },
    legendary_phase: { model: 'cycle', interval: 132 },
    legendary_singularity: { model: 'cycle', interval: 420 },
    point_defence_turret: { model: 'auto' },
    utility_repair_beam: { model: 'beam' },
    utility_demolition_launcher: { model: 'ammo' },
  };
  // (Held beams of kinds that fire shells or pulses today: the section 4 dps and reach, until their family unit gives them their own)
  const RAIL_E = { railgun_coilgun: 14, railgun_spear: 120, emp_hush: 25, arc_spark: 13.5, legendary_cinder_bloom: 14, legendary_prism: 16, legendary_phase: 30, legendary_singularity: 210 };
  // (Held beams' energy a second, section 4: demand x the piece's area. Tesla: a zap every 12 ticks of 14 damage, chaining)
  const BEAM_E = { arc_tesla: 30, legendary_frostbite: 24 };
  const BEAM_SET = { laser_cutter: { dps: 60 }, laser_searchlight: { dps: 25 }, arc_tesla: { dps: 70, range: 660, width: 10, zap: 12 } };
  // (Hush bursts on its fuse: 90 ticks of flight, or on proximity)
  BEAM_SET.emp_hush = { life: 90 };
  for (const m of models) {
    if (!m.weapon) continue;
    const f = FIRE[m.id];
    if (!f) throw new Error(`no fire block for weapon ${m.id}`);
    m.fire = { ...f, interval: f.model === 'beam' ? 1 : f.interval ?? m.fireInterval ?? 10 };
    // (A clip's interval is its own beat within the clip, from section 4: the fire rate everything else reads too)
    if (f.interval !== undefined) m.fireInterval = f.interval;
    // (A cycle railgun's energy a shot is its draw x its interval: the section 4 energies set the draw, per cell)
    if (BEAM_E[m.id]) m.demand = r2(BEAM_E[m.id] / PIECE_AREA[m.pieces[0]]);
    if (RAIL_E[m.id]) m.demand = r2((RAIL_E[m.id] * 60) / (f.interval * PIECE_AREA[m.pieces[0]]));
    const kind = TUNING.weapons[m.weapon] ?? {};
    const set = { ...(m.weaponMods?.set ?? {}) };
    if (kind.ammo && f.model !== 'ammo') set.ammo = null;
    Object.assign(set, BEAM_SET[m.id] ?? {});
    if (Object.keys(set).length) m.weaponMods = { ...m.weaponMods, set };
  }
  // ---- Legendaries' texts (rework 2026-11 section 4): what each does, in numbers; its mount line is added after
  const LEGEND_TEXT = {
    legendary_hive: 'A nest that regrows: it holds eight seekers and looses them four at a time, a tenth of a second apart, each homing on a different one of the four ships nearest your cursor. One grows back every three-quarters of a second, drawing a little power. Each is 10 damage and a 70 blast, and dies to one point-defence hit.',
    legendary_frostbite: 'The freeze beam: a held beam out to 760 that burns 95 a second. The ship it touches is slowed, 40% less thrust and turning, while lit and 0.7 s after.',
    legendary_cinder_bloom: 'The arsonist: a shell every 1.2 s for 16 damage, and the part it hits burns for 22 a second over 5 s, the fire spreading to its neighbours.',
    legendary_prism: 'The splitter: a crystal bolt every 1.6 s that splits where your cursor is into five 11-damage shards in a 40 degree fan. You choose where the fan opens.',
    legendary_phase: 'The ghost round: a slow 70-damage round every 2.2 s that flies through rock, wrecks and shields, hits the hull directly, and carries on through two ships.',
    legendary_singularity: 'The black hole: 210 power a shot, one every 7 s. A slow orb flies out along your aim, pulls every ship within 900 toward it for 3.8 s, then collapses in a 300 blast for 140.',
  };
  for (const [id, text] of Object.entries(LEGEND_TEXT)) {
    const m = models.find((x) => x.id === id);
    if (!m) throw new Error(`text for ${id}, which isn't a model`);
    m.description = mounted(id, text).description;
  }
  for (const id of Object.keys(FIRE)) if (!models.some((m) => m.id === id && m.weapon)) throw new Error(`fire block for ${id}, which isn't a weapon model`);

  // ---- Shot behaviours (rework 2026-11, the shot-behaviours unit: common/src/ships/features/weaponry): shared options a
  // model switches on in its weaponMods.set. endAtAim: bursts or splits at the aim distance (or earlier on its fuse or
  // on impact); walk: a salvo landing at these fractions of the aim distance, `gap` ticks apart; guided: steers to the
  // cursor (at most `turn` rad a tick) while the trigger is held; mark: a beam whose target takes +20% damage from
  // everyone while lit and `ticks` after; slow: a beam whose target flies slowed (-40% thrust and turning) while lit and
  // `ticks` after (the Frostbite's is its kind's: tuning.json weapons.frostbite.slow). A family unit tunes the numbers.
  const SHOT = {
    flak_cloudmaker: { endAtAim: true },
    legendary_prism: { endAtAim: true },
    emp_blackout: { endAtAim: true },
    mortar_quake: { walk: { at: [0.7, 1, 1.3], gap: 15 } },
    missile_hammerhead: { guided: { turn: 0.05 } },
    missile_swarm: { salvo: { count: 6, gap: 6 } },
    laser_searchlight: { mark: { ticks: 120 } },
  };
  for (const [id, set] of Object.entries(SHOT)) {
    const m = models.find((x) => x.id === id && x.weapon);
    if (!m) throw new Error(`shot behaviour for ${id}, which isn't a weapon model`);
    m.weaponMods = { ...m.weaponMods, set: { ...(m.weaponMods?.set ?? {}), ...set } };
  }
}
// ---- (end firing models)
for (const id of Object.keys(MOUNT)) if (!models.some((m) => m.id === id && m.weapon)) throw new Error(`mount for ${id}, which isn't a weapon model`);
for (const id of Object.keys(MOUNTING)) if (!MOUNT[id]) throw new Error(`mounting rules for ${id}, which isn't a weapon model`);
// (Everything below the legacy functions' own keys: a model is a FunctionDef)
for (const m of models) m.carriesFlow = true;

// ---------------------------------------------------------------------------
// Components (docs §2) and recipes
// ---------------------------------------------------------------------------

const COMPONENTS = [
  ['barrel_assembly', 'Barrel Assembly', 'uncommon', 60, { steel_plate: 2, servo_motor: 1 }, 45, '#a8a29e', 'A rifled barrel on a servo mount: cannons, autocannons, flak and mortars.'],
  ['coil_winding', 'Coil Winding', 'uncommon', 48, { copper_wire: 6, ferrite_plate: 1 }, 40, '#d97706', 'Copper wound on a ferrite core: railguns, arc and EMP projectors, jump coils.'],
  ['capacitor_cell', 'Capacitor Cell', 'uncommon', 40, { copper_wire: 3, insulated_polymer: 1, scrap_electronics: 1 }, 30, '#38bdf8', 'A fast-discharge cell: batteries, capacitors, pulse guns and lasers.'],
  ['thrust_nozzle', 'Thrust Nozzle', 'rare', 85, { titanium_plate: 2, ceramic_plate: 1 }, 60, '#f97316', 'A ceramic-lined titanium bell: torches, plasma and fusion drives.'],
  ['fuel_injector', 'Fuel Injector', 'uncommon', 55, { steel_plate: 1, propellant: 2, servo_motor: 1 }, 45, '#fb923c', 'Meters propellant into a burn: afterburners and torches.'],
  ['reactor_core', 'Reactor Core', 'rare', 130, { hardened_steel: 2, crystal: 1, coolant: 2 }, 90, '#facc15', 'The heart of a generator past the cell reactor.'],
  ['wire_spool', 'Wire Spool', 'common', 14, { copper_wire: 4, insulated_polymer: 1 }, 0, '#c2773a', 'Insulated power wire: one spool lays four segments of wiring.'],
];

/** Each model's recipe: its own (handwritten where it's special), else plate per cell and its kind's parts */
const RECIPES = {
  cannon_pip: { alloy_plate: 2, copper_wire: 1 },
  cannon_hammer: { alloy_plate: 3, copper_wire: 2, barrel_assembly: 1 },
  cannon_twinlink: { steel_plate: 3, copper_wire: 3, barrel_assembly: 2 },
  cannon_longbarrel: { titanium_plate: 3, copper_wire: 2, barrel_assembly: 2, targeting_chip: 1 },
  cannon_bastion: { cobalt_alloy: 5, hardened_steel: 2, barrel_assembly: 3, servo_motor: 2 },
  autocannon_rattler: { alloy_plate: 2, copper_wire: 2, scrap_electronics: 1 },
  autocannon_chainsaw: { steel_plate: 3, copper_wire: 3, barrel_assembly: 1, servo_motor: 1 },
  autocannon_stinger: { titanium_plate: 2, barrel_assembly: 1, targeting_chip: 1 },
  flak_burst: { alloy_plate: 2, copper_wire: 1, scrap_electronics: 1 },
  flak_cloudmaker: { steel_plate: 3, copper_wire: 2, barrel_assembly: 1, targeting_chip: 1 },
  mortar_lobber: { alloy_plate: 3, copper_wire: 1, servo_motor: 1 },
  mortar_quake: { titanium_plate: 3, barrel_assembly: 2, servo_motor: 1 },
  laser_glint: { alloy_plate: 1, copper_wire: 2, crystal_lens: 1, capacitor_cell: 1 },
  laser_cutter: { steel_plate: 2, copper_wire: 3, crystal_lens: 2, capacitor_cell: 1 },
  laser_searchlight: { titanium_plate: 1, crystal_lens: 3, capacitor_cell: 1, targeting_chip: 1 },
  pulse_strobe: { steel_plate: 1, copper_wire: 2, crystal_lens: 1, capacitor_cell: 1 },
  pulse_overpulse: { titanium_plate: 2, crystal_lens: 1, capacitor_cell: 3, power_coupling: 1 },
  missile_dart: { steel_plate: 2, copper_wire: 1, targeting_chip: 1 },
  missile_swarm: { titanium_plate: 2, copper_wire: 2, targeting_chip: 2, servo_motor: 1 },
  missile_hammerhead: { cobalt_alloy: 4, targeting_chip: 2, servo_motor: 2, nav_computer: 1 },
  railgun_needle: { steel_plate: 2, copper_wire: 2, coil_winding: 1, power_coupling: 1 },
  railgun_coilgun: { titanium_plate: 2, coil_winding: 3, capacitor_cell: 2 },
  railgun_spear: { titanium_plate: 4, hardened_steel: 2, coil_winding: 3, power_coupling: 2 },
  emp_hush: { steel_plate: 1, coil_winding: 1, power_coupling: 1 },
  emp_blackout: { cobalt_alloy: 3, coil_winding: 3, power_coupling: 2, quantum_core: 1 },
  arc_spark: { steel_plate: 1, coil_winding: 2, power_coupling: 1 },
  arc_tesla: { titanium_plate: 2, coil_winding: 3, crystal_lens: 1, power_coupling: 1 },
  torpedo_eel: { steel_plate: 3, copper_wire: 2, targeting_chip: 1, servo_motor: 1 },
  torpedo_leviathan: { cobalt_alloy: 5, targeting_chip: 2, nav_computer: 1, servo_motor: 2 },
  lance_lance: { cobalt_alloy: 2, copper_wire: 4, crystal_lens: 2, power_coupling: 2, capacitor_cell: 2 },
  legendary_hive: { cobalt_alloy: 1, targeting_chip: 1, servo_motor: 1, rustjaw_cog: 1 },
  legendary_frostbite: { cobalt_alloy: 1, copper_wire: 6, crystal_lens: 2, frost_gland: 4, frost_heart: 1 },
  legendary_cinder_bloom: { cobalt_alloy: 1, power_coupling: 1, cinder_ash: 2, cinder_ember: 1 },
  legendary_prism: { crystal_lens: 2, copper_wire: 2, prism_shard: 1 },
  legendary_phase: { cobalt_alloy: 2, nav_computer: 1, void_ichor: 1, void_pearl: 1 },
  legendary_singularity: { cobalt_alloy: 2, quantum_core: 1, maw_fragment: 1 },
  engine_ion_drive: { alloy_plate: 2, copper_wire: 1 },
  engine_vernier: { alloy_plate: 1, copper_wire: 1 },
  engine_afterburner: { alloy_plate: 2, copper_wire: 1, fuel_injector: 1 },
  engine_torch: { alloy_plate: 3, copper_wire: 2, fuel_injector: 1, thrust_nozzle: 1 },
  engine_plasma_drive: { steel_plate: 3, copper_wire: 4, thrust_nozzle: 1, power_coupling: 1 },
  engine_drift_sail: { titanium_plate: 1, composite_sheet: 3, copper_wire: 2, crystal_lens: 1 },
  engine_fusion_torch: { cobalt_alloy: 4, thrust_nozzle: 2, reactor_core: 1, power_coupling: 1 },
  power_cell_reactor: { alloy_plate: 1, copper_wire: 2 },
  power_isotope_pile: { steel_plate: 2, copper_wire: 2, reactor_core: 1 },
  power_fusion_plant: { steel_plate: 6, copper_wire: 6, reactor_core: 2, coolant: 4 },
  power_overclock_reactor: { titanium_plate: 3, copper_wire: 4, reactor_core: 2, power_coupling: 2 },
  power_battery: { alloy_plate: 1, copper_wire: 2 },
  power_capacitor: { composite_sheet: 1, capacitor_cell: 1 },
  power_drive_cell: { steel_plate: 1, copper_wire: 2, capacitor_cell: 1 },
  power_heavy_bank: { titanium_plate: 4, capacitor_cell: 4, power_coupling: 1 },
  utility_mining_laser: { alloy_plate: 2, copper_wire: 2 },
  utility_bore: { steel_plate: 3, copper_wire: 3, crystal_lens: 1 },
  utility_demolition_launcher: { alloy_plate: 2, copper_wire: 1, servo_motor: 1 },
  utility_siphon: { steel_plate: 2, copper_wire: 2, coolant: 2 },
  utility_scanner: { alloy_plate: 1, copper_wire: 2, crystal_lens: 1 },
  utility_long_range_array: { titanium_plate: 3, copper_wire: 4, crystal_lens: 2, nav_computer: 1 },
  utility_constructor: { titanium_plate: 2, copper_wire: 3, servo_motor: 2 },
  shield_deflector: { steel_plate: 1, copper_wire: 2, shield_emitter: 1 },
  shield_flicker_screen: { steel_plate: 1, copper_wire: 2, shield_emitter: 1, capacitor_cell: 1 },
  shield_bulwark_projector: { titanium_plate: 4, copper_wire: 4, shield_emitter: 3, power_coupling: 1 },
  utility_jump_coil: { steel_plate: 1, coil_winding: 1, power_coupling: 1, crystal: 1 },
  utility_heavy_coil: { cobalt_alloy: 4, coil_winding: 4, power_coupling: 2, nav_computer: 1 },
  plating_reactive_armour: { steel_plate: 2, propellant: 1, scrap_electronics: 1 },
  plating_spaced_plating: { titanium_plate: 3, composite_sheet: 1 },
};
// (The Pulse Dynamo, Flash Screen and Rail Driver)
Object.assign(RECIPES, {
  power_pulse_dynamo: { titanium_plate: 1, coil_winding: 2, capacitor_cell: 1 },
  shield_flash_screen: { steel_plate: 1, copper_wire: 2, shield_emitter: 1, capacitor_cell: 2 },
  railgun_rail_driver: { titanium_plate: 4, hardened_steel: 2, coil_winding: 3, capacitor_cell: 2, power_coupling: 2 },
});
// (Support weapons: the Repair Beam and the Point Defence Turret)
Object.assign(RECIPES, {
  utility_repair_beam: { steel_plate: 2, copper_wire: 3, crystal_lens: 2, servo_motor: 1, power_coupling: 1 },
  point_defence_turret: { steel_plate: 1, copper_wire: 2, servo_motor: 1, targeting_chip: 1 },
});
// (Burst Strafer and Tow Beam)
Object.assign(RECIPES, {
  engine_burst_strafer: { steel_plate: 1, fuel_injector: 1, capacitor_cell: 1 },
  utility_tow_beam: { steel_plate: 2, coil_winding: 2, servo_motor: 1, power_coupling: 1 },
});
/** Plating comes in two sizes: its recipe is per cell */
const PER_CELL = new Set(['plating_reactive_armour', 'plating_spaced_plating']);
const KNOWN = new Set([...read('items.json').items.map((d) => d.id), ...read('recipes.json').refining.map((r) => r.id), ...COMPONENTS.map((c) => c[0])]);
/** Fabrication seconds: 20 a cell, longer for higher tiers; small low-tier ones are instant */
const TIME_BY_GRADE = [1, 1, 1.5, 2.5, 4, 6];

const recipes = {};
for (const m of models) {
  const inputs = RECIPES[m.id];
  if (!inputs) throw new Error(`no recipe for ${m.id}`);
  for (const id of Object.keys(inputs)) if (!KNOWN.has(id)) throw new Error(`${m.id}: unknown input ${id}`);
  const area = PIECE_AREA[m.pieces[0]];
  // (As a Mk I or II part always was: small and low-tier, made at once)
  const instant = m.grade <= 2 && area <= 1;
  recipes[m.id] = { inputs, time: instant ? 0 : Math.round(20 * Math.max(1, area) * TIME_BY_GRADE[m.grade]), ...(PER_CELL.has(m.id) ? { perCell: true } : {}) };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

const ids = new Set();
for (const m of models) { if (ids.has(m.id) || FNS.has(m.id)) throw new Error(`duplicate id ${m.id}`); ids.add(m.id); }

// (One model a line)
const NOTE = 'Written by scripts/econ/models.mjs (edit that, not this). Player models: fixed named modules (docs/parts-redesign.md). `legacy`: the family each legacy function migrates to.';
writeFileSync(join(DATA, 'ships/models.json'),
  `{\n  "_comment": ${JSON.stringify(NOTE)},\n  "legacy": ${JSON.stringify(LEGACY)},\n  "models": [\n${models.map((m) => '    ' + JSON.stringify(m)).join(',\n')}\n  ]\n}\n`);

const rec = read('recipes.json');
rec.models = recipes;
for (const [id, , , , inputs, time] of COMPONENTS) {
  const r = { id, out: { [id]: 1 }, inputs, time, starter: true };
  const i = rec.craft.findIndex((c) => c.id === id);
  if (i >= 0) rec.craft[i] = r; else rec.craft.push(r);
}
writeFileSync(join(DATA, 'recipes.json'), JSON.stringify(rec, null, 2) + '\n');

const items = read('items.json');
for (const [id, name, rarity, value, , , color, description] of COMPONENTS) {
  const d = { id, name, category: 'component', rarity, value, color, description };
  const i = items.items.findIndex((x) => x.id === id);
  if (i >= 0) items.items[i] = { ...items.items[i], ...d };
  else {
    // After the last component
    const at = items.items.map((x) => x.category).lastIndexOf('component');
    items.items.splice(at + 1, 0, d);
  }
}
writeFileSync(join(DATA, 'items.json'), JSON.stringify(items, null, 2) + '\n');

console.log(`${models.length} models (${models.filter((m) => m.weapon).length} weapons), ${COMPONENTS.length} components`);
