/**
 * What a shell's hit on a ship does, worked out the same way on both sides (docs/design/confirmed-hits.md, part B).
 * The server runs these for every hit (server/src/ships/bridge/damage.ts `hurt`, weapons.ts `cover`, game/Weapons.ts);
 * a client can run them on its own copy of a ship to know what a confirmed hit did without being told.
 *
 *   coverPart     the part that takes a hit meant for another (a boss's stages)
 *   partHit       shield soak, stage cover, splash share, bane, taken scale, armour, the ruin floor, the part's HP
 *   shellAmount   a shell's damage after its pierce passes (as the server stores it: f32)
 *   shellVs       what a shell hits with (damage type and penetration, its shield and hull scales, its bane)
 *   igniteRule    the part a fire shell sets burning
 *   hitEndFx      the detonation a shell's end (or a pierce pass) is told with
 *   hpWire        part HP as the wire carries it
 *   deriveShellHit  the lot, on a client's view of the target (shield unknown: 0; boss modifiers unknown: defaults)
 *   gunShell      what a gun's shell is (kind, tuning, grade, strength), from the firing ship as both sides have it
 *   sidesHurt     whether one side's shells may hurt another's (GameServer.canDamage, bar its PvP zones)
 *   shipSegmentHit  where a shell's line this tick first meets a ship at a pose (the bridge's segmentHit, on numbers a
 *                 client has too: client-detected hits, part D)
 *
 * Arithmetic here is the server's own, in the same order: change nothing here without the hit golden
 * (server/src/game/hitRules.golden.test.ts) passing unchanged.
 */

import type { Catalog } from './catalog.js';
import type { ShipState } from './state.js';
import { hpWire, type ShipTuning, type WeaponTuning } from './tuning.js';
import { geomContainsPoint, type PlacedGeom } from './grid.js';
import type { Vec2 } from './types.js';
import { damagePart } from './state.js';
import { hitMultiplier, weaponHit, type HitInfo } from './damage.js';
import { RUIN_HP, stageOf, currentStage, standing, deciding, stageParts } from './stages.js';
import { partDistance, castParts } from './collide.js';
import { worldToLocalDir } from './flight.js';
import { gunDef, stackMods, ammoByCode } from './launch.js';
import { dhypot } from '../math/detTrig.js';

/** A hit that gets less than this share through the armour it strikes shows as glancing */
export const GLANCING = 0.6;

/**
 * A staged boss hit on a later stage's part (its back, under the plates): the nearest current-stage plate takes this
 * share of it (bosses.json rules.stageCover, or the boss's own stageCover, says otherwise). Under half, so aiming at
 * the stage being fought is plainly better; well above nothing, so a shot that lands still counts.
 */
export const STAGE_COVER = 0.4;

/** What a piercing shell keeps of its damage each time it passes through something (unless its def says) */
export const PIERCE_KEEP = 0.75;

/** What the rules need to know of the world: the server's ShipBridge is one; a client's ship store another */
export interface HitCtx {
  readonly catalog: Catalog;
  readonly tuning: ShipTuning;
  /** The ship's parts' shapes in its grid space (asked only when a hit needs them) */
  geometry(ship: ShipState): readonly PlacedGeom[];
}

/** While a splash hurts one body's parts (all from the point `at`): the part the cover last sent a hit to, and in what stage */
export interface CoverMemo { ship: ShipState; at: Vec2; first: number; best: number }

/** What a hit is made of, beyond its amount (absent fields: a plain hit) */
export interface HitVs {
  /** A blast: a part's function may take only a share of it (spaced plating: `splashTaken`) */
  splash?: boolean;
  /** × to shields (0: shields don't stop it) */
  shield?: number;
  /** × to the hull */
  hull?: number;
  /** Its damage type and penetration (damage.ts) */
  hit?: HitInfo;
  /** Where it struck, grid space (the cover picks the plate nearest it) */
  at?: Vec2;
  /** Ammunition made for one faction's ships: × damage against them */
  bane?: { faction: string; damage: number };
}

/**
 * What only the server knows about the target, asked lazily (only when the rule needs it, so a plain hit costs no
 * lookups). A client's view leaves them out: no boss modifiers, no bane.
 */
export interface HitMods {
  /** The tick (a shield's last hit) */
  tick: number;
  /** The share of a hit on a later stage's part its cover takes (undefined: STAGE_COVER); asked only then */
  stageCover?(): number | undefined;
  /** The faction its ships are (for bane rounds); asked only for a bane round */
  baneFaction?(): string | undefined;
  /** What it takes of every hit (a braced boss, a Searchlight's mark); asked once the hit has a part to land on */
  taken?(): number;
  /** One blast's cover choices, shared between its parts */
  memo?: CoverMemo | null;
}

