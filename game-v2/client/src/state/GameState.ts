/**
 * Game State - Client-side game state management
 * 
 * Implements:
 * - Server tick estimation with EMA smoothing
 * - Adaptive interpolation delay based on ping + jitter
 * - Snapshot buffering for smooth entity interpolation
 * - Client-side prediction with server reconciliation
 * - Smooth render positions to prevent rubber banding
 * 
 * CRITICAL: Uses BitBuffer precision for all physics to match server exactly.
 */

import { FULL_CHARGE, unpackCharge, pilotExtras, PILOT_ROW, Timeline, type Charge, type TimelineClock, type FlightBody } from '@space-game/common';

/** The own ship on its tick layer at a tick (GameState.ownStep): its body, its stores and priming (no stores: docked, unchanged) */
export interface OwnStepped { body: Readonly<FlightBody>; charge?: Charge; jumpPrime: number }
import { FarShips } from './FarShips';
import { EntityMap, type InterpolatedEntity } from './entities';
import { triggerScreenShake, updateScreenShake, type ScreenShake } from './screenShake';
import { spawnAsteroids, seedAsteroids, clearDeterministicAsteroids } from './asteroidEntities';
import { interpolateFrame } from './interpolation';
export { EntityMap, type InterpolatedEntity };
import { Populations } from './Populations';
import type { DrawModeHook } from './drawMode';
import factionsFile from '../../../data/factions.json';
import {
  ServerSnapshotMessage,
  ClientInputMessage,
  EntityState,
  EntityType,
  podDrift,
  InventorySlot,
  AsteroidSpawnData,
  Composition,
  asteroidParamsAt,
  type AsteroidBeltData,
  calcAsteroidPosition,
  asteroidSpin,
  scaledOrbitTick,
  asteroidRegistry,
} from '@space-game/common';
import {
  PLAYER_MAX_HP,
  BOOST_FUEL_DEFAULT,
  BOOST_REGEN,
  BOOST_REGEN_DELAY,
  TICK_RATE,
  TICK_MS, FOCUS_RANGE, CROWD_BASE_WINDOW, CROWD_RATE_LEAD, crowdPeriodMs,
  INTERP_MAX_DELAY_MS,
  INTERP_MIN_DELAY_MS,
  INTERP_SLEW_MS_PER_SEC,
  PING_HISTORY_SIZE,
} from '@space-game/common';

// ============================================
// INTERFACES
// ============================================

/** Buffered snapshot for interpolation */
export interface BufferedSnapshot {
  tick: number;
  entities: Map<number, EntityState>;
}

// ============================================
// CONSTANTS
// ============================================

const PING_ALPHA = 0.12;           // EMA smoothing for ping
const JITTER_ALPHA = 0.08;         // EMA smoothing for jitter
const SNAPSHOT_BUFFER_SIZE = 6;    // Keep last N snapshots for interpolation
/** A correction of the own ship this far (world units) or more counts as a snap (the overlay's counters) */
const SNAP_THRESHOLD = 260;

// Input delay buffer: inputs are stamped this many ticks ahead (33ms, imperceptible)
const INPUT_DELAY_INITIAL_TICKS = 2;

/** Estimated server tick snaps instead of smoothing when it's this many ticks off */
const SERVER_TICK_SNAP = 20;
/** How much of the way to each pong's tick offset the estimate moves per call (a few hundred ms to settle) */
const TICK_OFFSET_SMOOTHING = 0.03;
/** The prediction re-syncs to the clock estimate (rather than stepping to it) when this far out */
const PREDICT_RESYNC_TICKS = 30;
/** A shell removed before any frame drew it waits for one at most this long (snapshot ticks: a hidden tab draws none) */
const LATE_TICKS = 30;
/** The local ship's predicted poses kept (ticks) */
const SELF_POSE_TICKS = 180;

export class GameState {
  /** Asteroid composition (set by the game from the mining data), deterministic like the server's */
  composeAsteroid: ((type: string, key: string, size: number, systemId: string, stage?: number) => Composition) | null = null;
  /**
   * Where asteroids must be exactly placed this frame: boxes of half size (hw, hh) round the camera and round the pilot
   * (set by the game each frame from the view). Rocks outside both are placed every ORBIT_FAR_TICKS ticks, in turn, so a
   * system's hundreds of rocks aren't all solved every frame. Null: every rock, every tick.
   */
  orbitFocus: { cx: number; cy: number; px: number; py: number; hw: number; hh: number } | null = null;

