/**
 * Weapons balance calculator (audit 2026-11-01, docs/audits/weapons-balance-2026-11-01.md).
 *
 * Read-only: it loads the game data and runs the shared game code (common/src: rebuild, stepGuns, gunLoad,
 * powerTick, hitMultiplier, castParts, nearestParts) to measure every weapon model's real cadence, energy draw and
 * time to kill against built enemy ships. Nothing in the game is changed.
 *
 *   Run from game-v2/:   server/node_modules/.bin/tsx docs/audits/weapons-balance-calc.ts [--md]
 *
 * --md prints the markdown tables the audit doc uses; without it, a plain dump.
 *
 * Damage is applied the way server/src/ships/bridge/damage.ts `hurt` and splashAt do (shield first with vsShield,
 * then hull x vsHull x penetration x material resist; splash on the `reach` nearest parts with 1 - 0.7 d/r falloff;
 * spaced plating's splashTaken), and a ship dies when its core does. Assumptions are listed in the doc and marked
 * ASSUME below.
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { loadCatalog } from '../../common/src/ships/catalog.js';
import { parseBlueprint, blueprintGeometry } from '../../common/src/ships/blueprint.js';
import { createShipState, rebuildShip, damagePart, type ShipState } from '../../common/src/ships/state.js';
import { partWeaponDef, volleyAngles } from '../../common/src/ships/launch.js';
import { stepGuns } from '../../common/src/ships/guns.js';
import { gunLoad, powerTick, gunDrawFlatOut, BROWNOUT, type Charge } from '../../common/src/ships/energy.js';
import { hitMultiplier, weaponHit, type HitInfo } from '../../common/src/ships/damage.js';
import { castParts, nearestParts } from '../../common/src/ships/collide.js';
import { standing } from '../../common/src/ships/stages.js';
import { plated } from '../../common/src/ships/grades.js';
import { pulseProfile } from '../../common/src/ships/pulse.js';
import { accelAlong } from '../../common/src/ships/flight.js';
import type { WeaponInfo } from '../../common/src/ships/rebuild.js';
import type { Blueprint } from '../../common/src/ships/types.js';

const MD = process.argv.includes('--md');
const AFTER = process.argv.includes('--after');
const ROOT = join(__dirname, '../..');
const SD = join(ROOT, 'data/ships');
const rj = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const bespokeDir = join(SD, 'bespoke');
const tuning = rj(join(SD, 'tuning.json'));
const modelsFile = rj(join(SD, 'models.json'));
const MODELS: any[] = modelsFile.models;

// ---------------------------------------------------------------------------------------------------------------
// The audit's suggested numbers (docs/audits/weapons-balance-2026-11-01.md, "Suggestions"), applied in memory only
// with --after, so the doc's after-table is measured, not guessed. Each op names the file a real change would touch:
// tuning.json weapons.<kind>, or a model's row in scripts/econ/models.mjs (W row mods / FIRE block / demand).
//   dmg: x direct damage, splash: x splash damage, fire: fire block fields, energy: x its energy (demand, reloadE,
//   chargeE), mods: merged into weaponMods (add / set), kind: tuning.json weapons.<kind> fields
// ---------------------------------------------------------------------------------------------------------------
type Op = { model?: string; kind?: string; dmg?: number; splash?: number; fire?: Record<string, unknown>; energy?: number; mods?: { add?: Record<string, number>; set?: Record<string, unknown> }; tune?: Record<string, unknown> };
export const SUGGESTIONS: Op[] = [
  // Early (the starter's rivals): each should at least match the Pip at its job
  { model: 'autocannon_rattler', dmg: 7 / 5, fire: { interval: 5.5 }, energy: 1.78 },
  { model: 'flak_burst', dmg: 8 / 5, splash: 30 / 16, mods: { set: { fuse: 70 }, add: { pen: 0.5 } } },
  { model: 'mortar_lobber', splash: 90 / 70 },
  { model: 'laser_glint', dmg: 125 / 96, energy: 1.3 },
  { model: 'pulse_strobe', dmg: 12 / 9, mods: { set: { vsHull: 0.9 }, add: { pen: 0.5 } }, energy: 1.33 },
  { model: 'missile_dart', dmg: 40 / 30, splash: 45 / 34, fire: { interval: 72 } },
  // Mid
  { model: 'cannon_twinlink', fire: { reload: 70 } },
  { model: 'railgun_needle', dmg: 72 / 62, fire: { interval: 54 } },
  { model: 'autocannon_chainsaw', dmg: 8 / 5, energy: 1.6 },
  { model: 'flak_cloudmaker', dmg: 8 / 5, splash: 30 / 16, mods: { set: { fuse: 70 }, add: { pen: 0.5 } }, fire: { reload: 90 }, energy: 1.5 },
  { model: 'arc_spark', dmg: 50 / 34, energy: 1.47 },
  { model: 'laser_cutter', mods: { set: { ramp: { to: 120, ticks: 90 } } } },
  { model: 'torpedo_eel', mods: { set: { maxSpeed: 24, homing: 0.035 } } },
  // Late
  { model: 'cannon_longbarrel', dmg: 260 / 170, fire: { cooldown: 60 }, energy: 1.5 },
  { model: 'missile_swarm', fire: { rounds: 2, interval: 150 } },
  { model: 'autocannon_stinger', dmg: 2, fire: { interval: 6, reload: 48 }, mods: { add: { pen: 0.5 } }, energy: 2 },
  { model: 'pulse_overpulse', dmg: 14 / 9, fire: { clip: 16, reload: 60 }, mods: { set: { vsHull: 0.8 }, add: { pen: 0.5 } }, energy: 1.67 },
  { model: 'laser_searchlight', mods: { set: { dps: 40 } } },
  { model: 'railgun_spear', dmg: 210 / 160 },
  { model: 'arc_tesla', mods: { set: { dps: 100 } }, energy: 1.33 },
  { model: 'missile_hammerhead', dmg: 150 / 105, splash: 80 / 54, fire: { interval: 150 } },
  // Legendaries that are weaker than the starter
  { model: 'legendary_prism', dmg: 30 / 22, fire: { interval: 48 }, energy: 2 },
  { kind: 'prism_shard', tune: { damage: 18 } },
  { model: 'legendary_hive', fire: { regrow: 35 } },
  { model: 'legendary_cinder_bloom', fire: { interval: 60 } },
  { model: 'legendary_phase', dmg: 110 / 70, fire: { interval: 80 }, energy: 1.65 },
  { model: 'legendary_singularity', splash: 220 / 140, fire: { interval: 360 } },
];
function applySuggestions(): void {
  for (const op of SUGGESTIONS) {
    if (op.kind && op.tune) Object.assign(tuning.weapons[op.kind], op.tune);
    if (!op.model) continue;
    const m = MODELS.find((x) => x.id === op.model);
    if (!m) throw new Error('no model ' + op.model);
    const wm = (m.weaponMods ??= {});
    if (op.dmg) {
      if (wm.set?.damage !== undefined) wm.set.damage *= op.dmg;
      else { wm.mul ??= {}; wm.mul.damage = (1 + (wm.mul.damage ?? 0)) * op.dmg - 1; }
      if (wm.set?.dps !== undefined) wm.set.dps *= op.dmg;
      if (wm.set?.ramp) wm.set.ramp = { ...wm.set.ramp, to: wm.set.ramp.to * op.dmg };
    }
    if (op.splash) {
      if (wm.set?.splash) wm.set.splash = { ...wm.set.splash, damage: wm.set.splash.damage * op.splash };
      else { wm.mul ??= {}; wm.mul.splashDamage = (1 + (wm.mul.splashDamage ?? 0)) * op.splash - 1; }
    }
    if (op.mods?.add) { wm.add ??= {}; for (const [k, v] of Object.entries(op.mods.add)) wm.add[k] = (wm.add[k] ?? 0) + v; }
    if (op.mods?.set) wm.set = { ...(wm.set ?? {}), ...op.mods.set };
    if (op.fire) { m.fire = { ...m.fire, ...op.fire }; if (op.fire.interval !== undefined) m.fireInterval = op.fire.interval; }
    if (op.energy) {
      m.demand *= op.energy;
      for (const k of ['reloadE', 'chargeE']) if (m.fire[k] !== undefined) m.fire[k] *= op.energy;
    }
  }
}
if (AFTER) applySuggestions();
const catalog = loadCatalog({
  pieces: rj(join(SD, 'pieces.json')), functions: rj(join(SD, 'functions.json')), materials: rj(join(SD, 'materials.json')),
  models: modelsFile,
  bespoke: existsSync(bespokeDir) ? readdirSync(bespokeDir).filter((f) => f.endsWith('.json')).sort().map((f) => rj(join(bespokeDir, f))) : [],
});
const FACTIONS = rj(join(ROOT, 'data/factions.json'));
const BOSSES = rj(join(ROOT, 'data/bosses.json')).bosses;
const MOBS = rj(join(ROOT, 'data/mobs.json')).mobs;
const CS: number = tuning.cellSize;
const PIECE_AREA: Record<string, number> = { sq: 1, tri: 0.5, round: Math.PI / 4, rect2: 2, block2: 4, round2: Math.PI };
const SPARROW = readFileSync(join(SD, 'blueprints/sparrow-t.json'), 'utf8');
const UP = -Math.PI / 2;
const POSE = { x: 0, y: 0, angle: UP };

/** ASSUME: a typical fighting distance (faction behaviour.range is 520; the scrapborn like 520, pirates more) */
const RANGE = 600;
/** Seconds simulated for sustained numbers */
const SUSTAIN_S = 60;
/** Give up a kill after this long (s) */
const TTK_CAP = 300;