/** A hit's outcome (partHit fills one in) */
export interface PartHitResult {
  /** The part that took it (-1: nothing stood to take it, and nothing happened) */
  part: number;
  /** Shield plus hull damage */
  dealt: number;
  /**
   * The hit's number (what it shows: a damage message's share): the shield's take, and the hull's as a client with the
   * part's HP to the wire's tenth (hpWire) works it out: what got through, but no more than the HP the part showed
   * (above its ruin floor). The same on both ends however the HP's hundredths lie (a hit that breaks a part
   * shows what it showed it had left): so a client's sum of its hits' numbers is the server's (tuning.ts damageUnits)
   */
  shown: number;
  /** What the shield took */
  soak: number;
  /** The shield broke on this hit (it held something, and holds nothing now) */
  broke: boolean;
  /** The armour's multiplier (hitMultiplier: 1 without a HitInfo) */
  through: number;
  /** What got through, braces counted: through × min(1, taken). Under GLANCING it shows as glancing */
  share: number;
  /** share < GLANCING */
  glancing: boolean;
}

export function newPartHit(): PartHitResult {
  return { part: -1, dealt: 0, shown: 0, soak: 0, broke: false, through: 1, share: 1, glancing: false };
}

/** (Part HP on the wire: tuning.ts, beside the health it decides) */
export { hpWire };

/** Does a shell of this kind do anything at its end a detonation has to tell (a burst, an EMP, shards, a pull, fire)? */
export function bursts(def: WeaponTuning): boolean {
  return !!(def.splash || def.emp || def.split || def.pierce || def.ignite || def.chain || def.pull || def.hold || def.fuse);
}

/** What a piercing shell keeps of its damage each pass */
export function pierceKeepOf(def: WeaponTuning): number {
  return def.pierceKeep ?? PIERCE_KEEP;
}

/** Is the shell spent by a hit, after this many passes before it (ships and mobs it went through)? */
export function shellGone(def: WeaponTuning, passes: number): boolean {
  return passes >= (def.pierce ?? 0);
}

/**
 * A shell's damage after `passes` pierce passes: (def.damage ?? 14) × strength, × pierceKeep each pass. Rounded to
 * f32 at each step, as the server's Projectile.damage stores it.
 */
export function shellAmount(def: WeaponTuning, strength: number, passes = 0): number {
  let a = Math.fround((def.damage ?? 14) * strength);
  for (let i = 0; i < passes; i++) a = Math.fround(a * pierceKeepOf(def));
  return a;
}

/** What a shell hits with: its damage type and penetration at the gun's grade, its own shield and hull scales, its bane */
export function shellVs(kind: string, def: WeaponTuning, grade: number): HitVs {
  const hit = weaponHit(kind, def, grade);
  const vs: HitVs = def.vsShield !== undefined || def.vsHull !== undefined ? { shield: def.vsShield, hull: def.vsHull, hit } : { hit };
  return def.bane ? { ...vs, bane: def.bane } : vs;
}

/**
 * What takes a hit meant for `part` (a boss's stages: stages.ts): itself if it's standing in the stage being fought;
 * otherwise (a later stage's, or a wreck) the nearest part standing in that stage, one that decides it if any does;
 * -1 if nothing stands (between stages). Nearest to where it struck (`at`, grid space) by each part's own outline,
 * when that's known: so a shot at a boss's back goes to the plate nearest that spot (not one by its middle, the
 * first of two equally near: the left one, always); else to the struck part's middle.
 */
export function coverPart(ctx: HitCtx, ship: ShipState, part: number, at?: Vec2, coverMemo?: CoverMemo | null): number {
  const catalog = ctx.catalog;
  if (!stageOf(catalog, ship, part)) return underCover(ctx, ship, part, at);
  const first = currentStage(catalog, ship);
  if (!first) return -1;
  if (stageOf(catalog, ship, part) === first && standing(catalog, ship, part)) return part;
  // One blast's parts, all from the same point (coverMemo): while the part the last went to still stands, it's the
  // nearest still (in the blast nothing heals or moves, so the parts standing only ever get fewer)
  const memo = coverMemo?.ship === ship && coverMemo.at === at ? coverMemo : null;
  if (memo && memo.first === first && memo.best >= 0 && standing(catalog, ship, memo.best)) return memo.best;
  const geoms = ctx.geometry(ship), [cx, cy] = at ?? geoms[part].centroid;
  let best = -1, bd = Infinity;
  // (That stage's parts, in part order: the first of two equally near wins)
  for (const i of stageParts(catalog, ship, first)) {
    const g = geoms[i];
    if (!g || !standing(catalog, ship, i)) continue;
    const d = (at ? partDistance(g, cx, cy) : dhypot(g.centroid[0] - cx, g.centroid[1] - cy)) + (deciding(catalog, ship, i) ? 0 : 1e6);
    if (d < bd) { bd = d; best = i; }
  }
  if (memo) { memo.first = first; memo.best = best; }
  return best;
}

