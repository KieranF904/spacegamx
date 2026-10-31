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

import { FULL_CHARGE, unpackCharge, pilotExtras, type Charge } from '@space-game/common';
import { FarShips } from './FarShips';
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
  TICK_MS,
  INTERP_MAX_DELAY_MS,
  INTERP_MIN_DELAY_MS,
  INTERP_SLEW_MS_PER_SEC,
  PING_HISTORY_SIZE,
} from '@space-game/common';

// ============================================
// INTERFACES
// ============================================

export interface InterpolatedEntity {
  /** The tick a deterministic asteroid was last placed for */
  orbitTick?: number;
  id: number;
  type: EntityType;
  /** Asteroids: what they're made of (colours, seams, scanner) */
  composition?: Composition;
  // Physics (authoritative / predicted position)
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  // Smooth render position (visual, catches up to x/y)
  renderX: number;
  renderY: number;
  renderAngle: number;
  // Server state
  hp: number;
  maxHp: number;
  data?: number[];
  // Player display name
  name?: string;
  /** Modular ships: angular velocity (rad/tick), predicted for the local player */
  angVel?: number;
  /** Modular ships: jump drive counter, predicted for the local player (others: data[3]) */
  jump?: number;
  /** This jump's speed scale (local player; server data[8] / 1000) */
  jumpScale?: number;
  /** A lodestone's priming left, ticks (local player; server data[12], then predicted) */
  jumpPrime?: number;
  /** Knocked out by an EMP until this tick (local player; the snapshot's tick + server data[5]): prediction drifts till then */
  empUntil?: number;
  /** Warmth, % (local player; server data[13]: common/src/ships/warmth.ts): the frost vignette, and how cold prediction flies and fires */
  warmth?: number;
  /** Burst Strafer: the dodge counter and the last dodge's way (local player: the server's, then predicted; others: their replica's): ships/strafer.ts */
  dodge?: number;
  dodgeDir?: number;
  /** The hold's cargo mass (local player; server data[14]: common/src/ships/load.ts): prediction flies it */
  cargoMass?: number;
  /** Other pilots: their status row (shield, EMP, beam heat, beams, cursor distance); data is rebuilt from it and their replica */
  status?: number[];
  /**
   * The last few states the server sent (tick-stamped). Snapshots only carry what
   * changed, and distant ships come less often, so between them we dead-reckon
   * from the latest of these. Projectiles are sent once and flown from here.
   */
  hist?: { tick: number; x: number; y: number; vx: number; vy: number; angle: number }[];
  // Projectile prediction fields
  spawnTick?: number;
  spawnX?: number;
  spawnY?: number;
  predictedX?: number;
  predictedY?: number;
  lastServerUpdate?: number;
  // Orbit params (client-side position calculation)
  orbitType?: number;
  semiMajorAxis?: number;
  eccentricity?: number;
  argPeriapsis?: number;
  meanAnomaly0?: number;
  epochTick?: number;
  /** Orbit clock rate (stations orbit slower than Kepler so ships can match them) */
  orbitTimeScale?: number;
  /** Station size (world units), for drawing */
  stationRadius?: number;
  wobblePhase?: number;
  isDeterministic?: boolean; // true → skip snapshot interpolation, calculate position
}

interface ScreenShake {
  /** 0..1: hits add to it, it drains away; the shake is trauma² (small knocks stay small) */
  trauma: number;
  /** Seconds, for the noise */
  time: number;
  /** This frame's offset (screen pixels) and roll (radians) */
  offsetX: number;
  offsetY: number;
  rotation: number;
}

/** Smooth 1D value noise, -1..1 (one lattice value per unit of t) */
function shakeNoise(t: number, seed: number): number {
  const h = (n: number) => { const x = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; };
  const i = Math.floor(t), f = t - i;
  const a = h(i);
  return a + (h(i + 1) - a) * f * f * (3 - 2 * f);
}

/** Screen shake at full trauma: offset (px), roll (rad), noise rate (Hz), and how fast trauma drains (per second) */
const SHAKE_PX = 24;
const SHAKE_ROLL = 0.01;
const SHAKE_HZ = 25;
const SHAKE_DECAY = 1.2;

/** Buffered snapshot for interpolation */
interface BufferedSnapshot {
  tick: number;
  entities: Map<number, EntityState>;
}

// ============================================
// CONSTANTS
// ============================================