const NON_DAMAGE = new Set(['point_defence_turret', 'utility_repair_beam', 'utility_demolition_launcher']);
const weaponModels = MODELS.filter((m) => m.weapon && !NON_DAMAGE.has(m.id));

// ---------------------------------------------------------------------------------------------------------------
// The shooter: the starter Sparrow T with its Pips swapped for the model under test (as fireModels.test.ts does).
// The gun sits on the Pip's square, so its draw is set from the model's real piece (demand is per cell).
// ---------------------------------------------------------------------------------------------------------------
function armed(modelId: string, guns: 1 | 2): ShipState {
  const b = parseBlueprint(SPARROW);
  const pips = b.parts.filter((q) => q.fn === 'cannon_pip');
  pips[0].fn = modelId;
  if (guns === 2) pips[1].fn = modelId;
  else { pips[1].fn = 'hull'; delete (pips[1] as any).facing; }
  const s = createShipState(catalog, tuning, 1, b, 0);
  const m = MODELS.find((x) => x.id === modelId);
  const area = PIECE_AREA[m.pieces[0]] ?? 1;
  for (const w of s.derived.weapons) {
    const draw = m.demand * area;
    s.derived.power!.draw[w.part] = draw;
    w.energy = w.fire.model === 'beam' ? draw / 60 : (draw * w.interval) / 60;
  }
  return s;
}