/**
 * The `under` rule off a boss's stages (a custom enemy's: the Clinker's magma under its plates, a core under its hull):
 * a hit on a piece drawn beneath the rest goes to the first standing part over it at the spot it struck (`at`, grid
 * space; else the struck part's middle), in part order. Where nothing covers it (a plate shot off), it takes the hit.
 */
function underCover(ctx: HitCtx, ship: ShipState, part: number, at?: Vec2): number {
  const catalog = ctx.catalog, parts = ship.blueprint.parts;
  if (!catalog.pieces.get(parts[part]?.piece)?.under) return part;
  const geoms = ctx.geometry(ship), [x, y] = at ?? geoms[part].centroid;
  for (let i = 0; i < parts.length; i++) {
    if (i === part || catalog.pieces.get(parts[i].piece)?.under || !standing(catalog, ship, i)) continue;
    if (geoms[i] && geomContainsPoint(geoms[i], x, y)) return i;
  }
  return part;
}

/**
 * A hit of `amount` meant for `part`: the cover picks what takes it, the shield soaks it first (and stops recharging
 * for a while), the part takes the rest, as much of it as gets through (`vs.hit`: the weapon's damage type and
 * penetration against the part's armour and material: damage.ts). Changes `ship.shield`, `ship.shieldHitTick` and
 * `ship.hp`; the result goes in `out`. Who's told (a broken shield, the last hitter) is the caller's.
 */
export function partHit(ctx: HitCtx, ship: ShipState, part: number, amount: number, vs: HitVs | undefined, mods: HitMods, out: PartHitResult = newPartHit()): PartHitResult {
  out.part = -1; out.dealt = 0; out.shown = 0; out.soak = 0; out.broke = false; out.through = 1; out.share = 1; out.glancing = false;
  if (amount <= 0) return out;
  const catalog = ctx.catalog;
  const struck = part;
  part = coverPart(ctx, ship, part, vs?.at, mods.memo);
  if (part < 0) return out;
  out.part = part;
  // (a later stage's part: the plate covering it takes only a share, so the stage being fought is what to aim at)
  if (part !== struck && stageOf(catalog, ship, struck) > currentStage(catalog, ship)) amount *= mods.stageCover?.() ?? STAGE_COVER;
  // (ammunition made for one faction's ships: Quench Slugs on the Cinder Cult)
  // (spaced plating: a blast does a share of its damage to the plate it lands on)
  if (vs?.splash) amount *= catalog.functions.get(ship.blueprint.parts[part]?.fn)?.splashTaken ?? 1;
  if (vs?.bane && mods.baneFaction?.() === vs.bane.faction) amount *= vs.bane.damage;
  // (marked by a Searchlight, a braced boss: more or less from every source)
  const taken = mods.taken ? mods.taken() : 1;
  amount *= taken;
  let dealt = 0;
  if (ship.shield > 0 && ship.kind === 'ship' && (vs?.shield ?? 1) > 0) {
    // What it does to shields (× vs.shield), and the rest of the shot goes on to the hull (a torpedo: shields don't stop it)
    const k = vs?.shield ?? 1;
    const soak = Math.min(ship.shield, amount * k);
    ship.shield -= soak;
    out.broke = ship.shield <= 0;
    amount -= soak / k;
    dealt += soak;
    out.soak = soak;
    ship.shieldHitTick = mods.tick;
  }
  const through = vs?.hit && ship.blueprint.parts[part] ? hitMultiplier(catalog, ctx.tuning, ship.blueprint.parts[part], vs.hit) : 1;
  out.through = through;
  // (a braced boss shows the hit as glancing: wait for its opening)
  out.share = through * Math.min(1, taken);
  out.glancing = out.share < GLANCING;
  // (a piece that ruins never breaks: it's left wrecked, RUIN_HP to it)
  const floor = catalog.pieces.get(ship.blueprint.parts[part]?.piece)?.ruin ? RUIN_HP : 0;
  let shown = dealt;
  if (amount > 0) {
    const req = amount * (vs?.hull ?? 1) * through;
    if (ship.hp[part] > 0 && !ship.detached[part]) shown += Math.min(req, Math.max(0, hpWire(ship.hp[part]) - floor));
    dealt += damagePart(ship, part, Math.min(req, Math.max(0, ship.hp[part] - floor)), ctx.tuning);
  }
  out.dealt = dealt;
  out.shown = shown;
  return out;
}

