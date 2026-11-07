/**
 * Heavier shots bench (docs/design/heavier-shots-2026-11.md): stated DPS against landed DPS for every shell-firing
 * player gun, at moving targets, with a competent aim. Read-only: it loads the game data and steps the shared,
 * deterministic weapon code (common/src: stepGuns, volleyShells / launchShot, gunDef, guideTick, distDue, castParts,
 * nearestParts, hitMultiplier). Nothing in the game is changed; `--after` applies PROPOSAL (a trial) to an in-memory
 * copy of models.json before the catalogue is built.
 *
 *   Run from game-v2/:   server/node_modules/.bin/tsx scripts/bench/heavierShots.ts [--after] [--md] [--only id,id] [--enemy]
 *
 * The rig: the starter Sparrow T with one Pip swapped for the gun (the other made hull), standing still at the origin,
 * the trigger held (a semi-automatic gun clicked as fast as it takes). Targets fly across the line of fire at the given
 * range, facing the shooter as an engaged AI does, jinking (reversing at seeded random times, at their real top speed
 * and thrust). The pilot leads: its cursor goes where the target will be when a round at the gun's own launch speed
 * gets there, from a smoothed reading of the target's velocity (a human reaction, REACT ticks), with a small hand
 * wobble. Homing shells lock the target; the Hammerhead is steered to the cursor; mortars and aim-burst shells end at
 * the held aim distance (GunStep.dist). Shells fly as the server flies them (straight, the waypoint law for homing,
 * Weapons.guide for guided) and hit the target's real part outlines (castParts with the shell's radius); splash is
 * splashAt's (the `reach` nearest parts, 1 - 0.7 d/r); a hit takes hitMultiplier (type x armour x penetration) and
 * at most the part's HP left (no overkill carries over: hitRules partHit). A target whose core goes is put back whole.
 *
 * Measured per (gun, target, range), over FIRE_S seconds of fire and two jink seeds:
 *   volleys/s, shells/s; stated DPS (each shell's nominal direct + splash damage x shells/s, reloads and charges
 *   included); landed DPS (raw: damage as it arrived; eff: through armour and part HP); hit rate (shells that
 *   struck or burst on the target / fired); aim-distance updates/s while firing (distDue ticks: each a gun row of
 *   about 3.2 B to every client stepping that ship, docs/audits/bitpack-2026-11-06.md).
 * Left out: shields (the targets have none), arc chains and pierce (one target), EMP, beams and the Glint's pulse
 * (no rounds), the Singularity's pull. Ignite (Cinder Bloom) burns its dps on the struck target while lit.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadCatalog } from '../../common/src/ships/catalog.js';
import { parseBlueprint, blueprintGeometry } from '../../common/src/ships/blueprint.js';
import { createShipState, rebuildShip, type ShipState } from '../../common/src/ships/state.js';
import { gunDef, volleyShells, aimReach, lifeToReach, endsAtAim } from '../../common/src/ships/launch.js';
import { stepGuns, distDue } from '../../common/src/ships/guns.js';
import { hitMultiplier, weaponHit } from '../../common/src/ships/damage.js';
import { castParts, nearestParts, partDistance } from '../../common/src/ships/collide.js';
import { standing } from '../../common/src/ships/stages.js';
import { accelAlong, worldToLocalDir } from '../../common/src/ships/flight.js';
import { guideKind, guideTick, newGuide, qGuide, type Guide, type GuideBody } from '../../common/src/guidance/waypoints.js';
import { steerToward } from '../../common/src/ships/features/weaponry/weaponry.js';
import type { WeaponInfo } from '../../common/src/ships/rebuild.js';
import type { WeaponTuning } from '../../common/src/ships/tuning.js';
import { leadTicks, roundLead } from '../../common/src/bodies/aiLead.js';

const argv = process.argv;
const AFTER = argv.includes('--after'), MD = argv.includes('--md'), ENEMY = argv.includes('--enemy');
const ONLY = (() => { const i = argv.indexOf('--only'); return i > 0 ? new Set(argv[i + 1].split(',')) : null; })();
const ROOT = join(__dirname, '../..');
const SD = join(ROOT, 'data/ships');
const rj = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const tuning = rj(join(SD, 'tuning.json'));
const modelsFile = rj(join(SD, 'models.json'));
const MODELS: any[] = modelsFile.models;
const CS: number = tuning.cellSize;

/** Seconds of held fire a scenario measures (then the shells still flying land) */
const FIRE_S = 15;
/** The pilot's reaction: ticks its read of the target's velocity lags by (an exponential smoothing time constant) */
const REACT = 10;
/** Hand wobble on the aim, radians (1 sigma) */
const WOBBLE = 0.004;
const RANGES = [400, 900, 1600];
const SEEDS = [1, 2];