/** The world angle a gun is pointed along (its turret window's centre, or its facing): what the sim aims at */
function aimOf(w: WeaponInfo): number {
  const local = w.window ? w.window.center : Math.atan2(w.dir[1], w.dir[0]);
  return local + POSE.angle + Math.PI / 2;
}

// Energy setups ------------------------------------------------------------------------------------------------
interface EnergySetup { id: string; name: string; spare: number; poolCap: number; poolRate: number; engines: number; bank?: { cap: number; rate: number } }
/** ASSUME: the pilot thrusts (not boosting) the whole time they fire: a dogfight */
const SETUPS: EnergySetup[] = [
  { id: 'starter', name: 'Starter (Sparrow T: 2 Cell Reactors 70/s, core 240 store, 2 Ion Drives 18/s)', spare: 70, poolCap: 240, poolRate: 720, engines: 18 },
  { id: 'mid', name: 'Modest (4 Cell Reactors 140/s, core + 2 Batteries 640 store, Plasma Drive 40/s)', spare: 140, poolCap: 640, poolRate: 720 + 1200, engines: 40 },
  { id: 'bank', name: 'Modest + 2 Capacitors touching the guns (bank 320, 4,000/s)', spare: 140, poolCap: 640, poolRate: 720 + 1200, engines: 40, bank: { cap: 320, rate: 4000 } },
];
function applySetup(s: ShipState, e: EnergySetup): Charge {
  const L = s.derived.power!;
  L.spare = e.spare;
  L.pool.cap = e.poolCap; L.pool.rate = e.poolRate;
  const thr = s.derived.thrusters;
  for (const t of thr) L.draw[t.part] = e.engines / thr.length;
  if (e.bank) {
    const guns = s.derived.weapons.map((w) => w.part);
    L.banks.push({ kind: 'cap', parts: [], cap: e.bank.cap, rate: e.bank.rate, intake: e.bank.cap / 4 /* a Capacitor's 40 per 160 held */, feeds: guns, shields: [], refills: true, dynamo: 0, dynamos: [] } as any);
    const f = L.feeds.length;
    L.feeds.push({ banks: [L.banks.length - 1] });
    for (const p of guns) L.feedOf[p] = f;
    return { g: 100, b: [100] };
  }
  return { g: 100, b: [] };
}

// The gun timeline ---------------------------------------------------------------------------------------------
interface Tick { shots: WeaponInfo[]; beams: WeaponInfo[]; pulses: WeaponInfo[] }
interface Timeline { ticks: Tick[]; brownoutAt: number; minShare: number; drawn: number; poolEnd: number; shotsFired: number; beamTicks: number }

function timeline(modelId: string, guns: 1 | 2, ticks: number, setup?: EnergySetup, firing: (t: number) => boolean = () => true): Timeline {
  const s = armed(modelId, guns);
  let charge = setup ? applySetup(s, setup) : undefined;
  const out: Tick[] = [];
  let brownoutAt = -1, minShare = 1, drawn = 0, shotsFired = 0, beamTicks = 0;
  for (let t = 1; t <= ticks; t++) {
    let energy: { charge: Charge } | undefined;
    if (setup && charge) {
      const load = gunLoad(s, t) ?? [];
      const r = powerTick(s.derived, charge, { thrusting: true, boosting: false, load }, tuning);
      charge = r.charge;
      energy = { charge };
      const f = s.derived.power!.feedOf[s.derived.weapons[0].part];
      const share = charge.gun?.[f] ?? 1;
      const asked = load[f] ?? 0;
      if (asked > 1e-9) {
        drawn += (asked * share) / 60;
        if (share < BROWNOUT && brownoutAt < 0) brownoutAt = t;
        minShare = Math.min(minShare, share);
      }
    }
    const w0 = s.derived.weapons[0];
    const r = stepGuns(s, POSE, { firing: firing(t), aimWorld: aimOf(w0), aimDist: 0, energy }, t, tuning);
    out.push({ shots: r.shots.map((x) => x.w), beams: r.beams, pulses: r.pulses.map((x) => x.w) });
    shotsFired += r.shots.length + r.pulses.length;
    beamTicks += r.beams.length;
  }
  return { ticks: out, brownoutAt, minShare, drawn, poolEnd: charge ? charge.g : 100, shotsFired, beamTicks };
}

// The targets --------------------------------------------------------------------------------------------------
const designs: Record<string, Blueprint> = {};
for (const f of readdirSync(join(SD, 'blueprints/enemy'))) if (f.endsWith('.json')) designs[f.replace('.json', '')] = parseBlueprint(readFileSync(join(SD, 'blueprints/enemy', f), 'utf8'));

