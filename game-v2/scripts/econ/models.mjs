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
  // `demand` is the draw a cell gives while its beat runs (a clip or charge gun draws by its fire block instead: reloadE, chargeE).
  // Heavier shots 2026-11 then made the Pip 18 dmg every 20 t at 54, the Hammer 88 every 60 t, the Twinlink 8 at 10 t, 20 dmg at 62.)
  ['cannon_pip', 'Pip', 'cannon', 'sq', 0, { int: 1.5, draw: 1.5, blurb: 'The reliable starter' }, { set: { damage: 18, speed: 54, life: 133 } }, 'The starter gun: three reliable amber shells a second, and no tricks.'],
  ['cannon_hammer', 'Hammer', 'cannon', 'rect2', 6, { int: 4.2, demand: 5, blurb: 'The breacher' }, { mul: { speed: xp(38 / 48), size: xp(1.6) }, add: { pen: 1 }, set: { damage: 88 } }, 'The breacher: one slow, heavy, armour-piercing slug a second, for 88.'],
  ['cannon_twinlink', 'Twinlink', 'cannon', 'rect2', 12, { demand: 3.87, blurb: 'Paired autoloader turret' }, { mul: { spread: x(3.3 / 1.8) }, set: { damage: 20, speed: 62, life: 116 } }, 'A paired autoloader turret: a burst of eight heavy rounds, then a pause to reload.'],
  ['cannon_longbarrel', 'Longbarrel', 'cannon', 'rect2', 20, { demand: 5.14, blurb: 'The sniper' }, { mul: { damage: xp(170 / 14), speed: xp(140 / 48), life: xp(60 / 150) }, add: { pen: 1 }, set: { spread: 0 } }, 'The sniper: it charges while you hold and fires itself at full, one telegraphed shot that picks a part off.'],
  ['cannon_bastion', 'Bastion', 'cannon', 'block2', 30, { hp: 1.3, mass: 1.6, demand: 4.17, blurb: 'The ship-killer double tap' }, { mul: { damage: xp(180 / 14), speed: xp(32 / 48), size: xp(2.2) }, add: { pen: 1 } }, 'The ship-killer double tap: two huge, slow cannonballs you can dodge, then a long wait.'],
  ['autocannon_rattler', 'Rattler', 'autocannon', 'sq', 3, {}, { set: { damage: 11, speed: 62, life: 87 } }, 'The steady hose: a stream of yellow shells, four a second, at a fixed rhythm.'],
  // (The Chainsaw's draw is its demand x 4 / its beat: 22.4 keeps its spun-up 22.4 E a second per cell at the 8-tick beat, as 10.5 did at 3.75)
  ['autocannon_chainsaw', 'Chainsaw', 'autocannon', 'rect2', 14, { int: 0.55, demand: 22.4 }, { mul: { spread: x(1.5) }, set: { damage: 11 } }, 'The minigun: it spins up from two and a half shots a second to seven and a half while you hold the trigger, and is useless on a tap.'],
  ['autocannon_stinger', 'Stinger', 'autocannon', 'sq', 24, { dmg: 1.5, int: 1.25 }, { mul: { spread: x(0.4) }, set: { damage: 12, speed: 88, life: 61 } }, 'The marksman SMG: six fast, accurate needles in a burst, then a pause to reload.'],
  ['flak_burst', 'Burst', 'flak', 'sq', 4, {}, {}, 'The sky-filler: a canister shell that bursts where you aim, or sooner when it passes near a target, throwing fragments over 170 units.'],
  ['flak_cloudmaker', 'Cloudmaker', 'flak', 'rect2', 16, { dmg: 1.7, int: 1.4 }, { mul: { splashRadius: x(250 / 170), splashDamage: x(26 / 16) } }, 'The wall you place: four shells that burst where you aim, or sooner when they pass near a target, throwing fragments over 250 units.'],
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
  // E/s spread over its cells; a pulse gun's, its E a burst x 60 / interval. Heavier shots 2026-11: the Strobe 2 bolts of 14 at 84, the
  // Overpulse a clip of 6 at 10 t, 13 dmg at 96; their demand, and so their draw, stays.)
  ['laser_glint', 'Glint', 'laser', 'sq', 9, {}, {}, 'The long pulse: it charges for 1.8 s, then a 1.4 s pulse peaking at 96 damage reaches 5,100 units. Time it; 27 E a pulse.'],
  ['laser_cutter', 'Cutter', 'laser', 'rect2', 18, { demand: r2(32 / PIECE_AREA.rect2) }, { set: { dps: 60, range: 900, width: 14, pulse: null, falloff: null, ramp: { to: 150, ticks: 90 } } }, 'The welding torch: a short held beam that burns deeper the longer it stays on one part, 60 rising to 150 damage a second over 1.5 s (it starts over if it slips off). 32 E a second.'],
  ['laser_searchlight', 'Searchlight', 'laser', 'round', 26, { demand: r2(15 / PIECE_AREA.round) }, { set: { dps: 25, range: 7650, width: 8, pulse: null, falloff: null } }, 'The spotter: a thin beam that reaches furthest and barely hurts, but what it lights takes 20% more damage from everyone for 2 s after. 15 E a second.'],
  ['pulse_strobe', 'Strobe', 'pulse', 'sq', 10, { demand: r2((6 * 60) / 30) }, { set: { burst: 2, damage: 14, speed: 84, life: 60 } }, 'Steady shield pressure: a burst of 2 bolts every half second, 14 damage each, 1.6 times against shields and 0.6 against hull. 6 E a burst.'],
  ['pulse_overpulse', 'Overpulse', 'pulse', 'rect2', 25, { demand: r2((36 * 60) / (90 + 12 * 6) / PIECE_AREA.rect2) }, { set: { burst: 1, vsShield: 1.9, vsHull: 0.5, damage: 13, speed: 96, life: 53 } }, 'The shield shredder: a clip of 6 fast bolts at 6 a second, 13 damage each, then a 1 s reload drawing 36 E. 1.9 times against shields and half against hull.'],
  ['missile_dart', 'Dart', 'missile', 'sq', 11, { blurb: 'Lock and forget' }, {}, 'Lock and forget: a missile every couple of seconds that homes on the ship nearest your cursor, 30 damage and a 120 blast. Twenty-four missiles a crate. Point defence kills it in one hit.'],
  ['missile_swarm', 'Swarm', 'missile', 'rect2', 21, { dmg: 0.5, burst: 2, int: 0.41, blurb: 'The ripple that floods point defence' }, { mul: { homing: x(1.3) }, set: { damage: 10, splash: { radius: 60, damage: 12 } } }, 'The ripple that floods point defence: a pair of small rockets every three-quarters of a second, steady for as long as you hold, spreading and then converging on the ship nearest your cursor. Each is 10 damage and a 60 blast and dies to one point-defence hit. One round a pair.'],
  ['missile_hammerhead', 'Hammerhead', 'missile', 'block2', 33, { dmg: 3.5, int: 1.8, hp: 1.2, mass: 1.4, blurb: 'The steered warhead' }, { mul: { damage: xp(3.5), speed: x(0.7), maxSpeed: x(0.7), size: x(1.5) }, set: { splash: { radius: 150, damage: 54 }, intercept: 2 } }, 'The steered warhead: a slow, heavy missile, 105 damage and a 150 blast. While you hold fire it flies toward your cursor; let go and it flies straight. Point defence needs two hits.'],
  // (Railguns, rework section 4: the Needle's slug 62 dmg, pierce 2, speed 150, 75 ticks; the Coilgun five slugs of 16 in a 12 degree cone, pierce 1,
  // life 18 (2,700 reach), 54 ticks, 14 E a shot; the Spear 160 dmg through three hulls at full damage, 114 ticks, 120 E. The energy a cycle gun
  // draws is its draw x its interval, so RAIL_E sets each demand to give 14 E and 120 E a shot)
  ['railgun_needle', 'Needle', 'railgun', 'rect2', 13, {}, {}, 'The cheap rail: a long thin slug that goes through two ships. It fires slugs from the hold and needs no power.'],
  ['railgun_coilgun', 'Coilgun', 'railgun', 'rect2', 22, { dmg: 0.7, int: 0.72, draw: 1.8 }, { set: { ammo: null, damage: 25, burst: 3, spread: 3, jitter: 0, life: 18, pierce: 1 } }, 'The rail shotgun: three heavy slugs in a tight cone, a finisher for close range that is spent past 2,700. It throws its own slugs for 14 E a shot, so it needs no ammo.'],
  ['railgun_spear', 'Spear', 'railgun', 'block2', 28, { dmg: 2.6, int: 1.52, draw: 2.2, hp: 1.2 }, { set: { damage: 160, pierce: 3, pierceKeep: 1 } }, 'The capital rail: one slug every couple of seconds that goes through three ships at full damage, a ring of shock at each. It costs 120 E a shot and needs no ammo.'],
  ['emp_hush', 'Hush', 'emp', 'sq', 15, { blurb: 'Switch one ship off' }, {}, 'Switches one ship off: an orb that bursts on its fuse or beside a ship, and 2 s of dead engines and guns.'],
  ['emp_blackout', 'Blackout', 'emp', 'block2', 35, { int: 1.5, dmg: 1.6, blurb: 'The charged area blackout' }, { set: { emp: { radius: 320, ticks: 168 } }, mul: { size: x(1.4) } }, 'Hold to charge, then it fires itself: an orb that bursts where you aimed, or beside a ship, for a wide 2.8 s blackout.'],
  // (A long blue bolt: six times the arc's life at its speed, out to about 4,000; Kieran 2026-11-03)
  ['arc_spark', 'Spark', 'arc', 'sq', 17, { blurb: 'The chain zap' }, { mul: { life: 5, damage: x(0.85) } }, 'A fast blue bolt that flies out to 4,000 and leaps to 3 more ships near what it hits, weaker each hop.'],
  ['arc_tesla', 'Tesla', 'arc', 'round', 29, { dmg: 1.4, blurb: 'The held storm' }, { set: { chain: { count: 5, radius: 300, falloff: 0.5 } } }, 'Hold to keep zapping, five times a second: each zap leaps to 5 more ships nearby, weaker each hop.'],
  ['torpedo_eel', 'Eel', 'torpedo', 'rect2', 19, { blurb: 'The stalker' }, { set: { homing: 0.02 } }, 'The stalker: a slow, fat torpedo that creeps after its prey, 420 damage straight through shields and a 90 blast. Six torpedoes a crate, one every four seconds. Point defence needs three hits.'],
  // (The Leviathan flies at its launch speed all its life: nothing accelerates a shell that doesn't home or steer (server Weapons.tick), so its
  // maxSpeed is its speed, and its reach (what the hangar shows) 10 x 343)
  ['torpedo_leviathan', 'Leviathan', 'torpedo', 'block2', 38, { dmg: 2.4, hp: 1.2, mass: 1.3, blurb: 'The fight-ender' }, { mul: { size: x(1.4) }, set: { damage: 560, speed: 10, maxSpeed: 10, life: 343, splash: { radius: 160, damage: 120 }, intercept: 5, arm: 30 } }, 'The fight-ender: a huge torpedo, 560 damage straight through shields and a 120 blast, one every three seconds. It flies straight at a steady pace and does not home, and arms half a second after launch. One round a shot. Point defence needs five hits.'],
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