// ---------------------------------------------------------------------------------------------------------------
// The proposal (docs/design/heavier-shots-2026-11.md), applied with --after to the in-memory models only. Per model:
//   fire: fields merged into its fire block (interval also sets fireInterval); spin replaces the spin
//   shell: final shell numbers (damage, speed, splash, burst, spread, size): set in its weaponMods, any mul of the
//   same field dropped; life is worked out to keep its reach (speed x life) unless given
// ---------------------------------------------------------------------------------------------------------------
type Prop = { fire?: Record<string, unknown>; shell?: Record<string, any>; keepReach?: boolean };
// (Empty: the 2026-11 proposal is applied in scripts/econ/models.mjs (commit after 17545d4); its rows were the Pip, Hammer,
// Twinlink, Rattler, Chainsaw, Stinger, Strobe, Overpulse, Coilgun, Rail Driver and Leviathan. Put the next trial here.)
export const PROPOSAL: Record<string, Prop> = {};

function applyProposal(): void {
  for (const [id, p] of Object.entries(PROPOSAL)) {
    const m = MODELS.find((x) => x.id === id);
    if (!m) throw new Error('no model ' + id);
    if (p.fire) {
      m.fire = { ...m.fire, ...p.fire };
      if (p.fire.interval !== undefined) m.fireInterval = p.fire.interval;
    }
    if (p.shell) {
      const before: any = gunDef(tuning, m.weapon, { model: m.weaponMods ?? {} });
      const wm = (m.weaponMods = JSON.parse(JSON.stringify(m.weaponMods ?? {})));
      wm.set ??= {};
      for (const [k, v] of Object.entries(p.shell)) {
        wm.set[k] = v;
        if (wm.mul) { delete wm.mul[k]; if (k === 'splash') { delete wm.mul.splashDamage; delete wm.mul.splashRadius; } }
      }
      if (p.shell.speed !== undefined && p.shell.life === undefined && p.keepReach !== false) {
        wm.set.life = Math.max(4, Math.round((before.speed * before.life) / p.shell.speed));
        if (wm.mul) delete wm.mul.life;
      }
    }
  }
}
if (AFTER) applyProposal();

const catalog = loadCatalog({
  pieces: rj(join(SD, 'pieces.json')), functions: rj(join(SD, 'functions.json')), materials: rj(join(SD, 'materials.json')),
  models: modelsFile, bespoke: [],
});
const SPARROW = readFileSync(join(SD, 'blueprints/sparrow-t.json'), 'utf8');

// ---------------------------------------------------------------------------------------------------------------
// Deterministic noise
// ---------------------------------------------------------------------------------------------------------------
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r());

// ---------------------------------------------------------------------------------------------------------------
// The shooter
// ---------------------------------------------------------------------------------------------------------------
function armed(fn: string): ShipState {
  const b = parseBlueprint(SPARROW);
  const pips = b.parts.filter((q) => q.fn === 'cannon_pip');
  pips[0].fn = fn;
  pips[1].fn = 'hull';
  delete (pips[1] as any).facing;
  const s = createShipState(catalog, tuning, 1, b, 0);
  if (s.derived.weapons.length !== 1) throw new Error(`${fn}: ${s.derived.weapons.length} guns on the rig`);
  return s;
}
const defOf = (s: ShipState, w: WeaponInfo): WeaponTuning => gunDef(tuning, w.kind, { mods: s.blueprint.parts[w.part]?.mods, grade: w.grade, size: w.size, model: w.model });