  // ============================================
  // PLAYER STATE
  // ============================================
  public playerId: number = 0;
  /** Off in proto mode: the client reads the in-process simulation directly. */
  public predictionEnabled = true;
  /**
   * The own ship on its tick layer (set by Game: ShipClient.ownStepTo): stepped to a tick (once per tick: its whole step,
   * guns included, common sim/ownStep.ts; what it fired that tick drawn as it gets there), its state there. Null when
   * there's no own ship on the layer yet (before its first keyframe): it follows the server's rows meanwhile
   */
  public ownStep: ((tick: number) => OwnStepped | null) | null = null;
  /** Where the own ship is drawn at a fractional tick (its layer's pose, corrections eased in: ShipClient.ownPose) */
  public ownPose: ((tick: number) => { x: number; y: number; angle: number } | null) | null = null;
  /** The batteries' charge as one percentage, for the HUD (ShipClient: energy.ts chargeTotal) */
  public chargeTotal: ((charge: Charge) => number) | null = null;
  /** The batteries' charge, as the own ship's tick layer has it at the prediction's tick (energy.ts), and the server's row's */
  public charge: Charge = { ...FULL_CHARGE };
  public serverCharge: Charge = { ...FULL_CHARGE };
  /** Replicated ships: a snapshot's keyframes and control changes go here... */
  public onReplication: ((snapshot: ServerSnapshotMessage) => void) | null = null;
  /** First thing with each snapshot: replicated motion is brought up to date, and fire events become shells */
  public preSnapshot: ((snapshot: ServerSnapshotMessage) => EntityState[]) | null = null;
  /** ...and each frame, every other ship is placed by its replica (true = placed) */
  public replicaPose: ((entity: InterpolatedEntity, renderTick: number) => boolean) | null = null;
  /** The prediction-mode hook (state/drawMode.ts): the game's prediction sets C3's (predict/Prediction.ts); null is mode A, the interpolated drawing */
  public drawMode: DrawModeHook | null = null;
  public playerName: string = '';
  public hp: number = PLAYER_MAX_HP;
  public maxHp: number = PLAYER_MAX_HP;
  public boostFuel: number = BOOST_FUEL_DEFAULT;
  public maxBoostFuel: number = BOOST_FUEL_DEFAULT;
  /** Last boost fuel value received from server — used as reconciliation anchor */
  public serverBoostFuel: number = BOOST_FUEL_DEFAULT;
  public xp: number = 0;
  public level: number = 1;
  public credits: number = 0;
  public systemId: string = 'sol';
  /** This system's ships past the snapshot's view, for the system map (mapDots) */
  public readonly farShips = new FarShips();
  /** This system's hostile populations: the ghosts of packs nobody's near (pops; common world/populations.ts) */
  public readonly populations = new Populations(
    (factionsFile as unknown as { spawns: ConstructorParameters<typeof Populations>[0] }).spawns,
    Object.keys((factionsFile as unknown as { factions: Record<string, unknown> }).factions),
  );
  /** Per system id: what its hostiles rate (the welcome message; ships/rating.ts) */
  public threats: Record<string, number> = {};
  /** Systems with danger bands (Sol): the threat in each band (system id -> region id -> rating) */
  public regionThreats: Record<string, Record<string, number>> = {};
  
  // Inventory
  public inventory: InventorySlot[] = [];
// ============================================
  // TICK SYNCHRONIZATION
  // ============================================
  public tickRate: number = TICK_RATE;
  public serverTick: number = 0;
  private serverTickTarget: number = 0;
  private serverTickTargetTime: number = 0;
  /** Server tick minus our clock in ticks, smoothed (see getEstimatedServerTick) */
  private tickOffset: number | null = null;
  /** A pong has come since the last join: the server tick estimate means something (before it, it's our own clock) */
  public clockSynced = false;
  /** The tick interpolate() last drew the world at */
  public renderTickNow = 0;
  
  // ============================================
  // PING / JITTER / ADAPTIVE DELAY
  // ============================================
  public ping: number = 0;
  public rawPing: number = 0;
  public jitter: number = 0;
  public interpDelayMs: number = 120;
  /** Coalesced frames (CAPS.COALESCE) may come this much later: the interpolation delay is that much longer (network/netCaps.ts) */
  public coalesceMs = 0;
  /**
   * Its system's crowd level (CAPS.CROWD; common network/crowd.ts): the focus radius (the ghost fade is its last km), the
   * snapshot window, the system's ticks a second. Its clock runs at tickMs a tick: TICK_MS, longer while the system is
   * slowed (a rate change is said ahead and turns the clock at its tick: crowdTurn)
   */
  public crowd = { lv: 0, focus: FOCUS_RANGE, window: CROWD_BASE_WINDOW, rate: TICK_RATE };
  public tickMs = TICK_MS;
  private tickMsNext: { at: number; ms: number } | null = null;
  /** Interpolation delay added for a wider window: the snapshots come further apart */
  public crowdDelayMs = 0;

  /** Its system's crowd level, from a tick (crowd message) */
  onCrowd(msg: { tick: number; lv: number; f: number; w: number; r: number }, now: number = performance.now()): void {
    this.crowd = { lv: msg.lv, focus: msg.f, window: msg.w, rate: msg.r };
    const ms = crowdPeriodMs(msg.r);
    this.crowdDelayMs = Math.max(0, msg.w - CROWD_BASE_WINDOW) * ms;
    const est = this.tickOffset === null ? null : this.getEstimatedServerTick(now);
    // (Another system's clock, or the first word of one: its tick now, at its rate, from here)
    if (est === null || Math.abs(msg.tick - est) > CROWD_RATE_LEAD + 30) {
      this.tickMs = ms;
      this.tickMsNext = null;
      this.serverTickTarget = msg.tick + (this.smoothedPing / 2) / ms;
      this.serverTickTargetTime = now;
      this.tickOffset = null;
      return;
    }
    if (ms !== this.tickMs) this.tickMsNext = { at: msg.tick, ms };
  }