interface TargetDef { id: string; label: string; tier: string; design: string; grade: number; plating: number; hp: number; coreK?: number; asDesigned?: boolean }
const fac = (f: string) => FACTIONS.factions[f]?.hpScale ?? 1;
const ELITE = FACTIONS.rules.eliteHp;
const TARGETS: TargetDef[] = [
  { id: 'mite', label: 'Scrap Mite (Sol, Mk I)', tier: 'start', design: 'scrap_mite', grade: 1, plating: 0, hp: fac('scrapborn') },
  { id: 'crawler', label: 'Scrap Crawler (Sol, Mk I)', tier: 'start', design: 'scrap_crawler', grade: 1, plating: 0, hp: fac('scrapborn') },
  { id: 'skiff', label: 'Pirate Skiff (Sol lanes, Mk I)', tier: 'start', design: 'pirate_skiff', grade: 1, plating: 0, hp: fac('pirates') },
  { id: 'cutter', label: 'Redtooth Cutter (Sol/Ashfall, Mk I)', tier: 'start', design: 'redtooth_cutter', grade: 1, plating: 0, hp: fac('redtooth') },
  { id: 'brawler', label: 'Redtooth Brawler (Sol camp, Mk I)', tier: 'start', design: 'redtooth_brawler', grade: 1, plating: 0, hp: fac('redtooth') },
  { id: 'raider2', label: 'Pirate Raider Mk II (Nebula Prime)', tier: 'mid', design: 'pirate_raider', grade: 2, plating: 0, hp: fac('pirates') },
  { id: 'warden2', label: 'Frost Warden Mk II (Borealis, shielded)', tier: 'mid', design: 'frost_warden', grade: 2, plating: 0, hp: fac('frost') },
  { id: 'zealot3', label: 'Cinder Zealot Mk III (Cinder Reach)', tier: 'mid', design: 'cinder_zealot', grade: 3, plating: 0, hp: fac('cinder') },
  { id: 'eliteGun2', label: 'Elite Pirate Gunship Mk II (x1.7 HP, plate +1)', tier: 'elite', design: 'pirate_gunship', grade: 2, plating: 1, hp: fac('pirates') * ELITE },
  { id: 'tallyman', label: 'The Tallyman (Sol boss: Gunship Mk I, plate +1, x4 HP, core x2.5)', tier: 'boss', design: 'pirate_gunship', grade: 1, plating: BOSSES.boss_tallyman.plating ?? 1, hp: BOSSES.boss_tallyman.hp, coreK: 2.5 },
];

function makeTarget(t: TargetDef): ShipState {
  const bp = t.asDesigned ? designs[t.design] : plated(catalog, designs[t.design], t.grade, t.plating);
  const s = createShipState(catalog, tuning, 2, bp, 0);
  if (t.hp !== 1) { s.maxHp = s.maxHp.map((h) => h * t.hp); s.hp = [...s.maxHp]; }
  if (t.coreK) bp.parts.forEach((p, i) => { if (p.fn === 'core') { s.maxHp[i] *= t.coreK!; s.hp[i] = s.maxHp[i]; } });
  s.rebuildHp = [...s.hp];
  return s;
}

/** Top speed along a ship-local direction (world units a tick), friction 0.985 (common/src/constants.ts) */
function topSpeed(s: ShipState, dir: [number, number]): number {
  let v = 0;
  for (let i = 0; i < 2000; i++) v = (v + accelAlong(s.derived, dir, v)) * 0.985;
  return v;
}

// One fight: a gun's timeline against one target ---------------------------------------------------------------
interface Fight { ttk: number; shots: number; dealtShield: number; dealtHull: number; killed: boolean }

