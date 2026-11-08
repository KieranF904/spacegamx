/**
 * @contract client.ship.jump
 * owns:       the local jump drive as the client sees it: phase, reach, landing, aim, charging fields, plus the system's flight world (gravity, star, lodestones, hazards, terrain)
 * needs:      JumpControlHost (state, store, isKeyDown, hangarOpen, helm, showMessage), common jump/jumpFields/hazardFlight, terrainFor
 * invariants: reach and landing use the burn's own rules (jumpReachAt, jumpLanding) — server/src/golden/parity.test.ts
 *             a charge under way keeps the aim it was locked with — none pinned
 * extend:     a new system-wide flight field is one more field set in onSystemInfo and read by replicaEnv
 */

import {
  jumpPhase, jumpTuning, jumpReachAt, jumpLanding, jumpFieldAt, fieldRangeBoost, fieldCharge, primeBoost, inSolarRing, lodestonePosition, hazardFlight,
  FRICTION, EntityType, type ServerMessage, type ShipTuning, type JumpTuning, type JumpField, type LodestoneData, type GravityWell, type Terrain, type HazardRules, type ReplicaEnv, type ShipDerived,
} from '@space-game/common';
import hazardData from '../../../../data/hazards.json';
import type { GameState } from '../../state/GameState';
import { terrainFor } from '../../rendering/terrainData';
import { settings } from '../../settings/Settings';
import type { ShipStore } from '../ShipStore';
import { JumpFx } from '../JumpFx';

const HAZARD_RULES = hazardData as unknown as HazardRules;

export interface JumpControlHost {
  readonly state: GameState;
  readonly store: ShipStore;
  isKeyDown(code: string): boolean;
  hangarOpen(): boolean;
  helm(): boolean;
  showMessage(text: string, color?: string): void;
}

export class JumpControl {
  readonly jump: JumpTuning;
  constructor(private readonly h: JumpControlHost, tuning: ShipTuning) {
    this.jump = jumpTuning(tuning);
  }
  /** The current system's gravity well, so prediction pulls exactly like the server */
  gravity: GravityWell | null = null;
  /** This system's central body (a star's charging ring boosts the jump drive) */
  central: { type?: string; radius?: number } | null = null;
  /** This system's stillstones (their fields charge the drive too: common/src/ships/jumpFields.ts), from systemInfo */
  lodestones: LodestoneData[] = [];
  /** The system as hazards see it (ratings, the star's radius, the central body), from systemInfo */
  hazardSys: { hazardRatings?: Record<string, number>; starRadius?: number; centralBody?: { type?: string } } | null = null;
  hazardFor = (d: ShipDerived, x: number, y: number) => (this.hazardSys ? hazardFlight(HAZARD_RULES, this.hazardSys, d, x, y) : undefined);
  /** Where the next jump is aimed: distance, and what it locked on to */
  jumpAimInfo: { dist: number; label: string | null; bearing?: number; sent?: number } = { dist: 0, label: null };
  /** What a locked charge was aimed at (jumpLocked: undefined while there's none) */
  lockLabel: string | null | undefined;
  /** This system's rock (a surface's terrain), or null */
  terrain: Terrain | null = null;
  /** J was pressed: the jump control stays on until the burn starts (or J again cancels) */
  jumpLatched = false;

  /** The local ship's jump drive phase (ready when there's no ship) */
  localJump(): ReturnType<typeof jumpPhase> {
    const me = this.h.state.entities.get(this.h.state.playerId);
    const ship = me && this.h.store.get(me.id);
    return jumpPhase(me ? JumpFx.counter(me, true) : 0, ship?.derived.jumpCooldown ? { ...this.jump, cooldownTicks: ship.derived.jumpCooldown } : this.jump);
  }

  /** Jump range multiplier at a point (a star's charging ring), for a drive with `primed` ticks of a stillstone's priming (jumpFields.ts stepPrime) */
  jumpBoostAt(x: number, y: number, primed = 0): number {
    return fieldRangeBoost(inSolarRing(x, y, this.central, this.jump), primed, this.jump);
  }

  /** How far the local ship's drive reaches here (the burn's own rule: jumpReachAt, a gravity hazard's share too) */
  jumpReach(): number {
    const me = this.h.state.entities.get(this.h.state.playerId);
    const ship = me && this.h.store.get(me.id);
    if (!me || !ship) return 0;
    return jumpReachAt(ship.derived, this.jump, this.jumpBoostAt(me.x, me.y, me.jumpPrime ?? 0), this.hazardFor(ship.derived, me.x, me.y));
  }