  /** A rate said ahead: the clock turns at its tick, carrying on from where it is */
  private crowdTurn(now: number): void {
    const n = this.tickMsNext;
    if (!n || this.tickOffset === null) return;
    const est = now / this.tickMs + this.tickOffset;
    if (est < n.at) return;
    const raw = this.serverTickTarget + (now - this.serverTickTargetTime) / this.tickMs;
    this.tickMs = n.ms;
    this.tickMsNext = null;
    this.tickOffset = est - now / this.tickMs;
    this.serverTickTarget = raw;
    this.serverTickTargetTime = now;
  }
  /** @internal read by state/interpolation.ts */
  targetInterpDelayMs: number = 120;
  private pingHistory: number[] = [];
  private smoothedPing: number = 0;
  private smoothedJitter: number = 0;
  
  /** Rolling ping history for graph display (last 120 samples = 4 min at 2s interval) */
  public pingGraphHistory: number[] = [];
  public jitterGraphHistory: number[] = [];
  private readonly GRAPH_HISTORY_SIZE = 120;
  
  // ============================================
  // PREDICTION DISAGREEMENT STATS
  // ============================================
  /** Pre-reconciliation: predicted pos vs server pos before replay */
  public predErrorPre: number = 0;
  public predErrorPreAvg: number = 0;
  public predErrorPreMax: number = 0;
  /** Post-reconciliation: final predicted pos vs render pos */
  public predErrorPost: number = 0;
  public predErrorPostAvg: number = 0;
  public predErrorPostMax: number = 0;
  /** How many unacked inputs were replayed */
  public predPendingCount: number = 0;
  /** Number of hard snaps (teleports) since last reset */
  public predSnapCount: number = 0;
  /** Velocity disagreement */
  public predVelError: number = 0;
  public predVelErrorAvg: number = 0;
  /** Rolling history for a mini graph (last 60 samples) */
  public predErrorHistory: number[] = [];
  private readonly PRED_HISTORY_SIZE = 60;
  private predStatsAlpha = 0.15; // EMA smoothing
  private predMaxDecay = 0.995; // slow decay on max to auto-reset
  /** Log reconciliation spikes to the console (Game: the net stats setting) */
  public logSpikes = false;
  
  // ============================================
  // INPUT DELAY BUFFER
  // ============================================
  /** Input delay in ticks */
  public inputDelayTicks: number = INPUT_DELAY_INITIAL_TICKS;
  /** Queued inputs waiting for their targetTick to be reached */
  private inputDelayQueue: ClientInputMessage[] = [];
  /** Cached estimated server tick — updated once per frame, then incremented per tick iteration */
  public cachedServerTick: number = 0;
  /** Last-drained fire state — the laser visual should use THIS, not the live mouse */

  // ============================================
  // INPUT
  // ============================================
  private inputSeq: number = 0;
  
  // ============================================
  // ENTITY STATE
  // ============================================
  public entities = new EntityMap();
  /** @internal read by state/interpolation.ts */
  snapshotBuffer: BufferedSnapshot[] = [];
  
  // Screen shake
  public screenShake: ScreenShake = {
    trauma: 0,
    time: 0,
    offsetX: 0,
    offsetY: 0,
    rotation: 0,
  };

  // ============================================
  // TICK SYNC METHODS
  // ============================================

  /**
   * Called when a pong message is received.
   */
  handlePong(clientTime: number, _serverTime: number, serverTick: number): void {
    const now = performance.now();
    const rtt = Date.now() - clientTime;
    this.rawPing = rtt;
    
    // EMA-smoothed ping
    this.pingHistory.push(rtt);
    while (this.pingHistory.length > PING_HISTORY_SIZE) this.pingHistory.shift();
    
    if (this.smoothedPing <= 0) {
      this.smoothedPing = rtt;
    } else {
      this.smoothedPing += (rtt - this.smoothedPing) * PING_ALPHA;
    }
    
    // EMA-smoothed jitter
    const jitterSample = Math.abs(rtt - this.smoothedPing);
    this.smoothedJitter += (jitterSample - this.smoothedJitter) * JITTER_ALPHA;
    
    this.ping = Math.round(this.smoothedPing);
    this.jitter = Math.round(this.smoothedJitter);
    
    // Store for graph
    this.pingGraphHistory.push(this.ping);
    this.jitterGraphHistory.push(this.jitter);
    while (this.pingGraphHistory.length > this.GRAPH_HISTORY_SIZE) this.pingGraphHistory.shift();
    while (this.jitterGraphHistory.length > this.GRAPH_HISTORY_SIZE) this.jitterGraphHistory.shift();
    
    // Update server tick target (account for half RTT transit)
    const halfRttTicks = (rtt / 2) / this.tickMs;
    this.serverTickTarget = serverTick + halfRttTicks;
    this.serverTickTargetTime = now;
    
    if (this.tickOffset === null) this.tickOffset = this.serverTickTarget - now / this.tickMs;
    this.clockSynced = true;
    
    // Adaptive interpolation delay formula
    const baseMin = this.smoothedPing < 60 ? 80 : 110;
    const target = Math.max(baseMin, Math.min(INTERP_MAX_DELAY_MS,
      this.smoothedPing * 0.7 + this.smoothedJitter * 4 + 90 + this.coalesceMs + this.crowdDelayMs
    ));
    this.targetInterpDelayMs = Math.max(INTERP_MIN_DELAY_MS, target);
  }