const PING_ALPHA = 0.12;           // EMA smoothing for ping
const JITTER_ALPHA = 0.08;         // EMA smoothing for jitter
const SNAPSHOT_BUFFER_SIZE = 6;    // Keep last N snapshots for interpolation
const RENDER_SMOOTH_SELF = 1.0;    // Render lerp rate for local player (1.0 = no smoothing, instant)
const RENDER_SMOOTH_OTHER = 0.25;  // Render lerp rate for other entities
const SNAP_THRESHOLD = 260;        // Teleport if error > this
/** Rocks out of sight are placed every this many ticks (see orbitFocus) */
const ORBIT_FAR_TICKS = 8;
const SMOOTH_THRESHOLD = 12;       // Snap if error < this
const RECONCILE_SMOOTH = 0.5;      // Reconciliation smoothing rate

// Input delay buffer: inputs are stamped this many ticks ahead (33ms, imperceptible)
const INPUT_DELAY_INITIAL_TICKS = 2;

/** Estimated server tick snaps instead of smoothing when it's this many ticks off */
const SERVER_TICK_SNAP = 20;
/** How much of the way to each pong's tick offset the estimate moves per call (a few hundred ms to settle) */
const TICK_OFFSET_SMOOTHING = 0.03;
/** The prediction re-syncs to the clock estimate (rather than stepping to it) when this far out */
const PREDICT_RESYNC_TICKS = 30;

const NONE: ReadonlySet<InterpolatedEntity> = new Set();

/**
 * The entities by id, each type also kept in a set of its own as they come and go, for the passes a frame makes over
 * one kind (the shots, the stations) without walking the hundreds of rocks and ships besides. An entity's type never changes.
 */
export class EntityMap extends Map<number, InterpolatedEntity> {
  private byType = new Map<EntityType, Set<InterpolatedEntity>>();

  override set(id: number, e: InterpolatedEntity): this {
    const old = super.get(id);
    if (old && old !== e) this.byType.get(old.type)?.delete(old);
    super.set(id, e);
    let s = this.byType.get(e.type);
    if (!s) this.byType.set(e.type, (s = new Set()));
    s.add(e);
    return this;
  }

  override delete(id: number): boolean {
    const old = super.get(id);
    if (old) this.byType.get(old.type)?.delete(old);
    return super.delete(id);
  }

  override clear(): void {
    this.byType.clear();
    super.clear();
  }

