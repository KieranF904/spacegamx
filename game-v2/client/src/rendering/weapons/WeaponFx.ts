/**
 * All projectile visuals: tracers, heads, muzzle flashes and impact sparks.
 *
 * Shots are placed from their exact spawn point and spawn tick (both in the
 * snapshot), not from wherever the first snapshot happened to catch them, so
 * every tracer leaves the muzzle and travels continuously:
 *   - your own shots run on the present timeline, matching your predicted ship
 *   - everyone else's run on the interpolated timeline, matching their ships
 * When the server reports a hit (damage message with the hit point), the tracer
 * stops there and throws sparks.
 *
 * Barrels are deterministic: a shell's spawn point is its barrel at its fire
 * tick, and the firing ship is drawn on the same timeline, so the two meet
 * when the shot's age reaches 0. That's when its muzzle flash goes off (shots
 * usually arrive a little ahead of that, in the interpolation buffer), pinned
 * to the ship from then on as it flies and turns.
 *
 * Your own shells don't wait for the server: your client fires them on the
 * tick it predicts (common/src/ships/guns.ts), from the same barrel with the
 * same spread (predict). When the server's copy arrives it takes over the
 * shell already flying (same tick, same spawn, same heading), so hits stop it;
 * one the server never fired fades out after CONFIRM_TICKS. A shell fired and
 * spent between two snapshots never arrives: its hit takes the predicted shell
 * on its line instead (adopt).
 *
 * Everything is pooled sprites of painted textures (fxTextures.ts), so a frame
 * only moves and fades them; only an EMP orb's crackle is drawn as lines.
 */

import { Container, Graphics, Texture } from 'pixi.js';
import { disc, softDot, streak, streakScale, petal, petalScale, ring, puff, glowBall, DOT_SIZE } from '../fxTextures';
import { ParticlePool } from '../particlePool';
import { EntityType, WeaponType } from '@space-game/common';
import type { GameState, InterpolatedEntity } from '../../state/GameState';
import { WeaponStyle, weaponStyle, shotScale, muzzleScale, type ImpactLayers } from './weaponStyles';
import type { Lighting } from '../lighting/Lighting';
import { arcFraction, incomingTicks, landingPoint, sonarPeriod } from './ordnanceTells';
import { BURST, burstLife, burstSpeed, hitAge, offSurface, throwAngle, type SurfaceNormal } from './impactAim';
import { AnchorList, rideStep, type ImpactAnchor } from './impactAnchor';
import type { CombatSoundFeed } from '../../audio/CombatSounds';

/** Which way a hit throws (impactAim): the angle its directional parts leave at, and the struck surface's normal if one was found */
interface Aim { a: number; nx: number; ny: number; surface: boolean }

interface Shot {
  id: number;
  style: WeaponStyle;
  /** Shell size relative to the base shot (fixed cannons fire bigger shells) */
  size: number;
  /** x its flash, recoil and impact, from its damage (weaponStyles.shotScale) */
  power: number;
  /** Its own phase for sway and pulsing (so two shots do not beat together) */
  phase: number;
  /** x its brightness: a stream's dim rounds (style.accent) */
  dim: number;
  /** The firing gun's spin as it left the barrel (0..1): turns its colours from cold to hot (style.heat) */
  hot: number;
  type: number;
  owner: number;
  glow: number;
  spawnX: number;
  spawnY: number;
  spawnTick: number;
  vx: number;
  vy: number;
  hit: { x: number; y: number } | null;
  /** Its muzzle flash has gone off (at age 0 on its timeline): its shot is heard then (sounds) */
  flashed: boolean;
  /** Its gun's model, grade and mount, for its shot's sound */
  model?: string;
  grade: number;
  turret: boolean;
  /** Fired by your own client ahead of the server (until the server's copy takes it over) */
  predicted: boolean;
  /** The firing ship's pose on the fire tick (the flash sits on the barrel in its frame) */
  pose?: FirePoseXY;
  /** Drawn from the barrel's tip, not the spawn point: this offset at first, easing to none over BARREL_EASE ticks (muzzleFlash) */
  vox?: number;
  voy?: number;
  /** The tick its flight ends (a mortar's landing: projectile row data[9]), 0 for none */
  endTick: number;
  /** Where it lands, when it has an end */
  landX: number;
  landY: number;
  /** Its blast radius (world units), when its gun is known: the landing ring's */
  splash: number;
  /** 0..1 through its flight to its end (swells a lobbed shell) */
  arc: number;
  /** The timeline tick it was last placed at */
  t: number;
  /** Rings swelled so far (a sonar's, accumulated so a changing period never jumps the phase) */
  pulse: number;
  /** Frames since the shot stopped (hit or removed); null while flying */
  fading: number | null;
  /** Hulls it can still pass through (its gun's pierce; the server's count): a hit on one throws the impact and flies on */
  pierceLeft: number;
  /**
   * The tick its flight ends on its timeline (Infinity until known): the end of its life, where that's known (fire-event
   * and predicted shells), or about where the server dropped it. A straight shell flies on to it after the server's
   * removal comes (another pilot's is drawn a few ticks behind the server: a short-lived shell, the Spark's six ticks,
   * would otherwise be gone before it got out of the barrel) and stops there however late the removal comes.
   */
  endAt: number;
  /** The server has removed it: it flies out what's left of its flight on its timeline */
  gone: boolean;
  /** Hits reported ahead of where it's drawn (its timeline behind the server's): each lands as the head gets there */
  pending: { x: number; y: number; age: number; at: number }[] | null;
  head: { x: number; y: number } | null;
  tail: { x: number; y: number } | null;
  /** Where its contrail was last laid down (NaN until the first frame) */
  ctX: number;
  ctY: number;
  /**
   * It stopped at a surface drawn here (castHit), or at the server's hit: nothing of it is drawn past that point, and
   * from then on the server's hits for it only confirm (never move its impact or bring it back)
   */
  ended: boolean;
  /** When it ended (clock): it's kept, undrawn, for a while after its fade, so a late row, hit or adopt finds it ended */
  endedAt: number;
  /** Ships it has passed through (a piercing shell's surfaces, as drawn here): not struck again */
  passed: number[] | null;
  /** Hits drawn here the server hasn't told yet: its hits for them are taken as said */
  unconfirmed: number;
  /** Ticks into its flight before it can strike anything (a shell that arms late: the Leviathan's) */
  arm: number;
}

/** Where a shell's drawn line meets a drawn surface (WeaponFx.castHit fills it) */
export interface DrawnHit { t: number; x: number; y: number; target: number }
/** An ended shell is kept (undrawn) this many frames after it ends, for what the server says of it later */
const KEEP_ENDED_FRAMES = 150;

/** A piece of contrail left in the world: it stays where it was laid and fades over `max` frames, long after the shot has gone */
interface TrailSeg { x0: number; y0: number; x1: number; y1: number; age: number; max: number; width: number; color: number; alpha: number }
const TRAIL_CAP = 2048;

/** A muzzle flash: pinned to the ship that fired it (`owner`, at `ox, oy` and `rel` in its frame) */
interface Flash {
  x: number; y: number; angle: number; life: number; max: number; size: number; color: number; sparks: { a: number; l: number }[]; petals: number[];
  /** Its flash's width × this (a heavy shell's is fat) */
  girth: number;
  owner: number; ox: number; oy: number; rel: number;
}
interface Smoke { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; color?: number; alpha?: number; /** The impact it came off rides its target: it flies in the target's frame (impactAnchor rideStep) */ anc?: ImpactAnchor }
interface Spark {
  x: number; y: number; vx: number; vy: number; life: number; max: number; color: number; width?: number;
  /** An ember: its colour cools to this as it dies (and it stays bright longer before fading) */
  cool?: number;
  /** Its speed kept a frame (default 0.9) */
  drag?: number;
  /** The impact it came off rides its target: it flies in the target's frame, its velocity relative to it (rideStep) */
  anc?: ImpactAnchor;
}
/** A layered impact's core flash or glow (ImpactLayers core, bloom) */
interface HitGlow {
  x: number; y: number; life: number; max: number; size: number; color: number; core: boolean;
  /** A fireball's (ImpactLayers.fireball): its drift, and the colour it cools to */
  vx?: number; vy?: number; cool?: number;
  /** The impact it belongs to rides its target (ImpactAnchor) */
  anc?: ImpactAnchor;
}
/** A fragment torn off a hull (ImpactLayers.debris): a glowing chunk slowing, cooling and trailing smoke */
interface Frag { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; hot: number; cool: number; trail: number; drag: number; puff: number; /** Smokes for this share of its life (an outlier's trail crosses the screen) */ smokes: number; anc?: ImpactAnchor }
/** A shock ring racing out from a hit (ImpactLayers shock); `life` starts below 0 for one that follows later */
interface Shock { x: number; y: number; life: number; max: number; size: number; width: number; color: number; anc?: ImpactAnchor }
/** A glow on the hull where a hit landed, riding with the ship it struck (`owner`, at `ox, oy` in its frame), or still (owner -1) */
interface Scorch { x: number; y: number; life: number; max: number; size: number; color: number; anc?: ImpactAnchor }
/** A rebound streak (ImpactLayers.flare): out from (x, y) along `a`, `len` long at full reach */
interface Flare { x: number; y: number; a: number; len: number; width: number; life: number; max: number; color: number; anc?: ImpactAnchor }
/** The light a layered hit throws, fading over its life */
interface HitLight { x: number; y: number; life: number; max: number; radius: number; power: number; color: number; anc?: ImpactAnchor }
interface Ring { x: number; y: number; life: number; max: number; size: number; color: number; anc?: ImpactAnchor }

const FADE_FRAMES = 9;
/** Layered impacts' particles at most (the oldest go first past it) */
const HIT_CAP = 600;
/** Fragments live at most (the oldest go first past it), and smoke puffs they may add */
const FRAG_CAP = 240;
const SMOKE_CAP = 700;

/** A layered impact's scale from its shot's (shell size × damage scale): the square root, so a big shell reads big without taking over */
export function impactScale(size: number): number {
  return Math.sqrt(Math.max(0.2, size));
}
/** A shell drawn from its barrel's tip eases onto its true path over this many ticks */
const BARREL_EASE = 8;
/** A predicted shell the server hasn't confirmed by then was never fired: it fades */
const CONFIRM_TICKS = 60;
/**
 * A hit on a shell of yours no snapshot ever brought takes the predicted shell whose line passes within this of the hit
 * point (WeaponFx.adopt; a predicted line is the server's to a fraction of a unit when the prediction holds)...
 */
const ADOPT_REACH = 30;
/**
 * ...whose head, on your timeline, passed the hit at most this many ticks ago (your timeline runs ahead of the server's by
 * the input lead; the hit is told a snapshot window, a lazy message or a coalescing hold after it happened)
 */
const ADOPT_TICKS = 40;

/** A pending hit still waiting for its shell's head after this many frames lands anyway */
const PENDING_FRAMES = 40;

/** What a shell's gun is: its model's look (MODEL_STYLES), its damage, its blast radius, and the ticks it flies (straight shells: Shot.endAt) */
/**
 * The two timelines shells are drawn on this frame (WeaponFx.update's present and render ticks), each the one its
 * firing ship is drawn at: yours at your predicted ship's drawn tick (GameState.ownDrawTick: the server's tick runs the
 * prediction's lead behind it, and your shells drawn on that came out where your ship had been that many ticks
 * before), everyone else's at the tick interpolate placed them at
 */
export function shotTimelines(state: GameState): [present: number, render: number] {
  // (One Timeline for every kind's draw tick: common sim/timeline.ts, GameState.timeline)
  const tl = state.timelineAt();
  // (A dev prediction mode may draw yours elsewhere, with your ship: GameState.drawMode)
  const own = tl.drawTick('ownShot'), dm = state.drawMode;
  return [dm?.own ? dm.own(own) : own, tl.drawTick('pilotShot')];
}