  /**
   * The server's tick now, estimated. What's smoothed is the offset between the
   * server's tick and our clock (it hardly changes: each pong nudges it), not
   * the tick itself. (Smoothing the tick, which climbs 60 a second, always
   * trails it: with the old half-a-tick-per-call limit, at 60 fps it fell up to
   * 20 ticks behind and snapped forward, over and over, so the prediction ran
   * behind the server and every input arrived late.)
   */
  getEstimatedServerTick(now: number = performance.now()): number {
    this.crowdTurn(now);
    const target = this.serverTickTarget - this.serverTickTargetTime / this.tickMs;
    if (this.tickOffset === null || Math.abs(target - this.tickOffset) > SERVER_TICK_SNAP) this.tickOffset = target;
    else this.tickOffset += (target - this.tickOffset) * TICK_OFFSET_SMOOTHING;
    return now / this.tickMs + this.tickOffset;
  }

  /**
   * Raw server tick (no smoothing) for deterministic systems like asteroids.
   */
  getRawServerTick(now: number = performance.now()): number {
    return this.serverTickTarget + (now - this.serverTickTargetTime) / this.tickMs;
  }

  /** The world drawn is caught up: a snapshot is buffered and the last frame's render tick has reached the oldest one
   *  (so nothing is drawn from before it: the loading screen waits for this, app/readiness.ts) */
  viewCaughtUp(): boolean {
    const b = this.snapshotBuffer;
    return b.length > 0 && this.renderTickNow >= b[0].tick;
  }

  getRenderTick(now: number = performance.now()): number {
    const interpDelayTicks = this.interpDelayMs / this.tickMs;
    return Math.max(0, this.getEstimatedServerTick(now) - interpDelayTicks);
  }

  // ============================================
  // INPUT METHODS
  // ============================================

  nextInputSeq(): number {
    return ++this.inputSeq;
  }

  /**
   * Queue a SENT input into the delay buffer.
   * Physics will be applied when localTick reaches targetTick.
   */
  applyInput(input: ClientInputMessage): void {
    this.inputDelayQueue.push(input);
  }

  /**
   * Queue an UNSENT tick into the delay buffer.
   * The input still gets tracked by tick for reconciliation replay.
   */
  predictTick(input: ClientInputMessage): void {
    // seq=0 marks this as unsent (not sent to server)
    const clone = { ...input, seq: 0 };
    this.inputDelayQueue.push(clone);
  }

  /**
   * Cache the estimated server tick once per frame.
   * MUST be called before the tick loop to avoid EMA drift from
   * multiple calls to getEstimatedServerTick within one frame.
   */
  updateCachedServerTick(): void {
    this.cachedServerTick = Math.round(this.getEstimatedServerTick(performance.now()));
  }

  /**
   * The tick the local ship's prediction is at. It moves by exactly one per
   * physics step (Game.update), so every tick number is stepped once: when a
   * snapshot comes, replaying the inputs after it steps exactly the ticks the
   * server will. (Taking the tick number afresh from the clock estimate each
   * frame, as before, let numbers be skipped or repeated relative to the steps
   * run: the replay was then a tick out, and the ship jumped a tick's travel.)
   */
  public predictedTick = 0;
  /** The local ship one step back (it's drawn between that and now: see interpolate) */
  /** @internal read by state/interpolation.ts */
  selfPrev: { x: number; y: number; angle: number } | null = null;
  /** This frame's estimate of the server tick (fractional) */
  /** @internal read by state/interpolation.ts */
  frameTick = 0;

  /**
   * How far ahead of the server's tick the prediction runs: the trip to the
   * server and a margin for jitter, so an input stamped for (tick + input delay)
   * arrives before the server gets there. It moves only when the connection
   * changes by more than a tick (each change makes the prediction skip a step
   * or take an extra one).
   */
  public leadTicks = 1;

  private updateLead(): void {
    const want = (this.smoothedPing / 2 + this.smoothedJitter * 2) / this.tickMs + 0.5;
    if (want > this.leadTicks + 0.3 || want < this.leadTicks - 1.3) this.leadTicks = Math.max(1, Math.min(15, Math.ceil(want)));
  }

  /**
   * The tick the local ship is drawn at this frame (interpolate): between its last two predicted steps, half a tick
   * behind the estimate plus the lead. Your own shells are drawn on this timeline (WeaponFx's present), so they leave
   * the barrels of the ship as drawn; the server's tick (getRawServerTick) runs leadTicks behind it, and a shell drawn
   * on that came out where the ship had been that many ticks before. Without prediction, the server's tick.
   */
  ownDrawTick(now: number = performance.now()): number {
    const t = this.timelineAt(now).ownDraw();
    return this.drawMode?.own ? this.drawMode.own(t) : t;
  }

  /**
   * Which tick each kind of thing is confirmed at, predicted to and drawn at (common sim/timeline.ts, sim foundation
   * 1C): ownDrawTick, renderTickNow and the shells' timelines (WeaponFx shotTimelines) read it. Up to date as of the
   * last timelineAt (every ownDrawTick, aheadTick)
   */
  readonly timeline = new Timeline({ predictionEnabled: false, confirmedTick: 0, predictedTick: 0, frameTick: 0, rawServerTick: 0, renderTick: 0, hasPrev: false });