function fight(modelId: string, guns: 1 | 2, target: TargetDef, tl?: Timeline, shotOffset = 0): Fight {
  const s = makeTarget(target);
  const geoms = blueprintGeometry(catalog, s.blueprint);
  const core = s.blueprint.parts.findIndex((p) => p.fn === 'core');
  const ok = (i: number) => s.hp[i] > 0 && !s.detached[i] && s.derived.alive[i] && standing(catalog, s, i);
  const cx = geoms[core].centroid[0];
  let minY = Infinity, maxY = -Infinity;
  for (const g of geoms) { minY = Math.min(minY, g.bbox.minY); maxY = Math.max(maxY, g.bbox.maxY); }
  const m = MODELS.find((x) => x.id === modelId);
  const shooter = armed(modelId, guns);
  const w0 = shooter.derived.weapons[0];
  const def: any = partWeaponDef(tuning, w0.kind, undefined, { model: w0.model });
  const hit: HitInfo = weaponHit(w0.kind, def, w0.grade);
  const T = tl ?? timeline(modelId, guns, TTK_CAP * 60);
  let dealtShield = 0, dealtHull = 0, lastShieldHit = -1e9, dead = false;
  let rampPart = -1, rampTicks = 0, rampLast = -100, lit = 0, litLast = -10;
  const burns: { part: number; until: number; dps: number }[] = [];
  const pending: { at: number; fn: () => void }[] = [];

  /** server hurt(): shield first, then the part, as much as gets through */
  const hurt = (part: number, amount: number, opts: { shield?: number; hull?: number; splash?: boolean; h?: HitInfo }, tick: number) => {
    if (dead || amount <= 0 || part < 0) return;
    if (opts.splash) amount *= catalog.functions.get(s.blueprint.parts[part].fn)?.splashTaken ?? 1;
    if (s.shield > 0 && (opts.shield ?? 1) > 0) {
      const k = opts.shield ?? 1;
      const soak = Math.min(s.shield, amount * k);
      s.shield -= soak; amount -= soak / k; dealtShield += soak; lastShieldHit = tick;
    }
    const through = hitMultiplier(catalog, tuning, s.blueprint.parts[part], opts.h ?? hit);
    if (amount > 0) {
      const d = damagePart(s, part, Math.min(amount * (opts.hull ?? 1) * through, Math.max(0, s.hp[part])), tuning);
      dealtHull += d;
      if (s.hp[part] <= 0) {
        if (part === core) { dead = true; return; }
        rebuildShip(s, catalog, tuning);
      }
    }
  };
  /** The first standing part along the line from the front (enemies face you), `lat` cells to the side of the core */
  const front = (lat = 0): { part: number; gy: number } | null => {
    const h = castParts(geoms, ok, cx + lat, minY - 3, cx + lat, maxY + 3, 0);
    return h ? { part: h.part, gy: minY - 3 + (maxY - minY + 6) * h.t } : null;
  };
  const splash = (gx: number, gy: number, radius: number, damage: number, tick: number) => {
    const reach = Math.max(3, Math.round(radius / CS));
    const near = nearestParts(geoms, ok, gx, gy, radius / CS);
    for (let k = 0; k < near.length && k < reach && !dead; k++) hurt(near[k].i, damage * (1 - 0.7 * ((near[k].d * CS) / radius)), { splash: true }, tick);
  };
  /** One shell arriving (ASSUME: it hits, aimed at the core; travel time ignored) */
  const shell = (d: any, tick: number, lat = 0, along = 0) => {
    // A lobbed shell passes over everything and lands at the cursor (ASSUME: on the core), a walking one `along` world units from it
    if (d.lob && d.splash) { splash(cx + lat, geoms[core].centroid[1] + along / CS, d.splash.radius, d.splash.damage, tick); return; }
    const f = front(lat);
    if (!f) return;
    const vs = { shield: d.vsShield, hull: d.vsHull };
    if (d.fuse && d.splash && !d.homing) {
      // Flak: bursts on its fuse, ASSUME on average half a tick's flight inside it (fuse 120, shell 34 a tick: 103 short of the hull)
      splash(cx + lat, f.gy - Math.max(0, d.fuse - (d.speed ?? 34) / 2) / CS, d.splash.radius, d.splash.damage, tick);
      return;
    }
    if (d.hold && d.splash) { splash(s.derived.com[0], s.derived.com[1], d.splash.radius, d.splash.damage, tick); return; } // Singularity collapses on it
    if (d.split) {
      // Prism: ASSUME aimed a little short, so it splits in front and 3 of its 5 shards land (aimed on the hull it hits whole and the shards fly past)
      const sd: any = tuning.weapons[d.split.kind];
      for (let k = 0; k < 3; k++) hurt(f.part, sd.damage, {}, tick);
      return;
    }
    if ((d.damage ?? 0) > 0) hurt(f.part, d.damage, vs, tick);
    if (d.ignite) {
      const cur = burns.find((b) => b.part === f.part);
      if (cur) cur.until = Math.max(cur.until, tick + d.ignite.ticks); else burns.push({ part: f.part, until: tick + d.ignite.ticks, dps: d.ignite.dps });
    }
    if (d.splash) { const g = front(lat); splash(cx + lat, g ? g.gy : f.gy, d.splash.radius, d.splash.damage, tick); }
  };
  /** A volley's shells (a burst, a salvo's or walk's later shells), each its lateral offset at RANGE for an exact fan */
  const volley = (tick: number) => {
    const n = def.burst ?? 1;
    const angles = n > 1 && def.jitter !== undefined ? volleyAngles(def, 0) : Array(n).fill(0);
    // (A walking salvo's shells land at 70%, 100% and 130% of the aim distance: ASSUME the aim is on the core, so the first lands short, the last long)
    const off = (i: number) => (def.walk ? (def.walk.at[i] - 1) * RANGE : 0);
    for (const a of angles) shell(def, tick, (RANGE * Math.tan(a)) / CS, off(0));
    const later = def.salvo?.count ?? def.walk?.at.length ?? 1;
    const gap = def.salvo?.gap ?? def.walk?.gap ?? 0;
    for (let i = 1; i < later; i++) pending.push({ at: tick + gap * i, fn: () => shell(def, tick + gap * i, 0, off(i)) });
  };
  let shots = 0, t = 0;
  for (t = 1; t <= T.ticks.length && !dead; t++) {
    // shield regen
    if (s.derived.shieldMax > 0 && s.shield < s.derived.shieldMax && t - lastShieldHit > s.derived.shieldDelay) s.shield = Math.min(s.derived.shieldMax, s.shield + s.derived.shieldRegen / 60);
    const tk = T.ticks[t - 1];
    for (const _ of tk.shots) { shots++; volley(t + shotOffset); }
    for (const w of tk.pulses) {
      shots++;
      const prof = pulseProfile(def.pulse);
      for (let a = 0; a < prof.ticks; a++) pending.push({ at: t + a, fn: () => { const f = front(); if (f) hurt(f.part, def.damage * prof.share[a], {}, t + a); } });
    }
    for (const w of tk.beams) {
      const f = front();
      if (!f) continue;
      let dmg = (def.dps ?? 0) / 60;
      // (a Tesla burns its dps x zap / 60 all at once every `zap` ticks)
      if (def.zap) dmg = t % def.zap === 0 ? (def.dps * def.zap) / 60 : 0;
      if (t - litLast > 1) lit = 0;
      lit++; litLast = t;
      if (w.fire.windup) dmg *= Math.min(1, lit / w.fire.windup);
      if (def.ramp) {
        // (the Cutter: deeper the longer it stays on one part; a new part or a gap over 4 ticks starts it over)
        if (f.part !== rampPart || t - rampLast > 4) { rampPart = f.part; rampTicks = 0; }
        const k = def.dps + (def.ramp.to - def.dps) * Math.min(1, rampTicks / def.ramp.ticks);
        dmg *= k / def.dps;
        rampTicks++; rampLast = t;
      }
      if (def.armorBonus && s.blueprint.parts[f.part].fn === 'armor') dmg *= def.armorBonus;
      hurt(f.part, dmg, {}, t);
    }
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].at === t) { const p = pending[i]; pending.splice(i, 1); p.fn(); }
    // burns tick every 10 ticks; a burning part lost passes its fire to the front part (ASSUME: the spread)
    if (t % 10 === 0) for (const b of burns) {
      if (t >= b.until) continue;
      if (s.hp[b.part] <= 0 || !s.derived.alive[b.part]) { const f = front(); if (!f) continue; b.part = f.part; }
      hurt(b.part, (b.dps * 10) / 60, { h: weaponHit('cinder_bloom', def, w0.grade) }, t);
    }
  }
  // (the last shell still has to get there: its flight to RANGE, and a Singularity's hold before it collapses)
  const arrive = (flightTicks(def, RANGE) + (def.hold ?? 0)) / 60;
  return { ttk: dead ? (t - 1) / 60 + arrive : Infinity, shots, dealtShield, dealtHull, killed: dead };
}