/** Is the part a shot struck still there to burn (alive and attached)? */
export function struckStands(ship: ShipState, struck: number): boolean {
  return struck >= 0 && ship.hp[struck] > 0 && !ship.detached[struck];
}

/**
 * The part a fire shell sets burning, when the hit says: the part it struck, if the shell carries fire, the target is
 * a ship and the part is still there after the hit. -1 otherwise (the server then picks the part nearest the hit
 * point: bridge/damage.ts ignite; a client is told that part).
 */
export function igniteRule(ship: ShipState, struck: number, def: WeaponTuning): number {
  return def.ignite && ship.kind === 'ship' && struckStands(ship, struck) ? struck : -1;
}

/** The detonation a shell's hit is told with: its end (`gone`), when it bursts; a pierce pass, when its def keeps damage */
export interface HitEndFx { kind: string; radius: number }

export function hitEndFx(kind: string, def: WeaponTuning, gone: boolean): HitEndFx | null {
  if (gone) return bursts(def) ? { kind, radius: def.splash?.radius ?? def.emp?.radius ?? 40 } : null;
  return def.pierceKeep !== undefined ? { kind, radius: 40 } : null;
}

/** A client's view of one shell hit (docs/design/confirmed-hits.md 3.5) */
export interface ShellHitView {
  ctx: HitCtx;
  /** Its copy of the target (hp to the wire's tenth). The hit is applied to it: the covering part's HP to `hpAfter` */
  ship: ShipState;
  /** The part the shell struck (before the cover) */
  struck: number;
  kind: string;
  /** The gun's def, as the client builds the shells from (launch.ts gunDef) */
  def: WeaponTuning;
  /** The gun's grade (its penetration) */
  grade: number;
  /** The shell's damage scale as the client knows it (weapon strength); the server's extras come as an override */
  strength: number;
  /** Ships and mobs it has already passed through */
  passes: number;
  /** Where it struck, grid space */
  at?: Vec2;
  tick?: number;
}

export interface ShellHitOutcome {
  /** The part that took it (-1: none) */
  part: number;
  /** The hit's number (hull: a view has no shield): PartHitResult.shown, the server's own for the hit */
  dealt: number;
  /** The part's HP after, as the wire carries it (-1: no part took it) */
  hpAfter: number;
  /** Under GLANCING */
  glancing: boolean;
  /** The part set burning (-1: none, or one only the server can say) */
  ignite: number;
  /** The shell is spent */
  gone: boolean;
  /** The detonation it's told with, or null */
  fx: HitEndFx | null;
}

const NO_MODS: HitMods = { tick: 0 };

/**
 * What a shell's hit did, worked out from what a client knows: the shell's amount, the cover, the hit with no shield
 * (the view doesn't know it) and no boss modifiers, the part's HP rounded as the wire does, the fire and the end.
 * Changes `view.ship` (the part's HP to hpAfter; its shield is left as it was).
 */
export function deriveShellHit(view: ShellHitView): ShellHitOutcome {
  const { ship, def } = view;
  const amount = shellAmount(def, view.strength, view.passes);
  const vs = shellVs(view.kind, def, view.grade);
  const shield = ship.shield;
  ship.shield = 0;
  const r = partHit(view.ctx, ship, view.struck, amount, view.at ? { ...vs, at: view.at } : vs, view.tick === undefined ? NO_MODS : { tick: view.tick });
  ship.shield = shield;
  const hpAfter = r.part >= 0 ? hpWire(ship.hp[r.part]) : -1;
  if (r.part >= 0) ship.hp[r.part] = hpAfter;
  const gone = shellGone(def, view.passes);
  return { part: r.part, dealt: r.shown, hpAfter, glancing: r.glancing, ignite: igniteRule(ship, view.struck, def), gone, fx: hitEndFx(view.kind, def, gone) };
}

/** A gun's shell as a client knows it: its kind, the tuning it flies and hits with, its gun's grade and strength */
export interface GunShell { kind: string; def: WeaponTuning; grade: number; strength: number }

/**
 * What a shell from `ship`'s gun is, worked out from the firing ship alone (its blueprint and rebuild), so the server
 * and a client with the same copy of the ship get the same answer. `gun` packs as a fire event's part does: part +
 * 256 × ammunition code + 65536 for an augmented shot. Null: no such gun. The server's own shell may differ (power,
 * a ward's scale, a dry round): that is what a confirmed hit's extras carry.
 */