  /** The timeline as of `now` (its clock read from this frame's state) */
  timelineAt(now: number = performance.now()): Timeline {
    this.timeline.set(this.timelineClock(now));
    return this.timeline;
  }

  /** Ships stepped ahead from their decisions (AI pilots, custom enemies) and their shells: drawn at this tick (Timeline 'ahead') */
  aheadTick(now: number = performance.now()): number {
    return this.timelineAt(now).drawTick('ahead');
  }

  private timelineClock(now: number): TimelineClock {
    return {
      predictionEnabled: this.predictionEnabled,
      confirmedTick: this.serverTick,
      predictedTick: this.predictedTick,
      frameTick: this.frameTick,
      // (Read only when it's what the own ship is drawn at: prediction off, or not started)
      rawServerTick: !this.predictionEnabled || this.predictedTick <= 0 ? this.getRawServerTick(now) : 0,
      renderTick: this.renderTickNow,
      hasPrev: !!this.selfPrev,
    };
  }

  /** How many steps the prediction is behind where it should be this frame */
  ticksDue(now: number = performance.now()): number {
    this.updateLead();
    // (Drawn half a tick behind the prediction: see interpolate)
    this.frameTick = this.getEstimatedServerTick(now) + this.leadTicks;
    const target = Math.round(this.frameTick);
    // Starting out, or far adrift (the tab was asleep, a long stall): jump there and let a correction follow
    if (this.predictedTick === 0 || Math.abs(target - this.predictedTick) > PREDICT_RESYNC_TICKS) {
      this.predictedTick = target;
      this.cachedServerTick = target;
      this.selfPrev = null;
      return 0;
    }
    return Math.max(0, target - this.predictedTick);
  }

  /**
   * Get the target tick for a new input.
   * Uses cachedServerTick + inputDelayTicks.
   */
  getInputTargetTick(): number {
    return this.cachedServerTick + this.inputDelayTicks;
  }

  /**
   * Would an input for this tick reach the server after it ran it? Only while the prediction catches up after a hitch
   * (on time, a tick goes the trip and the input delay ahead of the server's: frameTick is its tick plus the trip)
   */
  inputLate(targetTick: number): boolean {
    return this.predictedTick > 0 && targetTick < this.frameTick;
  }

  /**
   * One prediction tick (Game.update, once per tick number): the inputs due are taken off the delay queue (the own
   * ship's tick layer already has them: OwnTick, by their target ticks, as the server runs them), and the own ship is
   * stepped to the next tick on its layer.
   */
  drainDelayQueue(): void {
    // (The server runs an input on its target tick; the layer has every sent input by its target tick, and those not
    // sent are the last one sent again)
    const nextTick = this.cachedServerTick + 1;
    if (this.inputDelayQueue.length) this.inputDelayQueue = this.inputDelayQueue.filter((input) => (input.targetTick ?? 0) > nextTick);
    // (Where the ship was, to draw it between that and the new step)
    const me = this.entities.get(this.playerId);
    if (me) this.selfPrev = { x: me.x, y: me.y, angle: me.angle };
    this.applyPhysics(nextTick);
  }

  /**
   * The own ship stepped to `tick` on its tick layer (once per tick: its whole step, ShipClient.ownStepTo) and its
   * entity put there; its stores to the HUD. Until its layer has it (its first keyframe), it follows the server's rows.
   */
  private applyPhysics(tick: number): void {
    const player = this.entities.get(this.playerId);
    if (!player) return;
    const st = this.ownStep?.(tick);
    if (!st) return;
    this.takeOwn(player, st);
    this.noteSelf(player, tick);
  }

  /** The own ship's entity from its tick layer's state */
  private takeOwn(player: InterpolatedEntity, st: OwnStepped): void {
    const b = st.body;
    player.x = b.x; player.y = b.y; player.vx = b.vx; player.vy = b.vy; player.angle = b.angle; player.angVel = b.angVel;
    player.jump = b.jump ?? 0; player.jumpScale = b.jumpScale; player.jumpAim = b.jumpAim; player.jumpTo = b.jumpTo; player.dodge = b.dodge ?? 0; player.dodgeDir = b.dodgeDir ?? 0;
    player.jumpPrime = st.jumpPrime;
    if (st.charge) {
      this.charge = st.charge;
      this.boostFuel = this.chargeTotal?.(this.charge) ?? this.serverBoostFuel;
    }
  }

  /**
   * The local ship's pose at the end of each recent tick, as predicted (and replayed after a correction, and as the
   * server had it at a snapshot that corrected it). Where the server had it then, while the prediction held: where a
   * told hit on it is drawn (ConfirmedHits.hitPoint). Cosmetic only: its own shells' fire events are built from its
   * confirmed ship (its replica), never from this (ShipClient.preSnapshot)
   */
  private selfPoses = new Map<number, { x: number; y: number; angle: number; vx: number; vy: number }>();

  /** The local ship's pose and velocity at the end of `tick` (null: not predicted lately) */
  selfPoseAt(tick: number): { x: number; y: number; angle: number; vx: number; vy: number } | null {
    return this.selfPoses.get(tick) ?? null;
  }