  /** The entities of one type (live: don't add or remove while going through it) */
  ofType(type: EntityType): ReadonlySet<InterpolatedEntity> {
    return this.byType.get(type) ?? NONE;
  }
}

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
   * Ship prediction (set by Game): steps the local ship with the shared ship
   * physics and returns the new boost fuel, or null when there's no ship yet.
   */
  public shipPhysics: ((player: InterpolatedEntity, input: ClientInputMessage, charge: Charge, tick: number) => Charge | null) | null = null;
  /** After each forward prediction step (never a replay): the local ship's guns fire on that tick (ShipClient.predictGuns) */
  public shipGuns: ((player: InterpolatedEntity, input: ClientInputMessage, tick: number, charge: Charge) => Charge | null) | null = null;
  /** The batteries' charge as one percentage, for the HUD (ShipClient: energy.ts chargeTotal) */
  public chargeTotal: ((charge: Charge) => number) | null = null;
  /** The batteries' charge, predicted (energy.ts), and the server's last word on it */
  public charge: Charge = { ...FULL_CHARGE };
  public serverCharge: Charge = { ...FULL_CHARGE };
  /** Replicated ships: a snapshot's keyframes and control changes go here... */
  public onReplication: ((snapshot: ServerSnapshotMessage) => void) | null = null;
  /** First thing with each snapshot: replicated motion is brought up to date, and fire events become shells */
  public preSnapshot: ((snapshot: ServerSnapshotMessage) => EntityState[]) | null = null;
  /** ...and each frame, every other ship is placed by its replica (true = placed) */
  public replicaPose: ((entity: InterpolatedEntity, renderTick: number) => boolean) | null = null;
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
  
  // ============================================
  // PING / JITTER / ADAPTIVE DELAY
  // ============================================
  public ping: number = 0;
  public rawPing: number = 0;
  public jitter: number = 0;
  public interpDelayMs: number = 120;
  private targetInterpDelayMs: number = 120;
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
  // Track inputs by tick for reconciliation - stores (tick, input) pairs
  private pendingInputsByTick: { tick: number; input: ClientInputMessage }[] = [];
  
  // ============================================
  // ENTITY STATE
  // ============================================
  public entities = new EntityMap();
  private snapshotBuffer: BufferedSnapshot[] = [];
  
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
    const halfRttTicks = (rtt / 2) / TICK_MS;
    this.serverTickTarget = serverTick + halfRttTicks;
    this.serverTickTargetTime = now;
    
    if (this.tickOffset === null) this.tickOffset = this.serverTickTarget - now / TICK_MS;
    
    // Adaptive interpolation delay formula
    const baseMin = this.smoothedPing < 60 ? 80 : 110;
    const target = Math.max(baseMin, Math.min(INTERP_MAX_DELAY_MS,
      this.smoothedPing * 0.7 + this.smoothedJitter * 4 + 90
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
    const target = this.serverTickTarget - this.serverTickTargetTime / TICK_MS;
    if (this.tickOffset === null || Math.abs(target - this.tickOffset) > SERVER_TICK_SNAP) this.tickOffset = target;
    else this.tickOffset += (target - this.tickOffset) * TICK_OFFSET_SMOOTHING;
    return now / TICK_MS + this.tickOffset;
  }

  /**
   * Raw server tick (no smoothing) for deterministic systems like asteroids.
   */
  getRawServerTick(now: number = performance.now()): number {
    return this.serverTickTarget + (now - this.serverTickTargetTime) / TICK_MS;
  }

  getRenderTick(now: number = performance.now()): number {
    const interpDelayTicks = this.interpDelayMs / TICK_MS;
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
  private selfPrev: { x: number; y: number; angle: number } | null = null;
  /** This frame's estimate of the server tick (fractional) */
  private frameTick = 0;

  /**
   * How far ahead of the server's tick the prediction runs: the trip to the
   * server and a margin for jitter, so an input stamped for (tick + input delay)
   * arrives before the server gets there. It moves only when the connection
   * changes by more than a tick (each change makes the prediction skip a step
   * or take an extra one).
   */
  public leadTicks = 1;

  private updateLead(): void {
    const want = (this.smoothedPing / 2 + this.smoothedJitter * 2) / TICK_MS + 0.5;
    if (want > this.leadTicks + 0.3 || want < this.leadTicks - 1.3) this.leadTicks = Math.max(1, Math.min(15, Math.ceil(want)));
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
   * Drain the delay queue: apply inputs whose targetTick <= cachedServerTick, then run physics ONCE.
   * Called once per client tick from Game.ts (after tickInput).
   * 
   * CRITICAL FOR DETERMINISM:
   * - Server applies ALL inputs with targetTick <= currentTick + 1 (nextTick), then runs physics ONCE
   * - We do the same: collect all ready inputs, use the LAST one for physics
   * - cachedServerTick is incremented after each drain to ensure unique targetTicks
   */
  drainDelayQueue(): void {
    // Collect all inputs that are ready (targetTick <= cachedServerTick + 1)
    // The +1 matches the server's "nextTick = currentTick + 1" logic
    const nextTick = this.cachedServerTick + 1;
    // Everything due, oldest first: the newest is the one in effect (as on the server)
    const due = this.inputDelayQueue.filter((input) => (input.targetTick ?? 0) <= nextTick)
      .sort((a, b) => (a.targetTick ?? 0) - (b.targetTick ?? 0) || (a.seq || 0) - (b.seq || 0));
    let lastInput: ClientInputMessage | null = null;
    for (const input of due) {
      // Track by the tick we're APPLYING physics for (nextTick), not targetTick
      // This is the tick that matches server simulation
      this.pendingInputsByTick.push({ tick: nextTick, input });
      lastInput = input;
    }
    if (due.length) this.inputDelayQueue = this.inputDelayQueue.filter((input) => (input.targetTick ?? 0) > nextTick);
    
    // (Where the ship was, to draw it between that and the new step)
    const me = this.entities.get(this.playerId);
    if (me) this.selfPrev = { x: me.x, y: me.y, angle: me.angle };
    // Run physics ONCE with the last applied input (or repeat last if none)
    if (lastInput) {
      this.applyPhysics(lastInput, nextTick);
    } else if (this.pendingInputsByTick.length > 0) {
      // No new input this tick — repeat last known input (server does this too)
      const last = this.pendingInputsByTick[this.pendingInputsByTick.length - 1].input;
      this.applyPhysics(last, nextTick);
    }
    // If no inputs at all, don't run physics (shouldn't happen in normal play)
  }

  /**
   * Apply one tick of prediction to the local ship (the shared ship physics,
   * via the shipPhysics hook). Until the ship's structure has synced there is
   * nothing to predict with, so the ship simply follows the server.
   */
  private applyPhysics(input: ClientInputMessage, tick: number): void {
    const player = this.entities.get(this.playerId);
    if (!player) return;
    // The batteries: the engines draw and the generators charge them in the flight step,
    // then the guns fire on this tick (as the server's will), each shot (and laser segment) spending from them
    const c = this.shipPhysics?.(player, input, this.charge, tick);
    if (c != null) this.charge = c;
    const after = this.shipGuns?.(player, input, tick, this.charge);
    if (after != null) this.charge = after;
    this.boostFuel = this.chargeTotal?.(this.charge) ?? this.serverBoostFuel;
  }

  // ============================================
  // SNAPSHOT HANDLING
  // ============================================

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
    
    // Handle removed entities
    for (const id of snapshot.removed) {
      const entity = this.entities.get(id);
      if (entity) this.entities.delete(id);
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
   * Handle one-time asteroid spawn data.
   * Creates InterpolatedEntity objects with orbit params — positions will be
   * calculated deterministically in interpolate() instead of from snapshots.
   */
  handleAsteroidSpawn(tick: number, asteroids: AsteroidSpawnData[]): void {
    for (const a of asteroids) {
      // Skip if we already have this entity (shouldn't happen, but be safe)
      if (this.entities.has(a.id)) continue;

      const entity: InterpolatedEntity = {
        id: a.id,
        type: EntityType.Asteroid,
        x: 0,
        y: 0,
        angle: 0,
        vx: 0,
        vy: 0,
        renderX: 0,
        renderY: 0,
        renderAngle: 0,
        hp: a.hp,
        maxHp: a.maxHp,
        data: [a.size, a.resourceType],
        // Deterministic orbit params
        orbitType: a.orbitType,
        semiMajorAxis: a.semiMajorAxis,
        eccentricity: a.eccentricity,
        argPeriapsis: a.argPeriapsis,
        meanAnomaly0: a.meanAnomaly0,
        epochTick: a.epochTick,
        wobblePhase: a.wobblePhase,
        isDeterministic: true,
        composition: a.definitionId && a.index !== undefined && a.systemId
          ? this.composeAsteroid?.(a.definitionId, `${a.systemId}:${a.index}:${a.epochTick}`, a.size, a.systemId, a.stage ?? undefined) : undefined,
      };

      // Calculate initial position so the first frame isn't at (0,0)
      const currentTick = Math.round(this.getRawServerTick());
      const { x, y } = calcAsteroidPosition({
        orbitType: a.orbitType,
        semiMajorAxis: a.semiMajorAxis,
        eccentricity: a.eccentricity,
        argPeriapsis: a.argPeriapsis,
        meanAnomaly0: a.meanAnomaly0,
        epochTick: a.epochTick,
      }, currentTick);
      entity.x = x;
      entity.y = y;
      entity.renderX = x;
      entity.renderY = y;

      this.entities.set(a.id, entity);
    }
  }

  /**
   * Deterministic asteroid seed message — client derives params locally.
   */
  handleAsteroidSeed(
    tick: number,
    systemId: string,
    seed: string,
    belt: AsteroidBeltData,
    ids: number[],
    indices: number[],
    asteroidField?: string,
  ): void {
    // Replace any existing deterministic asteroids to avoid stale state
    this.clearDeterministicAsteroids();
    
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const index = indices[i] ?? i;
      if (this.entities.has(id)) continue;

      // Use definition-based generation if field config exists
      const params = asteroidParamsAt(systemId, index, seed, tick, belt, asteroidField);
      
      // Calculate health using definition's healthPerUnit
      const hp = Math.floor(params.size * params.healthPerUnit);

      const entity: InterpolatedEntity = {
        id,
        type: EntityType.Asteroid,
        x: 0,
        y: 0,
        angle: 0,
        vx: 0,
        vy: 0,
        renderX: 0,
        renderY: 0,
        renderAngle: 0,
        hp,
        maxHp: hp,
        data: [params.size, params.resourceType],
        orbitType: params.orbitType,
        semiMajorAxis: params.semiMajorAxis,
        eccentricity: params.eccentricity,
        argPeriapsis: params.argPeriapsis,
        meanAnomaly0: params.meanAnomaly0,
        epochTick: params.epochTick,
        wobblePhase: params.wobblePhase,
        isDeterministic: true,
        composition: this.composeAsteroid?.(params.definitionId || 'asteroid_metal', `${systemId}:${index}:${params.epochTick}`, params.size, systemId, params.outlier ? 0 : undefined),
      };

      const currentTick = Math.round(this.getRawServerTick());
      const { x, y } = calcAsteroidPosition({
        orbitType: params.orbitType,
        semiMajorAxis: params.semiMajorAxis,
        eccentricity: params.eccentricity,
        argPeriapsis: params.argPeriapsis,
        meanAnomaly0: params.meanAnomaly0,
        epochTick: params.epochTick,
      }, currentTick);
      entity.x = x;
      entity.y = y;
      entity.renderX = x;
      entity.renderY = y;

      this.entities.set(id, entity);
    }
  }

  /**
   * Clear all deterministic asteroid entities — called on system change.
   */
  /** Travelled to another system: forget everything from the old one except our own ship. */
  clearForSystemChange(): void {
    this.farShips.clear();
    for (const id of [...this.entities.keys()]) {
      if (id !== this.playerId) this.entities.delete(id);
    }
    this.snapshotBuffer.length = 0;
  }

  clearDeterministicAsteroids(): void {
    for (const [id, entity] of this.entities) {
      if (entity.isDeterministic) {
        this.entities.delete(id);
      }
    }
  }

  private reconcilePlayer(snapshot: ServerSnapshotMessage): void {
    const player = this.entities.get(this.playerId);
    if (!player) return;
    
    const serverState = snapshot.entities.find(e => e.id === this.playerId);
    if (!serverState) return;
    
    // --- Prediction disagreement: measure BEFORE snapping ---
    // player.x/y = our predicted position; serverState.x/y = authoritative
    const preErrorX = player.x - serverState.x;
    const preErrorY = player.y - serverState.y;
    const preError = Math.hypot(preErrorX, preErrorY);
    
    const velErrorX = player.vx - (serverState.vx || 0);
    const velErrorY = player.vy - (serverState.vy || 0);
    const velError = Math.hypot(velErrorX, velErrorY);
    
    const angleError = Math.abs(player.angle - (serverState.angle || 0));
    
    // Store pre-error for logging after filter (so we see actual pending count)
    const preErrorForLog = preError;
    const velErrorForLog = velError;
    const angleErrorForLog = angleError;
    
    this.predErrorPre = preError;
    this.predErrorPreAvg = this.predErrorPreAvg * (1 - this.predStatsAlpha) + preError * this.predStatsAlpha;
    this.predErrorPreMax = Math.max(this.predErrorPreMax * this.predMaxDecay, preError);
    
    this.predVelError = velError;
    this.predVelErrorAvg = this.predVelErrorAvg * (1 - this.predStatsAlpha) + velError * this.predStatsAlpha;
    
    this.predErrorHistory.push(preError);
    if (this.predErrorHistory.length > this.PRED_HISTORY_SIZE) {
      this.predErrorHistory.shift();
    }
    
    // --- End pre-reconciliation measurement ---
    
    const oldRenderX = player.renderX;
    const oldRenderY = player.renderY;
    
    // Snap physics to server state
    player.x = serverState.x;
    player.y = serverState.y;
    player.angle = serverState.angle ?? player.angle;
    player.angVel = serverState.av ?? 0;
    player.vx = serverState.vx || 0;
    player.vy = serverState.vy || 0;
    player.hp = serverState.hp || player.hp;
    player.maxHp = serverState.maxHp || player.maxHp;
    player.data = serverState.data;
    player.jump = serverState.data?.[3] ?? 0;
    if (serverState.data && serverState.data.length > 8) player.jumpScale = serverState.data[8] / 1000;
    player.jumpPrime = serverState.data?.[12] ?? 0;
    player.empUntil = snapshot.tick + (serverState.data?.[5] ?? 0);
    player.warmth = serverState.data?.[13] ?? 100;
    player.cargoMass = serverState.data?.[14] ?? 0;
    // (After the charge groups: the Burst Strafer's dodge and way, strafer.ts pilotExtras)
    { const x = pilotExtras(serverState.data); player.dodge = x.dodge; player.dodgeDir = x.dodgeDir; }

    // Reset boost fuel to server-reported value before replaying inputs.
    // Boost fuel is now in entity data[1] for every snapshot (not just playerState).
    // This ensures reconciliation uses fresh fuel data, not 1-second-stale data.
    if (serverState.data && serverState.data.length >= 2) {
      this.serverBoostFuel = serverState.data[1];
      // (Local circuits: the core's store and each store group's, energy.ts unpackCharge)
      this.serverCharge = unpackCharge(serverState.data);
    }
    this.charge = { ...this.serverCharge };
    
    // Debug: log pending ticks BEFORE filtering
    const preFilterCount = this.pendingInputsByTick.length;
    const preFilterTicks = this.pendingInputsByTick.slice(-5).map(e => e.tick);
    
    // Remove acknowledged inputs - filter by TICK (snapshot represents server state at snapshot.tick)
    // Keep inputs for ticks AFTER the snapshot tick (those haven't been simulated by server yet)
    this.pendingInputsByTick = this.pendingInputsByTick.filter(
      entry => entry.tick > snapshot.tick
    );
    
    this.predPendingCount = this.pendingInputsByTick.length;
    
    // Debug spike detection - log detailed info when error exceeds threshold (AFTER filter)
    const SPIKE_THRESHOLD = 1.0; // Log when error > 1px
    if (this.logSpikes && preErrorForLog > SPIKE_THRESHOLD) {
      const pendingCount = this.pendingInputsByTick.length;
      const lastTick = this.pendingInputsByTick.length > 0 ? this.pendingInputsByTick[this.pendingInputsByTick.length - 1].tick : 0;
      const firstTick = this.pendingInputsByTick.length > 0 ? this.pendingInputsByTick[0].tick : 0;
      console.warn(
        `[RECON SPIKE] preErr=${preErrorForLog.toFixed(3)} velErr=${velErrorForLog.toFixed(5)} angleErr=${angleErrorForLog.toFixed(4)}\n` +
        `  server: (${serverState.x}, ${serverState.y}) v=(${serverState.vx}, ${serverState.vy}) a=${serverState.angle}\n` +
        `  snapshot tick=${snapshot.tick} lastProcessedSeq=${snapshot.lastProcessedInput}\n` +
        `  BEFORE filter: ${preFilterCount} inputs, last ticks: [${preFilterTicks.join(',')}]\n` +
        `  pending AFTER filter: ${pendingCount} inputs (tick ${firstTick}-${lastTick}) inputDelayTicks=${this.inputDelayTicks}\n` +
        `  boostFuel: client=${this.boostFuel.toFixed(1)} server=${serverState.data?.[1]}`
      );
    }
    
    // Save state before replay for post-reconciliation debug
    const preReplayX = player.x;
    const preReplayY = player.y;
    const preReplayVx = player.vx;
    const preReplayVy = player.vy;
    
    // Replay unacknowledged inputs - sort by tick to ensure correct order
    this.pendingInputsByTick.sort((a, b) => a.tick - b.tick);
    this.selfPrev = { x: player.x, y: player.y, angle: player.angle };
    for (const entry of this.pendingInputsByTick) {
      this.selfPrev = { x: player.x, y: player.y, angle: player.angle };
      this.reapplyInput(player, entry.input, entry.tick);
    }
    
    // Smooth render position to prevent rubber banding
    const errorX = player.x - oldRenderX;
    const errorY = player.y - oldRenderY;
    const errorDist = Math.hypot(errorX, errorY);
    
    // --- Post-reconciliation measurement (render error) ---
    this.predErrorPost = errorDist;
    this.predErrorPostAvg = this.predErrorPostAvg * (1 - this.predStatsAlpha) + errorDist * this.predStatsAlpha;
    this.predErrorPostMax = Math.max(this.predErrorPostMax * this.predMaxDecay, errorDist);
    
    // Debug post-reconciliation spike
    const POST_SPIKE_THRESHOLD = 1.0;
    if (this.logSpikes && errorDist > POST_SPIKE_THRESHOLD && preError <= 1.0) {
      console.warn(
        `[POST-RECON SPIKE] postErr=${errorDist.toFixed(3)} (preErr was ${preError.toFixed(3)})\n` +
        `  after snap: (${preReplayX.toFixed(2)}, ${preReplayY.toFixed(2)}) v=(${preReplayVx.toFixed(4)}, ${preReplayVy.toFixed(4)})\n` +
        `  after replay ${this.pendingInputsByTick.length} inputs: (${player.x.toFixed(2)}, ${player.y.toFixed(2)}) v=(${player.vx.toFixed(4)}, ${player.vy.toFixed(4)})\n` +
        `  oldRender: (${oldRenderX.toFixed(2)}, ${oldRenderY.toFixed(2)})`
      );
    }
    
    if (errorDist > SNAP_THRESHOLD) {
      player.renderX = player.x;
      player.renderY = player.y;
      this.predSnapCount++;
    } else if (errorDist > SMOOTH_THRESHOLD) {
      player.renderX = oldRenderX + errorX * RECONCILE_SMOOTH;
      player.renderY = oldRenderY + errorY * RECONCILE_SMOOTH;
    } else {
      player.renderX = player.x;
      player.renderY = player.y;
    }
  }

  /** Replay an unacknowledged input during reconciliation. */
  private reapplyInput(player: InterpolatedEntity, input: ClientInputMessage, tick: number): void {
    const c = this.shipPhysics?.(player, input, this.charge, tick);
    if (c != null) this.charge = c;
    this.boostFuel = this.chargeTotal?.(this.charge) ?? this.serverBoostFuel;
  }

  // ============================================
  // INTERPOLATION
  // ============================================

  interpolate(delta: number): void {
    const now = performance.now();
    
    // Cache the estimated server tick ONCE per frame.
    // getEstimatedServerTick() has stateful EMA smoothing — calling it
    // multiple times per frame (e.g. per-asteroid) causes drift.
    const estimatedTick = this.getEstimatedServerTick(now);
    const rawTick = this.getRawServerTick(now);
    const rawTickRounded = Math.round(rawTick);
    
    // Slew interpolation delay toward target
    const maxStep = INTERP_SLEW_MS_PER_SEC * delta;
    const deltaDelay = Math.max(-maxStep, Math.min(maxStep, this.targetInterpDelayMs - this.interpDelayMs));
    this.interpDelayMs = Math.max(INTERP_MIN_DELAY_MS, Math.min(INTERP_MAX_DELAY_MS, this.interpDelayMs + deltaDelay));
    
    const interpDelayTicks = this.interpDelayMs / TICK_MS;
    const renderTick = Math.max(0, estimatedTick - interpDelayTicks);
    
    // Find bracketing snapshots
    const buffer = this.snapshotBuffer;
    if (buffer.length < 2) {
      this.fallbackInterpolate();
      return;
    }
    
    let from: BufferedSnapshot | null = null;
    let to: BufferedSnapshot | null = null;
    
    for (let i = 0; i < buffer.length - 1; i++) {
      if (buffer[i].tick <= renderTick && buffer[i + 1].tick >= renderTick) {
        from = buffer[i];
        to = buffer[i + 1];
        break;
      }
    }
    
    if (!from && !to && renderTick < buffer[0].tick) {
      from = buffer[0];
      to = buffer[1];
    }
    
    if (!from && !to) {
      from = buffer[buffer.length - 2];
      to = buffer[buffer.length - 1];
    }
    
    if (!from || !to || from.tick === to.tick) {
      this.fallbackInterpolate();
      return;
    }
    
    const t = Math.max(0, Math.min(1.2, (renderTick - from.tick) / (to.tick - from.tick)));
    const focus = this.orbitFocus;
    
    for (const entity of this.entities.values()) {
      if (entity.id === this.playerId) continue;
      // Replicated ships: stepped from their keyframe and controls
      if (this.replicaPose?.(entity, renderTick)) continue;

      // Loot pods drifting from their anchor (data[3] its tick: see podDrift)
      if (entity.type === EntityType.DroppedItem && entity.data && entity.data.length >= 4 && entity.hist?.length) {
        const b = entity.hist[entity.hist.length - 1];
        const at = podDrift(b, renderTick - entity.data[3]);
        entity.x = at.x; entity.y = at.y; entity.vx = at.vx; entity.vy = at.vy;
        entity.renderX += (entity.x - entity.renderX) * RENDER_SMOOTH_OTHER;
        entity.renderY += (entity.y - entity.renderY) * RENDER_SMOOTH_OTHER;
        continue;
      }
      
      // Deterministic asteroids — calculate position from orbit params
      if (entity.isDeterministic && entity.orbitType !== undefined) {
        // An asteroid is placed by the whole tick: nothing to do until the tick changes
        if (entity.orbitTimeScale === undefined) {
          if (entity.orbitTick === rawTickRounded) continue;
          // Out of sight: every few ticks, each rock on its own turn (and at once if it has gone a while)
          if (focus && (rawTickRounded + entity.id) % ORBIT_FAR_TICKS !== 0 && rawTickRounded - (entity.orbitTick ?? -1e9) < 2 * ORBIT_FAR_TICKS
            && (Math.abs(entity.x - focus.cx) > focus.hw || Math.abs(entity.y - focus.cy) > focus.hh)
            && (Math.abs(entity.x - focus.px) > focus.hw || Math.abs(entity.y - focus.py) > focus.hh)) continue;
        }
        entity.orbitTick = rawTickRounded;
        const { x, y } = calcAsteroidPosition({
          orbitType: entity.orbitType ?? 0,
          semiMajorAxis: entity.semiMajorAxis ?? 0,
          eccentricity: entity.eccentricity ?? 0,
          argPeriapsis: entity.argPeriapsis ?? 0,
          meanAnomaly0: entity.meanAnomaly0 ?? 0,
          epochTick: entity.epochTick ?? 0,
        }, entity.orbitTimeScale !== undefined
          // Stations: slowed orbit clock, evaluated at the exact (fractional) tick for smooth motion
          ? scaledOrbitTick(rawTick, entity.epochTick ?? 0, entity.orbitTimeScale)
          : rawTickRounded);
        entity.x = x;
        entity.y = y;
        // Snap render position — no lerp lag so hitscan visual matches server
        entity.renderX = x;
        entity.renderY = y;
        // Asteroids turn with the tick, exactly as the server's outline does (polygon.ts)
        if (entity.type === EntityType.Asteroid) entity.angle = entity.renderAngle = asteroidSpin(entity.id, rawTickRounded);
        continue;
      }
      const fromState = from.entities.get(entity.id);
      const toState = to.entities.get(entity.id);
      
      if (fromState && toState) {
        entity.x = this.lerp(fromState.x, toState.x, t);
        entity.y = this.lerp(fromState.y, toState.y, t);
        entity.angle = this.lerpAngle(fromState.angle || 0, toState.angle || 0, t);
        entity.vx = toState.vx || 0;
        entity.vy = toState.vy || 0;
      } else if (entity.hist?.length) {
        // Not in both snapshots either side (unchanged, or far away and sent less often):
        // carry on from the latest state at or before now along its velocity
        let base = entity.hist[0];
        for (const s of entity.hist) if (s.tick <= renderTick) base = s;
        const lim = entity.type === EntityType.Projectile ? 900 : 45;
        const dt = Math.max(-lim, Math.min(lim, renderTick - base.tick));
        entity.x = base.x + base.vx * dt;
        entity.y = base.y + base.vy * dt;
        entity.angle = base.angle;
        entity.vx = base.vx;
        entity.vy = base.vy;
      } else if (toState) {
        entity.x = toState.x;
        entity.y = toState.y;
        entity.angle = toState.angle || 0;
        entity.vx = toState.vx || 0;
        entity.vy = toState.vy || 0;
      }
      
      // Smooth render position
      entity.renderX += (entity.x - entity.renderX) * RENDER_SMOOTH_OTHER;
      entity.renderY += (entity.y - entity.renderY) * RENDER_SMOOTH_OTHER;
      entity.renderAngle = this.lerpAngle(entity.renderAngle, entity.angle, 0.3);
    }
    
    // The local ship: drawn between its last two steps, half a tick behind the estimate, so it
    // moves evenly even when a frame runs no step or two (frames and ticks don't line up)
    const player = this.entities.get(this.playerId);
    if (player) {
      const prev = this.selfPrev;
      if (prev && this.predictionEnabled && this.predictedTick > 0) {
        const k = Math.max(0, Math.min(1, this.frameTick - this.predictedTick + 0.5));
        let da = player.angle - prev.angle;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        player.renderX = prev.x + (player.x - prev.x) * k;
        player.renderY = prev.y + (player.y - prev.y) * k;
        player.renderAngle = prev.angle + da * k;
      } else {
        player.renderX += (player.x - player.renderX) * RENDER_SMOOTH_SELF;
        player.renderY += (player.y - player.renderY) * RENDER_SMOOTH_SELF;
        player.renderAngle = player.angle;
      }
    }
  }

  private fallbackInterpolate(): void {
    const now = performance.now();
    for (const entity of this.entities.values()) {
      if (entity.id === this.playerId) {
        entity.renderX += (entity.x - entity.renderX) * RENDER_SMOOTH_SELF;
        entity.renderY += (entity.y - entity.renderY) * RENDER_SMOOTH_SELF;
        entity.renderAngle = entity.angle;
        continue;
      }
      // Deterministic asteroids still need position updates even in fallback
      if (entity.isDeterministic && entity.orbitType !== undefined) {
        const currentTick = Math.round(this.getEstimatedServerTick(now));
        const { x, y } = calcAsteroidPosition({
          orbitType: entity.orbitType ?? 0,
          semiMajorAxis: entity.semiMajorAxis ?? 0,
          eccentricity: entity.eccentricity ?? 0,
          argPeriapsis: entity.argPeriapsis ?? 0,
          meanAnomaly0: entity.meanAnomaly0 ?? 0,
          epochTick: entity.epochTick ?? 0,
        }, currentTick);
        entity.x = x;
        entity.y = y;
        entity.renderX = entity.x;
        entity.renderY = entity.y;
        if (entity.type === EntityType.Asteroid) entity.angle = entity.renderAngle = asteroidSpin(entity.id, currentTick);
        continue;
      }
      entity.renderX += (entity.x - entity.renderX) * RENDER_SMOOTH_OTHER;
      entity.renderY += (entity.y - entity.renderY) * RENDER_SMOOTH_OTHER;
      entity.renderAngle = this.lerpAngle(entity.renderAngle, entity.angle, 0.3);
    }
  }

  // ============================================
  // UTILITY
  // ============================================

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  private lerpAngle(a: number, b: number, t: number): number {
    let diff = b - a;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
  }

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
  
  /**
   * A knock: `intensity` (about px, 2 a nudge .. 18 a capital ship going up) and
   * `duration` (s) add trauma, so a strong hit on top of a weak one shakes harder
   * rather than replacing it.
   */
  triggerScreenShake(intensity: number, duration: number): void {
    const s = this.screenShake;
    s.trauma = Math.min(1, s.trauma + Math.sqrt(Math.max(0, Math.min(1, intensity / 18))) * Math.min(1, 0.45 + duration));
  }

  /** Each frame (seconds): trauma drains; the offset follows smooth noise, the same at any frame rate */
  updateScreenShake(delta: number): void {
    const s = this.screenShake;
    s.trauma = Math.max(0, s.trauma - Math.min(0.1, delta) * SHAKE_DECAY);
    s.time += delta;
    const k = s.trauma * s.trauma, t = s.time * SHAKE_HZ;
    s.offsetX = k ? SHAKE_PX * k * shakeNoise(t, 1) : 0;
    s.offsetY = k ? SHAKE_PX * k * shakeNoise(t, 2) : 0;
    s.rotation = k ? SHAKE_ROLL * k * shakeNoise(t, 3) : 0;
  }
}