export function gunShell(tuning: ShipTuning, ship: ShipState, gun: number): GunShell | null {
  if (!(gun >= 0)) return null;
  const part = gun % 256, ammo = Math.floor(gun / 256) % 256, aug = gun >= 65536;
  const w = ship.derived.weapons.find((x) => x.part === part);
  if (!w) return null;
  const mods = stackMods(ammoByCode(ammo)?.mods, aug ? ship.derived.ports?.augMods[part] : undefined);
  const def = gunDef(tuning, w.kind, { mods: ship.blueprint.parts[part]?.mods, ammo: mods, grade: w.grade, size: w.size, model: w.model });
  return { kind: w.kind, def, grade: w.grade ?? 1, strength: (w.strength ?? 1) * (ship.dmg ?? 1) };
}

// ---- Who may hurt whom, and where a shell meets a ship (client-detected hits, part D) ----

/** What a ship is, for who may hurt whom: a pilot's, a ward (what pilots defend), docked, a person's craft */
export const SIDE = { PILOT: 1, WARD: 2, DOCKED: 4, PERSON: 8 } as const;

/**
 * May a shell from a ship of side `a` (SIDE bits) hurt one of side `t`? 0 no, 1 yes, 2 both are pilots: only where
 * the server says (its PvP zones; a client takes it as no). Docked ships and people's craft are out of it both ways;
 * pilots and their wards are on one side. GameServer.canDamage is this plus the zones.
 */
export function sidesHurt(a: number, t: number): 0 | 1 | 2 {
  if ((a | t) & (SIDE.DOCKED | SIDE.PERSON)) return 0;
  const aOne = a & (SIDE.PILOT | SIDE.WARD), tOne = t & (SIDE.PILOT | SIDE.WARD), both = a & t & SIDE.PILOT;
  if (aOne && tOne && !both) return 0;
  return both ? 2 : 1;
}

/**
 * Does a collision between two ships hurt them (their factions: a hostile's, undefined for anything else)? Not between
 * hostiles of one faction (a pack's ships, or packs of one side bumping as they mill about): they're pushed apart as
 * any two ships are, but take no damage of it. Anything else hurts as ever (GameServer.contactHurts)
 */
export function contactHurts(a: string | undefined, b: string | undefined): boolean {
  return a === undefined || a !== b;
}

/** Does a world-space segment come within a ship's bounding circle (radius + 1 + margin) at (px, py)? */
export function nearShipSegment(px: number, py: number, radius: number, x0: number, y0: number, x1: number, y1: number, margin = 0): boolean {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  const u = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
  return dhypot(x0 + dx * u - px, y0 + dy * u - py) <= radius + 1 + margin;
}

/**
 * The first part `ok` lets through that a world-space segment touches, `margin` thick, on a ship at (px, py, angle)
 * whose centre of mass is `com` (grid units): the segment taken into the ship's grid space and cast against the
 * parts' shapes (collide.ts castParts). The server's bridge castShip, with the pose passed in.
 */
export function castShipAt(geoms: readonly PlacedGeom[], ok: (i: number) => boolean, cellSize: number, com: Vec2, px: number, py: number, angle: number, x0: number, y0: number, x1: number, y1: number, margin = 0): { part: number; t: number } | null {
  const [la, lb] = worldToLocalDir([x0 - px, y0 - py], angle), [lc, ld] = worldToLocalDir([x1 - px, y1 - py], angle);
  return castParts(geoms as PlacedGeom[], ok, la / cellSize + com[0], lb / cellSize + com[1], lc / cellSize + com[0], ld / cellSize + com[1], margin / cellSize);
}

/**
 * Where a shell's line this tick first meets a ship at a pose: its bounding circle, then its standing parts (a wreck's
 * bones and a beaten stage's ruins let shells through: stages.ts standing). The server's bridge segmentHit; a client
 * finding its own hits runs it on the ship as it has it, at the pose the server's collision step saw.
 */
export function shipSegmentHit(ctx: HitCtx, ship: ShipState, px: number, py: number, angle: number, x0: number, y0: number, x1: number, y1: number, margin = 0): { part: number; t: number } | null {
  if (!nearShipSegment(px, py, ship.derived.radius, x0, y0, x1, y1, margin)) return null;
  return castShipAt(ctx.geometry(ship), (i) => standing(ctx.catalog, ship, i), ctx.tuning.cellSize, ship.derived.com, px, py, angle, x0, y0, x1, y1, margin);
}