/** Raw damage a shot (a volley) carries, ignoring armour: direct + one full splash, for every shell of it (ASSUME: splash lands once at full) */
function rawPerShot(def: any, fire: any): number {
  if (def.pulse) return def.damage;
  const shells = (def.burst ?? 1) * (def.salvo?.count ?? def.walk?.at.length ?? 1);
  if (def.split) return 3 * tuning.weapons[def.split.kind].damage;
  const ign = def.ignite ? (def.ignite.dps * def.ignite.ticks) / 60 : 0;
  return ((def.damage ?? 0) + (def.splash?.damage ?? 0)) * shells + ign;
}

// Hit difficulty -----------------------------------------------------------------------------------------------
function flightTicks(def: any, dist: number): number {
  if (def.type === 'beam' || def.pulse || def.dps !== undefined && def.speed === undefined) return 0;
  if (def.zap) return 0;
  let v = def.speed ?? 48, x = 0, t = 0;
  while (x < dist && t < 2000) { x += v; t++; if (def.accel) v = Math.min(def.maxSpeed ?? v, v + def.accel); }
  return t;
}
function rangeOf(def: any, fire: any): number {
  if (def.type === 'beam' || fire.model === 'beam' || def.pulse) return def.range ?? 0;
  if (def.lob) return 2640;
  let v = def.speed ?? 48, x = 0;
  for (let t = 0; t < (def.life ?? 150); t++) { x += v; if (def.accel) v = Math.min(def.maxSpeed ?? v, v + def.accel); }
  return x;
}

// ---------------------------------------------------------------------------------------------------------------
// Run it
// ---------------------------------------------------------------------------------------------------------------
const f1 = (v: number) => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) : '-');
const secs = (v: number) => (Number.isFinite(v) ? (v >= 100 ? v.toFixed(0) : v.toFixed(1)) : 'never');

interface Row { id: string; name: string; lvl: number; grade: number; piece: string; model: string; mount: string; perShot: number; burstDps: number; sustDps: number; ePerShot: string; eps: number;
  range: number; speed: string; flight600: number; spread: number; e: Record<string, { brown: string; frac: number; outFrac: number; spareFrac: number }>; ttk: Record<string, Fight>; clipLabel: string; note: string;
  eff: number[]; own: number; mob: number; beam: boolean; clip?: number; crate: number }

/** What gets through to a part (vs hull x penetration x resist), for the reference armours: Mk I hull, Mk I plate, Mk II hull, Mk III hull */
const REF_PARTS = [{ fn: 'hull', material: 'alloy' }, { fn: 'armor', material: 'alloy' }, { fn: 'hull', material: 'steel' }, { fn: 'hull', material: 'titanium' }];
const GRADE_MAT = ['alloy', 'steel', 'titanium', 'cobalt', 'neutronium'];
function effMul(kind: string, def: any, grade: number, p: { fn: string; material: string }): number {
  const k = def.ignite ? 'cinder_bloom' : kind;
  return (def.vsHull ?? 1) * hitMultiplier(catalog, tuning, p, weaponHit(k, def, grade)) * (def.armorBonus && p.fn === 'armor' ? def.armorBonus : 1);
}
/** Seconds to kill a mob of `hp` (a circle: no shield or armour; Mobs.ts hurt), every shot hitting; a beam on a mob gets no ramp */
function mobTtk(def: any, tl: Timeline, hp: number): number {
  let dealt = 0, lit = 0;
  for (let t = 0; t < tl.ticks.length; t++) {
    const k = tl.ticks[t];
    for (const _ of k.shots) dealt += rawPerShot(def, null);
    // (a pulse's damage peaks pulse.peakAt of the way through it)
    for (const _ of k.pulses) { dealt += def.damage; if (dealt >= hp) return (t + pulseProfile(def.pulse).peak) / 60; }
    for (const w of k.beams) { lit++; let d = (def.dps ?? 0) / 60; if (def.zap) d = (t + 1) % def.zap === 0 ? (def.dps * def.zap) / 60 : 0; if (w.fire.windup) d *= Math.min(1, lit / w.fire.windup); dealt += d; }
    if (dealt >= hp) return t / 60 + (flightTicks(def, RANGE) + (def.hold ?? 0)) / 60;
  }
  return Infinity;
}

