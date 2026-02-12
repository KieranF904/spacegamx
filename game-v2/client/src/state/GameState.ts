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

import {
  ServerSnapshotMessage,
  ClientInputMessage,
  EntityState,
  EntityType,
  InventorySlot,
  EquipmentSlots,
  AsteroidSpawnData,
  makeAsteroidParams,
  makeAsteroidParamsFromField,
  calcAsteroidPosition,
  asteroidRegistry,
  stepPlayerPhysics,
  PhysicsState,
  PhysicsInput,
  // BitBuffer precision functions - used for reconciliation
  quantizePosition,
  quantizeVelocity,
  quantizeAngle,
  quantizeBoost,
} from '@space-game/common';
import {
  PLAYER_MAX_HP,
  BOOST_FUEL_DEFAULT,
  TICK_RATE,
  TICK_MS,
  SERVER_TICK_SMOOTHING,
  SERVER_TICK_MAX_STEP,
  INTERP_MAX_DELAY_MS,
  INTERP_MIN_DELAY_MS,
  INTERP_SLEW_MS_PER_SEC,
  PING_HISTORY_SIZE,
} from '@space-game/common';

// ============================================
// INTERFACES
// ============================================

export interface InterpolatedEntity {
  id: number;
  type: EntityType;
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
  wobblePhase?: number;
  isDeterministic?: boolean; // true → skip snapshot interpolation, calculate position
}

interface ScreenShake {
  intensity: number;
  duration: number;
  elapsed: number;
  offsetX: number;
  offsetY: number;
}

/** Buffered snapshot for interpolation */
interface BufferedSnapshot {
  tick: number;
  time: number; // performance.now() when received
  serverTime: number;
  lastProcessedInput: number;
  entities: Map<number, EntityState>;
  removed: number[];
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
const SMOOTH_THRESHOLD = 12;       // Snap if error < this
const RECONCILE_SMOOTH = 0.5;      // Reconciliation smoothing rate

// Input delay buffer constants
const INPUT_DELAY_MIN_TICKS = 2;   // Minimum buffer (33ms) — imperceptible
const INPUT_DELAY_MAX_TICKS = 18;  // Maximum buffer (300ms) — covers high-latency connections
const INPUT_DELAY_INITIAL_TICKS = 2; // Starting buffer (33ms)
const INPUT_DELAY_ERROR_THRESHOLD = 8; // px — increase buffer if error exceeds this
const INPUT_DELAY_CLEAN_PERIOD = 30_000; // ms — decrease buffer after 30s clean
const INPUT_DELAY_ADAPTIVE = false; // Disable adaptive ramping until base sync is proven

export class GameState {
  // ============================================
  // PLAYER STATE
  // ============================================
  public playerId: number = 0;
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
  
  // Inventory
  public inventory: InventorySlot[] = [];
  public equipment: EquipmentSlots = {
    leftWeapon: null,
    rightWeapon: null,
    booster: null,
    cockpit: null,
  };
  
  // ============================================
  // TICK SYNCHRONIZATION
  // ============================================
  public tickRate: number = TICK_RATE;
  public serverTick: number = 0;
  private serverTickTarget: number = 0;
  private serverTickTargetTime: number = 0;
  private smoothedServerTick: number = 0;
  
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
  
  // ============================================
  // INPUT DELAY BUFFER
  // ============================================
  /** Current adaptive input delay in ticks */
  public inputDelayTicks: number = INPUT_DELAY_INITIAL_TICKS;
  /** Queued inputs waiting for their targetTick to be reached */
  private inputDelayQueue: ClientInputMessage[] = [];
  /** Cached estimated server tick — updated once per frame, then incremented per tick iteration */
  public cachedServerTick: number = 0;
  /** Timestamp of last prediction disagreement exceeding threshold */
  private lastDisagreementTime: number = 0;
  /** Last-drained fire state — the laser visual should use THIS, not the live mouse */
  public drainedFireLeft: boolean = false;
  public drainedFireRight: boolean = false;
  public drainedTargetAngle: number = 0;
  
  // ============================================
  // INPUT
  // ============================================
  private inputSeq: number = 0;
  // Track inputs by tick for reconciliation - stores (tick, input) pairs
  private pendingInputsByTick: { tick: number; input: ClientInputMessage }[] = [];
  
  // ============================================
  // ENTITY STATE
  // ============================================
  public entities: Map<number, InterpolatedEntity> = new Map();
  private snapshotBuffer: BufferedSnapshot[] = [];
  