// ---------------------------------------------------------------------------------------------------------------
// The targets
// ---------------------------------------------------------------------------------------------------------------
interface TargetDef { id: string; label: string; design: string; dir: 'enemy' | 'player'; jink: [number, number]; speedK: number }
const ENEMY_TARGETS: TargetDef[] = [
  { id: 'small', label: 'Pirate Skiff (small, fast, jinking every 0.5-1.2 s)', design: 'pirate_skiff', dir: 'enemy', jink: [30, 72], speedK: 1 },
  { id: 'mid', label: 'Pirate Raider (mid, weaving every 1.5-3 s)', design: 'pirate_raider', dir: 'enemy', jink: [90, 180], speedK: 1 },
  { id: 'large', label: 'Pirate Gunship (large, slow, drifting, turns every 4-7 s)', design: 'pirate_gunship', dir: 'enemy', jink: [240, 420], speedK: 0.6 },
];
const PLAYER_TARGETS: TargetDef[] = [
  { id: 'small', label: 'Sparrow T (player starter, jinking)', design: 'sparrow-t', dir: 'player', jink: [30, 72], speedK: 1 },
  { id: 'mid', label: 'Halberd (player mid, weaving)', design: 'halberd', dir: 'player', jink: [90, 180], speedK: 1 },
  { id: 'large', label: 'Bulwark (player heavy, drifting)', design: 'bulwark', dir: 'player', jink: [240, 420], speedK: 0.6 },
];

interface Target {
  def: TargetDef; text: string; s: ShipState; geoms: ReturnType<typeof blueprintGeometry>; core: number;
  vmax: number; accel: number; radius: number;
}
function makeTarget(t: TargetDef): Target {
  const path = t.dir === 'enemy' ? join(SD, 'blueprints/enemy', t.design + '.json') : join(SD, 'blueprints', t.design + '.json');
  const text = readFileSync(path, 'utf8');
  const s = createShipState(catalog, tuning, 2, parseBlueprint(text), 0);
  s.shield = 0;
  const geoms = blueprintGeometry(catalog, s.blueprint);
  const core = s.blueprint.parts.findIndex((p) => p.fn === 'core');
  // (its top speed and thrust flying forward, friction 0.985 as the flight step has it)
  let v = 0;
  for (let i = 0; i < 3000; i++) v = (v + accelAlong(s.derived, [0, -1], v)) * 0.985;
  const accel = accelAlong(s.derived, [0, -1], 0);
  return { def: t, text, s, geoms, core, vmax: v * t.speedK, accel, radius: s.derived.radius };
}
function resetTarget(T: Target): void {
  T.s = createShipState(catalog, tuning, 2, parseBlueprint(T.text), 0);
  T.s.shield = 0;
}
const okPart = (T: Target) => (i: number) => T.s.hp[i] > 0 && !T.s.detached[i] && T.s.derived.alive[i] && standing(catalog, T.s, i);

// ---------------------------------------------------------------------------------------------------------------
// One scenario
// ---------------------------------------------------------------------------------------------------------------
interface Shell {
  x: number; y: number; vx: number; vy: number; life: number; age: number; size: number;
  def: WeaponTuning; dmg: number; scale: number; ends: boolean; guide?: Guide; guided?: boolean; shard?: boolean; hitAny?: boolean; counted: boolean;
}
interface Result { volleys: number; shells: number; stated: number; raw: number; eff: number; hits: number; distTicks: number; fireTicks: number }

/** Lead: where a round at `speed` from the origin meets a target at P moving at V (null: it can't) */
function intercept(px: number, py: number, vx: number, vy: number, speed: number): number | null {
  const a = vx * vx + vy * vy - speed * speed, b = 2 * (px * vx + py * vy), c = px * px + py * py;
  if (Math.abs(a) < 1e-9) return b < 0 ? -c / b : null;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const r = Math.sqrt(disc), t1 = (-b - r) / (2 * a), t2 = (-b + r) / (2 * a);
  const t = Math.min(t1, t2) > 0 ? Math.min(t1, t2) : Math.max(t1, t2);
  return t > 0 ? t : null;
}