  private noteSelf(player: InterpolatedEntity, tick: number): void {
    const p = this.selfPoses.get(tick);
    if (p) { p.x = player.x; p.y = player.y; p.angle = player.angle; p.vx = player.vx; p.vy = player.vy; }
    else this.selfPoses.set(tick, { x: player.x, y: player.y, angle: player.angle, vx: player.vx, vy: player.vy });
    if (this.selfPoses.size > SELF_POSE_TICKS) for (const t of this.selfPoses.keys()) if (t < tick - SELF_POSE_TICKS) this.selfPoses.delete(t);
  }

  // ============================================
  // SNAPSHOT HANDLING
  // ============================================

  /**
   * Shells removed before any frame drew them: kept until one has (interpolate), then removed with the next snapshot.
   * A shell made and removed by the same snapshot is one; so is a shell made and removed by two snapshots that came in
   * one WebSocket message (coalesced frames, docs/design/packed-frames.md: all its sub-frames are applied in one go, with
   * no frame drawn between them). Without this the renderers never saw it: no tracer, only a mark where it hit
   */
  private lateRemovals: number[] = [];
  /** ...those a frame has drawn since: removed with the next snapshot */
  private lateDrawn: number[] = [];
  /** Shells made since the last frame drawn, and the snapshot tick each came in (removeShell, applySnapshot) */
  private madeNow = new Map<number, number>();

  /**
   * A shell a confirmed hit ended (ships/hits/ConfirmedHits.ts), by the rule a snapshot's removal follows: gone now,
   * or, if no frame has drawn it yet, once one has (so its tracer and hit are drawn)
   */
  removeShell(id: number): void {
    if (this.undrawn(id)) this.lateRemovals.push(id);
    else this.entities.delete(id);
  }

  /**
   * Made since the last frame drawn (and lately: with no frames drawn at all, a hidden tab, nothing waits more than
   * LATE_TICKS of snapshots, or they would pile up)
   */
  private undrawn(id: number): boolean {
    const t = this.madeNow.get(id);
    return t !== undefined && this.serverTick - t <= LATE_TICKS;
  }

  /** A frame is being drawn (interpolate): what's made so far has been seen, and shells waiting on that can go */
  /** @internal called by state/interpolation.ts */
  frameDrawn(): void {
    this.madeNow.clear();
    if (this.lateRemovals.length) {
      for (const id of this.lateRemovals) this.lateDrawn.push(id);
      this.lateRemovals.length = 0;
    }
  }

  /** States seen in a snapshot for entities created later in the same snapshot */
  private pendingHist = new Map<number, { tick: number; x: number; y: number; vx: number; vy: number; angle: number }>();