// Engines: [id, name, family, piece, level, thrust, draw, rated, boost, boostDrain, intake, buffer, material, description]
// (intake, buffer: energy routing, docs/design/energy-routing-impl.md §5.3: E a second each cell refills its own buffer at,
// and the E each cell holds. Burn stays `draw`, and boosting burns draw x (1 + boostDraw x boostDrain))
// (The spec's table, but the Ion Drive pushes 2.26, as the thruster it replaces did: the starter flies as it always has)
const E = [
  ['engine_ion_drive', 'Ion Drive', 'ion', 'sq', 0, 2.26, 9, 34, 2.0, 1.0, 12, 30, 'alloy', 'Efficient and steady, with a low top speed.'],
  ['engine_vernier', 'Vernier', 'ion', 'tri', 2, 1.2, 4, 40, 1, 0, 4, 8, 'alloy', 'A cheap little thruster for corner push. It has no boost: boosting gives it no extra thrust and no extra drain.'],
  ['engine_afterburner', 'Afterburner', 'afterburner', 'sq', 5, 1.6, 8, 50, 3.6, 3.0, 10, 60, 'alloy', 'Weak at cruise, a huge burst when boosting. Best with a Drive Cell touching it.'],
  ['engine_torch', 'Torch', 'afterburner', 'rect2', 8, 4.0, 34, 70, 1, 0, 30, 40, 'alloy', 'Brutal thrust at full power all the time, and a brutal drain. It has no boost: nothing is held back to give.'],
  ['engine_plasma_drive', 'Plasma Drive', 'plasma', 'rect2', 16, 3.1, 20, 55, 1.8, 0.8, 25, 60, 'steel', 'The balanced main engine.'],
  ['engine_drift_sail', 'Drift Sail', 'ion', 'round', 22, 0.9, 3, 26, 1.3, 0.5, 3, 6, 'titanium', 'Near-free cruising, never in a hurry.'],
  ['engine_fusion_torch', 'Fusion Torch', 'plasma', 'block2', 30, 3.6, 28, 85, 1.7, 0.4, 32.5, 100, 'cobalt', 'The long-haul racer: fast, and faster still.'],
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
for (const [id, name, family, piece, level, thrust, draw, rated, boost, boostDrain, intake, buffer, material, description] of E) {
  const lf = FNS.get(KIND_BASE[family]);
  const blast = BLAST[KIND_BASE[family]];
  models.push({
    ...base(id, name, family, [piece], level, material, {}),
    hpScale: lf.hpScale, demand: draw, priority: 1, thrust, rated, boost, boostDrain, intake, buffer, ...(blast ? { blast } : {}),
    rarity: level >= 20 ? 'rare' : level >= 5 ? 'uncommon' : 'common', description, category: 'engines', fabOrder: next('engines'),
    ...legacyLook(KIND_BASE[family]), guide: { name, blurb: description.replace(/\.$/, ''), ...(piece !== 'sq' ? { piece } : {}), order: guideOrder++ },
  });
}

// Power, utility, shields and plating: [id, name, family, piece(s), level, material, fields, description, category]
// (A store's `intake`: energy routing's Takes, the most E a second each cell accepts (docs/design/energy-routing-impl.md §5.2);
// `store` and `discharge` are its Holds and Gives. The new store and discharge numbers there land with the switch-over, P2)
const OTHER = [
  ['power_cell_reactor', 'Cell Reactor', 'reactor', ['sq'], 0, 'alloy', { produce: 35, hpScale: 0.8, blast: BLAST.generator }, 'The starter generator. It explodes when destroyed.', 'power'],
  ['power_isotope_pile', 'Isotope Pile', 'reactor', ['round'], 9, 'steel', { produce: 18, hpScale: 1.6 }, 'A weak generator, but tough, and it never explodes.', 'power'],
  ['power_fusion_plant', 'Fusion Plant', 'reactor', ['block2'], 18, 'steel', { produce: 48, hpScale: 0.9, massScale: 2, blast: { radius: 3, damage: 70, delayTicks: [4, 16] } }, 'A heavy plant with plenty of power, and a big blast.', 'power'],
  ['power_overclock_reactor', 'Overclock Reactor', 'reactor', ['rect2'], 24, 'titanium', { produce: 62, hpScale: 0.4, blast: { radius: 3.6, damage: 95, delayTicks: [3, 12] } }, 'The most power for its size: fragile, and the biggest blast.', 'power'],
  ['power_battery', 'Battery', 'battery', ['sq'], 0, 'alloy', { store: 200, discharge: 600, intake: 50, hpScale: 0.6 }, 'A store for power: holds 200 and gives it out quickly.', 'power'],
  ['power_capacitor', 'Capacitor', 'capacitor', ['sq'], 7, 'composite', { store: 160, discharge: 2000, intake: 40, hpScale: 0.6 }, 'A small store that gives its power out in a rush: holds 160, for guns and beams that want a burst.', 'power'],
  ['power_drive_cell', 'Drive Cell', 'drive_cell', ['sq'], 10, 'steel', { store: 320, discharge: 1400, intake: 80, hpScale: 0.6 }, 'A bigger store for the engines and Burst Strafers: holds 320 and gives it out steadily.', 'power'],
  ['power_heavy_bank', 'Heavy Bank', 'battery', ['block2'], 20, 'titanium', { store: 450, discharge: 150, intake: 150, hpScale: 0.7, massScale: 1.6 }, 'A deep, heavy store: holds a lot, but gives it out slowly.', 'power'],
  ['utility_mining_laser', 'Mining Laser', 'mining', ['sq'], 0, 'alloy', { demand: 30, priority: 2, facing: true, mining: true, minePulse: 0.9, hpScale: 0.7 }, 'A pulsed cutter that takes ore from rock, and a poor weapon.', 'utility'],
  ['utility_bore', 'Bore', 'mining', ['rect2'], 10, 'steel', { demand: 20, priority: 2, facing: true, mining: true, minePulse: 1.2, hpScale: 0.8 }, 'A heavy cutter that breaks harder rock than a mining laser.', 'utility'],
  ['utility_demolition_launcher', 'Demolition Launcher', 'demolition', ['sq'], 8, 'alloy', { weapon: 'charge', demand: 8, priority: 2, fireInterval: 120, hpScale: 0.8, weaponMods: {} }, 'Fires mining charges (30 a crate, one every 2 seconds) that stick to rock, blink for a second, then blow it open. Harmless to ships.', 'utility'],
  ['utility_siphon', 'Siphon', 'siphon', ['sq'], 12, 'steel', { demand: 10, priority: 2, facing: true, siphon: true, hpScale: 0.7 }, 'Drinks gas from gas pockets and sends it back to the ship.', 'utility'],
  ['utility_scanner', 'Scanner', 'scanner', ['sq'], 5, 'alloy', { demand: 4, priority: 3, range: 2400, hpScale: 0.6 }, 'A quick short sweep that reads rocks and finds seams.', 'utility'],
  ['utility_long_range_array', 'Long-Range Array', 'scanner', ['round2'], 20, 'titanium', { demand: r2(8 / PIECE_AREA.round2), priority: 3, range: 4800, hpScale: 0.6 }, 'A slow sweep that reaches twice as far as a scanner.', 'utility'],
  // (Level 2, Kieran 2026-10-30: the lane-clearance job, offered at 2, has you build one, and nothing opens early now; still a Mk III titanium rig)
  ['utility_constructor', 'Constructor', 'constructor', ['sq'], 2, 'titanium', { demand: 4, priority: 3, hpScale: 0.6, grade: 3 }, 'Builds structures piece by piece.', 'utility'],
  ['shield_deflector', 'Deflector', 'shield', ['sq'], 11, 'steel', { shield: 40, shieldRegen: 8, shieldDelay: 180, demand: 16, priority: 2, hpScale: 0.6 }, 'The standard shield, which soaks damage before the hull and refills 8 a second per cell after 3 seconds unhit.', 'shields'],
  ['shield_flicker_screen', 'Flicker Screen', 'shield', ['round'], 19, 'steel', { shield: 20, shieldRegen: 20, shieldDelay: 60, demand: r2(16 * 0.4), priority: 2, hpScale: 0.6 }, 'A thin, cheap shield that refills 20 a second per cell after only 1 second unhit.', 'shields'],
  ['shield_bulwark_projector', 'Bulwark Projector', 'shield', ['block2'], 27, 'titanium', { shield: 60, shieldRegen: 5, shieldDelay: 240, demand: r2(16 * 1.2), priority: 2, hpScale: 0.7 }, 'A deep shield that soaks an alpha strike but refills only 5 a second per cell after 4 seconds unhit.', 'shields'],
  ['utility_jump_coil', 'Jump Coil', 'jumpcoil', ['sq'], 14, 'steel', { jumpCapacity: 12, demand: 8, priority: 3, hpScale: 0.8 }, 'More jump drive for a bigger hull.', 'engines'],
  ['utility_heavy_coil', 'Heavy Coil', 'jumpcoil', ['block2'], 30, 'cobalt', { jumpCapacity: 16, jumpCooldown: 0.8, demand: 8, priority: 3, hpScale: 0.8 }, 'A dense coil with more jump drive per cell that also cuts the jump cooldown by a fifth.', 'engines'],
  ['plating_reactive_armour', 'Reactive Armour', 'plating', ['sq', 'rect2'], 12, 'steel', { armour: 2, hpScale: 2, massScale: 1.6 }, 'Plate that blunts small fast hits, so it beats streams of fire.', 'shields'],
  ['plating_spaced_plating', 'Spaced Plating', 'plating', ['sq', 'rect2'], 22, 'titanium', { grade: 2, armour: 1, splashTaken: 0.5, hpScale: 3.2, massScale: 1.3 }, 'Layered plate with room between that takes half damage from blasts.', 'shields'],
];
const LOOK = {
  reactor: 'generator', battery: 'battery', capacitor: 'weapon_battery', drive_cell: 'drive_battery', mining: 'miner', demolition: 'charge_launcher',
  siphon: 'siphon', scanner: 'scanner', constructor: 'constructor', shield: 'shield', jumpcoil: 'jumpcoil', plating: 'armor',
};
/** Families with no legacy function: their own look (client/src/ships/partDecor.ts DECOR_SHAPES) */
/** Reactors and the Capacitor each read differently in stills and icons (their animated looks live in PartFx) */
const POWER_COLOR = { power_cell_reactor: '#38bdf8', power_isotope_pile: '#6fbf4a', power_fusion_plant: '#f5e3a0', power_overclock_reactor: '#e0452f', power_capacitor: '#f5a83a' };
const OWN_LOOK = { constructor: { color: '#f5b942', decor: 'none' } };
for (const [id, name, family, pieces, level, material, fields, description, category] of OTHER) {
  const look = OWN_LOOK[family] ?? legacyLook(LOOK[family]);
  models.push({
    ...base(id, name, family, pieces, level, material, { grade: fields.grade }), ...fields, ...(fields.weapon ? mounted(id, description) : { description }),
    rarity: level >= 20 ? 'rare' : level >= 5 ? 'uncommon' : 'common', category, fabOrder: next(category), ...look,
    ...(family === 'plating' ? { color: level > 15 ? '#7d8796' : '#857462' } : {}),
    ...(POWER_COLOR[id] ? { color: POWER_COLOR[id] } : {}),
    guide: { name, blurb: description.split(/[.:]/)[0], ...(pieces[0] !== 'sq' ? { piece: pieces[0] } : {}), order: guideOrder++ },
  });
}
// ---- The Pulse Dynamo, the Flash Screen and the Rail Driver (docs/design/rework-2026-11.md §2.6) ----------
// The Pulse Dynamo is a stub on the ports core: no ports, so it makes and moves no power (its `dynamo` figure is read only by
// the shipgen tool's layout); the Flash Screen's return is its own feature (features/flash) and the Rail Driver a plain heavy rail (their own behaviour comes later in the rework). Appended
// last, so no other model's order moves.
{
  const DYNAMO_LOOK = { color: '#6d3fb3', decor: 'battery', glow: '#b57cff' };
  const LATE_OTHER = [
    ['power_pulse_dynamo', 'Pulse Dynamo', 'dynamo', ['sq'], 18, 'titanium', { dynamo: 10, hpScale: 0.6 }, 'An old charger the ports core no longer uses: it has no ports and makes and moves no power.', 'power', DYNAMO_LOOK],
    // (The Flash Screen's own store holds flashCost E a point: full, it buys the return at once; it refills over its in port. features/flash)
    ['shield_flash_screen', 'Flash Screen', 'shield', ['sq'], 13, 'steel', { shield: 36, shieldRegen: 0, shieldDelay: 0, flash: true, flashCost: 4, demand: 16, priority: 2, hpScale: 0.6 }, 'A shield with no slow refill. When it breaks, a full store of its own brings it straight back; otherwise it returns whole 4 seconds later. The store refills from its power line.', 'shields', legacyLook('shield')],
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
  // (The semi-automatic rifle, its own numbers: a clip of 4 at 12 ticks, 60 dmg, pierce 1, speed 150; reloading itself for 90 ticks draws 48 E.
  // Its demand is that reload's draw spread over the clip's cycle as it was (6 at 10 ticks: heavier-shots-2026-11 keeps
  // the legacy draw); the fire block below gives the rest.)
  const desc = 'The semi-automatic rifle: a clip of four heavy shots, one a click (as fast as you can click, up to five a second; a second Rail Driver takes alternate shots, skipping one that is reloading), then it reloads itself in a second and a half for 48 E. It needs no ammo.';
  models.push({
    ...base('railgun_rail_driver', 'Rail Driver', 'railgun', ['block2'], 29, 'titanium', { grade: 4 }),
    weapon: 'railgun', ...mounted('railgun_rail_driver', desc), hpScale: 0.96, demand: r2((48 * 60) / (90 + 6 * 10) / PIECE_AREA.block2), priority: 2, fireInterval: 10,
    weaponMods: { set: { ammo: null, damage: 60, pierce: 1, speed: 150, life: 60 } },
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
// batteries and generation back it). (Kieran 2026-10-31, after playtesting:
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
      { strafe: { kick: 14, ticks: 12, cooldown: 24 }, demand: 700, intake: 40, buffer: 140, priority: 1, facing: true, hpScale: 0.6 },
      'A dodge thruster: a hard fifth-of-a-second burst away from its nozzle, ready again in under half a second, and a lot of energy every time. Fit them facing different ways to dodge any way. No push at all for cruising.', 'engines'],
    ['utility_tow_beam', 'Tow Beam', 'tow', ['rect2'], 12, 'steel',
      { tow: true, demand: 12, priority: 2, facing: true, hpScale: 0.9, massScale: 1.2 },
      'Latches onto a wreck, debris or a loot pod and drags it on a tether to a station to salvage, and never takes hold of a working ship. It draws power only while towing, and pulls weaker short of it.', 'utility'],
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
// ---- Energy routing's relays: the Conduit and the Diode (docs/design/energy-routing-impl.md §1.1, §3.4, P4; §0 D1: no
// wires, power moves only between parts sharing a full cell edge). Plain store data, read by the power core
// (common/src/ships/power/portsBuild.ts): a relay holds `store`, gives `discharge` and takes `intake` E a second per cell.
// `relayOnly`: a pass-through. `oneWay`: a Diode, giving only out of its facing edge
// (that edge must touch a part: blueprint.ts partFacingRule 'joined'), taking from every other. Until the switch-over
// Appended last, so no other model's order moves.
{
  const RELAY_LOOK = {
    power_conduit: { color: '#b0711f', decor: 'none' },
    power_diode: { color: '#d9a03a', decor: 'none' },
  };
  const RELAYS = [
    ['power_conduit', 'Conduit', 'relay', ['sq'], 0, 'alloy', { store: 10, discharge: 200, intake: 200, relayOnly: true, hpScale: 0.5 },
      'A power line: it passes power between the parts it touches, up to 200 a second, and holds only 10 itself.', 'power'],
    ['power_diode', 'Diode', 'relay', ['sq'], 4, 'alloy', { store: 10, discharge: 200, intake: 200, oneWay: true, hpScale: 0.5 },
      'A one-way power line: power only flows out of its front, into the part there, up to 200 a second; the other parts touching it can only feed it. Its front must touch a part.', 'power'],
  ];
  for (const [id, name, family, pieces, level, material, fields, description, category] of RELAYS) {
    models.push({
      ...base(id, name, family, pieces, level, material, { grade: fields.grade }), ...fields, description,
      rarity: level >= 20 ? 'rare' : level >= 5 ? 'uncommon' : 'common', category, fabOrder: next(category), ...RELAY_LOOK[id],
      guide: { name, blurb: description.split(/[.:]/)[0], ...(pieces[0] !== 'sq' ? { piece: pieces[0] } : {}), order: guideOrder++ },
    });
  }
}
// ---- (end Conduit and Diode)
// ---- The Gyro and the Heavy Gyro (common/src/ships/features/gyro): reaction wheels. `gyro` is turning torque per cell,
// added to the ship's turning both ways wherever the part sits, with no push of its own. A gyro draws `demand` per cell a
// second only while the ship turns flat out (less turning gently, none holding a heading), as an engine does `intake`/`buffer` are its numbers for the routing core (a thruster that is active while
// turning). Heavy (`massScale`): the price is a little thrust. Sized so 2-4 Heavy Gyros swing a capital ship onto a new
// heading 30-50% sooner, and a Gyro on a small ship helps a little. Appended last, so no other model's order moves.
{
  const GYRO_LOOK = { color: '#7f9cb8', decor: 'none', glow: '#7dd3fc' };
  const GYROS = [
    ['utility_gyro', 'Gyro', 'gyro', ['sq'], 6, 'alloy', { gyro: 250, demand: 6, intake: 6, buffer: 6, priority: 1, massScale: 1.5, hpScale: 0.8 },
      'A reaction wheel: it adds turning force anywhere on the hull, with no push of its own, and draws power only while turning. Heavier than plain hull.', 'engines'],
    ['utility_heavy_gyro', 'Heavy Gyro', 'gyro', ['block2'], 20, 'titanium', { gyro: 7000, demand: 12, intake: 10, buffer: 24, priority: 1, massScale: 2, hpScale: 0.9 },
      'A big reaction wheel for big ships: it adds a lot of turning force anywhere on the hull, with no push of its own, and draws power only while turning. Heavy.', 'engines'],
  ];
  for (const [id, name, family, pieces, level, material, fields, description, category] of GYROS) {
    models.push({
      ...base(id, name, family, pieces, level, material, { grade: fields.grade }), ...fields, description,
      rarity: level >= 20 ? 'rare' : level >= 5 ? 'uncommon' : 'common', category, fabOrder: next(category), ...GYRO_LOOK,
      guide: { name, blurb: description.split(/[.:]/)[0], ...(pieces[0] !== 'sq' ? { piece: pieces[0] } : {}), order: guideOrder++ },
    });
  }
}
// ---- (end Gyro and Heavy Gyro)
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
    // (Heavier shots, docs/design/heavier-shots-2026-11.md: fewer, heavier rounds; the Pip 15 -> 20 t, the Hammer 42 -> 60 t, the
    // Twinlink 16 @ 6 t -> 8 @ 10 t, the Rattler 7 -> 15 t, the Chainsaw's spin 15 -> 3.75 t -> 24 -> 8 t, the Stinger 12 @ 7.5 t -> 6 @ 12 t,
    // the Overpulse 12 @ 6 t -> 6 @ 10 t, the Rail Driver 6 @ 10 t -> 4 @ 12 t. A cycle gun's demand stays: its draw a second is unchanged)
    cannon_pip: { model: 'cycle', interval: 20 },
    cannon_hammer: { model: 'cycle', interval: 60 },
    cannon_twinlink: { model: 'clip', interval: 10, clip: 8, reload: 80, reloadE: 24 },
    cannon_longbarrel: { model: 'charge', charge: 120, cooldown: 90, chargeE: 36 },
    cannon_bastion: { model: 'clip', interval: 18, clip: 2, reload: 180, reloadE: 60 },
    autocannon_rattler: { model: 'cycle', interval: 15 },
    autocannon_chainsaw: { model: 'cycle', spin: { from: 24, to: 8, up: 60, down: 30 } },
    autocannon_stinger: { model: 'clip', interval: 12, clip: 6, reload: 60, reloadE: 20 },
    flak_burst: { model: 'ammo' },
    flak_cloudmaker: { model: 'clip', interval: 30, clip: 4, reload: 150, reloadE: 30 },
    mortar_lobber: { model: 'ammo' },
    mortar_quake: { model: 'ammo', rounds: 3, interval: 180 },
    laser_glint: { model: 'cycle' },
    laser_cutter: { model: 'beam' },
    laser_searchlight: { model: 'beam' },
    pulse_strobe: { model: 'cycle' },
    pulse_overpulse: { model: 'clip', interval: 10, clip: 6, reload: 60, reloadE: 36 },
    missile_dart: { model: 'ammo', interval: 108 },
    missile_swarm: { model: 'ammo', rounds: 1, interval: 45 },
    missile_hammerhead: { model: 'ammo' },
    railgun_needle: { model: 'ammo' },
    railgun_coilgun: { model: 'cycle', interval: 54 },
    railgun_spear: { model: 'cycle', interval: 114 },
    railgun_rail_driver: { model: 'clip', interval: 12, clip: 4, reload: 90, reloadE: 48, semi: true },
    emp_hush: { model: 'cycle', interval: 162 },
    emp_blackout: { model: 'charge', charge: 90, cooldown: 240, chargeE: 90 },
    arc_spark: { model: 'cycle', interval: 45 },
    arc_tesla: { model: 'beam' },
    torpedo_eel: { model: 'ammo' },
    torpedo_leviathan: { model: 'ammo', rounds: 1, interval: 180 },
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
    legendary_singularity: 'The black hole: 210 power a shot, one every 7 s. A slow orb flies to your cursor and stops there, pulls every ship within 900 toward it for 3.8 s, then collapses in a 300 blast for 140.',
  };
  // ---- Energy routing (docs/design/energy-routing-impl.md §1.4, §5.1, owner decision D3): each weapon's own buffer, filled at
  // `intake` E a second. Its `shot` (E) is derived so that at full supply the beat and damage are today's: a cycle, ammo or
  // auto gun's intake over its interval; a spin gun's over its fastest beat; a clip refills whole in today's `reload` (the
  // Hive in its eight regrows); a charge gun's over charge + cooldown. `buffer` is in shots (a clip's: its clip). A beam
  // burns `burn` E a second from a buffer of `bufferE`, refilled at `intake`, and relights at half of it (a weapon fire.relight overrides).
  // Read by the power core; `demand` is the draw the hangar and the ratings quote.
  const ENERGY = {
    cannon_pip: { intake: 20 }, autocannon_rattler: { intake: 28 }, flak_burst: { intake: 10 }, cannon_hammer: { intake: 30 },
    mortar_lobber: { intake: 6 }, laser_glint: { intake: 35 }, pulse_strobe: { intake: 50 }, legendary_prism: { intake: 60 },
    point_defence_turret: { intake: 25 }, missile_dart: { intake: 8 }, cannon_twinlink: { intake: 55 }, legendary_hive: { intake: 60 },
    legendary_frostbite: { beam: { burn: 90, intake: 90, bufferE: 270 } }, railgun_needle: { intake: 30 },
    autocannon_chainsaw: { intake: 80, buffer: 10 }, emp_hush: { intake: 40 }, flak_cloudmaker: { intake: 35 }, arc_spark: { intake: 70 },
    laser_cutter: { beam: { burn: 90, intake: 40, bufferE: 180 } }, torpedo_eel: { intake: 10 }, cannon_longbarrel: { intake: 110 },
    missile_swarm: { intake: 12 }, railgun_coilgun: { intake: 70 }, legendary_cinder_bloom: { intake: 130 }, autocannon_stinger: { intake: 120 },
    mortar_quake: { intake: 12 }, pulse_overpulse: { intake: 130 }, laser_searchlight: { beam: { burn: 140, intake: 140, bufferE: 280 } },
    legendary_phase: { intake: 140 }, railgun_spear: { intake: 90, buffer: 2 }, arc_tesla: { beam: { burn: 170, intake: 170, bufferE: 300 } },
    railgun_rail_driver: { intake: 80 }, cannon_bastion: { intake: 220 }, legendary_singularity: { intake: 240 },
    lance_lance: { beam: { burn: 300, intake: 300, bufferE: 600 } }, missile_hammerhead: { intake: 12 }, emp_blackout: { intake: 120 },
    torpedo_leviathan: { intake: 15 },
  };
  // (The utility guns keep today's draw: the Repair Beam burns and refills at its demand x area with 2 s of it held; the Demolition Launcher takes its demand x area)
  for (const id of ['utility_repair_beam', 'utility_demolition_launcher']) {
    const m = models.find((x) => x.id === id);
    const e = m.demand * PIECE_AREA[m.pieces[0]];
    ENERGY[id] = m.fire.model === 'beam' ? { beam: { burn: e, intake: e, bufferE: 2 * e } } : { intake: e };
  }
  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  for (const m of models) {
    if (!m.weapon) continue;
    const e = ENERGY[m.id], f = m.fire;
    if (!e) throw new Error(`no energy for weapon ${m.id}`);
    if (f.model === 'beam') {
      if (!e.beam) throw new Error(`${m.id}: a beam's energy is { beam: { burn, intake, bufferE } }`);
      Object.assign(f, e.beam);
      continue;
    }
    if (e.beam) throw new Error(`${m.id}: only a beam burns`);
    const ticks = f.model === 'clip' ? (f.regrow ? f.regrow * f.clip : f.reload) / f.clip
      : f.model === 'charge' ? f.charge + f.cooldown
      : f.spin ? f.spin.to : f.interval;
    if (!(ticks > 0)) throw new Error(`${m.id}: no beat to derive its shot from`);
    Object.assign(f, { shot: r5((e.intake * ticks) / 60), intake: e.intake, buffer: f.model === 'clip' ? f.clip : e.buffer ?? 1 });
  }
  for (const id of Object.keys(ENERGY)) if (!models.some((m) => m.id === id && m.weapon)) throw new Error(`energy for ${id}, which isn't a weapon model`);
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
    flak_burst: { endAtAim: true },
    flak_cloudmaker: { endAtAim: true },
    legendary_prism: { endAtAim: true },
    emp_blackout: { endAtAim: true },
    mortar_quake: { walk: { at: [0.7, 1, 1.3], gap: 15 } },
    missile_hammerhead: { guided: { turn: 0.05 } },
    missile_swarm: { salvo: { count: 2, gap: 5 } },
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

// ---------------------------------------------------------------------------
// Components (docs §2) and recipes
// ---------------------------------------------------------------------------

// ---- The ports energy core (common/src/ships/power/ports.ts; docs/design/energy-ports-2026-11.md): every part's ports, the
// weapons' power profiles, the feed layer's parts, and which guns and engines take which material (tuning.json feeds).
// Read by every ship. A port is in the
// part's own frame (a gun's or engine's: N its facing, S its back), `rate` E a second. Generators give out of their
// front, one port a cell; stores take at the back and give at the front; guns, engines, shields and tools take at the
// back, their rate a little over what they draw (a beam's its burn). Appended last, so no other model's order moves.
{
  const ports = (dir, side, cells, rate) => cells.map((cell) => ({ dir, side, cell, rate }));
  const io = (inRate, outRate, inCells = [0], outCells = [0]) => [...ports('in', 'S', inCells, inRate), ...ports('out', 'N', outCells, outRate)];
  // Fixed ports: the generators (a cell's worth each) and the stores (In at the back, Out at the front: Out over In, so a
  // charged store pours; a Heavy Bank joins two lines into one)
  const PORTS = {
    // (A round piece's straight edges are its W and S: the Isotope Pile gives out of its W)
    power_cell_reactor: ports('out', 'N', [0], 35), power_isotope_pile: ports('out', 'W', [0], 18),
    power_fusion_plant: ports('out', 'N', [0, 1], 100), power_overclock_reactor: ports('out', 'N', [0, 1], 70),
    power_battery: io(40, 60), power_capacitor: io(40, 400), power_drive_cell: io(60, 250), power_heavy_bank: io(70, 150, [0, 1], [0]),
    power_conduit: io(200, 200), power_diode: io(200, 200),
  };
  // (Beams in pieces, Kieran 2026-11-04: `pieces` equal shares of the buffer, each a fixed pulse of its share of the burn time;
  // `rest` is the cooldown after a pulse or a chain of them; `spike` of a pulse's damage moves into a peak `spikeWidth` of it
  // wide at its centre, the same damage a pulse. power/ports.ts portsBeamStep)
  const PULSE = (pieces, rest, spike = 0.35, spikeWidth = 0.2) => ({ pieces, rest, spike, spikeWidth });
  // Profiles and feeds (section 9, 10): what shapes a gun's draw, and the materials a gun or engine takes (about a third of the
  // mid guns, half of the high ones; none of the starters)
  const PROFILE = {
    cannon_longbarrel: { profile: { discharge: 1 }, takes: ['overcharge', 'coolant', 'flux'] },
    cannon_bastion: { takes: ['overcharge', 'accelerant'] },
    autocannon_chainsaw: { takes: ['coolant', 'flux'] },
    pulse_overpulse: { takes: ['coolant', 'accelerant'] },
    laser_cutter: { profile: { burst: true, ...PULSE(3, 0.5) }, takes: ['lens', 'coolant'] },
    laser_searchlight: { profile: PULSE(4, 0.3, 0.25), takes: ['lens'] },
    railgun_spear: { profile: { steady: 30, passive: 5 }, takes: ['damping', 'overcharge'] },
    railgun_rail_driver: { takes: ['accelerant', 'coolant'] },
    lance_lance: { profile: { burst: true, passive: 20, ...PULSE(2, 1, 0.4, 0.15) }, takes: ['lens', 'coolant'] },
    legendary_singularity: { profile: { passive: 30, discharge: 1.5 }, takes: ['overcharge', 'coolant', 'damping'] },
    engine_plasma_drive: { takes: ['catalyst', 'reaction'] },
    engine_fusion_torch: { takes: ['catalyst', 'burstgel'] },
  };
  const backCells = (piece) => (PIECE_AREA[piece] >= 2 ? [0, 1] : [0]);
  for (const m of models) {
    if (PORTS[m.id]) m.ports = PORTS[m.id];
    else if (m.weapon || m.thrust || m.shield || m.gyro || m.jumpCapacity || m.mining || m.siphon || m.range || m.strafe || m.tow) {
      // (Consumers: In at the back, a little over the draw, split over the back cells; an engine's its own intake)
      const side = m.mounting?.angle === 'right', cells = side ? [0] : backCells(m.pieces[0]), area = PIECE_AREA[m.pieces[0]];
      // (An engine's in ports carry its boosted burn (power/ports.ts: a thruster takes all its lines bring), so a store or a
      // strong line in front of it keeps a boost going; its intake if that's more)
      const boosted = (m.boost ?? 1) > 1 ? (m.demand ?? 0) * (1 + 2.2 * (m.boostDrain ?? 0)) : 0;
      const draw = m.thrust ? Math.max((m.intake ?? m.demand) ?? 0, m.demand ?? 0, boosted) * area : (m.demand ?? 0) * area * 1.5;
      // (A side mount (mounting angle 'right': it fires at right angles to the edge it bolts on, the W in its own frame) takes there)
      if (draw > 0) m.ports = ports('in', side ? 'W' : 'S', cells, Math.max(4, Math.ceil(draw / cells.length)));
    }
    if (PROFILE[m.id]) Object.assign(m, PROFILE[m.id]);
  }
  // The feed layer's parts and the power parts the ports meta wants: [id, name, family, pieces, level, material, fields, description, category, look]
  const FEED_LOOK = { color: '#5b7a8c', decor: 'none' }, TANK_LOOK = (color) => ({ color, decor: 'battery', glow: color });
  const TANKS = [
    ['overcharge', 'Overcharge', 20, '#f97316', 'Harder hits and half the discharge, for 40% more power a shot'],
    ['coolant', 'Coolant', 18, '#38bdf8', 'Half the discharge and rest, 15% softer hits'],
    ['damping', 'Damping Gel', 22, '#a78bfa', 'A heavy gun needs half the floor, a quarter slower'],
    ['flux', 'Flux Salts', 18, '#facc15', '30% less power a shot, 15% softer hits'],
    ['accelerant', 'Accelerant', 24, '#f43f5e', '30% faster fire for a quarter more power a shot, and a higher floor'],
    ['lens', 'Lens Fluid', 20, '#2dd4bf', 'A beam burns a quarter less and hits a tenth softer, resting longer'],
    ['catalyst', 'Catalyst', 16, '#84cc16', 'An engine burns 40% less for 15% less thrust'],
    ['reaction', 'Reaction Mass', 18, '#e879f9', '40% more thrust for the same burn; a Reaction Thruster runs on it'],
    ['burstgel', 'Burst Gel', 22, '#fb7185', 'Boost half again as hard for half the extra burn'],
  ];
  const FEED_PARTS = [
    ['power_joiner_bank', 'Joiner Bank', 'battery', ['rect2'], 8, 'steel', { store: 150, discharge: 90, intake: 40, hpScale: 0.6, ports: [...ports('in', 'S', [0, 1], 40), ...ports('out', 'N', [0], 90)] },
      'A battery that joins two lines into one: it takes 40 a second at each of its two back ports and gives 90 out of its front left. Holds 300.', 'power', legacyLook('battery')],
    ['power_splitter_bank', 'Splitter Bank', 'battery', ['rect2'], 8, 'steel', { store: 150, discharge: 45, intake: 80, hpScale: 0.6, ports: [...ports('in', 'S', [0], 80), ...ports('out', 'N', [0, 1], 45)] },
      'A battery that splits one line into two: it takes 80 a second at its back left and gives 45 out of each front port. Holds 300.', 'power', legacyLook('battery')],
    ['power_joiner_elbow', 'Elbow Joiner Bank', 'battery', ['rect2'], 8, 'steel', { store: 150, discharge: 90, intake: 40, hpScale: 0.6, ports: [...ports('in', 'S', [0, 1], 40), ...ports('out', 'E', [0], 90)] },
      'A battery that joins two lines into one around a corner: it takes 40 a second at each of its two back ports and gives 90 out of its right end (flip it for the left). Holds 300.', 'power', legacyLook('battery')],
    ['power_joiner_end', 'End Joiner Bank', 'battery', ['rect2'], 8, 'steel', { store: 150, discharge: 90, intake: 40, hpScale: 0.6, ports: [...ports('in', 'W', [0], 40), ...ports('in', 'E', [0], 40), ...ports('out', 'N', [0], 90)] },
      'A battery that joins two lines from its two ends: it takes 40 a second at its left end and at its right end, and gives 90 out of its front left. Holds 300.', 'power', legacyLook('battery')],
    ['power_joiner_cross', 'Cross Joiner Bank', 'battery', ['rect2'], 8, 'steel', { store: 150, discharge: 90, intake: 40, hpScale: 0.6, ports: [...ports('in', 'S', [0], 40), ...ports('in', 'N', [0], 40), ...ports('out', 'E', [0], 90)] },
      'A battery that joins a line from its back and one from its front into one: it takes 40 a second at its back left and its front left, and gives 90 out of its right end. Holds 300.', 'power', legacyLook('battery')],
    ['power_splitter_elbow', 'Elbow Splitter Bank', 'battery', ['rect2'], 8, 'steel', { store: 150, discharge: 45, intake: 80, hpScale: 0.6, ports: [...ports('in', 'S', [0], 80), ...ports('out', 'N', [0], 45), ...ports('out', 'E', [0], 45)] },
      'A battery that splits one line in two, one straight on and one round a corner: it takes 80 a second at its back left and gives 45 out of its front left and 45 out of its right end. Holds 300.', 'power', legacyLook('battery')],
    ['power_splitter_tee', 'Tee Splitter Bank', 'battery', ['rect2'], 8, 'steel', { store: 150, discharge: 45, intake: 80, hpScale: 0.6, ports: [...ports('in', 'W', [0], 80), ...ports('out', 'N', [0], 45), ...ports('out', 'S', [0], 45)] },
      'A battery that splits a line from its end to its front and back: it takes 80 a second at its left end and gives 45 out of its front left and 45 out of its back left. Holds 300.', 'power', legacyLook('battery')],
    ['power_splitter_end', 'End Splitter Bank', 'battery', ['rect2'], 8, 'steel', { store: 150, discharge: 45, intake: 80, hpScale: 0.6, ports: [...ports('in', 'S', [0], 80), ...ports('out', 'W', [0], 45), ...ports('out', 'E', [0], 45)] },
      'A battery that splits one line out of its two ends: it takes 80 a second at its back left and gives 45 out of its left end and 45 out of its right end. Holds 300.', 'power', legacyLook('battery')],
    ['power_surge_cell', 'Surge Cell', 'capacitor', ['sq'], 14, 'composite', { store: 120, discharge: 300, intake: 120, hpScale: 0.5, ports: io(120, 300) },
      'A fast cell: it takes 120 a second and pours 300, so a gun that shuts its ports after a shot gets it all back the moment they open. Holds 120.', 'power', legacyLook('weapon_battery')],
    ['power_corner', 'Corner Conduit', 'relay', ['sq'], 2, 'alloy', { store: 10, discharge: 200, intake: 200, relayOnly: true, hpScale: 0.5, ports: [...ports('in', 'S', [0], 200), ...ports('out', 'E', [0], 200)] },
      'A power line that turns: in at the back, out to the right (flip it for the left), up to 200 a second.', 'power', { color: '#b0711f', decor: 'none' }],
    ['power_combiner', 'Combiner', 'relay', ['sq'], 12, 'steel', { store: 10, discharge: 150, intake: 150, relayOnly: true, combiner: true, hpScale: 1.2, ports: io(150, 150), feedPoints: [{ side: 'W' }] },
      'Joins a feed to a power line: a pipe at its left side brings a material, and the line out of its front carries it with the power, along conduits (a battery stops it) into a gun or engine that takes it. Tough.', 'power', { color: '#8c6b2a', decor: 'none', glow: '#f2c14e' }],
    ['power_passthrough', 'Passthrough', 'relay', ['sq'], 10, 'alloy', { store: 10, discharge: 200, intake: 200, relayOnly: true, pipeThrough: true, hpScale: 0.5, ports: io(200, 200), feedPoints: [{ side: 'W' }, { side: 'E' }] },
      'A power line with a pipe through it, side to side: the one way a feed crosses a line.', 'power', { color: '#b0711f', decor: 'none', glow: '#5b7a8c' }],
    ['feed_pipe', 'Feed Pipe', 'feed', ['sq'], 10, 'alloy', { pipe: true, feedPoints: [{ side: 'N' }, { side: 'E' }, { side: 'S' }, { side: 'W' }], hpScale: 0.5 },
      'A pipe: it joins tanks, Selectors, Combiners and guns with feed inputs on every side. It carries no power.', 'power', FEED_LOOK],
    ['feed_selector', 'Selector', 'feed', ['sq'], 16, 'steel', { selector: true, feedPoints: [{ side: 'W' }, { side: 'E' }, { side: 'N' }], hpScale: 0.6 },
      'Two feeds in (left and right), one out (front): the pilot switches which one passes (Y). What is already in the lines and buffers runs out first.', 'power', { ...FEED_LOOK, glow: '#f2c14e' }],
    ...TANKS.map(([feed, name, level, color, what]) =>
      [`feed_tank_${feed}`, `${name} Tank`, 'feed', ['sq'], level, 'steel', { tank: { feed, holds: 120 }, feedPoints: [{ side: 'N' }, { side: 'E' }, { side: 'S' }, { side: 'W' }], hpScale: 0.7 },
        `A tank of ${name}: ${what}. Holds 120; pipes join it on every side. It is refilled in the hangar.`, 'power', TANK_LOOK(color)]),
  ];
  for (const [id, name, family, pieces, level, material, fields, description, category, look] of FEED_PARTS) {
    models.push({
      ...base(id, name, family, pieces, level, material, { grade: fields.grade }), ...fields, description,
      rarity: level >= 20 ? 'rare' : level >= 5 ? 'uncommon' : 'common', category, fabOrder: next(category), ...look,
      guide: { name, blurb: description.split(/[.:]/)[0], ...(pieces[0] !== 'sq' ? { piece: pieces[0] } : {}), order: guideOrder++ },
    });
  }
  // The Reaction Thruster: an engine built for feed. On power alone a weak, cheap push; on Reaction Mass five times that
  // for the same 4 a second (two Ion Drives push 4.5 for 18), on Catalyst a quarter of the burn, on Burst Gel a hard boost
  models.push({
    ...base('engine_reaction_thruster', 'Reaction Thruster', 'ion', ['sq'], 15, 'steel', {}),
    hpScale: FNS.get('thruster').hpScale, demand: 4, priority: 1, thrust: 1.0, rated: 60, boost: 1, boostDrain: 0, intake: 6, buffer: 10,
    ports: ports('in', 'S', [0], 6), feedPort: { side: 'W' }, takes: ['reaction', 'catalyst', 'burstgel'], feedUse: 1.2,
    feedMods: { reaction: { thrust: 5 }, catalyst: { burn: 0.25, thrust: 2.5 }, burstgel: { thrust: 2.2, boost: 2.5 } },
    rarity: 'uncommon', description: 'An engine built for feed: a weak push on power alone, five times that on Reaction Mass piped to its left side (1.2 a second while thrusting). Power stays with the guns; the price is tanks and space.',
    category: 'engines', fabOrder: next('engines'), ...legacyLook('thruster'), glow: '#e879f9',
    guide: { name: 'Reaction Thruster', blurb: 'An engine built for feed', order: guideOrder++ },
  });
  // The Slurry Cannon: two inputs, power at its back left and its own feed at its back right, and it fires only with feed
  MOUNT.cannon_slurry = 'fixed';
  MOUNTING.cannon_slurry = { attach: 'back', clear: ahead(2) };
  const slurryDesc = 'The two-input gun: power at its back left and its own feed input at its back right, and it fires only with a material in it: a heavy slug every 0.7 s that hits like a Hammer. Overcharge, Accelerant or Flux Salts.';
  models.push({
    ...base('cannon_slurry', 'Slurry Cannon', 'cannon', ['rect2'], 18, 'titanium', { grade: 3 }),
    weapon: 'cannon', ...mounted('cannon_slurry', slurryDesc), hpScale: r2(FNS.get('weapon').hpScale * 1.1), demand: 18, priority: 2, fireInterval: 42,
    weaponMods: { mul: { damage: xp(48 / 14), speed: xp(38 / 48), size: xp(1.5) }, add: { pen: 1 } }, blast: BLAST.weapon,
    fire: { model: 'cycle', interval: 42, shot: 25, intake: 45, buffer: 1 },
    ports: ports('in', 'S', [0], 54), feedPort: { side: 'S', cell: 1, required: true }, takes: ['overcharge', 'accelerant', 'flux'],
    rarity: 'rare', category: 'weapons', fabOrder: next('weapons'), ...legacyLook('weapon'),
    guide: { name: 'Slurry Cannon', blurb: 'The two-input gun', piece: 'rect2', order: guideOrder++ },
  });
  // Ways to arm a ship (docs/design/energy-ports-2026-11.md section 17). Three kinds of gun, by what they ask of the ship:
  // - simple: fires off any line (a Cell Reactor at its port). Cheap, many of them.
  // - dual: the same, and a second input with its own buffer (`augment`): wire a rated line into it (`floor` E/s: a lone
  //   Cell Reactor's 35 never fills it; an Overclock, a Battery or a Surge Cell does) and its shots become something else
  //   (a breaching charge, a choked pattern, a storm of arcs...). A spam gun on one reactor, a specialist on two lines.
  // - heavy / super: a floor on the gun itself (profile.steady: what it gathers collapses unless its lines deliver that
  //   much while it fills), a big draw (`infra.draw` E/s: its energy a cycle is that draw over its cycle) and a big hit
  //   (`infra.damage` x). Only heavy infrastructure runs one: a Fusion Plant, or a store that can pour that fast while it
  //   lasts. Some have an augment of their own on top.
  // Damage here is per role, not per cell: each gun is judged in the scenarios it is for (scripts/balance/weapon-scenarios.mjs).
  // Ammunition guns pay in rounds and stay simple; support guns and legendaries keep their ways.
  const ROLE = {
    simple: ['cannon_pip', 'autocannon_rattler', 'laser_glint', 'pulse_strobe', 'autocannon_stinger', 'flak_burst', 'mortar_lobber', 'missile_dart',
      'railgun_needle', 'torpedo_eel', 'missile_swarm', 'mortar_quake', 'missile_hammerhead', 'torpedo_leviathan'],
    dual: ['cannon_hammer', 'cannon_twinlink', 'autocannon_chainsaw', 'railgun_coilgun', 'arc_spark', 'pulse_overpulse', 'flak_cloudmaker', 'laser_searchlight', 'cannon_slurry'],
    heavy: ['cannon_longbarrel', 'cannon_bastion', 'railgun_spear', 'railgun_rail_driver', 'laser_cutter', 'arc_tesla'],
    super: ['lance_lance'],
  };
  // (Heavy and super: draw E/s on a ports ship, and damage x. The floor is 85% of the draw, spread over the gun's ports)
  const HEAVY = {
    cannon_longbarrel: { draw: 170, damage: 3 }, cannon_bastion: { draw: 170, damage: 1.8 }, railgun_spear: { draw: 170, damage: 1.6 },
    railgun_rail_driver: { draw: 170, damage: 1.8 }, laser_cutter: { draw: 170, damage: 2.6 }, arc_tesla: { draw: 100, damage: 1.3 },
    lance_lance: { draw: 260, damage: 2.5 },
  };
  // (Augments. side/cell: its input, in the gun's own frame (S cell 1: the back of a 2-wide gun's right cell, which its main
  // input gives up); rate: E/s it takes; floor: E/s its line must deliver while it fills; cost: E a shot (a beam: E/s);
  // buffer: shots it holds (a beam: seconds); mods: on top of the gun's own (a mul is a change: 0.3 is x1.3))
  // (Damage x on a ports ship for the guns that had no place in any scenario: the Rattler and Strobe as cheap swarm turrets,
  // the Twinlink's stream; the Coilgun's base is a short-range pattern that its Choke turns into a real gun; the Slurry
  // Cannon's feed is its infrastructure)
  const DUAL = { railgun_coilgun: 0.55, cannon_slurry: 1.35, cannon_twinlink: 1.25, autocannon_rattler: 1.4, pulse_strobe: 1.2 };
  const AUG = (name, say, side, cell, rate, floor, cost, mods, buffer) => ({ name, say, side, ...(cell ? { cell } : {}), rate, floor, cost, ...(buffer ? { buffer } : {}), mods });
  // (Heavier shots 2026-11: the Twinlink's, Chainsaw's, Overpulse's and Rail Driver's augments cost more a shot as the guns fire fewer,
  // heavier rounds, so the E a second stays; a clip gun's augment buffer is its clip)
  const AUGMENT = {
    cannon_hammer: AUG('Breaching charge', 'its slug punches one grade deeper and bursts inside', 'S', 1, 60, 45, 30, { mul: { damage: 0.25 }, add: { pen: 1 }, set: { splash: { radius: 70, damage: 36 } } }),
    cannon_twinlink: AUG('Tracer lock', 'a tight stream twice as fast, harder-hitting, that reaches much further', 'S', 1, 60, 45, 13, { mul: { spread: -0.7, speed: 1, damage: 0.4 }, add: { pen: 0.5 } }, 8),
    autocannon_chainsaw: AUG('Incendiary belt', 'every round sets the part it hits burning', 'S', 1, 60, 45, 6, { set: { ignite: { dps: 6, ticks: 180, radius: 0.6 } } }, 10),
    railgun_coilgun: AUG('Choke', 'a tight, heavy pattern that carries twice as far', 'S', 1, 60, 45, 36, { mul: { spread: -0.65, life: 1, damage: 0.8 } }),
    arc_spark: AUG('Storm coil', 'its arc leaps to six targets, further apart', 'W', 0, 60, 45, 30, { set: { chain: { count: 6, radius: 420, falloff: 0.65 } } }),
    pulse_overpulse: AUG('Overdrive', 'three bolts a shot, fanned', 'S', 1, 60, 45, 15, { add: { burst: 2 }, mul: { spread: 0.4 } }, 6),
    flak_cloudmaker: AUG('Wide burst', 'bursts half again as wide and 60% harder', 'S', 0, 60, 45, 45, { mul: { splashRadius: 0.5, splashDamage: 0.6 } }),
    laser_searchlight: AUG('Sear', 'its marking beam burns twice as hot', 'S', 0, 60, 45, 40, { mul: { dps: 1 } }),
    cannon_longbarrel: AUG('Penetrator', 'its round goes on through two more ships', 'W', 0, 70, 50, 150, { add: { pierce: 2 }, set: { pierceKeep: 1 } }),
    cannon_bastion: AUG('Shatter', 'each ball bursts in a 200 blast', 'W', 0, 70, 50, 80, { set: { splash: { radius: 200, damage: 110 } } }),
    railgun_rail_driver: AUG('Coil boost', 'half again the damage, a third faster', 'W', 0, 70, 50, 28, { mul: { damage: 0.5, speed: 0.3 } }, 4),
    laser_cutter: AUG('Focus', 'burns half again as hot', 'W', 0, 70, 50, 60, { mul: { dps: 0.5 } }),
    arc_tesla: AUG('Storm', 'zaps half again as hard', 'S', 0, 70, 50, 50, { mul: { dps: 0.5 } }),
    lance_lance: AUG('Focus', 'burns half again as hot', 'W', 0, 100, 55, 100, { mul: { dps: 0.5 } }),
  };
  for (const [tier, ids] of Object.entries(ROLE)) for (const id of ids) {
    const m = models.find((x) => x.id === id);
    if (!m) throw new Error(`role for unknown model ${id}`);
    const h = HEAVY[id], ag = AUGMENT[id];
    m.infra = { tier, damage: h?.damage ?? DUAL[id] ?? 1, ...(h ? { draw: h.draw } : {}) };
    if (ag) {
      m.augment = ag;
      // (Its augment takes the back of its right cell: its main input keeps the left one, at the whole rate)
      if (ag.side === 'S' && ag.cell === 1) {
        const left = m.ports.filter((q) => q.dir === 'in' && !(q.side === 'S' && q.cell === 1));
        m.ports = left.map((q) => ({ ...q, rate: q.rate * 2 }));
      }
    }
    if (h) {
      const ins = m.ports.filter((q) => q.dir === 'in');
      m.profile = { ...(m.profile ?? {}), steady: Math.round(0.85 * h.draw) };
      m.ports = m.ports.map((q) => (q.dir === 'in' ? { ...q, rate: Math.ceil((1.1 * h.draw) / ins.length) } : q));
    }
  }
}
// ---- (end ports energy core)
// ---- Field machines (docs/design/field-fabrication.md; common/src/ships/features/machines, common/src/econ/field): the
// fabricator builds, repairs, attaches and recycles parts from the hold, the refiner refines the hold's ore, each while the
// ship flies. `machine.tier` sets its speed and grade cap (econ/field/rules.ts, the one place those numbers live). Each
// draws its `demand` per cell a second only while it works (power/ports.ts: a tool whose draw PortsState.mach turns on),
// the fabricator the most of any part, the refiner less, so it can run while mining. One of each a ship. Ports: in at the
// back, as any tool (1.5 x its draw over its back cells). Appended after the ports block, so no other model's order moves.
{
  const MACHINE_LOOK = { fabricator: { color: '#c08a3e', decor: 'battery', glow: '#fbbf24' }, refiner: { color: '#7a8f5a', decor: 'none', glow: '#a3e635' } };
  const MACHINES = [
    ['fabricator_field', 'Field Fabricator', 'fabricator', ['rect2'], 0, 'alloy', { machine: { kind: 'fabricator', tier: 1 }, demand: 20 },
      'Builds and repairs parts from your hold while you fly, up to Mk II, drawing 40 a second while it works. One per ship.'],
    ['fabricator_bay', 'Fabrication Bay', 'fabricator', ['block2'], 12, 'steel', { machine: { kind: 'fabricator', tier: 2 }, demand: 17.5, massScale: 1.4 },
      'Builds and repairs parts from your hold 1.6 times as fast as a Field Fabricator, up to Mk III, drawing 70 a second while it works. One per ship.'],
    ['fabricator_forge', 'Assembly Forge', 'fabricator', ['block2'], 24, 'titanium', { machine: { kind: 'fabricator', tier: 3 }, demand: 27.5, massScale: 1.6 },
      'Builds and repairs any part from your hold 2.5 times as fast as a Field Fabricator, drawing 110 a second while it works. One per ship.'],
    ['refiner_field', 'Field Refiner', 'refiner', ['sq'], 3, 'alloy', { machine: { kind: 'refiner', tier: 1 }, demand: 20 },
      'Refines ore in your hold while you fly, up to Mk II materials, at 0.4 of a station\'s pace, drawing 20 a second while it works. One per ship.'],
    ['refiner_bay', 'Refinery Bay', 'refiner', ['rect2'], 12, 'steel', { machine: { kind: 'refiner', tier: 2 }, demand: 17.5 },
      'Refines ore in your hold up to Mk III materials, at 0.7 of a station\'s pace, drawing 35 a second while it works. One per ship.'],
    ['refiner_forge', 'Smelter Forge', 'refiner', ['block2'], 24, 'titanium', { machine: { kind: 'refiner', tier: 3 }, demand: 13.75, massScale: 1.4 },
      'Refines any ore in your hold at a station\'s pace, drawing 55 a second while it works. One per ship.'],
  ];
  const portsOf = (piece, demand) => {
    const cells = PIECE_AREA[piece] >= 2 ? [0, 1] : [0];
    const rate = Math.max(4, Math.ceil((demand * PIECE_AREA[piece] * 1.5) / cells.length));
    return cells.map((cell) => ({ dir: 'in', side: 'S', cell, rate }));
  };
  for (const [id, name, family, pieces, level, material, fields, description] of MACHINES) {
    models.push({
      ...base(id, name, family, pieces, level, material, {}), ...fields, priority: 3, hpScale: 0.8, description,
      ports: portsOf(pieces[0], fields.demand),
      rarity: level >= 20 ? 'rare' : level >= 5 ? 'uncommon' : 'common', category: 'utility', fabOrder: next('utility'), ...MACHINE_LOOK[family],
      guide: { name, blurb: description.split(/[.:]/)[0], ...(pieces[0] !== 'sq' ? { piece: pieces[0] } : {}), order: guideOrder++ },
    });
  }
}
// ---- (end field machines)
// ---- Mine Bay and Docking Clamps (docs/design/groups-mines-docking.md; common/src/ships/features/minebay, features/clamp) ----
// The Mine Bay is not an aimed weapon: a key press drops a batch of proximity mines out of its facing edge from its
// magazine (`mineBay`: batch, capacity, cooldown ticks); the field fabricator refills the magazine (econ/field/rules.ts
// REARM, a placeholder cost). The mines' own numbers live in features/minebay/minebay.ts MINES. A Docking Clamp's facing
// edge is a clamp mouth `clamp.size` cells wide: two ships whose clamps of the same size face each other, lined up, lock
// together as one body when both pilots agree. Neither draws power. Appended after the field machines, so no other
// model's order moves. (Kieran 2026-11-07: numbers and costs are placeholders to tune.)
{
  const LINK_LOOK = { minebay: { color: '#6b6f4a', decor: 'battery', glow: '#ef4444' }, clamp: { color: '#7d8794', decor: 'none', glow: '#60a5fa' } };
  const LINK = [
    ['mine_bay', 'Mine Bay', 'minebay', ['rect2'], 8, 'steel', { mineBay: { batch: 4, capacity: 12, cooldown: 120 }, facing: true, hpScale: 0.8, massScale: 1.2 },
      'Drops a batch of 4 proximity mines out of its open edge on a key press, from a magazine of 12 the fabricator refills. Mines arm after a second and never go off for you or your party.'],
    ['docking_clamp', 'Docking Clamp', 'clamp', ['sq'], 4, 'alloy', { clamp: { size: 1 }, facing: true, hpScale: 1.2 },
      'A clamp on its open edge: line it up with the Docking Clamp of another ship and both pilots agree to lock the two ships together, one steering.'],
    ['docking_clamp_heavy', 'Heavy Docking Clamp', 'clamp', ['rect2'], 16, 'steel', { clamp: { size: 2 }, facing: true, hpScale: 1.4, massScale: 1.3 },
      'A two-cell clamp that locks only to another Heavy Docking Clamp, for bigger ships: line them up and both pilots agree to lock together.'],
  ];
  for (const [id, name, family, pieces, level, material, fields, description] of LINK) {
    models.push({
      ...base(id, name, family, pieces, level, material, {}), ...fields, description,
      rarity: level >= 20 ? 'rare' : level >= 5 ? 'uncommon' : 'common', category: 'utility', fabOrder: next('utility'), ...LINK_LOOK[family],
      guide: { name, blurb: description.split(/[.:]/)[0], ...(pieces[0] !== 'sq' ? { piece: pieces[0] } : {}), order: guideOrder++ },
    });
  }
}
// ---- (end Mine Bay and Docking Clamps)
// ---- Shaped shields (prototypes/shield-fx, the Shield Lab; common/src/ships/features/zoneshield): seven shields that cover a
// line (walls) or an arc instead of the whole ship, each its own part with its own HP and refill, projected from the part's
// open (facing) edge. `shaped`: kind, wall `len`/`off` or arc `rad`/`span` (cells, degrees), `cap` HP, `rate` HP a second
// once unhit for 1.2 s, `delay` seconds down after a break (it returns at a quarter). The numbers are the Lab's; its levels 1..5
// are spread over the track as 2, 4, 8, 12, 18 (level 1 opens nothing: track.test). All starting values to tune; the `demand` (E a second, per cell) is a placeholder. The Bubble is not
// here. Appended after the Mine Bay block, so no other model's order moves.
{
  const SHAPED_LOOK = { quick: { color: '#3f9fc4', decor: 'none', glow: '#5fd8ff' }, deep: { color: '#b4762b', decor: 'none', glow: '#ffb04a' } };
  const portsOf = (piece, demand) => {
    const cells = PIECE_AREA[piece] >= 2 ? [0, 1] : [0];
    const rate = Math.max(4, Math.ceil((demand * PIECE_AREA[piece] * 1.5) / cells.length));
    return cells.map((cell) => ({ dir: 'in', side: 'S', cell, rate }));
  };
  // [id, name, family, piece, level, material, shaped, total draw, description]
  const SHAPED = [
    ['shield_spark_wall', 'Spark Wall', 'shieldwall', 'sq', 2, 'alloy', { kind: 'wall', len: 2, off: 1, cap: 40, rate: 14, delay: 1.5 }, 10,
      'Two cells of flat shield just off the hull: 40 HP, 14 a second, 1.5 s down when broken. Cheap and quick.'],
    ['shield_guard_wall', 'Guard Wall', 'shieldwall', 'rect2', 4, 'alloy', { kind: 'wall', len: 3, off: 1, cap: 75, rate: 12, delay: 2.2 }, 16,
      'Three cells wide, one out: 75 HP, 12 a second, 2.2 s down when broken. Covers a gun and its neighbours.'],
    ['shield_rampart', 'Rampart', 'shieldwall', 'block2', 12, 'steel', { kind: 'wall', len: 5, off: 2, cap: 260, rate: 9, delay: 4.5, deep: true }, 30,
      'Five cells of deep flat shield, two out: 260 HP, 9 a second, 4.5 s down when broken. Slow to return.'],
    ['shield_visor', 'Visor', 'shieldarc', 'sq', 2, 'alloy', { kind: 'arc', rad: 2.5, span: 60, cap: 45, rate: 16, delay: 1.2 }, 11,
      'A tight 60 degree arc in front of a gun: 45 HP, 16 a second, 1.2 s down when broken.'],
    ['shield_buckler', 'Buckler', 'shieldarc', 'sq', 4, 'alloy', { kind: 'arc', rad: 2, span: 90, cap: 60, rate: 13, delay: 2 }, 13,
      'A small 90 degree arc close to the hull: 60 HP, 13 a second, 2 s down when broken.'],
    ['shield_shell', 'Shell', 'shieldarc', 'rect2', 8, 'steel', { kind: 'arc', rad: 3.5, span: 120, cap: 160, rate: 8, delay: 3.5, deep: true }, 22,
      'A 120 degree arc that wraps most of a side: 160 HP, 8 a second, 3.5 s down when broken.'],
    ['shield_half_dome', 'Half-dome', 'shieldarc', 'block2', 18, 'titanium', { kind: 'arc', rad: 5, span: 180, cap: 320, rate: 6, delay: 5.5, deep: true }, 36,
      'A 180 degree dome over one end: 320 HP, 6 a second, 5.5 s down when broken. Deep and slow.'],
  ];
  for (const [id, name, family, piece, level, material, shaped, draw, description] of SHAPED) {
    const demand = r2(draw / PIECE_AREA[piece]);
    models.push({
      ...base(id, name, family, [piece], level, material, {}), shaped, facing: true, demand, priority: 2, hpScale: 0.6, description,
      ports: portsOf(piece, demand),
      rarity: level >= 5 ? 'rare' : level >= 3 ? 'uncommon' : 'common', category: 'shields', fabOrder: next('shields'),
      ...SHAPED_LOOK[shaped.deep ? 'deep' : 'quick'],
      guide: { name, blurb: description.split(/[.:]/)[0], ...(piece !== 'sq' ? { piece } : {}), order: guideOrder++ },
    });
  }
}
// ---- (end shaped shields)

const COMPONENTS = [
  ['barrel_assembly', 'Barrel Assembly', 'uncommon', 60, { steel_plate: 2, servo_motor: 1 }, 45, '#a8a29e', 'A rifled barrel on a servo mount: cannons, autocannons, flak and mortars.'],
  ['coil_winding', 'Coil Winding', 'uncommon', 48, { copper_wire: 6, ferrite_plate: 1 }, 40, '#d97706', 'Copper wound on a ferrite core: railguns, arc and EMP projectors, jump coils.'],
  ['capacitor_cell', 'Capacitor Cell', 'uncommon', 40, { copper_wire: 3, insulated_polymer: 1, scrap_electronics: 1 }, 30, '#38bdf8', 'A fast-discharge cell: batteries, capacitors, pulse guns and lasers.'],
  ['thrust_nozzle', 'Thrust Nozzle', 'rare', 85, { titanium_plate: 2, ceramic_plate: 1 }, 60, '#f97316', 'A ceramic-lined titanium bell: torches, plasma and fusion drives.'],
  ['fuel_injector', 'Fuel Injector', 'uncommon', 55, { steel_plate: 1, propellant: 2, servo_motor: 1 }, 45, '#fb923c', 'Meters propellant into a burn: afterburners and torches.'],
  ['reactor_core', 'Reactor Core', 'rare', 130, { hardened_steel: 2, crystal: 1, coolant: 2 }, 90, '#facc15', 'The heart of a generator past the cell reactor.'],
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
// (The Conduit and the Diode: cheap, a power line and a one-way one)
Object.assign(RECIPES, {
  power_conduit: { alloy_plate: 1, copper_wire: 1 },
  power_diode: { alloy_plate: 1, copper_wire: 2, insulated_polymer: 1 },
});
// (The Gyro and the Heavy Gyro: a spinning wheel on a motor)
Object.assign(RECIPES, {
  utility_gyro: { alloy_plate: 2, copper_wire: 1, servo_motor: 1 },
  utility_heavy_gyro: { titanium_plate: 4, coil_winding: 2, servo_motor: 2, power_coupling: 1 },
});
// (The ports energy core's parts: tanks and pipes are plate and polymer; the banks cells and coils; the Combiner a coupling)
Object.assign(RECIPES, {
  power_joiner_bank: { steel_plate: 3, capacitor_cell: 2, copper_wire: 2 },
  power_splitter_bank: { steel_plate: 3, capacitor_cell: 2, copper_wire: 2 },
  power_joiner_elbow: { steel_plate: 3, capacitor_cell: 2, copper_wire: 2 },
  power_joiner_end: { steel_plate: 3, capacitor_cell: 2, copper_wire: 2 },
  power_joiner_cross: { steel_plate: 3, capacitor_cell: 2, copper_wire: 2 },
  power_splitter_elbow: { steel_plate: 3, capacitor_cell: 2, copper_wire: 2 },
  power_splitter_tee: { steel_plate: 3, capacitor_cell: 2, copper_wire: 2 },
  power_splitter_end: { steel_plate: 3, capacitor_cell: 2, copper_wire: 2 },
  power_surge_cell: { steel_plate: 1, capacitor_cell: 2, coil_winding: 1 },
  power_corner: { alloy_plate: 1, copper_wire: 2, insulated_polymer: 1 },
  power_combiner: { steel_plate: 2, power_coupling: 1, insulated_polymer: 1 },
  power_passthrough: { alloy_plate: 1, copper_wire: 2, insulated_polymer: 2 },
  feed_pipe: { alloy_plate: 1, insulated_polymer: 1 },
  feed_selector: { steel_plate: 1, servo_motor: 1, insulated_polymer: 1 },
  engine_reaction_thruster: { steel_plate: 2, servo_motor: 1, insulated_polymer: 1 },
  cannon_slurry: { titanium_plate: 3, barrel_assembly: 2, insulated_polymer: 2, servo_motor: 1 },
});
for (const feed of ['overcharge', 'coolant', 'damping', 'flux', 'accelerant', 'lens', 'catalyst', 'reaction', 'burstgel']) RECIPES[`feed_tank_${feed}`] = { steel_plate: 2, insulated_polymer: 1 };
// (Field machines: the Field Fabricator is starter materials only, so a bare core can build it; docs/design/field-fabrication.md)
Object.assign(RECIPES, {
  fabricator_field: { alloy_plate: 4, copper_wire: 4 },
  fabricator_bay: { steel_plate: 4, copper_wire: 6, servo_motor: 2, power_coupling: 1 },
  fabricator_forge: { titanium_plate: 6, servo_motor: 3, power_coupling: 2, targeting_chip: 1 },
  refiner_field: { alloy_plate: 3, copper_wire: 2, coolant: 1 },
  refiner_bay: { steel_plate: 3, copper_wire: 4, crystal_lens: 1, coolant: 2 },
  refiner_forge: { titanium_plate: 4, copper_wire: 4, reactor_core: 1, coolant: 2 },
});
// (Mine Bay and Docking Clamps: placeholder costs, to tune; docs/design/groups-mines-docking.md)
Object.assign(RECIPES, {
  mine_bay: { steel_plate: 2, copper_wire: 2, servo_motor: 1 },
  docking_clamp: { alloy_plate: 2, servo_motor: 1 },
  docking_clamp_heavy: { steel_plate: 4, servo_motor: 2, power_coupling: 1 },
});
// (Shaped shields: placeholder costs, to tune)
Object.assign(RECIPES, {
  shield_spark_wall: { alloy_plate: 1, copper_wire: 2, shield_emitter: 1 },
  shield_guard_wall: { alloy_plate: 2, copper_wire: 2, shield_emitter: 1 },
  shield_rampart: { steel_plate: 3, copper_wire: 4, shield_emitter: 2, power_coupling: 1 },
  shield_visor: { alloy_plate: 1, copper_wire: 2, shield_emitter: 1 },
  shield_buckler: { alloy_plate: 1, copper_wire: 2, shield_emitter: 1, capacitor_cell: 1 },
  shield_shell: { steel_plate: 2, copper_wire: 3, shield_emitter: 2 },
  shield_half_dome: { titanium_plate: 4, copper_wire: 4, shield_emitter: 3, power_coupling: 1 },
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
// Sounds: every weapon model is heard as its own (client/src/audio/weaponSounds.ts). A model takes its kind's sounds
// (legacyLook) unless it's here; `sfx` here replaces both its kind's plain and turret shot (a model is one or the
// other), `sfxLoop` is a held beam's loop (its `sfx` then plays as it lights). Files: scripts/sfx-manifest.json.
// ---------------------------------------------------------------------------

const MODEL_SOUND = {
  // (The Pip keeps the cannon kind's original shot sound, by Kieran's choice: pip_shot.mp3 stays in sfx, unused)
  cannon_hammer: { sfx: 'hammer_shot' },
  cannon_twinlink: { sfx: 'twinlink_shot' },
  cannon_longbarrel: { sfx: 'longbarrel_shot' },
  cannon_bastion: { sfx: 'bastion_shot' },
  cannon_slurry: { sfx: 'slurry_shot' },
  autocannon_chainsaw: { sfx: 'chainsaw_shot' },
  autocannon_stinger: { sfx: 'stinger_shot' },
  flak_cloudmaker: { sfx: 'cloudmaker_shot' },
  mortar_quake: { sfx: 'quake_shot' },
  laser_cutter: { sfxLoop: 'laser_loop' },
  laser_searchlight: { sfxLoop: 'searchlight_loop' },
  pulse_overpulse: { sfx: 'overpulse_shot' },
  missile_swarm: { sfx: 'swarm_launch' },
  missile_hammerhead: { sfx: 'hammerhead_launch' },
  railgun_coilgun: { sfx: 'coilgun_shot' },
  railgun_spear: { sfx: 'spear_shot' },
  railgun_rail_driver: { sfx: 'rail_driver_shot' },
  emp_blackout: { sfx: 'blackout_shot' },
  arc_tesla: { sfxLoop: 'arc_loop' },
  torpedo_leviathan: { sfx: 'leviathan_launch' },
  lance_lance: { sfx: 'lance_fire', sfxLoop: 'lance_loop' },
  utility_repair_beam: { sfxLoop: 'repair_loop' },
  point_defence_turret: { sfx: 'pd_shot' },
};
for (const m of models) {
  const s = MODEL_SOUND[m.id];
  if (!s) continue;
  if (s.sfx) { delete m.sfxTurret; m.sfx = s.sfx; }
  if (s.sfxLoop) m.sfxLoop = s.sfxLoop;
}
for (const id of Object.keys(MODEL_SOUND)) if (!models.some((m) => m.id === id)) throw new Error(`MODEL_SOUND: no model ${id}`);

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

const ids = new Set();
for (const m of models) { if (ids.has(m.id) || FNS.has(m.id)) throw new Error(`duplicate id ${m.id}`); ids.add(m.id); }

// Which edge a family's models are drawn pointing by default (FunctionDef.pointing: the viewer's defaultFacing), and the
// plating that reacts to a shot (FunctionDef.platingHit: the client's hit effects)
const POINTING = { ion: 'S', afterburner: 'S', plasma: 'S', mining: 'N', demolition: 'N', siphon: 'N' };
const PLATING_HIT = { plating_reactive_armour: 'sparks', plating_spaced_plating: 'chips' };
for (const m of models) {
  if (POINTING[m.family]) m.pointing = POINTING[m.family];
  if (PLATING_HIT[m.id]) m.platingHit = PLATING_HIT[m.id];
}

// (One model a line)
const NOTE = 'Written by scripts/econ/models.mjs (edit that, not this). Player models: fixed named modules (docs/parts-redesign.md). `legacy`: the family each legacy function migrates to.';
writeFileSync(join(DATA, 'ships/models.json'),
  `{\n  "_comment": ${JSON.stringify(NOTE)},\n  "legacy": ${JSON.stringify(LEGACY)},\n  "models": [\n${models.map((m) => '    ' + JSON.stringify(m)).join(',\n')}\n  ]\n}\n`);

/** Components that were retired: dropped from the books when this runs (wire_spool: ships no longer take wire) */
const RETIRED = new Set(['wire_spool']);

const rec = read('recipes.json');
rec.models = recipes;
rec.craft = rec.craft.filter((c) => !RETIRED.has(c.id));
for (const [id, , , , inputs, time] of COMPONENTS) {
  const r = { id, out: { [id]: 1 }, inputs, time, starter: true };
  const i = rec.craft.findIndex((c) => c.id === id);
  if (i >= 0) rec.craft[i] = r; else rec.craft.push(r);
}
writeFileSync(join(DATA, 'recipes.json'), JSON.stringify(rec, null, 2) + '\n');

const items = read('items.json');
items.items = items.items.filter((x) => !RETIRED.has(x.id));
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