type AimMode = 'pilot' | 'ai';

function scenario(fn: string, T: Target, range: number, seed: number, aim: AimMode = 'pilot'): Result {
  const ship = armed(fn);
  const w = ship.derived.weapons[0];
  const def0: any = defOf(ship, w);
  const hitInfo = weaponHit(w.kind, def0, w.grade);
  resetTarget(T);
  const r = rng(seed * 7919 + range);
  // Target state: on the +x axis at `range`, flying across (y)
  let tx = range, ty = 0, tvy = 0, dirSign = r() < 0.5 ? -1 : 1, nextJink = 1 + Math.floor(T.def.jink[0] + r() * (T.def.jink[1] - T.def.jink[0]));
  let estVx = 0, estVy = 0;
  const tAngle = Math.PI; // facing the shooter (ship angle: its nose along the angle)
  const shells: Shell[] = [];
  const res: Result = { volleys: 0, shells: 0, stated: 0, raw: 0, eff: 0, hits: 0, distTicks: 0, fireTicks: 0 };
  const queue: { at: number; spawn: () => void }[] = [];
  let burnUntil = -1, burnDps = 0, burnPart = -1;
  const fireTicks = FIRE_S * 60;
  const speedOf = (d: any) => (d.speed ?? 48);
  const pose = { x: 0, y: 0, angle: 0 };
  const localGunAngle = w.mount === 'turret' && w.window ? w.window.center : Math.atan2(w.dir[1], w.dir[0]);
  const ok = okPart(T);

  const toGrid = (x: number, y: number): [number, number] => {
    const [lx, ly] = worldToLocalDir([x - tx, y - ty], tAngle);
    return [lx / CS + T.s.derived.com[0], ly / CS + T.s.derived.com[1]];
  };
  const hurt = (part: number, amount: number, splash: boolean) => {
    if (part < 0 || amount <= 0) return;
    res.raw += amount;
    const p = T.s.blueprint.parts[part];
    let a = amount * hitMultiplier(catalog, tuning, p, hitInfo);
    if (splash) a *= catalog.functions.get(p.fn)?.splashTaken ?? 1;
    const dealt = Math.min(a, Math.max(0, T.s.hp[part]));
    T.s.hp[part] -= dealt;
    res.eff += dealt;
    if (T.s.hp[part] <= 0) {
      if (part === T.core) resetTarget(T);
      else rebuildShip(T.s, catalog, tuning);
    }
  };
  const splashAt = (x: number, y: number, radius: number, damage: number): boolean => {
    // (splashAt: the reach-nearest parts by their outline, 1 - 0.7 d/r)
    if (Math.hypot(x - tx, y - ty) > radius + T.radius) return false;
    const [gx, gy] = toGrid(x, y);
    const near = nearestParts(T.geoms, ok, gx, gy, radius / CS);
    const reach = Math.max(3, Math.round(radius / CS));
    for (let k = 0; k < near.length && k < reach; k++) hurt(near[k].i, damage * (1 - 0.7 * ((near[k].d * CS) / radius)), true);
    return near.length > 0;
  };
  const detonate = (sh: Shell): boolean => {
    let got = false;
    const d: any = sh.def;
    if (d.split && !sh.shard) {
      // (Prism: shards fanned over arc, straight on from where it split)
      const sd: any = tuning.weapons[d.split.kind];
      const head = Math.atan2(sh.vy, sh.vx), arc = (d.split.arc * Math.PI) / 180;
      for (let i = 0; i < d.split.count; i++) {
        const a = head + arc * (i / (d.split.count - 1) - 0.5);
        shells.push({ x: sh.x, y: sh.y, vx: Math.cos(a) * sd.speed, vy: Math.sin(a) * sd.speed, life: sd.life, age: 0, size: sd.size, def: sd, dmg: sd.damage * sh.scale, scale: sh.scale, ends: false, shard: true, counted: false });
      }
    }
    if (d.splash) got = splashAt(sh.x, sh.y, d.splash.radius, d.splash.damage * sh.scale) || got;
    return got;
  };

  for (let t = 1; ; t++) {
    const firing = t <= fireTicks;
    if (!firing && shells.length === 0 && queue.length === 0) break;
    if (t > fireTicks + 1200) break;
    // Target flight: toward its jink direction at its thrust, capped at its top speed
    if (t >= nextJink) { dirSign = -dirSign; nextJink = t + Math.floor(T.def.jink[0] + r() * (T.def.jink[1] - T.def.jink[0])); }
    const want = dirSign * T.vmax;
    tvy += Math.max(-T.accel, Math.min(T.accel, want - tvy));
    const prevTx = tx, prevTy = ty;
    ty += tvy;
    // The shooter's read of it (smoothed), and the aim
    const k = 1 / REACT;
    estVx += (0 - estVx) * k; estVy += (tvy - estVy) * k;
    let aimX: number, aimY: number;
    const sp = speedOf(def0) * (def0.homing ? 0 : 1);
    if (aim === 'ai') {
      // (bodies/aiPilot.ts: the flight time of the main gun's round, bodies/aiLead.ts; here the gun under test is it)
      const tof = leadTicks(Math.hypot(tx, ty), roundLead(def0));
      aimX = tx; aimY = ty + tvy * tof;
    } else if (sp > 0) {
      const tt = intercept(tx, ty, estVx, estVy, sp) ?? Math.hypot(tx, ty) / sp;
      aimX = tx + estVx * tt; aimY = ty + estVy * tt;
    } else { aimX = tx; aimY = ty; }
    const aimAng = Math.atan2(aimY, aimX) + gauss(r) * WOBBLE;
    const aimDist = Math.hypot(aimX, aimY);
    pose.angle = aimAng - Math.PI / 2 - localGunAngle;
    // Fire: a semi-automatic gun is clicked as fast as it takes; anything else held
    const held = firing && (!w.fire.semi || t % 3 !== 0);
    if (firing) {
      res.fireTicks++;
      if (distDue(ship, t, tuning, () => 1, false)) res.distTicks++;
    }
    const step = stepGuns(ship, pose, { firing: held, aimWorld: aimAng, aimDist, hold: aim === 'pilot' }, t, tuning);
    for (const s of step.shots) {
      res.volleys++;
      const d: any = defOf(ship, s.w);
      const launch = (tick: number, index: number) => {
        const vs = volleyShells(1, ship, s.w, s.shot, { ...pose, vx: 0, vy: 0 }, tick, tuning);
        const ends = endsAtAim(d);
        vs.forEach((l, i) => {
          const dmg = (d.damage ?? 14) * s.shot.damageScale;
          let life = l.life;
          if (ends) life = lifeToReach(l.life, Math.hypot(l.vx, l.vy), aimReach(step.dist, d, index + i));
          const sh: Shell = { x: l.x, y: l.y, vx: l.vx, vy: l.vy, life, age: 0, size: l.size, def: d, dmg, scale: s.shot.damageScale, ends, counted: true };
          if (d.homing && !d.guided) {
            sh.x = qGuide(sh.x); sh.y = qGuide(sh.y); sh.vx = qGuide(sh.vx); sh.vy = qGuide(sh.vy);
            sh.guide = newGuide(2, guideKind(d.homing, d.accel ?? 0.5, d.maxSpeed ?? 40));
          }
          if (d.guided) sh.guided = true;
          shells.push(sh);
          res.shells++;
          res.stated += dmg + (d.splash ? d.splash.damage * s.shot.damageScale : 0);
        });
      };
      // (a salvo or a walking barrage: the rest follow `gap` ticks apart, the bridge's salvos queue)
      const n = d.walk ? d.walk.at.length : d.salvo ? d.salvo.count : 1;
      const gap = d.walk ? d.walk.gap : d.salvo ? d.salvo.gap : 0;
      launch(t, 0);
      for (let i = 1; i < n; i++) { const at = t + i * gap, idx = i; queue.push({ at, spawn: () => launch(at, idx) }); }
    }
    for (let q = queue.length - 1; q >= 0; q--) if (queue[q].at === t) { queue[q].spawn(); queue.splice(q, 1); }
    // Shells
    const tgBody: GuideBody = { x: tx, y: ty, vx: 0, vy: tvy };
    for (let i = shells.length - 1; i >= 0; i--) {
      const sh = shells[i], d: any = sh.def;
      if (sh.guide) {
        const m: GuideBody = { x: sh.x, y: sh.y, vx: sh.vx, vy: sh.vy };
        guideTick(sh.guide, 100 + i, m, tgBody, t);
        sh.vx = m.vx; sh.vy = m.vy;
      } else if (sh.guided) {
        const spd = Math.hypot(sh.vx, sh.vy) || 1, nsp = Math.min(d.maxSpeed ?? d.speed ?? 40, spd + (d.accel ?? 0));
        const o = { x: 0, y: 0 };
        if (firing) steerToward(sh.x, sh.y, sh.vx, sh.vy, aimX, aimY, d.guided.turn, o); else { o.x = sh.vx / spd; o.y = sh.vy / spd; }
        sh.vx = o.x * nsp; sh.vy = o.y * nsp;
      }
      const x0 = sh.x, y0 = sh.y;
      sh.x += sh.vx; sh.y += sh.vy; sh.age++; sh.life--;
      let gone = false, struck = false;
      const lobbed = !!d.lob;
      const armed = sh.age > (d.arm ?? 0);
      if (!lobbed && armed && Math.hypot(sh.x - tx, sh.y - ty) < T.radius + 80 + Math.hypot(sh.vx, sh.vy)) {
        // Relative motion in the target's frame: from where it was against where the target is now
        const [g0x, g0y] = toGrid(x0 + (tx - prevTx), y0 + (ty - prevTy));
        const [g1x, g1y] = toGrid(sh.x, sh.y);
        const h = castParts(T.geoms, ok, g0x, g0y, g1x, g1y, (5 * sh.size) / CS);
        if (h) {
          const hx = x0 + (sh.x - x0) * h.t, hy = y0 + (sh.y - y0) * h.t;
          sh.x = hx; sh.y = hy;
          if ((sh.dmg ?? 0) > 0) hurt(h.part, sh.dmg, false);
          if (d.ignite) { burnUntil = t + d.ignite.ticks; burnDps = d.ignite.dps; burnPart = h.part; }
          if (d.split && sh.ends && !sh.shard) { /* hit whole: the shards fly past */ } else detonate(sh);
          struck = true; gone = true;
        } else if (d.fuse && sh.age > 4) {
          const [gx, gy] = toGrid(sh.x, sh.y);
          let near = Infinity;
          for (let p = 0; p < T.geoms.length; p++) if (ok(p)) near = Math.min(near, partDistance(T.geoms[p], gx, gy, d.fuse / CS) * CS);
          if (near <= d.fuse) { struck = detonate(sh); gone = true; }
        }
      }
      if (!gone && sh.life <= 0) {
        // (its life's end: a shell that ends at the aim bursts or splits there; a plain one is just gone)
        if (sh.ends || d.splash) struck = detonate(sh) || struck;
        gone = true;
      }
      if (gone) {
        if (struck && sh.counted) res.hits++;
        shells.splice(i, 1);
      }
    }
    if (burnUntil >= t && burnPart >= 0 && ok(burnPart)) hurt(burnPart, burnDps / 60, false);
  }
  return res;
}