const rows: Row[] = [];
const ticks = SUSTAIN_S * 60;
for (const m of weaponModels) {
  const s = armed(m.id, 1);
  const w = s.derived.weapons[0];
  if (!w) { console.error('no weapon for', m.id); continue; }
  const def: any = partWeaponDef(tuning, w.kind, undefined, { model: w.model });
  const f = w.fire;
  const area = PIECE_AREA[m.pieces[0]] ?? 1;
  const draw = m.demand * area;
  // Free power: the gun's own cadence
  const free = timeline(m.id, 1, ticks);
  const per = f.model === 'beam' ? 0 : rawPerShot(def, f);
  let sustDps: number, burstDps: number;
  if (f.model === 'beam') {
    const top = def.ramp?.to ?? def.dps ?? 0;
    sustDps = (top * free.beamTicks) / ticks; burstDps = top;
    if (def.ramp) sustDps = top; // (on one part, after its ramp)
  } else {
    sustDps = (free.shotsFired * per) / SUSTAIN_S;
    const firstGap = f.model === 'charge' ? f.charge : f.model === 'clip' ? f.interval : (f.spin ? f.spin.to * w.interval / f.interval : w.interval);
    burstDps = (per * 60) / firstGap;
  }
  const eps = gunDrawFlatOut(w, draw);
  const ePerShot = f.model === 'ammo' ? `${f.rounds ?? 1} round${(f.rounds ?? 1) > 1 ? 's' : ''}` : f.model === 'beam' ? `${f1(draw)}/s` : f.model === 'clip' ? `${f1(f.reloadE)}/clip` : f.model === 'charge' ? `${f1(f.chargeE)}/charge` : `${f1((draw * w.interval) / 60)}/shot`;
  const e: Row['e'] = {};
  for (const st of SETUPS) {
    const tl = timeline(m.id, 2, ticks, st);
    const frac = (tl.shotsFired + tl.beamTicks) / Math.max(1, 2 * (free.shotsFired + free.beamTicks));
    e[st.id] = { brown: tl.brownoutAt < 0 ? 'never' : (tl.brownoutAt / 60).toFixed(1) + ' s', frac, outFrac: (2 * eps) / (st.spare - st.engines + st.poolRate), spareFrac: (2 * eps) / (st.spare - st.engines) };
  }
  const longTl = timeline(m.id, 1, TTK_CAP * 60);
  const ttk: Row['ttk'] = {};
  for (const t of TARGETS) ttk[t.id] = fight(m.id, 1, t, longTl);
  const clipLabel = f.model === 'clip' ? `clip ${f.clip}${f.regrow ? ` regrow ${f.regrow}t` : `, reload ${f.reload}t`}` : f.model === 'charge' ? `charge ${f.charge}t, cool ${f.cooldown}t` : f.spin ? `spin ${f.spin.from}->${f.spin.to}t` : f.windup ? `windup ${f.windup}t` : '';
  rows.push({
    id: m.id, name: m.name, lvl: m.unlock?.level ?? 0, grade: m.grade, piece: m.pieces[0], model: f.model + (f.regrow ? '+regrow' : ''), mount: m.mount,
    perShot: per, burstDps, sustDps, ePerShot, eps, range: rangeOf(def, f), speed: def.type === 'beam' || f.model === 'beam' || def.pulse ? 'instant' : def.zap ? 'instant' : `${f1(def.speed ?? 48)}${def.maxSpeed ? '->' + f1(def.maxSpeed) : ''}`,
    flight600: flightTicks(def, RANGE), spread: def.spread ?? 0, e, ttk, clipLabel,
    eff: REF_PARTS.map((p) => sustDps * effMul(w.kind, def, w.grade, p)), own: sustDps * effMul(w.kind, def, w.grade, { fn: 'hull', material: GRADE_MAT[w.grade - 1] }), crate: f.model === 'ammo' && def.ammo ? (def.ammo.rounds / (f.rounds ?? 1)) * (w.interval / 60) : 0, mob: mobTtk(def, longTl, MOBS.scrap_mite.hp), beam: f.model === 'beam' || !!def.pulse, clip: f.model === 'clip' && !f.regrow ? f.clip : undefined,
    note: [def.homing ? `homing ${+def.homing.toFixed(3)}` : '', def.guided ? 'guided' : '', def.lob ? 'lobbed to cursor' : '', def.vsShield === 0 ? 'ignores shields' : def.vsShield ? `x${def.vsShield} shields / x${def.vsHull} hull` : '', def.emp ? 'EMP' : '', def.mark ? 'marks +20%' : '', def.slow ? 'slows' : '', def.chain ? `chains ${def.chain.count}` : '', def.pierce ? `pierce ${def.pierce}` : ''].filter(Boolean).join(', '),
  });
}

// The starter pair (2 Pips), the reference
const pairTl = timeline('cannon_pip', 2, TTK_CAP * 60);
const pairTtk: Record<string, Fight> = {};
for (const t of TARGETS) pairTtk[t.id] = fight('cannon_pip', 2, t, pairTl);

// Targets' own numbers
const tgtInfo = TARGETS.map((t) => {
  const s = makeTarget(t);
  const core = s.blueprint.parts.findIndex((p) => p.fn === 'core');
  const total = s.maxHp.reduce((a, b) => a + b, 0);
  const plates = s.blueprint.parts.filter((p) => p.fn === 'armor').length;
  const mats = [...new Set(s.blueprint.parts.map((p) => p.material))].join('/');
  return { t, parts: s.blueprint.parts.length, total, core: s.maxHp[core], shield: s.derived.shieldMax, regen: s.derived.shieldRegen, plates, mats,
    fwd: topSpeed(s, [0, -1]), side: topSpeed(s, [1, 0]), radius: s.derived.radius };
});
const pipFree = rows.find((r) => r.id === 'cannon_pip')!;
/** Pip TTK / its TTK, geometric mean over a band of targets (a gun that never kills counts as 20x slower) */
function killSpeed(r: Row, band: 'start' | 'later'): number {
  const ts = TARGETS.filter((t) => (band === 'start') === (t.tier === 'start'));
  let lg = 0;
  for (const t of ts) { const a = pipFree.ttk[t.id].ttk, b = r.ttk[t.id].ttk; lg += Math.log(Number.isFinite(b) ? a / Math.max(b, 0.05) : 0.05); }
  return Math.exp(lg / ts.length);
}