  applySnapshot(snapshot: ServerSnapshotMessage): void {
    this.serverTick = snapshot.tick;
    const fired = this.preSnapshot?.(snapshot);
    if (fired?.length) snapshot.entities.push(...fired);
    
    // Buffer the snapshot
    const entityMap = new Map<number, EntityState>();
    for (const state of snapshot.entities) {
      entityMap.set(state.id, state);
    }
    
    this.snapshotBuffer.push({ tick: snapshot.tick, entities: entityMap });
    
    while (this.snapshotBuffer.length > SNAPSHOT_BUFFER_SIZE) {
      this.snapshotBuffer.shift();
    }
    
    // Shells removed before they were drawn, drawn once since: gone now
    for (const id of this.lateDrawn) this.entities.delete(id);
    this.lateDrawn.length = 0;
    // (...and those still waiting that waited too long, or whose id this snapshot names again: used for something new)
    if (this.lateRemovals.length) {
      this.lateRemovals = this.lateRemovals.filter((id) => {
        if (this.undrawn(id) && !entityMap.has(id)) return true;
        this.entities.delete(id);
        this.madeNow.delete(id);
        return false;
      });
    }
    if (this.madeNow.size > 512) for (const [id, t] of this.madeNow) if (this.serverTick - t > LATE_TICKS) this.madeNow.delete(id);

    // Handle removed entities
    for (const id of snapshot.removed) {
      const entity = this.entities.get(id);
      // (A shell made by an earlier snapshot of this message, not drawn yet: it goes once it has been)
      if (entity) { if (this.undrawn(id)) this.lateRemovals.push(id); else this.entities.delete(id); }
      // A shell fired and gone between two snapshots (its fire event and its removal in the same one: it hit at once,
      // fired from inside a rock or point-blank): made below, then removed once a frame has drawn it, so its tracer and
      // hit are drawn (it used to be made after its removal and never removed, flying on as a ghost)
      else if (entityMap.get(id)?.type === EntityType.Projectile) this.lateRemovals.push(id);
    }
    
    // Ships out of view: forgotten until they come back into it
    for (const id of snapshot.out ?? []) this.entities.delete(id);

    // Projectiles on their straight line come without a position: muzzle + velocity × age
    for (const state of snapshot.entities) {
      if (state.type === EntityType.Projectile && state.x === undefined && state.data && state.data.length >= 6) {
        const age = snapshot.tick - state.data[3];
        state.x = state.data[4] + (state.vx ?? 0) * age;
        state.y = state.data[5] + (state.vy ?? 0) * age;
      }
    }

    // Remember each state with its tick, for dead reckoning (not status-only rows: those ships are replicated)
    for (const state of snapshot.entities) {
      if (state.type === EntityType.Asteroid || state.type === EntityType.Station || state.x === undefined) continue;
      const e = this.entities.get(state.id);
      const h = { tick: snapshot.tick, x: state.x, y: state.y, vx: state.vx || 0, vy: state.vy || 0, angle: state.angle || 0 };
      if (e) {
        e.hist = e.hist ?? [];
        e.hist.push(h);
        if (e.hist.length > 3) e.hist.shift();
      } else {
        this.pendingHist.set(state.id, h);
      }
    }

    // Create entities that don't exist yet
    for (const state of snapshot.entities) {
      if (!this.entities.has(state.id)) {
        const entity: InterpolatedEntity = {
          id: state.id,
          type: state.type,
          x: state.x,
          y: state.y,
          angle: state.angle || 0,
          vx: state.vx || 0,
          vy: state.vy || 0,
          renderX: state.x,
          renderY: state.y,
          renderAngle: state.angle || 0,
          hp: state.hp || 0,
          maxHp: state.maxHp || 0,
          data: state.data,
          name: state.name,
          lastServerUpdate: snapshot.tick,
        };
        const h0 = this.pendingHist.get(state.id);
        if (h0) { entity.hist = [h0]; this.pendingHist.delete(state.id); }
        if (state.type === EntityType.Player && state.id !== this.playerId) { entity.status = state.data; entity.data = []; }
        
        if (state.type === EntityType.Projectile && state.data && state.data.length >= 6) {
          this.madeNow.set(state.id, snapshot.tick);
          entity.spawnTick = state.data[3];
          entity.spawnX = state.data[4];
          entity.spawnY = state.data[5];
        }
        if (state.type === EntityType.Station && state.data && state.data.length >= 7) {
          const orbitType = state.data[1];
          entity.orbitType = orbitType;
          entity.semiMajorAxis = state.data[2];
          entity.eccentricity = state.data[3];
          entity.argPeriapsis = state.data[4];
          entity.meanAnomaly0 = state.data[5];
          entity.epochTick = state.data[6];
          entity.orbitTimeScale = state.data[7] ?? 1;
          entity.stationRadius = state.data[8];
          if (orbitType !== 255) entity.isDeterministic = true;
        }
        
        this.entities.set(state.id, entity);
      } else {
        // Update existing entity hp/data from latest snapshot
        const entity = this.entities.get(state.id)!;
        entity.hp = state.hp || entity.hp;
        entity.maxHp = state.maxHp || entity.maxHp;
        if (state.type === EntityType.Player && state.id !== this.playerId) entity.status = state.data;
        else entity.data = state.data;
        if (state.name) entity.name = state.name;
        entity.lastServerUpdate = snapshot.tick;
      }
    }
    
    this.onReplication?.(snapshot);

    // Server reconciliation for player
    if (this.predictionEnabled) this.reconcilePlayer(snapshot);
  }

  /**
   * Clear all deterministic asteroid entities — called on system change.
   */
  /** Travelled to another system: forget everything from the old one except our own ship. */
  clearForSystemChange(): void {
    this.farShips.clear();
    this.populations.clear();
    for (const id of [...this.entities.keys()]) {
      if (id !== this.playerId) this.entities.delete(id);
    }
    this.snapshotBuffer.length = 0;
  }

  /**
   * A new connection (a reconnect after a drop, or a server that restarted): the world and the clock start over, as the
   * server's session for us does. Nothing the last one sent is removed by the new one (it never sent it), and a restarted
   * server's ticks start again from 0, so every tick kept here (the prediction's, the clock's offset, the delay queue,
   * the poses by tick) would stand far ahead of the new ones. The ping estimate and the graphs stay (the link is the
   * same); the first pong sets the clock afresh, the first snapshots the world, the welcome the own ship.
   */
  resetSession(): void {
    this.playerId = 0;
    this.entities.clear();
    this.snapshotBuffer.length = 0;
    this.farShips.clear();
    this.populations.clear();
    this.pendingHist.clear();
    this.lateRemovals.length = 0;
    this.lateDrawn.length = 0;
    this.madeNow.clear();
    this.selfPoses.clear();
    this.selfPrev = null;
    this.inputDelayQueue = [];
    // (The clock: a pong sets it again; until then nothing is predicted, ticksDue starts afresh from predictedTick 0)
    this.serverTick = 0;
    this.serverTickTarget = 0;
    this.serverTickTargetTime = 0;
    this.tickOffset = null;
    this.clockSynced = false;
    this.cachedServerTick = 0;
    this.predictedTick = 0;
    this.frameTick = 0;
    this.renderTickNow = 0;
    // (Its system's crowd and rate come again with the new session)
    this.crowd = { lv: 0, focus: FOCUS_RANGE, window: CROWD_BASE_WINDOW, rate: TICK_RATE };
    this.tickMs = TICK_MS;
    this.tickMsNext = null;
    this.crowdDelayMs = 0;
    // (systemId stays: the world it would clear on a change is already gone, and the first playerState sets it)
    this.charge = { ...FULL_CHARGE };
    this.serverCharge = { ...FULL_CHARGE };
  }