  /**
   * Where the local ship's jump would stop it (null: no ship or no reach): its slide while the drive spools, then the
   * aimed distance along the aim (the cursor's bearing; helm: the nose), as stepFlight flies it (jumpAim.ts). Drawn
   * from where the ship is drawn
   */
  jumpLanding(): { x: number; y: number; reach: number } | null {
    const me = this.h.state.entities.get(this.h.state.playerId);
    const ship = me && this.h.store.get(me.id);
    const reach = this.jumpReach();
    if (!me || !ship || !reach) return null;
    // (A charge under way goes where it was locked as it started: jumpLocked)
    const lock = this.jumpLocked();
    const bearing = lock ? lock.angle : this.h.helm() ? me.renderAngle : this.jumpAimInfo.bearing ?? me.renderAngle;
    const at = jumpLanding({ x: me.renderX, y: me.renderY, vx: me.vx, vy: me.vy }, me.jump ?? 0, bearing, lock ? lock.dist : this.jumpAimInfo.sent ?? this.jumpAimInfo.dist, reach, this.jump,
      { friction: FRICTION, gravity: this.gravity, hazard: this.hazardFor(ship.derived, me.x, me.y) });
    return { x: at[0], y: at[1], reach };
  }

  /** The charging fields the local ship is in now, and how long its drive stays primed (ticks) */
  localField(): JumpField & { prime: number } {
    const me = this.h.state.entities.get(this.h.state.playerId);
    if (!me) return { ring: false, lodestone: null, prime: 0 };
    const f = jumpFieldAt(me.renderX, me.renderY, { central: this.central, lodestones: this.lodestones }, this.h.state.getRawServerTick(), this.jump);
    return { ...f, prime: me.jumpPrime ?? 0 };
  }

  /** How brightly a stillstone's veins pulse: up as your drive charges in its field (0 when you're not in it) */
  lodestoneGlow(id: string): number {
    const f = this.localField();
    if (f.lodestone?.id !== id) return 0;
    const ph = this.localJump();
    return ph.phase === 'cooldown' ? 0.3 + 0.7 * ph.progress : ph.phase === 'ready' ? 1 : 0.6;
  }

  /** This system's stillstones (the map and markers draw them) */
  systemLodestones(): readonly LodestoneData[] {
    return this.lodestones;
  }

  /** Where a stillstone is now */
  lodestoneNow(l: LodestoneData): { x: number; y: number } {
    return lodestonePosition(l, this.h.state.getRawServerTick());
  }

  /**
   * What's wrong with where the jump would drop you, if anything: into a
   * star's (or a black hole's) hazard, or among hostiles that aren't calm.
   */
  jumpDanger(): string | null {
    const at = this.jumpLanding();
    if (!at) return null;
    const { x, y } = at;
    const body = this.central?.radius ?? 0;
    if (body > 0 && this.central?.type !== 'none' && Math.hypot(x, y) < body + (this.central?.type === 'black_hole' ? 2500 : 1500)) {
      return this.central?.type === 'black_hole' ? 'That drops you into the black hole\'s pull' : 'That drops you into the star\'s heat';
    }
    let foes = 0;
    for (const e of this.h.state.entities.values()) {
      if (e.type !== EntityType.ShipBody || e.data?.[0] !== 3 || e.data?.[9] === 1) continue;
      if (Math.hypot(e.renderX - x, e.renderY - y) < 3000) foes++;
    }
    return foes ? `Hostiles where you'd land (${foes})` : null;
  }

  /** Is the pilot lining up a jump (key held, latched or spooling)? */
  jumpAiming(): boolean {
    const ph = this.localJump().phase;
    return ph === 'charging' || (ph === 'ready' && (this.jumpLatched || this.h.isKeyDown('KeyJ')));
  }

  /**
   * A charge under way: where it goes, locked as it started (common flight.ts FlightBody.jumpAim/jumpTo, as the own
   * ship's tick layer has them): its heading, the distance asked (0: as far as it reaches), and what it was aimed at
   * then (the label the aim had as the lock first showed). Null when not charging or there's no lock
   */
  jumpLocked(): { angle: number; dist: number; label: string | null } | null {
    const me = this.h.state.entities.get(this.h.state.playerId);
    if (!me || me.jumpAim === undefined || this.localJump().phase !== 'charging') { this.lockLabel = undefined; return null; }
    if (this.lockLabel === undefined) this.lockLabel = this.jumpAimInfo.label;
    const dist = me.jumpTo ?? 0;
    return { angle: me.jumpAim, dist: dist > 0 ? dist : this.jumpReach(), label: this.lockLabel };
  }