// ---------------------------------------------------------------------------------------------------------------
// The guns
// ---------------------------------------------------------------------------------------------------------------
const NOT_ROUNDS = new Set(['laser', 'lance', 'frostbite', 'repair', 'point_defence', 'charge', 'emp']);
const guns = MODELS.filter((m) => m.weapon && !NOT_ROUNDS.has(m.weapon) && m.fire?.model !== 'beam' && (!ONLY || ONLY.has(m.id)));
// (legacy functions the enemy designs carry, then the model guns on wards: outposts' Pip and Rattlers, freighters' Rattlers and Chainsaws)
const ENEMY_GUNS = ['weapon', 'autocannon', 'flak', 'missile', 'railgun', 'mortar', 'torpedo', 'arc', 'magma_cannon', 'cannon_pip', 'autocannon_rattler', 'autocannon_chainsaw'];

const f1 = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));
const pct = (v: number) => `${Math.round(v * 100)}%`;

interface Row { id: string; name: string; vps: number; sps: number; dmg: number; speed: number; splash: string; stated: number; dist: number; by: Record<string, { raw: number; eff: number; hit: number }> }

function runGun(fn: string, name: string, targets: Target[], aim: AimMode): Row {
  const ship = armed(fn);
  const w = ship.derived.weapons[0], d: any = defOf(ship, w);
  const row: Row = { id: fn, name, vps: 0, sps: 0, dmg: d.damage ?? 0, speed: d.speed ?? 48, splash: d.splash ? `${Math.round(d.splash.radius)}/${Math.round(d.splash.damage)}` : '', stated: 0, dist: 0, by: {} };
  let n = 0;
  for (const T of targets) for (const R of RANGES) {
    let raw = 0, eff = 0, hits = 0, shells = 0;
    for (const seed of SEEDS) {
      const r = scenario(fn, T, R, seed, aim);
      const s = r.fireTicks / 60;
      row.vps += r.volleys / s; row.sps += r.shells / s; row.stated += r.stated / s; row.dist += r.distTicks / s; n++;
      raw += r.raw / s; eff += r.eff / s; hits += r.hits; shells += r.shells;
    }
    row.by[`${T.def.id}@${R}`] = { raw: raw / SEEDS.length, eff: eff / SEEDS.length, hit: shells ? hits / shells : 0 };
  }
  row.vps /= n; row.sps /= n; row.stated /= n; row.dist /= n;
  return row;
}

