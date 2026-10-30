// Build enemy ship blueprints from compact text layouts (front of the ship at the top).
//   node scripts/gen-enemy-ships.mjs        → data/ships/blueprints/enemy/*.json
//
// One character per grid cell (sq pieces unless noted):
//   C core   G generator   K conduit   H hull   A armour   X cargo   S shield
//   T thruster (faces back)   W cannon   L pulse laser   F flak   M missile launcher   E EMP projector
//   lower-case w l f m = the same weapon on a turret mount
//   R railgun / P plasma lance: two cells side by side (RR / PP), a rect2 piece
//   < > / \  wedges (tri), rotated to sit against their neighbours
//   .  empty
// Weapons face forward (or sideways when something blocks the front).
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const out = join(dirname(fileURLToPath(import.meta.url)), '../data/ships/blueprints/enemy');
mkdirSync(out, { recursive: true });

import { build, buildBlocks } from './lib/layout.mjs';

const SHIPS = {
  // Pirates: cheap, numerous, scrappy
  pirate_skiff: ['Pirate Skiff', 'alloy', [
    '..H..',
    '<WCW>',
    '.GGG.',
    '.T.T.',
  ]],
  pirate_raider: ['Pirate Raider', 'alloy', [
    '.W.W.',
    '<KWK>',
    'AGCGA',
    '.T.T.',
  ]],
  pirate_gunship: ['Pirate Gunship', 'steel', [
    '..W.W..',
    '.<KMK>.',
    '.wGCGw.',
    'AGGKGGA',
    '.T.T.T.',
  ]],
  // Scrapborn (outer Sol, the Drift): feral junk drones, their drives worn out, so slow (at most half a
  // starter ship's speed, built in Sol's Mk I alloy); poor shots, fragile. Early-game prey.
  scrap_mite: ['Scrap Mite', 'steel', [
    '.W.',
    'HCH',
    'AGA',
    'AHA',
    '.T.',
  ], { drive: 0.36 }],
  scrap_spitter: ['Scrap Spitter', 'steel', [
    '..L..',
    '<HCH>',
    '.GKG.',
    '.HTH.',
  ], { drive: 0.36 }],
  scrap_crawler: ['Scrap Crawler', 'steel', [
    '..W..',
    'AKCKA',
    'AGGGA',
    'A.T.A',
  ], { drive: 0.46 }],
  // Scavenger drones: fragile swarms
  scav_drone: ['Scavenger Drone', 'composite', [
    '.W.',
    '<C>',
    '.G.',
    '.T.',
  ]],
  scav_harvester: ['Scavenger Harvester', 'composite', [
    '.L.L.',
    '<KCK>',
    'XGGGX',
    '.T.T.',
  ]],
  // Frost Brood: EMP and flak, light shields
  frost_shard: ['Frost Shard', 'composite', [
    '.E.F.',
    '<SCS>',
    '.GGG.',
    '.T.T.',
  ]],
  frost_warden: ['Frost Warden', 'composite', [
    '..E..',
    '.fSf.',
    '<GCG>',
    'HGSGH',
    '.T.T.',
  ]],
  // Cinder Cult: plasma lances and heavy armour
  cinder_zealot: ['Cinder Zealot', 'steel', [
    '..PP.',
    '.AKKA',
    '<GCG>',
    '.GGG.',
    '.T.T.',
  ]],
  cinder_brand: ['Cinder Brand', 'steel', [
    '.W..PP.W.',
    '.KAAKKAK.',
    '<KGGCGGK>',
    '.AGGGGGA.',
    '..T.T.T..',
  ]],
  // Void Wraiths: lasers, EMP and shields; fast
  void_phantom: ['Void Phantom', 'titanium', [
    '..L..',
    '<SCS>',
    '.GGG.',
    '.T.T.',
  ]],
  void_reaver: ['Void Reaver', 'titanium', [
    '...E...',
    '..LSL..',
    '.<SCS>.',
    'HGGGGGH',
    '.T.T.T.',
  ]],
  // Maw Spawn: railguns and missiles
  maw_lurker: ['Maw Lurker', 'steel', [
    '.M.RR.M.',
    '.K.KK.K.',
    'AKGGCGKA',
    '.AGGGGA.',
    '..T..T..',
  ]],
  maw_colossus: ['Maw Colossus', 'steel', [
    '.M..RR...M.',
    '.K..KK...K.',
    'AKKKGCGKKKA',
    'ASGGGGGGGSA',
    '.AGGGGGGGA.',
    '..T.T.T.T..',
  ]],
  // ---- Bosses (data/bosses.json) ----
  // Structures players defend (no thrusters: they stay put)
  city_pylon: ['Shield Pylon', 'steel', [
    '.ASA.',
    'ASGSA',
    'SGCGS',
    'ASGSA',
    '.ASA.',
  ]],
  // A moon siege's bastion, and the turrets parties build round it
  siege_bastion: ['Lunar Bastion', 'steel', [
    '..AASAA..',
    '.AHHGHHA.',
    'AHSGKGSHA',
    'AHGKCKGHA',
    'AHSGKGSHA',
    '.AHHGHHA.',
    '..AASAA..',
  ]],
  // Siege turrets (Sieges.ts), three marks each: an upgrade swaps the turret for the next mark
  siege_turret_cannon: ['Cannon Turret', 'steel', [
    '.w.',
    'AGA',
    'ACA',
  ]],
  siege_turret_cannon_2: ['Cannon Turret II', 'steel', [
    'w.w',
    'GKG',
    'ACA',
  ]],
  siege_turret_cannon_3: ['Cannon Turret III', 'steel', [
    'w.w.w',
    'GKGKG',
    '.ACA.',
  ]],
  siege_turret_flak: ['Flak Turret', 'steel', [
    'f.f',
    'GKG',
    'ACA',
  ]],
  siege_turret_flak_2: ['Flak Turret II', 'steel', [
    'f.f.f',
    'GKGKG',
    '.ACA.',
  ]],
  siege_turret_flak_3: ['Flak Turret III', 'steel', [
    'f.f.f.f',
    'GKGKGKG',
    '..ACA..',
  ]],
  siege_turret_laser: ['Laser Turret', 'steel', [
    '.l.',
    'GKG',
    'ACA',
  ]],
  siege_turret_laser_2: ['Laser Turret II', 'steel', [
    'l.l',
    'GKG',
    'ACA',
  ]],
  siege_turret_laser_3: ['Laser Turret III', 'steel', [
    'l.l.l',
    'GGKGG',
    '.ACA.',
  ]],
  siege_turret_missile: ['Missile Turret', 'steel', [
    'm.m',
    'GKG',
    'ACA',
  ]],
  siege_turret_missile_2: ['Missile Turret II', 'steel', [
    'm.m.m',
    'GGKGG',
    '.ACA.',
  ]],
  siege_turret_missile_3: ['Missile Turret III', 'steel', [
    'm.m.m.m',
    'GGKGKGG',
    '..ACA..',
  ]],
  boss_scrap_mother: ['Scrap Mother', 'steel', [
    '..w...w..',
    '.<HWHWH>.',
    'AXHGCGHXA',
    'AHGGKGGHA',
    '.AXHHHXA.',
    '..T...T..',
  ]],
  boss_rustjaw: ['Rustjaw', 'steel', [
    '..W.W...W.W..',
    '.<KWK...KWK>.',
    '.AKGK.M.KGKA.',
    '<AGGGKKKGGGA>',
    '.wGGGGCGGGGw.',
    'AKGXXGGGXXGKA',
    '.AGGGGGGGGGA.',
    '..T.T.T.T.T..',
  ]],
  boss_hoarfrost: ['Hoarfrost Matriarch', 'composite', [
    '....E.E....',
    '...fSKSf...',
    '..<SGKGS>..',
    '.EKGGCGGKE.',
    '<SGGSGSGGS>',
    '.HGGGGGGGH.',
    '..T.T.T.T..',
  ]],
  boss_cinder_warden: ['Cinder Warden', 'steel', [
    '...PP...PP...',
    '..AKKA.AKKA..',
    '.<AGGKKKGGA>.',
    'AAKGGGCGGGKAA',
    '.wKGGSGSGGKw.',
    '.AGGGGGGGGGA.',
    '..T.T.T.T.T..',
  ]],
  boss_prism_colossus: ['Prism Colossus', 'composite', [
    '...L...L...',
    '..SKL.LKS..',
    '.<KKKGKKK>.',
    '.LGGGCGGGL.',
    'AKGSGGGSGKA',
    '.AGGGGGGGA.',
    '..T.T.T.T..',
  ]],
  boss_void_leviathan: ['Void Leviathan', 'titanium', [
    '..L.....L..',
    '.<SL.E.LS>.',
    '.SKKKGKKKS.',
    'LKGGGCGGGKL',
    '.SGSGGGSGS.',
    '..GGGGGGG..',
    '..T.T.T.T..',
  ]],
  boss_maw_heart: ['Heart of the Maw', 'steel', [
    '.M...RR...RR...M.',
    '.K...KK...KK...K.',
    'AKA.AKKAAAKKA.AKA',
    'AKKKKGGGGGGGKKKKA',
    '.ASGGGGGCGGGGGSA.',
    '.wGGGGGGGGGGGGGw.',
    '.ASGGXXGGGXXGGSA.',
    '..AGGGGGGGGGGGA..',
    '...T.T.T.T.T.T...',
  ]],
  // Giants: one wanders each system, built at twice the scale (every cell a 2×2 block). Mostly hull
  // for their size: Sol's carries a handful of guns, the others a moderate battery.
  giant_midden: ['The Midden', 'steel', [
    '.....<KwK>.....',
    '...<AAHKHAA>...',
    '..<AHHHKHHHA>..',
    '.<AXXHHGHHXXA>.',
    '<AHXXHGGGHXXHA>',
    'wKKKKGGCGGKKKKw',
    'AHHXXHGKGHXXHHA',
    '<AHHXXHGHXXHHA>',
    '.<AAHHKKKHHAA>.',
    '..<AKKKKKKKA>..',
    '...wT.T.T.Tw...',
  ], { blocks: true, drive: 0.3 }],
  giant_mammoth: ['Redtooth Mammoth', 'steel', [
    '...W.W...W.W...',
    '..<KWK...KWK>..',
    '.<AKKA.M.AKKA>.',
    '<AAGGKKKKKGGAA>',
    'wKKGGXXGXXGGKKw',
    'AAGGGGGCGGGGGAA',
    'wKKGXXGGGXXGKKw',
    '<AAGGKKKKKGGAA>',
    '.AAKKGGGGGKKAA.',
    '..<KwKKKKKwK>..',
    '...T.T.T.T.T...',
  ], { blocks: true, drive: 0.45 }],
  giant_dredge: ['The Great Dredge', 'composite', [
    '..L.W.....W.L..',
    '.<KKK.....KKK>.',
    '<AAKKA...AKKAA>',
    'lKXXKKAAAKKXXKl',
    'wKXXGGGGGGGXXKw',
    '.SGGGGGCGGGGGS.',
    'AKXXGGKKKGGXXKA',
    'lKXXKGGGGGKXXKl',
    '<AAXXKKKKKXXAA>',
    '.<KKKK.T.KKKK>.',
    '..T..T...T..T..',
  ], { blocks: true, drive: 0.4 }],
  giant_rimeback: ['Rimeback', 'composite', [
    '....E.....E....',
    '...<KSA.ASK>...',
    '..<AAKKAKKAA>..',
    '.fKKGGGKGGGKKf.',
    '<AAGGSGKGSGGAA>',
    'fKKGGGGCGGGGKKf',
    '<AAGGSGGGSGGAA>',
    '.fKKGGKKKGGKKf.',
    '..<AAKKKKKAA>..',
    '...<AT.T.TA>...',
  ], { blocks: true, drive: 0.45 }],
  giant_ironmonger: ['The Ironmonger', 'steel', [
    '..R..W...W..R..',
    '.<KK.KK.KK.KK>.',
    '<AAKKKKKKKKKAA>',
    'mKKGGXXGXXGGKKm',
    'AAGGGGGCGGGGGAA',
    'wKKGGXXGXXGGKKw',
    'AAGGGGKKKGGGGAA',
    'mKKGXXGGGXXGKKm',
    '<AAKKGGGGGKKAA>',
    '.<KwKKKKKKKwK>.',
    '..T.T.T.T.T.T..',
  ], { blocks: true, drive: 0.45 }],
  giant_pilgrim: ['The Ash Pilgrim', 'steel', [
    '...P.W...W.P...',
    '..<KKK...KKK>..',
    '.<AAKKAAAKKAA>.',
    'wKKGGKKKKKGGKKw',
    'AAGGGXXGXXGGGAA',
    'wKKGGGGCGGGGKKw',
    'AAGGGXXGXXGGGAA',
    'wKKGGKKKKKGGKKw',
    '.<AAKKGGGKKAA>.',
    '..<KKKKKKKKK>..',
    '...T.T.T.T.T...',
  ], { blocks: true, drive: 0.4 }],
  giant_shroud: ['The Shroudhulk', 'titanium', [
    '..L...L.L...L..',
    '.<KK.<KKK>.KK>.',
    '<AAKKKKKKKKKAA>',
    'lGGGGSGKGSGGGGl',
    'AAGGGGGCGGGGGAA',
    '.SGGXXGGGXXGGS.',
    'lGGGGGKKKGGGGGl',
    '<AAGXXGGGXXGAA>',
    '.<AAKKKeKKKAA>.',
    '..<AT.T.T.TA>..',
  ], { blocks: true, drive: 0.5 }],
};

// An optional fourth entry: { drive } (engine output, 0.1..1: the Scrapborn's worn-out drives), { blocks } (a giant)
for (const [file, [name, material, rows, opts]] of Object.entries(SHIPS)) {
  const bp = (opts?.blocks ? buildBlocks : build)(name, material, rows);
  if (opts?.drive) bp.drive = opts.drive;
  writeFileSync(join(out, `${file}.json`), JSON.stringify(bp, null, 1) + '\n');
}
console.log(`${Object.keys(SHIPS).length} enemy ships written to ${out}`);