  /**
   * A snapshot in: the own ship's tick layer has taken its keyframe, causes and corrections (ShipClient.preSnapshot),
   * so its state at the prediction's tick may have moved (stepped again from there); the entity follows it, and the
   * size of the move is the reconcile statistics (the overlay's corrections). Its own row, when one came, gives the
   * status the HUD reads (HP, EMP, warmth, slowed and marked ticks, the stores as the server packed them)
   */
  private reconcilePlayer(snapshot: ServerSnapshotMessage): void {
    const player = this.entities.get(this.playerId);
    if (!player) return;
    const serverState = snapshot.entities.find(e => e.id === this.playerId);
    if (serverState) {
      player.hp = serverState.hp || player.hp;
      player.maxHp = serverState.maxHp || player.maxHp;
      player.data = serverState.data;
      player.empUntil = snapshot.tick + (serverState.data?.[5] ?? 0);
      player.warmth = serverState.data?.[PILOT_ROW.warmth] ?? 100;
      player.cargoMass = serverState.data?.[PILOT_ROW.cargo] ?? 0;
      { const x = pilotExtras(serverState.data); player.slowUntil = snapshot.tick + x.slowed; player.markUntil = snapshot.tick + x.marked; }
      if (serverState.data && serverState.data.length >= 2) {
        this.serverBoostFuel = serverState.data[1];
        this.serverCharge = unpackCharge(serverState.data);
      }
    }
    if (this.predictedTick <= 0) return;
    const st = this.ownStep?.(this.predictedTick);
    if (!st) {
      // (Not on its layer yet: the server's row places it)
      if (serverState) {
        player.x = serverState.x; player.y = serverState.y; player.angle = serverState.angle ?? player.angle;
        player.vx = serverState.vx || 0; player.vy = serverState.vy || 0; player.angVel = serverState.av ?? 0;
      }
      return;
    }
    const ex = player.x - st.body.x, ey = player.y - st.body.y, err = Math.hypot(ex, ey);
    const verr = Math.hypot(player.vx - st.body.vx, player.vy - st.body.vy);
    this.takeOwn(player, st);
    this.noteSelf(player, this.predictedTick);
    if (err === 0 && verr === 0) return;
    this.predErrorPre = err;
    this.predErrorPreAvg = this.predErrorPreAvg * (1 - this.predStatsAlpha) + err * this.predStatsAlpha;
    this.predErrorPreMax = Math.max(this.predErrorPreMax * this.predMaxDecay, err);
    this.predVelError = verr;
    this.predVelErrorAvg = this.predVelErrorAvg * (1 - this.predStatsAlpha) + verr * this.predStatsAlpha;
    this.predErrorHistory.push(err);
    if (this.predErrorHistory.length > this.PRED_HISTORY_SIZE) this.predErrorHistory.shift();
    // (The ticks stepped again: from the snapshot's to the prediction's)
    this.predPendingCount = Math.max(0, this.predictedTick - snapshot.tick);
    if (err > SNAP_THRESHOLD) this.predSnapCount++;
    if (this.logSpikes && err > 1) console.warn(`[OWN CORRECTION] ${err.toFixed(3)} at tick ${this.predictedTick} (snapshot ${snapshot.tick})`);
  }

  // ============================================
  // INTERPOLATION
  // ============================================

  // ============================================
  // UTILITY
  // ============================================

  getPlayerPosition(): { x: number; y: number } {
    const player = this.entities.get(this.playerId);
    if (player) {
      return { x: player.renderX, y: player.renderY };
    }
    return { x: 0, y: 0 };
  }

  getPlayerAngle(): number {
    const player = this.entities.get(this.playerId);
    return player?.renderAngle || 0;
  }

  getEntity(id: number): InterpolatedEntity | undefined {
    return this.entities.get(id);
  }

  getEntitiesByType(type: EntityType): InterpolatedEntity[] {
    return Array.from(this.entities.values()).filter(e => e.type === type);
  }

  /** One asteroid spawn message in (state/asteroidEntities.ts) */
  handleAsteroidSpawn(tick: number, asteroids: AsteroidSpawnData[]): void {
    spawnAsteroids(this, tick, asteroids);
  }

  /** The deterministic asteroid seed message in (state/asteroidEntities.ts) */
  handleAsteroidSeed(tick: number, systemId: string, seed: string, belt: AsteroidBeltData, ids: number[], indices: number[], asteroidField?: string): void {
    seedAsteroids(this, tick, systemId, seed, belt, ids, indices, asteroidField);
  }

  /** Clear all deterministic asteroid entities, on a system change */
  clearDeterministicAsteroids(): void {
    clearDeterministicAsteroids(this.entities);
  }

  /** The frame's draw pass over every entity (state/interpolation.ts) */
  interpolate(delta: number): void {
    interpolateFrame(this, delta);
  }

  /** A knock adds trauma (state/screenShake.ts) */
  triggerScreenShake(intensity: number, duration: number): void {
    triggerScreenShake(this.screenShake, intensity, duration);
  }

  /** Each frame (seconds): trauma drains and the offset follows smooth noise */
  updateScreenShake(delta: number): void {
    updateScreenShake(this.screenShake, delta);
  }
}