if (!MD) {
  console.log(JSON.stringify({ rows: rows.map((r) => ({ ...r, ttk: Object.fromEntries(Object.entries(r.ttk).map(([k, v]) => [k, +v.ttk.toFixed(1)])) })), pair: Object.fromEntries(Object.entries(pairTtk).map(([k, v]) => [k, +v.ttk.toFixed(1)])), targets: tgtInfo.map((x) => ({ ...x, t: x.t.id })) }, null, 1));
} else {
  const L: string[] = [];
  L.push('### Enemies used\n');
  L.push('| Enemy | Tier | Parts | Total HP | Core HP | Shield (regen/s) | Plates | Material | Top speed fwd / side (u/tick) | Radius (u) |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const x of tgtInfo) L.push(`| ${x.t.label} | ${x.t.tier} | ${x.parts} | ${f1(x.total)} | ${f1(x.core)} | ${x.shield ? `${f1(x.shield)} (${f1(x.regen)})` : '-'} | ${x.plates} | ${x.mats} | ${f1(x.fwd)} / ${f1(x.side)} | ${f1(x.radius)} |`);
  L.push('\n### Per weapon: firing, damage, energy\n');
  const skiff = tgtInfo.find((x) => x.t.id === 'skiff')!;
  L.push(`Player Sparrow T top speed: ${f1(topSpeed(createShipState(catalog, tuning, 3, parseBlueprint(SPARROW), 0), [0, -1]))} u/tick forward.
`);
  L.push('| Weapon | Lvl / Mk | Firing | Dmg/shot (raw) | Burst DPS | Sustained DPS | x Pip | Eff. DPS vs Mk I hull / Mk I plate / Mk II hull / Mk III hull | Energy | E/s flat out | Range | Shell speed | Skiff drift at 600 u | 55 HP mob | Crate lasts | Notes |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) L.push(`| ${r.name} | ${r.lvl} / ${r.grade} | ${r.model}${r.clipLabel ? ` (${r.clipLabel})` : ''}, ${r.mount} | ${r.beam && !r.perShot ? '-' : f1(r.perShot)} | ${f1(r.burstDps)} | ${f1(r.sustDps)} | ${(r.sustDps / pipFree.sustDps).toFixed(2)} | ${r.eff.map(f1).join(' / ')} | ${r.ePerShot} | ${f1(r.eps)} | ${f1(r.range)} | ${r.speed} | ${r.flight600 ? `${f1(skiff.side * r.flight600)} u (${r.flight600} t)` : 'none'} | ${secs(r.mob)} s | ${r.crate ? f1(r.crate) + ' s' : '-'} | ${r.note} |`);
  L.push('\n### Energy: two of the gun, held for 60 s while thrusting\n');
  L.push('Each cell: first brownout / share of its free-power shots it still fires over 60 s / two guns flat out as a share of the spare generation left after the engines / as a share of the Output.\n');
  L.push(`| Weapon | ${SETUPS.map((s) => s.id).join(' | ')} |`);
  L.push(`|---|${SETUPS.map(() => '---').join('|')}|`);
  for (const r of rows) L.push(`| ${r.name} | ${SETUPS.map((s) => `${r.e[s.id].brown} / ${(r.e[s.id].frac * 100).toFixed(0)}% / ${(r.e[s.id].spareFrac * 100).toFixed(0)}% / ${(r.e[s.id].outFrac * 100).toFixed(0)}%`).join(' | ')} |`);
  L.push('\n### Summary (sorted by unlock level)\n');
  L.push('Kill speed: how much faster than one Pip it kills, the geometric mean over the start-area targets (mite to brawler) and over the later ones (raider to boss): Pip TTK / its TTK.\n');
  L.push('| Weapon | Lvl / Mk | Sustained DPS | Eff. DPS vs its own Mk of hull | x Pip (eff., own Mk) | Kill speed vs Pip: start / later | E/s flat out | Pair on starter: brownout |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const r of [...rows].sort((a, b) => a.lvl - b.lvl)) L.push(`| ${r.name} | ${r.lvl} / ${r.grade} | ${f1(r.sustDps)} | ${f1(r.own)} | ${(r.own / pipFree.own).toFixed(2)} | ${killSpeed(r, 'start').toFixed(2)} / ${killSpeed(r, 'later').toFixed(2)} | ${f1(r.eps)} | ${r.e.starter.brown} |`);
  L.push('\n### Time to kill (one gun, full power, every shot hits, aimed at the core from the front)\n');
  L.push(`| Weapon | ${TARGETS.map((t) => t.id).join(' | ')} |`);
  L.push(`|---|${TARGETS.map(() => '---').join('|')}|`);
  L.push(`| **2x Pip (starter)** | ${TARGETS.map((t) => secs(pairTtk[t.id].ttk)).join(' | ')} |`);
  for (const r of rows) L.push(`| ${r.name} | ${TARGETS.map((t) => { const x = r.ttk[t.id]; return !x.killed ? 'never' : r.beam && !r.perShot ? secs(x.ttk) : `${secs(x.ttk)} (${x.shots}${r.clip ? `, ${Math.ceil(x.shots / r.clip)} clip${Math.ceil(x.shots / r.clip) > 1 ? 's' : ''}` : ''})`; }).join(' | ')} |`);
  console.log(L.join('\n'));
}