  // Screen shake
  public screenShake: ScreenShake = {
    intensity: 0,
    duration: 0,
    elapsed: 0,
    offsetX: 0,
    offsetY: 0,
  };
  
  // Dying entities (for fade effects)
  public dyingEntities: Map<number, { entity: InterpolatedEntity; fadeProgress: number }> = new Map();

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
    
    if (this.smoothedServerTick === 0) {
      this.smoothedServerTick = this.serverTickTarget;
    }
    
    // Adaptive interpolation delay formula
    const baseMin = this.smoothedPing < 60 ? 80 : 110;
    const target = Math.max(baseMin, Math.min(INTERP_MAX_DELAY_MS,
      this.smoothedPing * 0.7 + this.smoothedJitter * 4 + 90
    ));
    this.targetInterpDelayMs = Math.max(INTERP_MIN_DELAY_MS, target);
  }

  getEstimatedServerTick(now: number = performance.now()): number {
    const raw = this.serverTickTarget + (now - this.serverTickTargetTime) / TICK_MS;
    if (this.smoothedServerTick === 0) {
      this.smoothedServerTick = raw;
      return raw;
    }
    const delta = raw - this.smoothedServerTick;
    const step = Math.max(-SERVER_TICK_MAX_STEP, Math.min(SERVER_TICK_MAX_STEP, delta));
    this.smoothedServerTick += step * SERVER_TICK_SMOOTHING;
    return this.smoothedServerTick;
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
   * Advance cachedServerTick by one after each tick iteration.
   * This ensures each tick in a multi-tick frame gets a unique targetTick.
   */
  advanceCachedTick(): void {
    this.cachedServerTick++;
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
    let lastInput: ClientInputMessage | null = null;
    let drainedCount = 0;
    let i = 0;
    while (i < this.inputDelayQueue.length) {
      const input = this.inputDelayQueue[i];
      const tt = input.targetTick ?? 0;
      if (tt <= nextTick) {
        // Track by the tick we're APPLYING physics for (nextTick), not targetTick
        // This is the tick that matches server simulation
        this.pendingInputsByTick.push({ tick: nextTick, input });
        drainedCount++;
        lastInput = input;
        // Track the latest drained fire state for laser rendering
        this.drainedFireLeft = !!input.fireLeft;
        this.drainedFireRight = !!input.fireRight;
        this.drainedTargetAngle = input.targetAngle;
        // Swap-remove for O(1)
        this.inputDelayQueue[i] = this.inputDelayQueue[this.inputDelayQueue.length - 1];
        this.inputDelayQueue.pop();
        // Don't increment i - we swapped a new element into this position
      } else {
        i++;
      }
    }
    
    // Run physics ONCE with the last applied input (or repeat last if none)
    if (lastInput) {
      this.applyPhysics(lastInput);
    } else if (this.pendingInputsByTick.length > 0) {
      // No new input this tick — repeat last known input (server does this too)
      const last = this.pendingInputsByTick[this.pendingInputsByTick.length - 1].input;
      this.applyPhysics(last);
    }
    // If no inputs at all, don't run physics (shouldn't happen in normal play)
  }

  /**
   * Adaptive delay: called from reconcilePlayer.
   * +1 tick on disagreement, -1 tick after 30s clean.
   */
  private updateInputDelay(preError: number): void {
    const now = performance.now();
    if (preError > INPUT_DELAY_ERROR_THRESHOLD) {
      // Disagreement — increase buffer
      this.inputDelayTicks = Math.min(INPUT_DELAY_MAX_TICKS, this.inputDelayTicks + 1);
      this.lastDisagreementTime = now;
    } else if (now - this.lastDisagreementTime > INPUT_DELAY_CLEAN_PERIOD
               && this.inputDelayTicks > INPUT_DELAY_MIN_TICKS) {
      // 30 seconds clean — decrease buffer
      this.inputDelayTicks--;
      this.lastDisagreementTime = now; // reset timer for next 30s window
    }
  }

  /**
   * Apply one tick of physics to the local player.
   * Uses shared physics from common/ to ensure client/server parity.
   */
  private applyPhysics(input: ClientInputMessage): void {
    const player = this.entities.get(this.playerId);
    if (!player) return;
    
    const state: PhysicsState = {
      x: player.x,
      y: player.y,
      vx: player.vx,
      vy: player.vy,
      angle: player.angle,
    };
    
    const physicsInput: PhysicsInput = {
      forward: input.forward,
      backward: input.backward,
      left: input.left,
      right: input.right,
      boost: input.boost,
      targetAngle: input.targetAngle,
    };
    
    const result = stepPlayerPhysics(state, physicsInput, {
      fuel: this.boostFuel,
      drainRate: 0.8,
    });
    
    // stepPlayerPhysics now applies BitBuffer quantization internally
    // No manual rounding needed - values are already at network precision
    player.x = result.state.x;
    player.y = result.state.y;
    player.vx = result.state.vx;
    player.vy = result.state.vy;
    player.angle = result.state.angle;
    this.boostFuel = quantizeBoost(result.boostFuel);
  }

  // ============================================
  // SNAPSHOT HANDLING
  // ============================================

  applySnapshot(snapshot: ServerSnapshotMessage): void {
    this.serverTick = snapshot.tick;
    
    // Buffer the snapshot
    const entityMap = new Map<number, EntityState>();
    for (const state of snapshot.entities) {
      entityMap.set(state.id, state);
    }
    
    this.snapshotBuffer.push({
      tick: snapshot.tick,
      time: performance.now(),
      serverTime: snapshot.serverTime,
      lastProcessedInput: snapshot.lastProcessedInput,
      entities: entityMap,
      removed: [...snapshot.removed],
    });
    
    while (this.snapshotBuffer.length > SNAPSHOT_BUFFER_SIZE) {
      this.snapshotBuffer.shift();
    }
    
    // Handle removed entities
    for (const id of snapshot.removed) {
      const entity = this.entities.get(id);
      if (entity) {
        if (entity.type === EntityType.Projectile) {
          this.dyingEntities.set(id, { entity: { ...entity }, fadeProgress: 0 });
        }
        this.entities.delete(id);
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
          if (orbitType !== 255) entity.isDeterministic = true;
        }
        
        this.entities.set(state.id, entity);
      } else {
        // Update existing entity hp/data from latest snapshot
        const entity = this.entities.get(state.id)!;
        entity.hp = state.hp || entity.hp;
        entity.maxHp = state.maxHp || entity.maxHp;
        entity.data = state.data;
        if (state.name) entity.name = state.name;
        entity.lastServerUpdate = snapshot.tick;
      }
    }
    
    // Server reconciliation for player
    this.reconcilePlayer(snapshot);
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
    belt: { innerRadius: number; outerRadius: number; count: number },
    ids: number[],
    indices: number[],
    asteroidField?: string,
  ): void {
    // Replace any existing deterministic asteroids to avoid stale state
    this.clearDeterministicAsteroids();
    
    // Get field configuration if available
    const field = asteroidField ? asteroidRegistry.getField(asteroidField) : undefined;
    
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const index = indices[i] ?? i;
      if (this.entities.has(id)) continue;

      // Use definition-based generation if field config exists
      const params = field 
        ? makeAsteroidParamsFromField(systemId, index, seed, tick, belt, field)
        : makeAsteroidParams(systemId, index, seed, tick, belt);
      
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
    
    // Adaptive input delay — adjust buffer based on disagreement
    if (INPUT_DELAY_ADAPTIVE) {
      this.updateInputDelay(preError);
    }
    // --- End pre-reconciliation measurement ---
    
    const oldRenderX = player.renderX;
    const oldRenderY = player.renderY;
    
    // Snap physics to server state
    player.x = serverState.x;
    player.y = serverState.y;
    player.angle = serverState.angle || player.angle;
    player.vx = serverState.vx || 0;
    player.vy = serverState.vy || 0;
    player.hp = serverState.hp || player.hp;
    player.maxHp = serverState.maxHp || player.maxHp;
    player.data = serverState.data;
    
    // Reset boost fuel to server-reported value before replaying inputs.
    // Boost fuel is now in entity data[1] for every snapshot (not just playerState).
    // This ensures reconciliation uses fresh fuel data, not 1-second-stale data.
    if (serverState.data && serverState.data.length >= 2) {
      this.serverBoostFuel = serverState.data[1];
    }
    this.boostFuel = this.serverBoostFuel;
    
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
    if (preErrorForLog > SPIKE_THRESHOLD) {
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
    for (const entry of this.pendingInputsByTick) {
      this.reapplyInput(player, entry.input);
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
    if (errorDist > POST_SPIKE_THRESHOLD && preError <= 1.0) {
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

  /**
   * Reapply an input during reconciliation.
   * Uses shared physics from common/ which applies BitBuffer quantization internally.
   * No additional rounding needed - stepPlayerPhysics handles all precision.
   */
  private reapplyInput(player: InterpolatedEntity, input: ClientInputMessage): void {
    const state: PhysicsState = {
      x: player.x,
      y: player.y,
      vx: player.vx,
      vy: player.vy,
      angle: player.angle,
    };
    
    const physicsInput: PhysicsInput = {
      forward: input.forward,
      backward: input.backward,
      left: input.left,
      right: input.right,
      boost: input.boost,
      targetAngle: input.targetAngle,
    };
    
    const result = stepPlayerPhysics(state, physicsInput, {
      fuel: this.boostFuel,
      drainRate: 0.8,
    });
    
    // stepPlayerPhysics already quantizes to BitBuffer precision - use values directly
    player.x = result.state.x;
    player.y = result.state.y;
    player.vx = result.state.vx;
    player.vy = result.state.vy;
    player.angle = result.state.angle;
    this.boostFuel = result.boostFuel;
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
    const rawTickRounded = Math.round(this.getRawServerTick(now));
    
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
    
    for (const entity of this.entities.values()) {
      if (entity.id === this.playerId) continue;
      
      // Deterministic asteroids — calculate position from orbit params
      if (entity.isDeterministic && entity.orbitType !== undefined) {
        const { x, y } = calcAsteroidPosition({
          orbitType: entity.orbitType ?? 0,
          semiMajorAxis: entity.semiMajorAxis ?? 0,
          eccentricity: entity.eccentricity ?? 0,
          argPeriapsis: entity.argPeriapsis ?? 0,
          meanAnomaly0: entity.meanAnomaly0 ?? 0,
          epochTick: entity.epochTick ?? 0,
        }, rawTickRounded);
        entity.x = x;
        entity.y = y;
        // Snap render position — no lerp lag so hitscan visual matches server
        entity.renderX = x;
        entity.renderY = y;
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
      } else if (toState) {
        entity.x = toState.x;
        entity.y = toState.y;
        entity.angle = toState.angle || 0;
        entity.vx = toState.vx || 0;
        entity.vy = toState.vy || 0;
      } else if (fromState) {
        entity.x = fromState.x + (fromState.vx || 0) * (renderTick - from.tick);
        entity.y = fromState.y + (fromState.vy || 0) * (renderTick - from.tick);
        entity.angle = fromState.angle || 0;
      }
      
      // Smooth render position
      entity.renderX += (entity.x - entity.renderX) * RENDER_SMOOTH_OTHER;
      entity.renderY += (entity.y - entity.renderY) * RENDER_SMOOTH_OTHER;
      entity.renderAngle = this.lerpAngle(entity.renderAngle, entity.angle, 0.3);
    }
    
    // Smooth local player render position
    const player = this.entities.get(this.playerId);
    if (player) {
      player.renderX += (player.x - player.renderX) * RENDER_SMOOTH_SELF;
      player.renderY += (player.y - player.renderY) * RENDER_SMOOTH_SELF;
      player.renderAngle = player.angle;
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
  
  triggerScreenShake(intensity: number, duration: number): void {
    if (this.screenShake.intensity > intensity && this.screenShake.duration > 0) return;
    this.screenShake.intensity = intensity;
    this.screenShake.duration = duration;
    this.screenShake.elapsed = 0;
  }
  
  updateScreenShake(delta: number): void {
    if (this.screenShake.duration <= 0) {
      this.screenShake.offsetX = 0;
      this.screenShake.offsetY = 0;
      return;
    }
    
    this.screenShake.elapsed += delta;
    
    if (this.screenShake.elapsed >= this.screenShake.duration) {
      this.screenShake.duration = 0;
      this.screenShake.offsetX = 0;
      this.screenShake.offsetY = 0;
      return;
    }
    
    const progress = this.screenShake.elapsed / this.screenShake.duration;
    const currentIntensity = this.screenShake.intensity * (1 - progress);
    this.screenShake.offsetX = (Math.random() - 0.5) * 2 * currentIntensity;
    this.screenShake.offsetY = (Math.random() - 0.5) * 2 * currentIntensity;
  }
  
  updateDyingEntities(delta: number): void {
    const fadeDuration = 0.3;
    const toRemove: number[] = [];
    
    for (const [id, dying] of this.dyingEntities) {
      dying.fadeProgress += delta / fadeDuration;
      dying.entity.x += dying.entity.vx;
      dying.entity.y += dying.entity.vy;
      dying.entity.renderX = dying.entity.x;
      dying.entity.renderY = dying.entity.y;
      
      if (dying.fadeProgress >= 1) {
        toRemove.push(id);
      }
    }
    
    for (const id of toRemove) {
      this.dyingEntities.delete(id);
    }
  }
}