export interface ShellLook { model?: string; damage?: number; splash?: number; pierce?: number; life?: number; arm?: number }

export interface FirePoseXY { x: number; y: number; angle: number }

/** A shell your client fired ahead of the server */
export interface PredictedShell {
  /** Your ship's pose on the fire tick */
  pose: FirePoseXY;
  owner: number;
  type: number;
  /** Its gun's grade (Mk I-V): the mark only scales its size and brightness */
  grade?: number;
  /** Its gun's model (PlacedPart.fn): its look (weaponStyles MODEL_STYLES) */
  model?: string;
  /** Damage a shot does: its recoil, flash and impact scale with it */
  damage?: number;
  /** Hulls it passes through (its gun's pierce) */
  pierce?: number;
  /** Ticks it flies (a straight shell's life), if known */
  life?: number;
  /** Ticks before it can strike anything (it arms late), if any */
  arm?: number;
  /** Fired from a turret (its shot's sound) */
  turret?: boolean;
  spawnX: number;
  spawnY: number;
  spawnTick: number;
  vx: number;
  vy: number;
  size: number;
}

function mixColor(a: number, b: number, t: number): number {
  const r = ((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t;
  const g = ((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t;
  const bl = (a & 255) * (1 - t) + (b & 255) * t;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

function hueColor(h: number): number {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return 0.6 - 0.4 * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}

const TEX = { get disc() { return disc(); }, get dot() { return softDot(0.5, 0.1); }, get streak() { return streak(); }, get petal() { return petal(); } };
/** The extra pool's textures (the glow pool holds its four already) */
const SHIP_TYPES = [EntityType.Player, EntityType.Enemy, EntityType.NPC, EntityType.ShipBody];
const TEX2 = { get ring() { return ring(); }, get puff() { return puff(); } };
/** The layered impacts' pool's texture */
const TEX3 = { get ball() { return glowBall(); } };

/** A colour with its hue turned by `deg` degrees (impact shards of a prism's rainbow) */
export function turnHue(c: number, deg: number): number {
  const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const l = (mx + mn) / 2;
  if (d < 1e-6) return c;
  const sat = d / (1 - Math.abs(2 * l - 1));
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = ((h * 60 + deg) % 360 + 360) % 360;
  const ch = (1 - Math.abs(2 * l - 1)) * sat, x = ch * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - ch / 2;
  const [r1, g1, b1] = h < 60 ? [ch, x, 0] : h < 120 ? [x, ch, 0] : h < 180 ? [0, ch, x] : h < 240 ? [0, x, ch] : h < 300 ? [x, 0, ch] : [ch, 0, x];
  return (Math.round((r1 + m) * 255) << 16) | (Math.round((g1 + m) * 255) << 8) | Math.round((b1 + m) * 255);
}

/** Crackle defaults (an EMP orb's) when a style asks for lightning with no numbers of its own */
const ORB_LIGHTNING = { color: 0xbfeaff, forks: 3, length: 7 };

export class WeaponFx {
  /** Light (additive) and smoke (normal blending) */
  /**
   * Normal blending, as these have always been drawn: the pool's 'add' never reached its sprites once the bloom made
   * it a render group (Pixi doesn't pass a render group's blend mode on). Additive would be brighter, a look to choose.
   */
  private glow = new ParticlePool('normal');
  private smokeG = new ParticlePool('normal');
  /** Rings, puffs and cloud (a fifth texture would not fit the glow pool) */
  private extraG = new ParticlePool('normal');
  /** Layered impacts (ImpactLayers): core flashes, glows and hull scorches as light (additive), and their shock rings as true thin rings */
  private hitG = new ParticlePool('add');
  private shockG = new ParticlePool('add', 'rings');
  /** What the bloom takes: the glow pool and the layered impacts' light */
  private glowRoot = new Container();
  private hitGlows: HitGlow[] = [];
  private shocks: Shock[] = [];
  private scorches: Scorch[] = [];
  private hitLights: HitLight[] = [];
  private flares: Flare[] = [];
  private frags: Frag[] = [];
  /** Fragments made so far (a group's are the last made while it spawned: the oldest are dropped past the cap) */
  private fragsMade = 0;
  /** Impacts riding what they hit: one entity lookup each a frame */
  private anchors = new AnchorList();
  /** What the impact being made hit (an entity id, -1: nothing known): its group rides it */
  private hitTarget = -1;
  private clock = 0;
  private crackle = new Graphics();
  /** Redrawn every frame it's crackling, so a render group of its own (Pixi rebuilds its draw list, not the scene's) */
  private crackleGroup = new Container({ isRenderGroup: true });
  private crackling = false;
  private smoke: Smoke[] = [];
  private shots = new Map<number, Shot>();
  private flashes: Flash[] = [];
  /** Contrail segments, a ring buffer of reused records (oldest overwritten when full); `trailLen` are live, ending at `trailHead` */
  private trail: TrailSeg[] = Array.from({ length: TRAIL_CAP }, () => ({ x0: 0, y0: 0, x1: 0, y1: 0, age: 0, max: 0, width: 0, color: 0, alpha: 0 }));
  private trailHead = 0;
  private trailLen = 0;
  private sparks: Spark[] = [];
  private rings: Ring[] = [];
  /** A shot seen leaving its gun (the ship renderer kicks the turret back) */
  onMuzzle: ((owner: number, x: number, y: number, power: number) => void) | null = null;
  /** Where a shot leaving (x, y) along `angle` comes out of its drawn barrel (the ship renderer knows), if it can tell */
  barrelTip: ((owner: number, x: number, y: number, angle: number) => { x: number; y: number } | null) | null = null;
  /** The firing ship's pose on a shell's fire tick, where it's known (shells built from fire events) */
  firePose: ((id: number) => FirePoseXY | undefined) | null = null;
  /** How far a gun's spin has got (0..1) where a shot left (x, y): the ship renderer knows (minigun tracers heat up with it) */
  spinAt: ((owner: number, x: number, y: number) => number) | null = null;
  /** The model and damage of the gun a fire-event shell came from (read once, as the shell is first seen) */
  shellLook: ((id: number, e: InterpolatedEntity) => ShellLook | undefined) | null = null;
  /** Where your cursor is in the world while you hold fire (a guided shell's guide line), else null; the object may be reused */
  guideTo: (() => { x: number; y: number } | null) | null = null;
  /**
   * The normal of the surface a shell flying (dx, dy) struck at (x, y), facing it (ships/hitSurface.ts: the part or rock
   * edge its line crossed), into `out`; null if none is known. Asked only by styles whose hits throw off the surface (hitThrow).
   */
  surfaceAt: ((x: number, y: number, dx: number, dy: number, owner: number, out: SurfaceNormal) => SurfaceNormal | null) | null = null;
  /**
   * The first drawn surface the segment (x0, y0) -> (x1, y1) meets (ships' parts at their drawn pose, a raised shield's
   * bubble, rocks: ships/drawnHit.ts), not `owner`'s nor those in `skip`, into `out`; false if none. Every drawn shell
   * stops at the first one it touches, in that frame
   */
  castHit: ((x0: number, y0: number, x1: number, y1: number, owner: number, skip: readonly number[] | null, out: DrawnHit) => boolean) | null = null;
  /**
   * A shell stopped (or passed, piercing) at a drawn surface: what else shows a hit there (a shield's ripple, a rock's
   * sparks), by its shell's id and type, and what it struck as drawn here (-1: not known, the server's point only)
   */
  onStruck: ((id: number, x: number, y: number, type: number, target: number) => void) | null = null;
  /** Shots and impacts heard as they're drawn here (audio/CombatSounds.ts) */
  sounds: CombatSoundFeed | null = null;
  private readonly drawn: DrawnHit = { t: 0, x: 0, y: 0, target: -1 };
  /** Ids of ended shells let go (and their spawn tick): a row or hit for one later doesn't bring it back */
  private spent = new Map<number, number>();
  /** Shells stopped at a drawn surface, and hits the server told that a drawn one had already shown (the probe, tests) */
  readonly stats = { struck: 0, confirmed: 0, serverLanded: 0, early: 0 };
  /**
   * Told of each count in `stats` as it happens, by shell (dev Sim tools' hit agreement, client dev/predict/hitTally.ts;
   * null otherwise): 'struck' drawn striking `target`, 'confirmed' a told hit on a shell drawn striking, 'landed' a told
   * hit no drawn surface took first, 'renamed' a shell fired here taking the server's id (`target`: the id it had),
   * 'orphan' a told hit no shell here took (at x, y). `owner` -1 where the shell is no longer held
   */
  tally: ((what: 'struck' | 'confirmed' | 'landed' | 'renamed' | 'orphan', shot: number, owner: number, target: number, x?: number, y?: number) => void) | null = null;
  private readonly normalScratch: SurfaceNormal = { nx: 0, ny: 0 };
  private readonly aim: Aim = { a: 0, nx: 0, ny: 0, surface: false };
  /** Hits reported for shells not yet seen (the hit's message comes ahead of the snapshot that brings its shell): matched up on the next update */
  private early: { id: number; x: number; y: number }[] = [];
  /**
   * Shells heading at the local pilot that warn of it (`incoming` styles), refilled every update: where each is and the
   * ticks to its closest approach. `threatCount` of the slots are live.
   */
  readonly threats: { x: number; y: number; t: number }[] = [{ x: 0, y: 0, t: 0 }, { x: 0, y: 0, t: 0 }, { x: 0, y: 0, t: 0 }, { x: 0, y: 0, t: 0 }];
  threatCount = 0;
  private state: GameState | null = null;

  /** Everything here that glows (for the bloom) */
  get glowLayer(): Container {
    return this.glowRoot;
  }

  /** Share of the impact sparks and smoke puffs made (the quality setting's particles) */
  particleKeep = 1;

  constructor(layer: Container) {
    this.crackle.blendMode = 'add';
    this.crackleGroup.addChild(this.crackle);
    this.glowRoot.addChild(this.glow.container, this.hitG.container, this.shockG.container);
    layer.addChild(this.smokeG.container, this.glowRoot, this.extraG.container, this.crackleGroup);
  }

  /** A line from (x0, y0) to (x1, y1), `width` thick with soft round ends */
  private line(x0: number, y0: number, x1: number, y1: number, width: number, color: number, alpha: number): void {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const k = streakScale(len, width);
    this.glow.take(TEX.streak, (x0 + x1) / 2, (y0 + y1) / 2, 0.5, 0.5, color, alpha, Math.atan2(y1 - y0, x1 - x0), k.x, k.y);
  }

  /** A filled circle (smooth-edged) */
  private circle(pool: ParticlePool, tex: Texture, x: number, y: number, r: number, color: number, alpha: number): void {
    const k = (r * 2) / DOT_SIZE;
    pool.take(tex, x, y, 0.5, 0.5, color, alpha, 0, k, k);
  }

  /** Projectile ids seen this frame (reused) */
  private seenShots = new Set<number>();

  /**
   * @param presentTick server tick "now" (the local player's predicted timeline)
   * @param renderTick  interpolated timeline other entities are drawn on
   */
  update(state: GameState, delta: number, presentTick: number, renderTick: number): void {
    const frames = Math.min(4, delta * 60);
    const seen = this.seenShots;
    seen.clear();
    this.state = state;
    this.threatCount = 0;
    const me = state.entities.get(state.playerId);

    for (const e of state.entities.ofType(EntityType.Projectile)) {
      seen.add(e.id);
      let shot = this.shots.get(e.id);
      if (!shot) {
        // (one that ended here and was let go: a later row for it doesn't bring it back)
        if (this.spent.get(e.id) === (e.spawnTick ?? 0)) continue;
        // Your own shell, already flying since your client fired it? The server's copy takes it over
        shot = this.claim(e) ?? this.createShot(e);
        this.shots.set(e.id, shot);
      }
      this.fly(shot, e, this.timeline(shot, state, presentTick, renderTick), state);
      if (shot.fading === null) {
        // A shell heading at you that the style warns of (a Leviathan): where it is and how long it has
        const inc = shot.style.incoming;
        if (inc && me && shot.head && shot.owner !== state.playerId && this.threatCount < this.threats.length) {
          const tt = incomingTicks(me.renderX, me.renderY, shot.head.x, shot.head.y, e.vx, e.vy, inc.radius, 600);
          if (tt >= 0) {
            const th = this.threats[this.threatCount++];
            th.x = shot.head.x; th.y = shot.head.y; th.t = tt;
          }
        }
      }
    }

    // Flashes ride along with their guns: the ship keeps moving and turning under them
    for (const f of this.flashes) {
      const o = f.owner >= 0 ? state.entities.get(f.owner) : undefined;
      if (!o) continue;
      const c = Math.cos(o.renderAngle), sn = Math.sin(o.renderAngle);
      f.x = o.renderX + f.ox * c - f.oy * sn;
      f.y = o.renderY + f.ox * sn + f.oy * c;
      f.angle = o.renderAngle + f.rel;
    }

    // Hits that came ahead of their shells (the message before the snapshot that brought them): theirs now; a shell of
    // yours this client never had, the one you fired on that line (adopt); else just a mark
    if (this.early.length) {
      for (const h of this.early) {
        const s = this.shots.get(h.id) ?? this.adopt(h, presentTick);
        if (s) this.strike(s, h.x, h.y); else { this.tally?.('orphan', h.id, -1, -1, h.x, h.y); this.impactAt(undefined, h.x, h.y); }
      }
      this.early.length = 0;
    }

    // Shots the server removed without a reported hit fly out what's left of their flight (straight ones), or burn out where they are
    for (const shot of this.shots.values()) {
      if (shot.predicted) {
        // Not confirmed yet: it flies on its own (and fades if the server never fired it)
        if (shot.fading !== null) continue;
        if (presentTick - shot.spawnTick > CONFIRM_TICKS) { shot.fading = 0; continue; }
        // (another ship's, drawn ahead by the PT timeline (a boss's move): on its owner's timeline, as its rows are)
        this.fly(shot, undefined, shot.owner === state.playerId ? presentTick : this.timeline(shot, state, presentTick, renderTick), state);
        continue;
      }
      if (!seen.has(shot.id) && shot.fading === null) {
        // A shell that was lobbed to a point and is gone has landed there: its burst (the server's damage messages only come for what it hit)
        if (shot.style.landBurst && shot.endTick > 0 && !shot.hit && shot.t >= shot.endTick - 20) this.landed(shot, state);
        else if (shot.style.motion === 'linear') {
          // (the server dropped it somewhere in the snapshot interval before the removal came: SNAPSHOT_RATE, every 3 ticks;
          // never behind where it's drawn already: your own run ahead of the server, and stop where they are)
          if (!shot.gone) { shot.gone = true; shot.endAt = Math.min(shot.endAt, Math.max(state.serverTick - 1, shot.t)); }
          this.fly(shot, undefined, this.timeline(shot, state, presentTick, renderTick), state);
        } else shot.fading = 0;
      }
    }

    this.draw(frames);
  }

  /** Shots, muzzle flashes and impacts light what's near them (see rendering/lighting) */
  collectLights(L: Lighting): void {
    for (const s of this.shots.values()) {
      if (!s.head || (s.fading !== null && s.fading >= FADE_FRAMES)) continue;
      const f = s.fading === null ? 1 : 1 - s.fading / FADE_FRAMES;
      // (a great orb lights no further than a big shell: its own glow is light enough)
      L.point(s.head.x, s.head.y, s.glow, 90 + 150 * Math.min(s.size, 3) + s.style.haloRadius * 3, 0.45 * f * (s.style.orb ? 2 : 1));
    }
    for (const f of this.flashes) L.point(f.x, f.y, f.color, 70 + f.size * 7, 1.4 * (1 - f.life / f.max));
    for (const r of this.rings) L.point(r.x, r.y, r.color, 80 + r.size * 6, 1.1 * (1 - r.life / r.max));
    for (const h of this.hitLights) { const f = 1 - h.life / h.max; L.point(h.x, h.y, h.color, h.radius, h.power * f * f); }
  }

  /** A lobbed shell reached its end: burst there, and shake a screen near enough (a Quake's) */
  private landed(shot: Shot, state: GameState): void {
    const lb = shot.style.landBurst!;
    shot.pierceLeft = 0;
    this.onHit(shot.id, shot.landX, shot.landY);
    const me = state.entities.get(state.playerId);
    if (lb.shake && me) {
      const d = Math.hypot(me.renderX - shot.landX, me.renderY - shot.landY);
      if (d < lb.shake) state.triggerScreenShake(7 * (1 - d / lb.shake), 0.3);
    }
  }

  /** Impact styles of held beams' burns (BeamLook.burn), built once each */
  private burnStyles = new WeakMap<object, WeaponStyle>();

  /**
   * A held beam's burn throws an impact off the surface it lights (MiningBeamFx, every `burn.every` frames): its layers
   * splash straight out of the surface (the beam flying `dx, dy`), as a laser's do
   */
  beamBurn(x: number, y: number, dx: number, dy: number, owner: number, burn: { color: number; hit: ImpactLayers }): void {
    let style = this.burnStyles.get(burn);
    if (!style) {
      style = { ...weaponStyle(WeaponType.Cannon), hitThrow: 'normal', impact: { sparks: 0, speed: 0, life: 0, color: burn.color, flash: 0 }, hit: burn.hit };
      this.burnStyles.set(burn, style);
    }
    const aim = this.aim;
    aim.nx = -dx; aim.ny = -dy; aim.surface = false;
    this.normalScratch.target = -1;
    const n = this.surfaceAt?.(x, y, dx, dy, owner, this.normalScratch);
    if (n) { aim.nx = n.nx; aim.ny = n.ny; aim.surface = true; }
    aim.a = throwAngle('normal', dx, dy, aim.nx, aim.ny);
    const st = style;
    this.grouped(this.normalScratch.target ?? -1, x, y, () => this.layeredHit(st, burn.hit, x, y, aim, 1, undefined));
  }

  /** A damage message with a hit point: stop that tracer there and throw sparks. */
  onHit(projectileId: number | undefined, x: number, y: number): void {
    const shot = projectileId !== undefined ? this.shots.get(projectileId) : undefined;
    if (shot) { this.strike(shot, x, y); return; }
    // (a shell that ended here and was let go: the server only confirms it)
    if (projectileId !== undefined && this.spent.has(projectileId)) { this.stats.confirmed++; this.tally?.('confirmed', projectileId, -1, -1); return; }
    // (A shell not seen yet: its snapshot is usually right behind this message, so it's matched on the next update)
    if (projectileId !== undefined && projectileId >= 0) { this.early.push({ id: projectileId, x, y }); return; }
    this.impactAt(undefined, x, y);
  }

  /**
   * One step of a shell's flight on its timeline (tick `t`): its muzzle flash as it leaves the gun, its place, the hits
   * its head has reached, and the end of its flight (Shot.endAt), where it stops and fades
   */
  private fly(shot: Shot, e: InterpolatedEntity | undefined, t: number, state: GameState): void {
    shot.t = t;
    // The flash goes off when the shot leaves the gun on its timeline (the ship is drawn at that tick too):
    // not when it arrives, which is usually a little early. Shots first seen well downrange don't flash.
    if (!shot.flashed && t >= shot.spawnTick) {
      shot.flashed = true;
      this.sounds?.shot({
        id: shot.id, spawnTick: shot.spawnTick, owner: shot.owner, type: shot.type, grade: shot.grade, model: shot.model, turret: shot.turret,
        x: shot.spawnX, y: shot.spawnY, ahead: shot.predicted && shot.owner !== state.playerId,
      });
      if (t - shot.spawnTick < 12) {
        if (shot.type === WeaponType.PrismShard) this.splitFlash(shot); else this.muzzleFlash(shot, state.entities.get(shot.owner));
      }
    }
    if (shot.fading !== null) return;
    const tt = Math.min(t, shot.endAt);
    // (where its head was drawn last: this frame's stretch of its flight runs from there, or from its spawn)
    const had = shot.head !== null, px = had ? shot.head!.x : shot.spawnX, py = had ? shot.head!.y : shot.spawnY;
    this.place(shot, e, tt);
    // Stopped by the first surface it touches as drawn (not a lobbed shell, which flies over to its end; not before it arms)
    if (shot.head && this.castHit && !shot.style.lob && shot.endTick <= 0 && tt - shot.spawnTick >= shot.arm) this.touch(shot, px, py);
    if (shot.fading !== null) return;
    if (shot.pending) this.landPending(shot, tt - shot.spawnTick, false);
    if (shot.fading === null && t >= shot.endAt) {
      if (shot.pending) this.landPending(shot, Infinity, true);
      if (shot.fading === null) shot.fading = 0;
    }
  }

  /**
   * A hit on a shell: a straight one whose drawn head hasn't got there yet (its timeline runs behind the server's:
   * another pilot's shot, or one not out of the barrel yet) lands when it does, so the impact goes off where and when
   * the shell is drawn arriving; otherwise at once
   */
  private strike(shot: Shot, x: number, y: number): void {
    // (Drawn already: it ended at a surface here, or passed one the server now tells. Its hit only confirms)
    if (shot.ended) { this.stats.confirmed++; this.tally?.('confirmed', shot.id, shot.owner, -1); return; }
    if (shot.unconfirmed > 0) { shot.unconfirmed--; this.stats.confirmed++; this.tally?.('confirmed', shot.id, shot.owner, -1); return; }
    if (shot.style.motion === 'linear' && shot.fading === null) {
      const age = hitAge(shot.spawnX, shot.spawnY, shot.vx, shot.vy, x, y);
      if (age > shot.t - shot.spawnTick + 0.5 && age < shot.endAt - shot.spawnTick + 1) {
        (shot.pending ??= []).push({ x, y, age, at: this.clock });
        return;
      }
    }
    this.land(shot, x, y);
  }

  /** The pending hits the head has reached (`age` ticks into its flight), or have waited too long; all of them if `all` */
  private landPending(shot: Shot, age: number, all: boolean): void {
    const p = shot.pending!;
    while (p.length && (all || p[0].age <= age + 0.5 || this.clock - p[0].at > PENDING_FRAMES)) {
      const h = p.shift()!;
      this.land(shot, h.x, h.y);
    }
    if (!p.length) shot.pending = null;
  }

  /** A hit lands: the shell stops there (a piercing one with hulls left flies on) and the impact goes off */
  private land(shot: Shot, x: number, y: number): void {
    // (The server's hit on something not drawn in its way here: the drawn world had the target a little elsewhere, or
    // this shell on another line)
    this.stats.serverLanded++;
    this.tally?.('landed', shot.id, shot.owner, -1);
    let target = -1;
    // A piercing round that still has hulls to pass keeps flying (tracer, contrail and line carry on); only its last hit ends it
    if (shot.pierceLeft > 0) shot.pierceLeft--;
    else {
      // Its end, short of the server's point if a drawn surface stands between: from where it was fired to there
      const h = this.drawn;
      if (this.castHit?.(shot.spawnX, shot.spawnY, x, y, shot.owner, shot.passed, h)) { x = h.x; y = h.y; target = h.target; }
      shot.hit = { x, y };
      // (and nothing of it past there: a tracer that had flown on collapses into it)
      const sp = Math.hypot(shot.vx, shot.vy) || 1;
      if (shot.tail && ((shot.tail.x - x) * shot.vx + (shot.tail.y - y) * shot.vy) / sp > 0) shot.tail = { x, y };
      shot.head = { x, y };
      if (shot.fading === null) shot.fading = 0;
      shot.ended = true;
      shot.endedAt = this.clock;
    }
    this.impactAt(shot, x, y);
    this.onStruck?.(shot.id, x, y, shot.type, target);
  }

  /**
   * This frame's stretch of a shell's flight, (x0, y0) to its head, against what's drawn: at the first surface it
   * touches it stops there (head and all), its impact goes off there now, and nothing of it shows past it; a piercing
   * shell with hulls left marks the surface and flies on. A hit the server told first (waiting for the head) is this one
   */
  private touch(shot: Shot, x0: number, y0: number): void {
    const h = this.drawn, head = shot.head!;
    if (!this.castHit!(x0, y0, head.x, head.y, shot.owner, shot.passed, h)) return;
    this.stats.struck++;
    this.tally?.('struck', shot.id, shot.owner, h.target, h.x, h.y);
    const x = h.x, y = h.y;
    if (shot.pending?.length) { shot.pending.shift(); if (!shot.pending.length) shot.pending = null; this.stats.confirmed++; this.tally?.('confirmed', shot.id, shot.owner, h.target); }
    else shot.unconfirmed++;
    if (shot.pierceLeft > 0) {
      shot.pierceLeft--;
      (shot.passed ??= []).push(h.target);
    } else {
      head.x = x; head.y = y;
      shot.hit = { x, y };
      // (a shell first drawn already this far along, its contact behind its tail: the tracer collapses into it, never past)
      const tail = shot.tail;
      if (tail && (tail.x - x) * shot.vx + (tail.y - y) * shot.vy > 0) { tail.x = x; tail.y = y; }
      shot.ended = true;
      shot.endedAt = this.clock;
      shot.fading = 0;
      shot.pending = null;
    }
    this.impactAt(shot, x, y);
    this.onStruck?.(shot.id, x, y, shot.type, h.target);
  }

  /** Has this shell been drawn (now or lately)? Then its hit effects are drawn where it's seen to strike (onStruck) */
  draws(id: number): boolean {
    return this.shots.has(id) || this.spent.has(id);
  }

  /**
   * Which way a hit throws (the style's hitThrow, impactAim.ts): off the surface the shell struck where it's known (asked
   * of surfaceAt only when the style throws off one), else back up its line; a hit with no shell anywhere
   */
  private aimOf(style: WeaponStyle, shot: Shot | undefined, x: number, y: number): Aim {
    const aim = this.aim;
    aim.surface = false;
    this.normalScratch.target = -1;
    const sp = shot ? Math.hypot(shot.vx, shot.vy) : 0;
    if (!shot || sp < 1e-6) {
      aim.a = Math.random() * Math.PI * 2; aim.nx = Math.cos(aim.a); aim.ny = Math.sin(aim.a);
      // (what it hit, to ride: asked along any line through the point)
      this.surfaceAt?.(x, y, -aim.nx, -aim.ny, shot?.owner ?? -1, this.normalScratch);
      this.hitTarget = this.normalScratch.target ?? -1;
      return aim;
    }
    const dx = shot.vx / sp, dy = shot.vy / sp, mode = style.hitThrow ?? 'back';
    aim.nx = -dx; aim.ny = -dy;
    // (asked for every hit: what it struck, for its group to ride; its normal only where the style throws off it)
    const n = this.surfaceAt?.(x, y, dx, dy, shot.owner, this.normalScratch);
    this.hitTarget = this.normalScratch.target ?? -1;
    if (n && mode !== 'back') { aim.nx = n.nx; aim.ny = n.ny; aim.surface = true; }
    aim.a = throwAngle(mode, dx, dy, aim.nx, aim.ny);
    return aim;
  }

  /** A direction `spread` radians off the throw, kept out of the struck surface */
  private dir(aim: Aim, spread: number): number {
    const a = aim.a + spread;
    return aim.surface ? offSurface(a, aim.nx, aim.ny) : a;
  }

  /** An impact at (x, y): its shell's style (a plain cannon's if none), thrown the way the style says, riding what it hit */
  private impactAt(shot: Shot | undefined, x: number, y: number): void {
    const style = shot?.style ?? weaponStyle(WeaponType.Cannon);
    const aim = this.aimOf(style, shot, x, y);
    this.grouped(this.hitTarget, x, y, () => this.impactParts(style, shot, x, y, aim));
    this.sounds?.impact({ shell: shot?.id ?? -1, owner: shot?.owner ?? -1, x, y });
  }

  /**
   * Makes `spawn`'s impact one group riding `target` (an entity id; -1 or gone: it stays where it is): what it adds to the
   * surface-bound lists (glows, fireballs, shock rings, scorches, lights, streaks, rings) is moved with the target each
   * frame; what it adds to the free ones (sparks, sprays, embers, fragments, smoke) flies in the target's frame
   */
  private grouped(target: number, x: number, y: number, spawn: () => void): void {
    const n0 = this.hitGlows.length, n1 = this.shocks.length, n2 = this.scorches.length, n3 = this.hitLights.length, n4 = this.flares.length, n5 = this.rings.length;
    const n6 = this.sparks.length, n7 = this.smoke.length, f0 = this.fragsMade;
    spawn();
    const anc = this.anchors.open(this.state?.entities, target, x, y);
    if (!anc) return;
    const bind = (arr: { anc?: ImpactAnchor; life: number; max: number }[], from: number): void => {
      for (let i = from; i < arr.length; i++) { arr[i].anc = anc; anc.hold(arr[i].max - arr[i].life + 2); }
    };
    bind(this.hitGlows, n0); bind(this.shocks, n1); bind(this.scorches, n2); bind(this.hitLights, n3); bind(this.flares, n4); bind(this.rings, n5);
    bind(this.sparks, n6); bind(this.smoke, n7); bind(this.frags, Math.max(0, this.frags.length - (this.fragsMade - f0)));
  }

  /** An impact's parts at (x, y): layered (ImpactLayers) or the flat flash and rings */
  private impactParts(style: WeaponStyle, shot: Shot | undefined, x: number, y: number, aim: Aim): void {
    // (The impact scales with the shot's damage as well as its shell's size)
    const size = (shot?.size ?? 1) * (shot?.power ?? 1);
    const normal = aim.a;
    const imp = style.impact;
    if (style.hit) { this.layeredHit(style, style.hit, x, y, aim, size, shot); return; }
    for (let i = 0; i < imp.sparks * size * this.particleKeep; i++) {
      const a = this.dir(aim, (Math.random() - 0.5) * 2.2);
      const s = imp.speed * (0.4 + Math.random());
      const col = Math.random() < 0.25 ? 0xffffff : style.shardHue ? turnHue(imp.color, (Math.random() - 0.5) * style.shardHue) : imp.color;
      this.sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: imp.life * (0.6 + Math.random() * 0.6), color: col });
    }
    // A cloud left where it landed (gas, dust, vapour)
    const cloud = style.smokeCloud;
    if (cloud) {
      for (let i = 0; i < 5; i++) {
        if (this.particleKeep < 1 && Math.random() > this.particleKeep) continue;
        const a = Math.random() * Math.PI * 2, v = 0.3 + Math.random() * 0.8;
        this.smoke.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: cloud.life * (0.7 + Math.random() * 0.6), size: cloud.size * size * (0.6 + Math.random() * 0.6), color: cloud.color, alpha: 0.3 });
      }
    }
    this.rings.push({ x, y, life: 0, max: 10, size: imp.flash * size, color: imp.color });
    // The heavier marks ring out wider and slower
    if (imp.ring !== undefined) this.rings.push({ x, y, life: 0, max: 16, size: imp.flash * size * 1.8, color: imp.ring });
    // A puff of vapourised hull
    for (let i = 0; i < 2; i++) {
      if (this.particleKeep < 1 && Math.random() > this.particleKeep) continue;
      const a = (aim.surface ? Math.atan2(aim.ny, aim.nx) : normal) + (Math.random() - 0.5) * 1.2;
      this.smoke.push({ x, y, vx: Math.cos(a) * 0.8, vy: Math.sin(a) * 0.8, life: 0, max: 40 + Math.random() * 20, size: 6 * size });
    }
  }

  /**
   * A layered impact (ImpactLayers): a white-hot core, a glow round it, shock rings, a spray of streaks and the shell's
   * own ricochet thrown off the hit (`aim`: off the struck surface or back up the line, by the style's hitThrow), embers
   * that cool as they drift off the surface, a glow left on the hull, the impact's own light and maybe a shake. Sized by
   * impactScale, not the flat flash's full scale.
   */
  private layeredHit(style: WeaponStyle, L: ImpactLayers, x: number, y: number, aim: Aim, size: number, shot: Shot | undefined): void {
    const imp = style.impact, k = impactScale(size), nk = Math.min(1.5, k) * this.particleKeep;
    const room = (): boolean => this.sparks.length < HIT_CAP * 2;
    // A loose scatter round the throw (tight for a directional hit, wide for a burst)
    const scat = ((L.scatter ?? (style.hitThrow && style.hitThrow !== 'back' ? 40 : 69)) * Math.PI) / 180;
    for (let i = 0, n = Math.round(imp.sparks * nk); i < n && room(); i++) {
      const a = this.dir(aim, (Math.random() * 2 - 1) * scat), s = imp.speed * (0.4 + Math.random());
      const col = Math.random() < 0.25 ? 0xffffff : style.shardHue ? turnHue(imp.color, (Math.random() - 0.5) * style.shardHue) : imp.color;
      this.sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: imp.life * (0.6 + Math.random() * 0.6), color: col });
    }
    if (this.hitGlows.length < HIT_CAP) {
      if (L.core) this.hitGlows.push({ x, y, life: 0, max: L.core.life, size: L.core.size * k, color: 0xffffff, core: true });
      if (L.bloom) this.hitGlows.push({ x, y, life: 0, max: L.bloom.life, size: L.bloom.size * k, color: L.bloom.color ?? imp.color, core: false });
    }
    const sh = L.shock;
    if (sh) {
      for (let i = 0; i <= (sh.count ?? 0) && this.shocks.length < HIT_CAP; i++) {
        const f = Math.pow(0.7, i);
        this.shocks.push({ x, y, life: -i * (sh.gap ?? 4), max: sh.life * (1 - 0.15 * i), size: sh.size * k * f, width: sh.width * k * f, color: sh.color ?? imp.color });
      }
    }
    const sp = L.spray;
    if (sp) {
      const cone = (sp.cone * Math.PI) / 180;
      for (let i = 0, n = Math.round(sp.count * nk); i < n && room(); i++) {
        // (most of it close to the throw, a few wide)
        const u = Math.random() * 2 - 1, a = this.dir(aim, u * Math.abs(u) * cone), s = sp.speed * (0.55 + Math.random() * 0.7);
        this.sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: sp.life * (0.6 + Math.random() * 0.6), color: Math.random() < 0.35 ? 0xffffff : sp.color ?? imp.color, width: sp.width ?? 1.7, drag: 0.88 });
      }
    }
    // The rebound line: bright streaks shooting out along the throw
    const fl = L.flare;
    if (fl && this.flares.length < 128) {
      const n = fl.count ?? 1, fan = ((fl.fan ?? 0) * Math.PI) / 180, col = fl.color ?? L.spray?.color ?? imp.color;
      for (let i = 0; i < n; i++) {
        const off = n > 1 ? (i / (n - 1) - 0.5) * 2 * fan : 0, a = this.dir(aim, off + (Math.random() - 0.5) * 0.08);
        // (the middle one longest)
        const len = fl.size * k * (n > 1 ? 1 - 0.35 * Math.abs(i / (n - 1) - 0.5) * 2 : 1) * (0.9 + Math.random() * 0.2);
        this.flares.push({ x, y, a, len, width: fl.width * Math.min(1.5, k), life: 0, max: fl.life, color: col });
      }
    }
    // A heavy hit's explosion: thrown out between the surface's normal and the throw (straight out for a 'normal' hit)
    const fb = L.fireball, db = L.debris;
    if (fb || db) {
      const out = aim.surface ? Math.atan2(aim.ny + Math.sin(aim.a), aim.nx + Math.cos(aim.a)) : aim.a;
      const oc = Math.cos(out), os = Math.sin(out);
      if (fb && this.hitGlows.length < HIT_CAP) {
        const n = fb.count ?? 3;
        for (let i = 0; i < n; i++) {
          const d = fb.size * k * (0.15 + (0.6 * i) / Math.max(1, n - 1)), side = (Math.random() - 0.5) * fb.size * k * 0.5, v = 0.5 + Math.random() * 0.9;
          this.hitGlows.push({
            x: x + oc * d - os * side, y: y + os * d + oc * side, life: -i, max: fb.life * (0.8 + Math.random() * 0.4), size: fb.size * k * (1 - 0.25 * i / n) * (0.85 + Math.random() * 0.3),
            color: fb.color ?? 0xffb050, cool: fb.cool ?? 0x5a1a08, core: false, vx: oc * v, vy: os * v,
          });
        }
      }
      if (db) {
        const cone = ((db.cone ?? 50) * Math.PI) / 180;
        for (let i = 0, n = Math.round(db.count * Math.min(1.5, k) * this.particleKeep); i < n; i++) {
          if (this.frags.length >= FRAG_CAP) this.frags.shift();
          // (speed and life drawn apart, each mostly near its typical, a few outliers much faster or longer-lived)
          const u = Math.random() * 2 - 1, a0 = out + u * Math.abs(u) * cone, a = aim.surface ? offSurface(a0, aim.nx, aim.ny) : a0;
          const fs = burstSpeed(db.outliers ?? BURST.outliers, db.outSpeed ?? BURST.outSpeed), fl = burstLife(db.outliers ?? BURST.outliers, db.outLife ?? BURST.outLife);
          const sp = db.speed * fs, big = fs > 1.6 || fl > 1.4;
          this.fragsMade++;
          this.frags.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, max: db.life * fl, size: db.size * Math.min(1.5, k) * (0.6 + Math.random() * 0.8),
            hot: db.hot, cool: db.cool, trail: db.trail ?? db.hot, drag: db.drag ?? 0.95, puff: Math.random() * 3, smokes: big ? 0.8 : 0.4 });
        }
      }
    }
    // The shell itself glancing off: long streaks of its own colour, tight round the throw
    const rc = L.ricochet;
    if (rc) {
      const cone = (rc.cone * Math.PI) / 180, col = shot?.glow ?? style.glowColor;
      for (let i = 0, n = Math.max(1, Math.round(rc.count * Math.min(1.5, k))); i < n && room(); i++) {
        const a = this.dir(aim, (Math.random() * 2 - 1) * cone), s = rc.speed * (0.8 + Math.random() * 0.4);
        this.sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: rc.life * (0.8 + Math.random() * 0.4), color: i === 0 ? style.coreColor : col, width: 2.6, drag: 0.93 });
      }
    }
    const em = L.embers;
    if (em) {
      // (they drift off the surface itself where it's known, not along the throw)
      const base = aim.surface ? Math.atan2(aim.ny, aim.nx) : aim.a;
      for (let i = 0, n = Math.round(em.count * nk); i < n && room(); i++) {
        const a0 = base + (Math.random() - 0.5) * 2.8, a = aim.surface ? offSurface(a0, aim.nx, aim.ny) : a0;
        const s = em.speed * burstSpeed(em.outliers ?? BURST.outliers, em.outSpeed ?? BURST.outSpeed);
        this.sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: em.life * burstLife(em.outliers ?? BURST.outliers, em.outLife ?? BURST.outLife), color: em.hot, cool: em.cool, width: 2.4 + Math.random() * 1.4, drag: 0.94 });
      }
    }
    if (L.scorch && this.scorches.length < HIT_CAP) {
      // (on what it struck: it rides with it, its group's anchor)
      this.scorches.push({ x, y, life: 0, max: L.scorch.life, size: L.scorch.size * k, color: L.scorch.color });
    }
    if (this.hitLights.length < 64) {
      const lt = L.light, glowR = (L.bloom?.size ?? L.core?.size ?? imp.flash * 0.5) * k;
      this.hitLights.push({ x, y, life: 0, max: Math.max(L.bloom?.life ?? 0, L.core?.life ?? 0, 8), radius: lt ? lt.radius * k : 60 + glowR * 4, power: lt?.power ?? 1, color: L.bloom?.color ?? imp.color });
    }
    // A cloud left where it landed, and a puff of vapourised hull (at the layered scale)
    const cloud = style.smokeCloud;
    if (cloud) {
      for (let i = 0; i < 5; i++) {
        if (this.particleKeep < 1 && Math.random() > this.particleKeep) continue;
        const a = Math.random() * Math.PI * 2, v = 0.3 + Math.random() * 0.8;
        this.smoke.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: cloud.life * (0.7 + Math.random() * 0.6), size: cloud.size * k * (0.6 + Math.random() * 0.6), color: cloud.color, alpha: 0.3 });
      }
    }
    if (Math.random() < this.particleKeep) {
      const a = (aim.surface ? Math.atan2(aim.ny, aim.nx) : aim.a) + (Math.random() - 0.5) * 1.2;
      this.smoke.push({ x, y, vx: Math.cos(a) * 0.8, vy: Math.sin(a) * 0.8, life: 0, max: 40 + Math.random() * 20, size: 5 * k });
    }
    const sk = L.shake, st = this.state, me = st?.entities.get(st.playerId);
    if (sk && st && me) {
      const d = Math.hypot(me.renderX - x, me.renderY - y);
      if (d < sk.radius) st.triggerScreenShake(sk.strength * (1 - d / sk.radius), sk.time ?? 0.18);
    }
  }

  /** Draws (and ages) the layered impacts' cores, glows, shock rings and hull scorches, and ages their lights */
  private drawHits(frames: number): void {
    const h = this.hitG, tex = TEX3.ball;
    for (let i = this.hitGlows.length - 1; i >= 0; i--) {
      const p = this.hitGlows[i];
      p.life += frames;
      if (p.life >= p.max) { this.hitGlows.splice(i, 1); continue; }
      if (p.anc) p.anc.move(p);
      if (p.life < 0) continue;
      const n = p.life / p.max, f = 1 - n;
      if (p.cool !== undefined) {
        // A fireball: it drifts out, swells fast and cools from its colour to a dull red as it fades
        const dr = Math.pow(0.9, frames);
        p.vx! *= dr; p.vy! *= dr; p.x += p.vx! * frames; p.y += p.vy! * frames;
        const r = p.size * (0.4 + 0.6 * (1 - Math.pow(1 - Math.min(1, n * 2.5), 2))), kk = (r * 2) / DOT_SIZE;
        h.take(tex, p.x, p.y, 0.5, 0.5, mixColor(p.color, p.cool, Math.min(1, n * 1.4)), 0.9 * Math.pow(f, 1.2), 0, kk, kk);
        if (n < 0.25) { const k2 = kk * 0.45; h.take(tex, p.x, p.y, 0.5, 0.5, 0xfff4d8, 0.9 * (1 - n / 0.25), 0, k2, k2); }
        continue;
      }
      // The core is a hard white flash shrinking away; the glow swells out (eased) and fades slower
      const r = p.core ? p.size * (1 - 0.35 * n) : p.size * (0.55 + 0.45 * (1 - f * f * f));
      const kk = (r * 2) / DOT_SIZE;
      h.take(tex, p.x, p.y, 0.5, 0.5, p.color, p.core ? f * f : 0.85 * Math.pow(f, 1.6), 0, kk, kk);
    }
    for (let i = this.scorches.length - 1; i >= 0; i--) {
      const p = this.scorches[i];
      p.life += frames;
      if (p.life >= p.max) { this.scorches.splice(i, 1); continue; }
      if (p.anc) p.anc.move(p);
      const n = p.life / p.max;
      // White-hot for a moment, then its colour, cooling to a dull red as it fades
      const col = n < 0.12 ? mixColor(0xffffff, p.color, n / 0.12) : mixColor(p.color, 0x5a1206, Math.min(1, (n - 0.12) / 0.7));
      const r = p.size * (1 - 0.3 * n), kk = (r * 2) / DOT_SIZE;
      h.take(tex, p.x, p.y, 0.5, 0.5, col, 0.95 * Math.pow(1 - n, 1.4), 0, kk, kk);
      if (n < 0.35) { const k2 = kk * 0.45; h.take(tex, p.x, p.y, 0.5, 0.5, 0xfff4e0, 0.8 * (1 - n / 0.35), 0, k2, k2); }
    }
    for (let i = this.shocks.length - 1; i >= 0; i--) {
      const s = this.shocks[i];
      s.life += frames;
      if (s.life >= s.max) { this.shocks.splice(i, 1); continue; }
      if (s.anc) s.anc.move(s);
      if (s.life < 0) continue;
      const n = s.life / s.max, f = 1 - n;
      // Out fast and slowing (ease-out), the band thinning to a hairline as it goes
      const r = s.size * (0.12 + 0.88 * (1 - f * f * f));
      this.shockG.ring(s.x, s.y, r, Math.max(0.8, s.width * f), s.color, 0.9 * Math.pow(f, 1.3));
      if (n < 0.4) this.shockG.ring(s.x, s.y, r * 0.96, Math.max(0.6, s.width * 0.35 * f), 0xffffff, 0.7 * (1 - n / 0.4));
    }
    // Fragments: slowing, cooling, a fading streak behind each and a puff of smoke now and then; dimming away at the end
    for (let i = this.frags.length - 1; i >= 0; i--) {
      const p = this.frags[i];
      p.life += frames;
      if (p.life >= p.max) { this.frags.splice(i, 1); continue; }
      // (in the frame of what it came off, slowing to rest on it: it carries the target's motion)
      rideStep(p, p.anc, p.drag, frames);
      const n = p.life / p.max, fade = n < 0.65 ? 1 : 1 - (n - 0.65) / 0.35, sp = Math.hypot(p.vx, p.vy);
      const col = mixColor(p.hot, p.cool, Math.min(1, n * 1.15));
      if (sp > 0.15) this.line(p.x - p.vx * 7, p.y - p.vy * 7, p.x, p.y, p.size * 0.9, p.trail, 0.45 * fade * Math.min(1, sp / 1.5));
      // (a soft glow round it while it's hot)
      if (n < 0.7) this.circle(this.glow, TEX.dot, p.x, p.y, p.size * 2.4, p.trail, 0.28 * (1 - n / 0.7));
      this.circle(this.glow, TEX.disc, p.x, p.y, p.size * (1 - 0.35 * n), col, 0.95 * fade);
      if (n < 0.3) this.circle(this.glow, TEX.disc, p.x, p.y, p.size * 0.45, 0xffffff, 0.8 * (1 - n / 0.3));
      p.puff -= frames;
      if (p.puff <= 0 && n < p.smokes && this.smoke.length < SMOKE_CAP && Math.random() < this.particleKeep) {
        p.puff = 3 + Math.random() * 3;
        const max = 26 + Math.random() * 16;
        this.smoke.push({ x: p.x, y: p.y, vx: p.vx * 0.1, vy: p.vy * 0.1, life: 0, max, size: p.size * 1.3, color: 0x6a625a, alpha: 0.22 * (1 - n), anc: p.anc });
        p.anc?.hold(max + 2);
      }
    }
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i];
      f.life += frames;
      if (f.life >= f.max) { this.flares.splice(i, 1); continue; }
      if (f.anc) { f.anc.move(f); f.a += f.anc.turn; }
      const n = f.life / f.max, out = 1 - Math.pow(1 - Math.min(1, n / 0.3), 3);
      // Shoots out fast (eased) from the hit, its root lifting off after it as it fades, thinning
      const r1 = f.len * out, r0 = f.len * 0.55 * Math.max(0, (n - 0.25) / 0.75), c = Math.cos(f.a), sn = Math.sin(f.a);
      const fade = Math.pow(1 - n, 1.3), w = f.width * (1 - 0.6 * n);
      this.line(f.x + c * r0, f.y + sn * r0, f.x + c * r1, f.y + sn * r1, w * 2.6, f.color, 0.55 * fade);
      this.line(f.x + c * r0, f.y + sn * r0, f.x + c * r1, f.y + sn * r1, w, 0xffffff, 0.95 * fade);
    }
    for (let i = this.hitLights.length - 1; i >= 0; i--) {
      const l = this.hitLights[i];
      l.life += frames;
      if (l.life >= l.max) this.hitLights.splice(i, 1);
      else if (l.anc) l.anc.move(l);
    }
  }

  // -------------------------------------------------------------------------

  private createShot(e: InterpolatedEntity): Shot {
    const type = e.data?.[0] ?? WeaponType.Cannon;
    // data[1]: the gun's grade
    const look = this.shellLook?.(e.id, e);
    const style = weaponStyle(type, e.data?.[1] ?? 1, look?.model);
    const hue = e.data?.[2] ?? 30;
    const shot: Shot = {
      id: e.id,
      style,
      size: e.data?.[7] || 1,
      power: shotScale(look?.damage),
      phase: (e.id * 0.618) % 1, dim: this.dimOf(style, e.id), hot: 0,
      type,
      owner: e.data?.[6] ?? -1,
      glow: type === WeaponType.PrismShard ? hueColor((e.id * 67) % 360) : mixColor(style.glowColor, hueColor(hue), style.ownerTint),
      spawnX: e.spawnX ?? e.x,
      spawnY: e.spawnY ?? e.y,
      spawnTick: e.spawnTick ?? 0,
      vx: e.vx,
      vy: e.vy,
      hit: null,
      flashed: false,
      model: look?.model, grade: e.data?.[1] ?? 1, turret: e.data?.[8] === 1,
      predicted: false,
      pose: this.firePose?.(e.id),
      endTick: e.data?.[9] ?? 0, landX: 0, landY: 0, splash: look?.splash ?? 0, arc: 0, t: 0, pulse: 0,
      fading: null, pierceLeft: look?.pierce ?? 0,
      endAt: look?.life ? (e.spawnTick ?? 0) + look.life : Infinity, gone: false, pending: null,
      head: null,
      tail: null, ctX: NaN, ctY: NaN,
      ended: false, endedAt: 0, passed: null, unconfirmed: 0, arm: look?.arm ?? 0,
    };
    if (shot.endTick > 0) {
      const o = { x: 0, y: 0 };
      landingPoint(shot.spawnX, shot.spawnY, shot.vx, shot.vy, shot.spawnTick, shot.endTick, o);
      shot.landX = o.x; shot.landY = o.y;
    }
    return shot;
  }

  private nextPredicted = -1;

  /** A stream's accent: every nth round bright, the rest dim */
  private dimOf(style: WeaponStyle, n: number): number {
    return style.accent && n % style.accent.every !== 0 ? style.accent.dim : 1;
  }

  /**
   * A puff off a gun that is not shooting: smoke venting from a housing, or sparks (a spent clip's eject, a rail's
   * vent). From the ship renderer, on reload.
   */
  vent(x: number, y: number, angle: number, kind: 'smoke' | 'spark', color: number): void {
    if (this.particleKeep < 1 && Math.random() > this.particleKeep) return;
    if (kind === 'smoke') {
      const a = angle + (Math.random() - 0.5) * 1.4;
      this.smoke.push({ x, y, vx: Math.cos(a) * 0.7, vy: Math.sin(a) * 0.7, life: 0, max: 40 + Math.random() * 20, size: 5 + Math.random() * 3, color, alpha: 0.2 });
      return;
    }
    for (let i = 0; i < 2; i++) {
      const a = angle + (Math.random() - 0.5) * 1.6, v = 1.5 + Math.random() * 2;
      this.sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 14 + Math.random() * 10, color });
    }
  }

  /**
   * A shell your client just fired (guns.ts): it flies from your barrel now, the server's copy takes it over when it
   * comes. Or another ship's drawn ahead by the PT timeline (predict/kinds/movesKind.ts), on its owner's timeline.
   * Returns its id here (retract takes it back)
   */
  predict(p: PredictedShell): number {
    const style = weaponStyle(p.type, p.grade, p.model);
    const id = this.nextPredicted--;
    this.shots.set(id, {
      id, style, size: p.size, power: shotScale(p.damage), phase: (-id * 0.618) % 1, dim: this.dimOf(style, -id), hot: 0, type: p.type, owner: p.owner,
      glow: mixColor(style.glowColor, hueColor((p.owner * 137) % 360), style.ownerTint),
      spawnX: p.spawnX, spawnY: p.spawnY, spawnTick: p.spawnTick, vx: p.vx, vy: p.vy,
      hit: null, flashed: false, model: p.model, grade: p.grade ?? 1, turret: p.turret ?? false, predicted: true, pose: p.pose, endTick: 0, landX: 0, landY: 0, splash: 0, arc: 0, t: 0, pulse: 0, fading: null, pierceLeft: p.pierce ?? 0,
      endAt: p.life ? p.spawnTick + p.life : Infinity, gone: false, pending: null, head: null, tail: null, ctX: NaN, ctY: NaN,
      ended: false, endedAt: 0, passed: null, unconfirmed: 0, arm: p.arm ?? 0,
    });
    return id;
  }

  /** A shell drawn ahead that never was (the PT timeline's re-step took it back): it fades where it is */
  retract(id: number): void {
    const s = this.shots.get(id);
    if (s && s.predicted && s.fading === null) s.fading = 0;
    if (s?.predicted) this.sounds?.retracted(id);
  }

  /**
   * The server's copy of a shell we fired ahead: same owner and weapon, the
   * same tick, from the same barrel, the same way. It takes over (keeping the
   * flight already drawn), so hits reported for it stop the right tracer.
   */
  private claim(e: InterpolatedEntity): Shot | null {
    const owner = e.data?.[6] ?? -1, type = e.data?.[0] ?? -1;
    const sx = e.spawnX ?? e.x, sy = e.spawnY ?? e.y, tick = e.spawnTick ?? 0;
    let best: Shot | null = null, bd = Infinity;
    for (const s of this.shots.values()) {
      // (one that already ended at a surface too: the server's copy takes it over ended, so it isn't drawn again)
      if (!s.predicted || s.owner !== owner || s.type !== type || (s.fading !== null && !s.ended)) continue;
      const dt = Math.abs(s.spawnTick - tick);
      if (dt > 3) continue;
      const d = Math.hypot(s.spawnX - sx, s.spawnY - sy) + Math.hypot(s.vx - e.vx, s.vy - e.vy) * 20 + dt * 10;
      if (d < bd) { bd = d; best = s; }
    }
    if (!best || bd > 120) return null;
    this.shots.delete(best.id);
    this.tally?.('renamed', e.id, best.owner, best.id);
    this.sounds?.renamed(best.id, e.id);
    best.id = e.id;
    best.predicted = false;
    return best;
  }

  /**
   * A hit on a shell this client never saw (h.id unknown after the snapshot it came with): one of yours that was fired
   * and spent between two snapshots, so no row ever brought it (a fast shell at close range: most Spark bolts inside
   * about 350), or one that came and went in a single coalesced message. Its predicted shell is flying still: without
   * this it was never claimed and flew on through what it hit to the end of its reach. The hit takes the predicted shell
   * whose line runs through the hit point (within ADOPT_REACH) and whose head, on your timeline (`present`), has got
   * there, not more than ADOPT_TICKS ago; of several (a stream from one gun lies along one line; twin turrets cross at
   * the aim), the oldest, as the hits come in firing order.
   */
  private adopt(h: { id: number; x: number; y: number }, present: number): Shot | null {
    let best: Shot | null = null, bp = Infinity;
    for (const s of this.shots.values()) {
      if (!s.predicted || (s.fading !== null && !s.ended) || s.style.motion !== 'linear') continue;
      const age = hitAge(s.spawnX, s.spawnY, s.vx, s.vy, h.x, h.y), flown = Math.min(present, s.endAt) - s.spawnTick;
      if (age < -1 || age > flown + 1 || flown - age > ADOPT_TICKS) continue;
      const off = Math.hypot(s.spawnX + s.vx * age - h.x, s.spawnY + s.vy * age - h.y);
      if (off > ADOPT_REACH) continue;
      if (!best || s.spawnTick < best.spawnTick - 0.5 || (Math.abs(s.spawnTick - best.spawnTick) <= 0.5 && off < bp)) { best = s; bp = off; }
    }
    if (!best) return null;
    this.shots.delete(best.id);
    this.tally?.('renamed', h.id, best.owner, best.id);
    this.sounds?.renamed(best.id, h.id);
    best.id = h.id;
    best.predicted = false;
    this.shots.set(h.id, best);
    return best;
  }

  private timeline(shot: Shot, state: GameState, presentTick: number, renderTick: number): number {
    // (A dev prediction mode's pick: GameState.drawMode, state/drawMode.ts)
    if (state.drawMode?.shot) return state.drawMode.shot(shot.owner, presentTick, renderTick);
    return !state.predictionEnabled || shot.owner === state.playerId ? presentTick : renderTick;
  }

  private place(shot: Shot, e: InterpolatedEntity | undefined, t: number): void {
    const age = t - shot.spawnTick;
    if (age < 0) { shot.head = null; return; } // not fired yet on this timeline
    shot.arc = arcFraction(t, shot.spawnTick, shot.endTick);
    const trail = shot.style.tracerTicks;
    if (shot.style.motion === 'linear') {
      // (From its barrel's tip at first, easing onto its true path)
      const off = (a: number) => Math.max(0, 1 - a / BARREL_EASE);
      const ox = shot.vox ?? 0, oy = shot.voy ?? 0;
      shot.head = { x: shot.spawnX + shot.vx * age + ox * off(age), y: shot.spawnY + shot.vy * age + oy * off(age) };
      const ta = Math.max(0, age - trail);
      shot.tail = { x: shot.spawnX + shot.vx * ta + ox * off(ta), y: shot.spawnY + shot.vy * ta + oy * off(ta) };
    } else if (e) {
      shot.head = { x: e.renderX, y: e.renderY };
      // Tail follows the current heading back, but never behind the muzzle
      const back = Math.min(Math.hypot(e.vx, e.vy) * trail, Math.hypot(e.renderX - shot.spawnX, e.renderY - shot.spawnY));
      const sp = Math.hypot(e.vx, e.vy) || 1;
      shot.tail = { x: e.renderX - (e.vx / sp) * back, y: e.renderY - (e.vy / sp) * back };
    }
  }

  /** Where a prism splits: each shard throws a ring and a few sparks in its own hue, so the five make a rainbow pop */
  private splitFlash(shot: Shot): void {
    const angle = Math.atan2(shot.vy, shot.vx);
    this.rings.push({ x: shot.spawnX, y: shot.spawnY, life: 0, max: 14, size: 38, color: shot.glow });
    this.rings.push({ x: shot.spawnX, y: shot.spawnY, life: 0, max: 9, size: 16, color: 0xffffff });
    for (let i = 0; i < 4; i++) {
      const a = angle + (Math.random() - 0.5) * 0.5, v = 3 + Math.random() * 3;
      this.sparks.push({ x: shot.spawnX, y: shot.spawnY, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 14 + Math.random() * 8, color: shot.glow });
    }
  }

  /** A directional flash out of the barrel (a long forward tongue and two side petals), sparks and a smoke puff */
  private muzzleFlash(shot: Shot, owner?: { renderX: number; renderY: number; renderAngle: number }): void {
    const m = shot.style.muzzle;
    const angle = Math.atan2(shot.vy, shot.vx);
    this.onMuzzle?.(shot.owner, shot.spawnX, shot.spawnY, shot.power);
    // At the drawn barrel's tip (shells spawn on the facing edge, the barrel pokes out past it), and the shell drawn from there too
    const tip = this.barrelTip?.(shot.owner, shot.spawnX, shot.spawnY, angle);
    if (tip) { shot.vox = tip.x - shot.spawnX; shot.voy = tip.y - shot.spawnY; }
    const x = tip?.x ?? shot.spawnX, y = tip?.y ?? shot.spawnY;
    // (in step with the shot through the usual range, never a speck, and growing slower past a heavy launch: muzzleScale)
    const size = m.size * muzzleScale(shot.size * shot.power);
    if (shot.style.heat) shot.hot = Math.max(0, Math.min(1, this.spinAt?.(shot.owner, shot.spawnX, shot.spawnY) ?? 0));
    // The barrel in the ship's frame: from the ship's pose on the fire tick (exact), else as it's drawn now (it's drawn at that tick)
    const ref = shot.pose ?? (owner ? { x: owner.renderX, y: owner.renderY, angle: owner.renderAngle } : undefined);
    const oa = ref?.angle ?? 0, c = Math.cos(-oa), sn = Math.sin(-oa);
    const dx = ref ? x - ref.x : 0, dy = ref ? y - ref.y : 0;
    this.flashes.push({
      x, y, angle, life: 0, max: m.life, size, color: m.color,
      sparks: Array.from({ length: m.sparks }, () => ({ a: (Math.random() - 0.5) * 0.7, l: size * (0.9 + Math.random() * 1.1) })),
      petals: [(1.6 + Math.random() * 0.8) * (m.tongue ?? 1), 0.6 + Math.random() * 0.3, 0.6 + Math.random() * 0.3], girth: m.girth ?? 1,
      owner: owner ? shot.owner : -1, ox: dx * c - dy * sn, oy: dx * sn + dy * c, rel: angle - oa,
    });
    // Spent casings flung out to the side, tumbling away
    // (a minigun throws more brass the faster it spins)
    const brass = Math.round((shot.style.casings ?? 0) * (shot.style.heat ? 0.3 + 0.9 * shot.hot : 1));
    for (let i = 0; i < brass; i++) {
      const side = angle + (Math.random() < 0.5 ? 1 : -1) * (1.2 + Math.random() * 0.5), v = 1.4 + Math.random() * 1.8;
      this.sparks.push({ x, y, vx: Math.cos(side) * v, vy: Math.sin(side) * v, life: 0, max: 26 + Math.random() * 14, color: 0xe0b860, width: 2.4 });
    }
    // Shock rings off the muzzle (a rail's coil rings come one after another, each wider)
    const mr = m.ring;
    if (mr) {
      const n = mr.count ?? 1;
      for (let i = 0; i < n; i++) {
        const ahead = i * size * 0.25;
        this.rings.push({ x: x + Math.cos(angle) * ahead, y: y + Math.sin(angle) * ahead, life: 0, max: 9 + i * 3, size: size * (mr.size ?? 1) * (0.5 + 0.3 * i), color: mr.color });
      }
    }
    // Smoke puffs out ahead of the barrel, carried a little by the shot, and left behind as the ship flies on
    for (let i = 0; i < m.smoke; i++) {
      if (this.particleKeep < 1 && Math.random() > this.particleKeep) continue;
      const a = angle + (Math.random() - 0.5) * 0.8, s = 0.8 + Math.random() * 1.6;
      const ahead = size * (0.4 + Math.random() * 0.5);
      this.smoke.push({ x: x + Math.cos(angle) * ahead, y: y + Math.sin(angle) * ahead, vx: Math.cos(a) * s + shot.vx * 0.04, vy: Math.sin(a) * s + shot.vy * 0.04,
        life: 0, max: 26 + Math.random() * 18, size: size * (0.12 + Math.random() * 0.1) });
    }
  }

  /** A ring of `r` radius (the ring texture's) */
  private ringAt(x: number, y: number, r: number, color: number, alpha: number): void {
    const k = (r * 2 * 32) / (28 * DOT_SIZE);
    this.extraG.take(TEX2.ring, x, y, 0.5, 0.5, color, alpha, 0, k, k);
  }

  /**
   * Where every lobbed shell will land, for everyone (its endTick, worked out where it comes down): the blast's ring and a
   * second ring tightening onto it as the shell falls. Yours in the shell's own colour, others' in a warning red.
   */
  private drawLandings(): void {
    for (const shot of this.shots.values()) {
      if (shot.fading === null && shot.endTick && shot.style.aimTick && shot.head && shot.owner === this.state?.playerId) {
        // Your Cloudmaker shell: a faint tick across its line where it will burst
        const sp = Math.hypot(shot.vx, shot.vy) || 1, nx = -shot.vy / sp, ny = shot.vx / sp;
        this.line(shot.landX - nx * 26, shot.landY - ny * 26, shot.landX + nx * 26, shot.landY + ny * 26, 2, shot.style.coreColor, 0.45);
        this.ringAt(shot.landX, shot.landY, 9, shot.style.coreColor, 0.35);
      }
      if (shot.fading !== null || !shot.endTick || !shot.style.landBurst || !shot.head) continue;
      const f = shot.arc, r = shot.splash || 200;
      const own = shot.owner === this.state?.playerId;
      const col = own ? shot.style.impact.color : 0xff6a4a;
      this.ringAt(shot.landX, shot.landY, r, col, 0.16 + 0.34 * f);
      this.ringAt(shot.landX, shot.landY, r * (1 + 1.3 * (1 - f)), col, 0.25 + 0.45 * f);
      this.circle(this.extraG, TEX.dot, shot.landX, shot.landY, 10 + 20 * f, col, 0.2 + 0.4 * f);
    }
  }

  /** The distance to the nearest ship that is not the shell's owner (a sonar's quickening) */
  private nearestShip(shot: Shot): number {
    const st = this.state;
    if (!st || !shot.head) return Infinity;
    let best = Infinity;
    for (const type of SHIP_TYPES) {
      for (const e of st.entities.ofType(type)) {
        if (e.id === shot.owner) continue;
        const d = Math.hypot(e.renderX - shot.head.x, e.renderY - shot.head.y);
        if (d < best) best = d;
      }
    }
    return best;
  }

  /** A dashed line from (x, y) toward your cursor, while you hold fire */
  private guideLine(x: number, y: number): void {
    const to = this.guideTo?.();
    if (!to) return;
    const dx = to.x - x, dy = to.y - y, full = Math.hypot(dx, dy), len = Math.min(full, 1400);
    if (len < 40) return;
    const ux = dx / full, uy = dy / full;
    for (let d = 30; d < len; d += 38) {
      const e = Math.min(len, d + 20);
      this.line(x + ux * d, y + uy * d, x + ux * e, y + uy * e, 1.5, 0xcfe6ff, 0.34 * (1 - d / 1700));
    }
    if (full <= 1400) this.ringAt(to.x, to.y, 14, 0xcfe6ff, 0.4);
  }

  /** Ages the contrail segments and draws the live ones (the oldest are at the back of the ring and expire first) */
  private drawTrails(frames: number): void {
    for (let i = 0; i < this.trailLen; i++) {
      const sg = this.trail[(this.trailHead - 1 - i + TRAIL_CAP) % TRAIL_CAP];
      sg.age += frames;
      if (sg.age >= sg.max) continue;
      const f = 1 - sg.age / sg.max;
      this.line(sg.x0, sg.y0, sg.x1, sg.y1, sg.width, sg.color, sg.alpha * f);
    }
    // (Lives differ per style, so only the oldest ones can be dropped from the count)
    while (this.trailLen > 0) {
      const old = this.trail[(this.trailHead - this.trailLen + TRAIL_CAP) % TRAIL_CAP];
      if (old.age < old.max) break;
      this.trailLen--;
    }
  }

  /**
   * The shots' fades this frame: one faded out goes (a hit still waiting for its head goes off first), except an ended
   * one, kept undrawn a while for what the server says of it later, then remembered by id (spent)
   */
  private ageShots(frames: number): void {
    // (Deleting the current entry while iterating a Map is safe)
    for (const shot of this.shots.values()) {
      if (shot.fading === null) continue;
      shot.fading += frames;
      if (shot.fading < FADE_FRAMES) continue;
      if (shot.pending) this.landPending(shot, Infinity, true);
      if (shot.ended && this.clock - shot.endedAt < KEEP_ENDED_FRAMES) continue;
      if (shot.ended && shot.id >= 0) {
        this.spent.set(shot.id, shot.spawnTick);
        if (this.spent.size > 1024) this.spent.delete(this.spent.keys().next().value!);
      }
      this.shots.delete(shot.id);
    }
  }

  private draw(frames: number): void {
    const g = this.glow;
    g.begin();
    this.smokeG.begin();
    this.extraG.begin();
    this.hitG.begin();
    this.shockG.begin();
    this.clock += frames;
    // (impacts ride what they hit: each anchor follows its target first, so everything on it is drawn where it now is)
    if (this.anchors.live.length) this.anchors.step(this.state?.entities, frames);
    if (this.crackling) { this.crackle.clear(); this.crackling = false; }

    this.ageShots(frames);
    for (const shot of this.shots.values()) {
      if (!shot.head || !shot.tail || (shot.fading !== null && shot.fading >= FADE_FRAMES)) continue;
      const fade = shot.fading === null ? 1 : 1 - shot.fading / FADE_FRAMES;
      const st = shot.style;
      // A dying tracer shrinks towards its head
      const k = shot.fading === null ? 0 : shot.fading / FADE_FRAMES;
      const tx = shot.tail.x + (shot.head.x - shot.tail.x) * k;
      const ty = shot.tail.y + (shot.head.y - shot.tail.y) * k;

      const z = shot.size * (st.lob ? 1 + st.lob * Math.sin(Math.PI * shot.arc) : 1);
      let hx = shot.head.x, hy = shot.head.y, bx = tx, by = ty;
      const dx = hx - bx, dy = hy - by, dl = Math.hypot(dx, dy);
      const ux = dl > 1e-6 ? dx / dl : 1, uy = dl > 1e-6 ? dy / dl : 0, nx = -uy, ny = ux;
      let alpha = fade * shot.dim;
      let coreCol = st.coreColor, glowCol = shot.glow;
      if (st.heat) {
        // (tracers run from the cold colour to the hot one with the gun's spin)
        coreCol = mixColor(st.heat.cold, st.heat.hot, shot.hot);
        glowCol = mixColor(shot.glow, st.heat.cold, 0.5 + 0.3 * shot.hot);
      }
      if (st.blink) alpha *= ((this.clock / st.blink + shot.phase * 2) % 1) < 0.5 ? 1 : 0.2;
      if (st.wobble && !shot.ended) {
        // The head sways across its line, the tail trailing the sway
        const w = st.wobble, sw = Math.sin(((this.clock + shot.phase * w.period) / w.period) * Math.PI * 2) * w.amp * z;
        hx += nx * sw; hy += ny * sw;
        bx += nx * sw * 0.4; by += ny * sw * 0.4;
      }
      const lanes = st.pair ? 2 : 1;
      for (let lane = 0; lane < lanes; lane++) {
        // A pair runs as two thinner tracers either side of the line
        const off = lanes === 2 ? (lane === 0 ? -0.5 : 0.5) * st.pair!.gap * z : 0, wk = lanes === 2 ? 0.7 : 1;
        const ox = nx * off, oy = ny * off;
        if (shot.ended) {
          // Ended at a surface: the tracer collapses into the impact point, its round end kept behind it, no head or halo
          // past it (the impact is drawn there)
          const gw = st.glowWidth * z * wk, cw = st.coreWidth * z * wk;
          if (gw > 0 && dl > gw) this.line(bx + ox, by + oy, hx + ox - ux * gw * 0.5, hy + oy - uy * gw * 0.5, gw, glowCol, st.glowAlpha * alpha);
          if (cw > 0 && dl > cw) this.line(bx + ox, by + oy, hx + ox - ux * cw * 0.5, hy + oy - uy * cw * 0.5, cw, coreCol, 0.9 * alpha);
          continue;
        }
        if (st.glowWidth > 0) this.line(bx + ox, by + oy, hx + ox, hy + oy, st.glowWidth * z * wk, glowCol, st.glowAlpha * alpha);
        if (st.coreWidth > 0) this.line(bx + ox, by + oy, hx + ox, hy + oy, st.coreWidth * z * wk, coreCol, 0.9 * alpha);
        if (st.haloRadius > 0) {
          this.circle(g, TEX.disc, hx + ox, hy + oy, st.haloRadius * z * wk, shot.glow, 0.14 * alpha);
          this.circle(g, TEX.disc, hx + ox, hy + oy, st.haloRadius * z * wk * 0.55, shot.glow, 0.22 * alpha);
        }
        if (st.headRadius > 0) this.circle(g, TEX.disc, hx + ox, hy + oy, st.headRadius * z * wk, st.headColor ?? 0xffffff, alpha);
      }
      const speed = Math.hypot(shot.vx, shot.vy);
      // A contrail: a segment laid from where the head was last frame to where it is now, left in the world to fade over `life` frames
      const ct = st.contrail;
      if (ct && shot.fading === null) {
        if (shot.ctX === shot.ctX && Math.hypot(hx - shot.ctX, hy - shot.ctY) > 0.5) {
          const sg = this.trail[this.trailHead];
          sg.x0 = shot.ctX; sg.y0 = shot.ctY; sg.x1 = hx; sg.y1 = hy; sg.age = 0; sg.max = ct.life;
          sg.width = ct.size * z; sg.color = ct.color; sg.alpha = 0.5 * alpha;
          this.trailHead = (this.trailHead + 1) % TRAIL_CAP;
          if (this.trailLen < TRAIL_CAP) this.trailLen++;
        }
        shot.ctX = hx; shot.ctY = hy;
      }
      // Ghost copies of the head, each further back and fainter
      if (st.afterimages && shot.fading === null) {
        const gap = Math.max(3, speed * 0.9);
        for (let i = 1; i <= st.afterimages; i++) {
          const f = i / (st.afterimages + 1);
          this.circle(g, TEX.disc, hx - ux * gap * i, hy - uy * gap * i, Math.max(1, st.headRadius * z) * (1 - 0.5 * f), shot.glow, 0.5 * (1 - f) * alpha * (0.55 + 0.45 * Math.sin(this.clock * 0.9 + i * 2.1 + shot.phase * 11)));
        }
      }
      // A ring swelling off the head and fading, again and again
      const rp = st.ringPulse;
      if (rp && shot.fading === null) {
        // (A sonar quickens as it closes on a ship: the phase builds up, so the period can change without a jump)
        if (shot.pulse === 0) shot.pulse = shot.phase || 0.001;
        shot.pulse += frames / (rp.closing ? sonarPeriod(rp.period, this.nearestShip(shot), rp.closing) : rp.period);
        const q = shot.pulse % 1, r = rp.size * z * (0.3 + 0.7 * q);
        const k2 = (r * 2 * 32) / (28 * DOT_SIZE);
        this.extraG.take(TEX2.ring, hx, hy, 0.5, 0.5, rp.color, 0.7 * (1 - q) * alpha, 0, k2, k2);
      }
      // A light at the nose: a hard blink, or a slow pulse
      const ns = st.nose;
      if (ns && shot.fading === null) {
        const ph = ((this.clock + shot.phase * ns.period) % ns.period) / ns.period;
        const on = ns.blink ? (ph < 0.22 ? 1 : 0) : 0.5 + 0.5 * Math.sin(ph * Math.PI * 2);
        if (on > 0.02) {
          this.circle(g, TEX.dot, hx, hy, ns.size * z * (0.8 + 0.5 * on), ns.color, 0.6 * on * alpha);
          this.circle(g, TEX.disc, hx, hy, ns.size * z * 0.28, mixColor(ns.color, 0xffffff, 0.5), on * alpha);
        }
      }
      // Your own guided shell: a dashed guide to your cursor while you hold fire (it flies where you point)
      if (st.guide && shot.fading === null && shot.owner === this.state?.playerId) this.guideLine(hx, hy);
      // A thin cloud as it flies: soft puffs along its path
      const sc = st.smokeCloud;
      if (sc?.fly && shot.fading === null) {
        const reach = Math.min(speed * 6, 180);
        for (let i = 0; i < 5; i++) {
          const f = (i + 1) / 5, r = sc.size * z * (0.7 + 0.8 * f), kk = (r * 2) / DOT_SIZE;
          this.extraG.take(TEX2.puff, hx - ux * reach * f, hy - uy * reach * f, 0.5, 0.5, sc.color, 0.22 * (1 - f) * alpha, 0, kk, kk);
        }
      }
      // A blast radius you can see coming: a faint ring round the head, the whole flight
      const rr = st.radiusRing;
      if (rr && shot.fading === null) {
        const k2 = (rr.radius * 2 * 32) / (28 * DOT_SIZE);
        this.extraG.take(TEX2.ring, hx, hy, 0.5, 0.5, rr.color, 0.22 * alpha, 0, k2, k2);
      }
      // A bolt of lightning down the whole tracer, different every frame
      const jg = st.jagged;
      if (jg && shot.fading === null && dl > 1) {
        const c = this.crackle, n = Math.max(4, Math.min(14, Math.round(dl / 40)));
        this.crackling = true;
        for (let pass = 0; pass < 2; pass++) {
          c.moveTo(bx, by);
          for (let i = 1; i <= n; i++) {
            const f = i / n, o = i === n ? 0 : (Math.random() - 0.5) * 2 * jg.amp * z;
            c.lineTo(bx + dx * f + nx * o, by + dy * f + ny * o);
          }
          c.stroke(pass === 0 ? { color: jg.color, width: 3, alpha: 0.35 * fade } : { color: 0xffffff, width: 1.2, alpha: 0.95 * fade });
        }
      }
      // Crackle (EMP orbs, arcs, lightning-wrapped shots)
      const lt = st.lightning ?? (st.orb ? ORB_LIGHTNING : undefined);
      if (lt && shot.fading === null) {
        const c = this.crackle, as = st.arcScale ?? 1;
        this.crackling = true;
        for (let k = 0; k < lt.forks; k++) {
          const a0 = Math.random() * Math.PI * 2;
          let x = hx, y = hy;
          c.moveTo(x, y);
          for (let j = 0; j < 4; j++) {
            x += Math.cos(a0 + (Math.random() - 0.5) * 1.6) * lt.length * as * z;
            y += Math.sin(a0 + (Math.random() - 0.5) * 1.6) * lt.length * as * z;
            c.lineTo(x, y);
          }
          c.stroke({ color: lt.color, width: 1.5, alpha: 0.8 * fade });
        }
      }
      // A gravity well: a faint ring at the pull radius and motes streaming in to the head, quickening as they fall
      const pl = st.pull;
      if (pl && shot.fading === null) {
        const c = this.crackle;
        this.crackling = true;
        c.circle(hx, hy, pl.radius).stroke({ color: pl.color, width: 2.5, alpha: 0.14 * alpha });
        c.circle(hx, hy, pl.radius * 0.985).stroke({ color: pl.color, width: 9, alpha: 0.04 * alpha });
        const N = 22;
        for (let i = 0; i < N; i++) {
          const f = (this.clock * 0.011 + i / N + shot.phase) % 1, a = i * 2.399 + shot.phase * 6.283 + f * 1.1;
          const r1 = pl.radius * (1 - f * f), r0 = Math.min(pl.radius, r1 + 24 + 90 * f), ca = Math.cos(a), sa = Math.sin(a);
          c.moveTo(hx + ca * r0, hy + sa * r0).lineTo(hx + ca * r1, hy + sa * r1).stroke({ color: pl.color, width: 2, alpha: 0.55 * Math.sin(f * Math.PI) * alpha });
        }
      }
      // Missiles leave smoke
      if (st.trail && shot.fading === null && Math.random() < 0.8) {
        this.smoke.push({ x: (st.wobble ? hx : shot.head.x) - shot.vx * 0.5, y: (st.wobble ? hy : shot.head.y) - shot.vy * 0.5, vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4,
          life: 0, max: st.trail.life * (0.7 + Math.random() * 0.6), size: st.trail.size * (0.6 + Math.random() * 0.5) });
      }
    }

    this.drawLandings();
    this.drawTrails(frames);

    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life += frames;
      if (f.life >= f.max) { this.flashes.splice(i, 1); continue; }
      const n = f.life / f.max, fade = 1 - n;
      // Soft bloom, then the flash shape: a long tongue forward and two short petals to the sides
      this.circle(g, TEX.dot, f.x, f.y, f.size * (0.7 + 0.5 * n) * 1.4 * f.girth, f.color, 0.3 * fade);
      const petal = (dir: number, len: number, wid: number, color: number, alpha: number) => {
        const k = petalScale(f.size * len * (0.7 + 0.5 * n), f.size * wid * fade * f.girth);
        g.take(TEX.petal, f.x, f.y, 0, 0.5, color, alpha, f.angle + dir, k.x, k.y);
      };
      petal(0, f.petals[0], 0.32, f.color, 0.75 * fade);
      petal(0, f.petals[0] * 0.6, 0.16, 0xffffff, 0.9 * fade);
      petal(Math.PI / 2.4, f.petals[1], 0.18, f.color, 0.55 * fade);
      petal(-Math.PI / 2.4, f.petals[2], 0.18, f.color, 0.55 * fade);
      this.circle(g, TEX.disc, f.x, f.y, f.size * 0.3 * fade * f.girth + 0.5, 0xffffff, 0.95 * fade);
      for (const sp of f.sparks) {
        const a = f.angle + sp.a;
        const l = sp.l * (0.5 + n);
        this.line(f.x + Math.cos(a) * l * 0.4, f.y + Math.sin(a) * l * 0.4, f.x + Math.cos(a) * l, f.y + Math.sin(a) * l, 1.4, f.color, 0.8 * fade);
      }
    }

    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const p = this.sparks[i];
      p.life += frames;
      if (p.life >= p.max) { this.sparks.splice(i, 1); continue; }
      // (in the frame of what it came off, if anything, slowing to rest on it: its streak drawn by its own motion off that)
      rideStep(p, p.anc, p.drag ?? 0.9, frames);
      const n = p.life / p.max, rvx = p.vx, rvy = p.vy;
      if (p.cool !== undefined) {
        // An ember: cooling as it goes, bright for most of its life and fading at the end
        this.line(p.x - rvx * 2, p.y - rvy * 2, p.x, p.y, p.width ?? 2.4, mixColor(p.color, p.cool, Math.min(1, n * 1.3)), 1 - n * n);
        continue;
      }
      this.line(p.x - rvx * 2.5, p.y - rvy * 2.5, p.x, p.y, p.width ?? 1.5, p.color, 1 - n);
    }

    // Gun smoke and impact vapour (normal blending, so it reads as smoke, not light)
    for (let i = this.smoke.length - 1; i >= 0; i--) {
      const s = this.smoke[i];
      s.life += frames;
      if (s.life >= s.max) { this.smoke.splice(i, 1); continue; }
      rideStep(s, s.anc, 0.95, frames);
      const k = s.life / s.max;
      this.circle(this.smokeG, TEX.dot, s.x, s.y, s.size * (1 + 1.8 * k) * 1.3, s.color ?? 0xb4aea6, (s.alpha ?? 0.16) * (1 - k) * Math.min(1, k * 8));
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life += frames;
      if (r.life >= r.max) { this.rings.splice(i, 1); continue; }
      if (r.anc) r.anc.move(r);
      const n = r.life / r.max;
      this.circle(g, TEX.disc, r.x, r.y, r.size * (0.3 + 0.7 * n), r.color, 0.35 * (1 - n));
      this.circle(g, TEX.disc, r.x, r.y, r.size * 0.25 * (1 - n) + 0.5, 0xffffff, 0.8 * (1 - n));
    }
    this.drawHits(frames);
    g.end();
    this.smokeG.end();
    this.extraG.end();
    this.hitG.end();
    this.shockG.end();
  }
}
