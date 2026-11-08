/**
 * @contract client.weaponFx
 * owns:       the life of every drawn shell (placing it on its timeline, predicted shells and the server's takeover, drawn
 *             hits and the server's), and the frame loop that hands it to the effect sub-systems in fx/
 * needs:      fx/FxField (pools and particles), fx/TracerFx (shell drawing), fx/MuzzleFx, fx/ImpactFx, fx/shotFactory, GameState,
 *             hooks set by the Renderer (barrelTip, castHit, surfaceAt, onStruck, sounds, shellLook, firePose, spinAt, guideTo)
 * events:     onMuzzle (a shot left its gun), onStruck (a shell stopped at a drawn surface), tally (dev hit agreement)
 * invariants: a drawn shell stops at the first surface it touches and nothing of it shows past — client/src/rendering/weapons/visualStop.test.ts
 *             the server's copy of a shell fired ahead takes over its flight — client/src/rendering/weapons/adoptHit.test.ts
 *             your shells are placed on the present timeline, others' on the interpolated one — client/src/rendering/weapons/ownShotsTimeline.test.ts
 *             a shot's sound is told when its muzzle flash goes off — client/src/rendering/weapons/combatSoundTiming.test.ts
 * extend:     a new look is a WeaponStyle field drawn in fx/TracerFx; a new impact part is a block in fx/ImpactFx; a new particle kind is a list on fx/FxField
 */

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

import type { Container } from 'pixi.js';
import { EntityType, WeaponType } from '@space-game/common';
import type { GameState, InterpolatedEntity } from '../../state/GameState';
import type { ImpactLayers } from './weaponStyles';
import type { Lighting } from '../lighting/Lighting';
import { arcFraction, incomingTicks } from './ordnanceTells';
import { hitAge, type SurfaceNormal } from './impactAim';
import type { CombatSoundFeed } from '../../audio/CombatSounds';
import { FxField } from './fx/FxField';
import { ImpactFx } from './fx/ImpactFx';
import { MuzzleFx } from './fx/MuzzleFx';
import { TracerFx } from './fx/TracerFx';
import { FADE_FRAMES } from './fx/particleTypes';
import { shotFromPrediction, shotFromRow } from './fx/shotFactory';
import type { DrawnHit, FirePoseXY, PredictedShell, ShellLook, Shot } from './fx/shotTypes';

export type { DrawnHit, FirePoseXY, PredictedShell, ShellLook } from './fx/shotTypes';
export { impactScale, turnHue } from './fx/particleTypes';

/** An ended shell is kept (undrawn) this many frames after it ends, for what the server says of it later */
const KEEP_ENDED_FRAMES = 150;

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

export class WeaponFx {
  /** Particle pools and lists, shared by the sub-systems below */
  private readonly f: FxField;
  private readonly impact: ImpactFx;
  private readonly muzzle: MuzzleFx;
  private readonly tracer: TracerFx;
  private clock = 0;
  private shots = new Map<number, Shot>();
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
   * sparks), by its shell's id and type, what it struck as drawn here (-1: not known, the server's point only) and whose
   */
  onStruck: ((id: number, x: number, y: number, type: number, target: number, owner: number) => void) | null = null;
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
    return this.f.glowRoot;
  }

  /** Share of the impact sparks and smoke puffs made (the quality setting's particles) */
  get particleKeep(): number { return this.f.particleKeep; }
  set particleKeep(v: number) { this.f.particleKeep = v; }

  constructor(layer: Container) {
    this.f = new FxField(layer);
    // (the sub-systems read the hooks set on this object live, through these views)
    const fx = this;
    this.impact = new ImpactFx(this.f, {
      get surfaceAt() { return fx.surfaceAt; },
      get sounds() { return fx.sounds; },
      get state() { return fx.state; },
    });
    this.muzzle = new MuzzleFx(this.f, {
      get onMuzzle() { return fx.onMuzzle; },
      get barrelTip() { return fx.barrelTip; },
      get spinAt() { return fx.spinAt; },
    });
    this.tracer = new TracerFx(this.f, {
      get guideTo() { return fx.guideTo; },
      get state() { return fx.state; },
    });
    layer.addChild(this.tracer.crackleGroup);
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
        shot = this.claim(e) ?? shotFromRow(e, this.shellLook?.(e.id, e), this.firePose?.(e.id));
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

    this.f.pinFlashes(state);

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
    this.f.collectLights(L);
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

  /**
   * A held beam's burn throws an impact off the surface it lights (MiningBeamFx, every `burn.every` frames): its layers
   * splash straight out of the surface (the beam flying `dx, dy`), as a laser's do
   */
  beamBurn(x: number, y: number, dx: number, dy: number, owner: number, burn: { color: number; hit: ImpactLayers }): void {
    this.impact.beamBurn(x, y, dx, dy, owner, burn);
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
        if (shot.type === WeaponType.PrismShard) this.muzzle.split(shot); else this.muzzle.flash(shot, state.entities.get(shot.owner));
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
    this.onStruck?.(shot.id, x, y, shot.type, target, shot.owner);
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
    this.onStruck?.(shot.id, x, y, shot.type, h.target, shot.owner);
  }

  /** Has this shell been drawn (now or lately)? Then its hit effects are drawn where it's seen to strike (onStruck) */
  draws(id: number): boolean {
    return this.shots.has(id) || this.spent.has(id);
  }

  /** An impact at (x, y): its shell's style (a plain cannon's if none), thrown the way the style says, riding what it hit */
  private impactAt(shot: Shot | undefined, x: number, y: number): void {
    this.impact.at(shot, x, y);
  }

  private nextPredicted = -1;

  /**
   * A puff off a gun that is not shooting: smoke venting from a housing, or sparks (a spent clip's eject, a rail's
   * vent). From the ship renderer, on reload.
   */
  vent(x: number, y: number, angle: number, kind: 'smoke' | 'spark', color: number): void {
    this.f.vent(x, y, angle, kind, color);
  }

  /**
   * A shell your client just fired (guns.ts): it flies from your barrel now, the server's copy takes it over when it
   * comes. Or another ship's drawn ahead by the PT timeline (predict/kinds/movesKind.ts), on its owner's timeline.
   * Returns its id here (retract takes it back)
   */
  predict(p: PredictedShell): number {
    const id = this.nextPredicted--;
    this.shots.set(id, shotFromPrediction(id, p));
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
    const f = this.f;
    f.begin();
    this.clock += frames;
    // (impacts ride what they hit: each anchor follows its target first, so everything on it is drawn where it now is)
    if (f.anchors.live.length) f.anchors.step(this.state?.entities, frames);
    this.tracer.beginFrame();

    this.ageShots(frames);
    this.tracer.drawAll(this.shots, this.clock, frames);
    f.drawParticles(frames);
    f.drawLayered(frames);
    f.end();
  }
}