/**
 * Point defence against each round it can shoot down: a shell launched LAUNCH_D away flying straight at a ship whose
 * turret (tuning point_defence range, the model's fire interval) is loaded when it comes into range: ticks inside
 * range before it reaches the hull (60), shots one turret gets, hits a shell takes (support.ts interceptHits), shells a
 * volley. PD's hits are instant (Weapons.intercept), so its rate and the round's time in range are all that matter
 */
function pdTable(): string[] {
  const pd = MODELS.find((m) => m.id === 'point_defence_turret');
  const range = tuning.weapons.point_defence.pointDefence?.range ?? 560, every = pd.fireInterval ?? 12;
  const out = [`Point defence (range ${range}, a shot every ${every} ticks = ${f1(60 / every)}/s, instant hits):`, '',
    '| round | top speed | ticks in range (from 900 / 1600) | PD shots, 1 turret | hits each | shells a volley | one turret stops |', '|---|---:|---:|---:|---:|---:|---|'];
  for (const m of MODELS) {
    if (!m.weapon || m.weapon === 'point_defence') continue;
    const d: any = gunDef(tuning, m.weapon, { model: m.weaponMods ?? {} });
    const hits = Math.max(0, Math.round(d.intercept ?? 0));
    if (!hits || (ONLY && !ONLY.has(m.id))) continue;
    const inRange = (from: number) => {
      let v = d.speed ?? 48, x = from, n = 0;
      // (a lobbed shell comes down at the aim: it flies the whole way, its last `range` in reach)
      while (x > 60 && n < 5000) { v = d.accel && (d.homing || d.guided) ? Math.min(d.maxSpeed ?? 40, v + d.accel) : v; x -= v; if (x <= range) n++; }
      return n;
    };
    const t9 = inRange(900), t16 = inRange(1600), shots = Math.floor((Math.min(t9, t16) - 1) / every) + 1;
    const per = d.walk ? d.walk.at.length : d.salvo ? d.salvo.count : d.burst ?? 1;
    const stops = Math.min(per, Math.floor(shots / hits));
    out.push(`| ${m.name} | ${f1(d.accel && (d.homing || d.guided) ? d.maxSpeed ?? 40 : d.speed)} | ${t9} / ${t16} | ${shots} | ${hits} | ${per} | ${stops} of ${per}${stops < per ? ` (needs ${Math.ceil((per * hits) / Math.max(1, shots))} turrets)` : ''} |`);
  }
  return out;
}