  /** Where the jump is aimed (Game sets it from the cursor, snapped to a destination) */
  setJumpAim(dist: number, label: string | null): void {
    this.jumpAimInfo = { dist, label, bearing: this.jumpAimInfo.bearing, sent: this.jumpAimInfo.sent };
  }

  /** The aim and distance the input says this tick, as the server gets them (the burn goes along the aim, that far: flight.ts) */
  setJumpSent(angle: number, dist: number): void {
    this.jumpAimInfo.bearing = angle;
    this.jumpAimInfo.sent = dist;
  }

  /** Is the jump control on this tick? (J latches it; it releases once the burn starts.) */
  jumpHeld(): boolean {
    // Hold mode: the key itself is the control (let go while spooling to abort)
    if (settings.data.gameplay.jumpMode === 'hold') return !this.h.hangarOpen() && this.h.isKeyDown('KeyJ');
    if (this.jumpLatched) {
      const ph = this.localJump().phase;
      if (ph === 'burn' || ph === 'cooldown' || this.h.hangarOpen()) this.jumpLatched = false;
    }
    return this.jumpLatched;
  }

  /**
   * How hard the well is pulling compared with what the ship can push back:
   * 0 (no well / negligible) .. 1 (the pull matches full thrust or worse).
   */
  horizonDanger(): number {
    const g = this.gravity;
    const me = this.h.state.entities.get(this.h.state.playerId);
    const ship = me && this.h.store.get(me.id);
    if (!g || !me || !ship || ship.derived.mass <= 0) return 0;
    const pull = g.strength / Math.max(Math.hypot(me.x, me.y), g.minRadius) ** 2;
    const push = Math.max(ship.derived.maxThrust.forward, ship.derived.maneuverForce) / ship.derived.mass;
    return Math.min(1, pull / push);
  }

  /** What the jump gauge says about charging fields */
  gaugeField(): { ring: boolean; lodestone: boolean; charge: number; primeSecs: number; boost: number; short: string } {
    const f = this.localField();
    return {
      ring: f.ring, lodestone: !!f.lodestone, charge: fieldCharge(f, this.jump), primeSecs: Math.ceil(Math.abs(f.prime) / 60),
      boost: primeBoost(f.prime, this.jump), short: this.jump.lodestoneShort,
    };
  }

  /** The world the replicas fly in (gravity, the central body, lodestones, hazards, a surface's rock): the gun lanes' too */
  replicaEnv(): ReplicaEnv {
    return { gravity: this.gravity, central: this.central, lodestones: this.lodestones, hazard: this.hazardFor, terrain: this.terrain };
  }

  /** systemInfo: the new system's well, central body, rock, stillstones and hazards */
  onSystemInfo(msg: Extract<ServerMessage, { type: 'systemInfo' }>): void {
    this.gravity = msg.centralBody.gravity ?? null;
    this.central = msg.centralBody;
    // A surface's rock (pushed out of it in prediction, as the server does)
    this.terrain = terrainFor(msg.systemId);
    this.lodestones = msg.lodestones ?? [];
    this.hazardSys = msg.hazardRatings ? { hazardRatings: msg.hazardRatings, starRadius: msg.hazardRadius, centralBody: { type: msg.centralBody.type } } : null;
  }

  /** J pressed: latch, abort or explain the cooldown (the key itself is the control in hold mode) */
  press(): void {
  const ph = this.localJump();
  const hold = settings.data.gameplay.jumpMode === 'hold';
  if (hold && ph.phase !== 'cooldown') return;
  if (this.jumpLatched || ph.phase === 'charging') this.jumpLatched = false; // abort
  else if (ph.phase === 'ready') this.jumpLatched = !!this.h.store.get(this.h.state.playerId);
  else if (ph.phase === 'cooldown') {
    const cool = this.h.store.get(this.h.state.playerId)?.derived.jumpCooldown || this.jump.cooldownTicks;
    const secs = Math.ceil(((1 - ph.progress) * cool) / 60 / (1 + fieldCharge(this.localField(), this.jump)));
    this.h.showMessage(`Jump drive cooling down (${secs}s)`, '#9fd8ff');
  }
  }
}