function main(): void {
  const t0 = Date.now();
  if (argv.includes('--pd')) { console.log(pdTable().join('\n')); return; }
  const targets = (ENEMY ? PLAYER_TARGETS : ENEMY_TARGETS).map(makeTarget);
  const list: [string, string][] = ENEMY ? ENEMY_GUNS.map((f) => [f, catalog.functions.get(f)?.name ?? f]) : guns.map((m) => [m.id, m.name]);
  const rows = list.map(([id, name]) => runGun(id, name, targets, ENEMY ? 'ai' : 'pilot'));
  const keys = targets.flatMap((T) => RANGES.map((R) => `${T.def.id}@${R}`));
  const mean = (row: Row, id: string, f: 'raw' | 'eff' | 'hit') => RANGES.reduce((a, R) => a + row.by[`${id}@${R}`][f], 0) / RANGES.length;
  const out: string[] = [];
  out.push(`heavierShots ${AFTER ? 'AFTER (proposal applied in memory)' : 'BEFORE (game data as it is)'}${ENEMY ? ', enemy guns at player ships, AI lead' : ''}: ${FIRE_S} s of fire x ${SEEDS.length} seeds, ranges ${RANGES.join('/')}`);
  for (const T of targets) out.push(`  ${T.def.id}: ${T.def.label}: radius ${f1(T.radius)}, top speed ${f1(T.vmax)} u/tick, thrust ${T.accel.toFixed(3)} u/tick2`);
  if (MD) {
    out.push('');
    out.push('| gun | volleys/s | shells/s | dmg/shell | speed | splash r/dmg | stated DPS | landed small | landed mid | landed large | hit% small / mid / large | dist upd/s | ~B/s |');
    out.push('|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---|---:|---:|');
    for (const r of rows) {
      out.push(`| ${r.name} | ${f1(r.vps)} | ${f1(r.sps)} | ${f1(r.dmg)} | ${f1(r.speed)} | ${r.splash} | ${f1(r.stated)} | ${f1(mean(r, 'small', 'eff'))} | ${f1(mean(r, 'mid', 'eff'))} | ${f1(mean(r, 'large', 'eff'))} | ${pct(mean(r, 'small', 'hit'))} / ${pct(mean(r, 'mid', 'hit'))} / ${pct(mean(r, 'large', 'hit'))} | ${f1(r.dist)} | ${f1(r.dist * 3.2)} |`);
    }
    out.push('');
    out.push(`Per range (landed DPS through armour and part HP; hit rate):`);
    out.push('');
    out.push(`| gun | ${keys.join(' | ')} |`);
    out.push(`|---|${keys.map(() => '---:').join('|')}|`);
    for (const r of rows) out.push(`| ${r.name} | ${keys.map((k) => `${f1(r.by[k].eff)} (${pct(r.by[k].hit)})`).join(' | ')} |`);
    out.push('');
    out.push(`Raw landed (as it arrived, before armour and part HP), mean over ranges: small / mid / large`);
    out.push('');
    for (const r of rows) out.push(`- ${r.name}: ${f1(mean(r, 'small', 'raw'))} / ${f1(mean(r, 'mid', 'raw'))} / ${f1(mean(r, 'large', 'raw'))}`);
  } else {
    for (const r of rows) {
      out.push(`${r.id.padEnd(24)} v/s ${f1(r.vps).padStart(5)} sh/s ${f1(r.sps).padStart(5)} dmg ${f1(r.dmg).padStart(5)} spd ${f1(r.speed).padStart(5)} splash ${r.splash.padEnd(7)} stated ${f1(r.stated).padStart(5)} dist/s ${f1(r.dist).padStart(5)}`);
      out.push('    ' + keys.map((k) => `${k} ${f1(r.by[k].eff)}/${f1(r.by[k].raw)} ${pct(r.by[k].hit)}`).join('  '));
    }
  }
  out.push(`(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  console.log(out.join('\n'));
}
main();
