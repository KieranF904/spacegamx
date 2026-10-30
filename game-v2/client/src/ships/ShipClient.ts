/**
 * Everything the client does for modular ships, in live play and proto alike:
 * mirrors ship state from the server (ShipStore), draws ships (ShipRenderer),
 * the HUD schematic (ShipHud), the hangar (HangarUI, docked only), helm vs
 * mouse-steer controls, client-side prediction with the shared ship physics,
 * and turret visuals.
 *
 *   H  dock at a station in range and open the hangar (closing it undocks)
 *   V  switch controls: mouse-steer ↔ helm (A/D turn, W/S thrust, Q/E strafe)
 *   J  jump drive: spool up, then fly far and fast along the nose (J again aborts)
 */

import { payMining, stagedIntegrity, type Terrain, chargeTotal, hazardFlight, warmthStage, withNumb, type Charge, type ShipState, type WeaponMods, type ShipDerived, type HazardRules } from '@space-game/common';
import hazardData from '../../../data/hazards.json';

const HAZARD_RULES = hazardData as unknown as HazardRules;
import { setHtml, setStyle } from '../ui/domWrite';
import type { Application } from 'pixi.js';
import {
  Blueprint, Catalog, ClientInputMessage, ClientMessage, EntityType, InventoryStub, ServerMessage, ShipTuning,
  stationInteractRadius, stepShipPhysics, stepTurretAim, shipPointToWorld, unpackCursorWeaponState, GravityWell,
  JumpTuning, jumpPhase, jumpTuning, coreHp, FRICTION, worldToLocalDir, partItemId, inSolarRing, jumpRange,
  jumpFieldAt, fieldRangeBoost, fieldCharge, primeBoost, pilotJumpStep, withEmp, lodestonePosition, type JumpField, type LodestoneData,
  ShipReplicaSet, ServerSnapshotMessage, packCursorWeaponState, rebuildVolley, WEAPON_KIND_TYPE, EntityState, accelAlong, turnAccel, rateShip, stepGuns, volleyShells, firesStraight, partWeaponDef,
} from '@space-game/common';
import type { MenuShipInfo } from '../ui/GameMenuUI';
import type { GameState, InterpolatedEntity } from '../state/GameState';
import type { Renderer } from '../rendering/Renderer';
import { ShipStore } from './ShipStore';
import { ShipRenderer } from './ShipRenderer';
import { ShipHud } from './ShipHud';
import type { HangarUI } from './HangarUI';
import { Lazy } from '../lazy';
import { JumpFx } from './JumpFx';
import { terrainFor } from '../rendering/terrainData';
import { BossFx } from './BossFx';
import { DamageFx } from './DamageFx';
import { MiningBeamFx } from './MiningBeamFx';
import { ScannerFx } from './ScannerFx';
import type { PilotState } from '../econ/clientEcon';
import type { ThrustCommand } from './ThrusterFx';
import { settings } from '../settings/Settings';
import { boundKeyName } from '../input/keybindings';

/** A pulse laser's sound by its grade, Mk I-V: subtle, and centred low (the wide Mk IV deepest, the x-ray Mk V a touch brighter) */
const PULSE_GRADE_PITCH = [0.98, 0.94, 1.01, 0.9, 1.04];

export interface ShipClientOptions {
  catalog: Catalog;
  tuning: ShipTuning;
  /** The pilot's items (the hangar builds from owned parts) */
  pilot: PilotState;
  /** Proto mode: every part is free in the hangar */
  grantAllParts?: boolean;
  /** Docked at a station: open the station screen (without this, docking opens the hangar) */
  onDocked?(station: string): void;
  /** Is the station screen open (closing the hangar then returns to it instead of undocking) */
  stationOpen?(): boolean;
  /** The hangar closed while the station screen is open */
  onHangarBackToStation?(): void;
  /** Is the mining button (right mouse) held */
  miningHeld?(): boolean;
  state: GameState;
  send(msg: ClientMessage): void;
  showMessage(text: string, color?: string): void;
  /** Local cursor in world units, for this client's own turrets */
  localAim(): { angle: number; dist: number };
  /** False while a menu has the keyboard */
  inputEnabled?(): boolean;
  /** Is this (game) key held? */
  isKeyDown(code: string): boolean;
  /** Play a sound (at a world position, or for the local pilot when `at` is absent); returns a stop function */
  sound?(id: string, at?: { x: number; y: number }, volume?: number, pitch?: number): (() => void) | null;
  /** A short notice at the top of the screen */
  toast?(text: string, kind: 'info' | 'good' | 'warn' | 'bad'): void;
  /** Proto: no stations, so the hangar opens anywhere */
  editAnywhere?: boolean;
  onHangarOpen?(): void;
  onHangarClose?(): void;
}

export class ShipClient {
  readonly store: ShipStore;
  private renderer: ShipRenderer | null = null;
  private scene: Renderer | null = null;
  private hud: ShipHud;
  /** Split out of the main chunk (Game prefetches it after sign-in) */
  readonly hangar: Lazy<HangarUI>;
  private helm = false;
  /** The settings' control mode last applied (V's switch holds until the setting itself changes) */
  private appliedMode: string | null = null;
  private lastBlueprint: Blueprint | null = null;
  private lastTurretFrame = 0;
  /** The current system's gravity well, so prediction pulls exactly like the server */
  private gravity: GravityWell | null = null;
  /** This system's central body (a star's charging ring boosts the jump drive) */
  private central: { type?: string; radius?: number } | null = null;
  /** This system's stillstones (their fields charge the drive too: common/src/ships/jumpFields.ts), from systemInfo */
  private lodestones: LodestoneData[] = [];
  /** The system as hazards see it (ratings, the star's radius, the central body), from systemInfo */
  private hazardSys: { hazardRatings?: Record<string, number>; starRadius?: number; centralBody?: { type?: string } } | null = null;
  private hazardFor = (d: ShipDerived, x: number, y: number) => (this.hazardSys ? hazardFlight(HAZARD_RULES, this.hazardSys, d, x, y) : undefined);
  /** Where the next jump is aimed: distance, and what it locked on to */
  private jumpAimInfo: { dist: number; label: string | null } = { dist: 0, label: null };
  private dockHint: HTMLDivElement;
  private planetHint: string | null = null;
  private planetVerb = 'Descend to';

  /** The planet below you that you could land on (null: none); `verb`: what X does there ("Enter" a pocket's way in) */
  setPlanetHint(name: string | null, verb = 'Descend to'): void {
    this.planetHint = name;
    this.planetVerb = verb;
  }
  private repairHint: HTMLDivElement;
  /** A dock request is waiting for the server's answer */
  private dockPending = false;
  private docked = false;
  /** The station we're berthed in, and where we came in (relative to it) */
  private berth: { station: number; ox: number; oy: number } | null = null;
  private jumpFx: JumpFx | null = null;
  /** This system's rock (a surface's terrain), or null */
  private terrain: Terrain | null = null;
  /** Bosses' warnings and beams */
  private bossFx: BossFx | null = null;
  private damageFx: DamageFx | null = null;
  private beamFx: MiningBeamFx | null = null;
  private scannerFx: ScannerFx | null = null;
  private zoom: () => number = () => 1;
  private jump: JumpTuning;
  /** J was pressed: the jump control stays on until the burn starts (or J again cancels) */
  private jumpLatched = false;
  private lastFrame = 0;
  /** The local jump charge sound, so an abort can cut it */
  private chargeSound: (() => void) | null = null;

  /** The ammunition your guns of a kind fire next (the crate the server will open: launch.ts chooseCrate) */
  ownAmmo?: (kind: string) => WeaponMods | undefined;

  constructor(private opts: ShipClientOptions) {
    this.store = new ShipStore(opts.catalog, opts.tuning);
    this.jump = jumpTuning(opts.tuning);
    this.dockHint = document.createElement('div');
    this.dockHint.style.cssText = `position: fixed; left: 50%; bottom: 152px; transform: translateX(-50%); display: none;
      padding: 7px 16px; border-radius: 999px; background: rgba(8, 16, 30, 0.85); border: 1px solid rgba(125, 211, 252, 0.6);
      color: #cfe9ff; font: 14px 'Segoe UI', system-ui, sans-serif; letter-spacing: 0.5px; pointer-events: none; z-index: 900;`;
    document.body.appendChild(this.dockHint);
    this.repairHint = document.createElement('div');
    this.repairHint.style.cssText = this.dockHint.style.cssText;
    this.repairHint.style.bottom = '196px';
    this.repairHint.style.borderColor = 'rgba(143, 246, 255, 0.55)';
    this.repairHint.style.color = '#9ffcff';
    this.repairHint.style.display = 'none';
    document.body.appendChild(this.repairHint);
    this.hud = new ShipHud(this.store, () => opts.state.playerId, () => this.helm);
    this.hangar = new Lazy(() => import('./HangarUI').then(({ HangarUI }) => new HangarUI({
      catalog: opts.catalog,
      tuning: opts.tuning,
      econ: opts.pilot.econ,
      owned: (slot) => {
        // Storage and the hold's modules (a refit takes those too), plus that slot's built parts (ghosts aren't built yet)
        const bag = opts.pilot.storedParts();
        for (const s of opts.pilot.cargo) if (opts.pilot.econ.items.get(s.id)?.category === 'part') bag[s.id] = (bag[s.id] ?? 0) + s.n;
        const rec = opts.pilot.hangar?.slots[slot];
        const parts = rec?.blueprint.parts ?? (slot === (opts.pilot.hangar?.active ?? 0) ? this.store.get(opts.state.playerId)?.blueprint.parts ?? [] : []);
        const ghosts = new Set(rec?.ghosts ?? []);
        for (const p of parts) {
          if (ghosts.has(p.uid)) continue;
          const id = partItemId(p);
          bag[id] = (bag[id] ?? 0) + 1;
        }
        return bag;
      },
      hangarState: () => opts.pilot.hangar,
      canMake: (id) => opts.pilot.canMake(id),
      level: () => opts.pilot.profile?.level ?? 1,
      have: (id) => opts.pilot.count(id),
      stored: (id) => opts.pilot.storage.reduce((t, x) => t + (x.id === id ? x.n : 0), 0),
      coming: () => opts.pilot.coming(),
      send: (m) => opts.send(m),
      knownPlans: () => opts.pilot.profile?.plans ?? ['sparrow-t'],
      sharedDesigns: () => this.shared,
      grantAll: opts.grantAllParts ?? false,
      getBlueprint: () => this.store.get(opts.state.playerId)?.blueprint ?? this.lastBlueprint ?? { name: 'New ship', catalogVersion: opts.catalog.version, parts: [] },
      liveShip: () => this.store.get(opts.state.playerId),
      onOpen: () => opts.onHangarOpen?.(),
      // (refreshes as the server reports saves, fitted parts and finished jobs)
      onClose: (launch) => {
        if (launch) opts.send({ type: 'shipEdit', blueprint: launch });
        if (opts.stationOpen?.()) opts.onHangarBackToStation?.();
        else this.undock();
        opts.onHangarClose?.();
      },
    })));
    opts.pilot.onChange(() => this.hangar.value?.onHangarUpdate());
    this.store.onMissing = (id) => opts.send({ type: 'shipNeed', id });
    this.replicas = new ShipReplicaSet(opts.tuning, (id) => this.store.get(id)?.derived, () => ({ gravity: this.gravity, central: this.central, lodestones: this.lodestones, hazard: this.hazardFor, terrain: this.terrain }),
      (station) => {
        const e = opts.state.entities.get(station);
        return e ? { x: e.renderX, y: e.renderY } : null;
      });
  }

  /** Designs party members sent (newest first, a few kept) */
  readonly shared: { from: string; blueprint: Blueprint }[] = [];

  addSharedDesign(from: string, blueprint: Blueprint): void {
    this.shared.unshift({ from, blueprint });
    if (this.shared.length > 8) this.shared.pop();
  }

  /** Every other ship's motion, replayed from keyframes and control changes (see common/src/network/replication.ts) */
  readonly replicas: ShipReplicaSet;
  /** Fire-event shells' firing poses (WeaponFx asks once, when it first sees the shell) */
  private firePoses = new Map<number, { x: number; y: number; angle: number }>();

  /**
   * A snapshot arriving, before anything else: its keyframes and control
   * changes, then its fire events as shells (built from the firing ship's
   * replicated pose and its blueprint: common/src/ships/launch.ts)
   */
  preSnapshot(m: ServerSnapshotMessage): EntityState[] {
    this.replicas.apply(m.tick, m.ships, m.ctl);
    const out: EntityState[] = [];
    for (const [owner, ago, partAmmo, aimQ, ...ids] of m.fire ?? []) {
      const tick = m.tick - ago, part = partAmmo % 256, ammo = Math.floor(partAmmo / 256);
      const ship = this.store.get(owner);
      const st = this.replicas.at(owner, tick);
      if (!ship || !st) continue;
      // A pulse laser's pulse (a fire event with no shells): drawn from the tick it started
      const gun = ship.derived.weapons.find((w) => w.part === part);
      if (gun && this.opts.tuning.weapons?.[gun.kind]?.pulse) { this.beamFx?.startPulse(owner, part, tick); continue; }
      const v = rebuildVolley({ owner, tick, part, aimQ, ids, ammo }, ship, st.body, this.opts.tuning);
      if (!v) continue;
      // The ship's pose as it fired: the muzzle flash sits on the barrel in its frame
      for (const id of ids) this.firePoses.set(id, { x: st.body.x, y: st.body.y, angle: st.body.angle });
      while (this.firePoses.size > 512) this.firePoses.delete(this.firePoses.keys().next().value!);
      // A pilot's shots move on the tick they're fired (they're fired before shells move; pilotless ships' after)
      const spawnTick = this.opts.state.entities.get(owner)?.type === EntityType.Player ? tick - 1 : tick;
      // (Its gun's grade, as the server's shells carry it: each mark's shells look their own way)
      const grade = ship.derived.weapons.find((w) => w.part === part)?.grade ?? 1;
      for (const s of v.shells) {
        const age = m.tick - spawnTick;
        out.push({
          id: s.id, type: EntityType.Projectile, x: s.x + s.vx * age, y: s.y + s.vy * age, vx: s.vx, vy: s.vy,
          data: [WEAPON_KIND_TYPE[v.kind] ?? 1, grade, (owner * 137) % 360, spawnTick, s.x, s.y, owner, s.size, v.turret ? 1 : 0],
        });
      }
    }
    return out;
  }

  /**
   * A ship body's core and hull % (its status data [5] and [7], which the HUD,
   * health bars and boss bar read) come from its part HP, which we have, rather
   * than over the wire again.
   */
  private fillHull(id: number): void {
    const e = this.opts.state.entities.get(id);
    const ship = this.store.get(id);
    if (!e || !ship || e.type !== EntityType.ShipBody || !e.data || e.data.length < 8) return;
    const core = coreHp(ship);
    let hp = 0, max = 0;
    ship.maxHp.forEach((m, i) => { max += m; if (!ship.detached[i]) hp += Math.max(0, ship.hp[i]); });
    e.data[5] = Math.round((core.max > 0 ? core.hp / core.max : 0) * 100);
    // (a boss in stages: each stage its share of the bar, as its phases reckon it)
    const staged = stagedIntegrity(this.store.catalog, ship);
    e.data[7] = Math.round((staged ?? (max > 0 ? hp / max : 0)) * 100);
  }

  /** After a snapshot: ships that are gone (and new status rows get their hull %) */
  onReplication(m: ServerSnapshotMessage): void {
    for (const s of m.entities) if (s.type === EntityType.ShipBody) this.fillHull(s.id);
    for (const id of m.removed) this.replicas.remove(id);
    for (const id of m.out ?? []) this.replicas.remove(id);
  }

  /** Place a replicated ship for this frame (false: not one, or not ready yet) */
  placeReplica(e: InterpolatedEntity, renderTick: number): boolean {
    const p = this.replicas.pose(e.id, renderTick);
    if (!p) return false;
    // A keyframe correcting a small drift is eased in; anything big (a teleport, a fresh ship) snaps
    const jumpBy = Math.hypot(p.x - e.renderX, p.y - e.renderY);
    const ease = jumpBy > 4 && jumpBy < 400 && !this.burning(e) ? 0.35 : 1;
    e.x = p.x; e.y = p.y; e.angle = p.angle; e.vx = p.vx; e.vy = p.vy;
    e.renderX += (p.x - e.renderX) * ease;
    e.renderY += (p.y - e.renderY) * ease;
    e.renderAngle = p.angle;
    e.angVel = 0;
    if (e.type === EntityType.Player) {
      // Rebuild the per-pilot data the effects read (see the server's player snapshot row)
      const s = e.status ?? [];
      e.data = [
        packCursorWeaponState(p.aim, (s[4] ?? 10) / 10, s[5] === 1, s[6] === 1),
        0, (s[7] ?? 0) * 100, p.jump, s[0] ?? 0, s[1] ?? 0, s[2] ?? 0, s[3] ?? 0, Math.round(p.jumpScale * 1000), 0,
      ];
    }
    return true;
  }

  private burning(e: InterpolatedEntity): boolean {
    return jumpPhase(JumpFx.counter(e, false), this.jump).phase === 'burn';
  }

  init(app: Application, renderer: Renderer): void {
    void app;
    this.scene = renderer;
    this.renderer = new ShipRenderer(this.store, renderer, this.opts.state, (id) =>
      id === this.opts.state.playerId ? this.localThrustCommand() : null,
    // Docked ships are inside their station: yours while you're berthed, others as the server says
    (id) => (id === this.opts.state.playerId ? this.docked : this.replicas.isDocked(id)));
    renderer.onMuzzle = (owner, x, y) => this.renderer?.kick(owner, x, y);
    // Muzzle flashes (and the shells' first stretch) from the drawn barrel's tip, not the facing edge they spawn at
    renderer.barrelTip = (owner, x, y, angle) => this.renderer?.barrelTip(owner, x, y, angle) ?? null;
    renderer.lodestoneGlow = (id) => this.lodestoneGlow(id);
    renderer.firePoseOf = (id) => { const p = this.firePoses.get(id); this.firePoses.delete(id); return p; };
    renderer.lighting.addSource((L) => this.damageFx?.collectLights(L));
    this.jumpFx = new JumpFx(renderer.getShipLayer(), this.store, this.opts.state, this.jump);
    this.beamFx = new MiningBeamFx(renderer.getEffectLayer(), this.store, this.opts.state, this.opts.tuning, () => {
      const aim = this.opts.localAim();
      const ship = this.store.get(this.opts.state.playerId);
      return { firing: !!this.opts.miningHeld?.() && !!ship?.derived.miners.length && !this.hangarOpen, aim: aim.angle, dist: aim.dist };
    });
    // A pulse laser's pulse: its charge whine, the crack at its peak and its fading tail (pitched by its grade)
    this.beamFx.onPulse = (x, y, grade, own) => { this.opts.sound?.('laser_pulse', own ? undefined : { x, y }, own ? 0.42 : 0.7, PULSE_GRADE_PITCH[Math.max(0, Math.min(4, grade - 1))]); };
    // A mining laser's pulse: a deep, soft throb, one a ship however many miners it has
    this.beamFx.onMiningPulse = (x, y, own) => { this.opts.sound?.('mining_pulse', own ? undefined : { x, y }, own ? 0.5 : 0.6); };
    this.scannerFx = new ScannerFx(renderer.getEffectLayer(), this.store, this.opts.state, this.opts.pilot.econ);
    this.zoom = () => renderer.getZoom();
    this.damageFx = new DamageFx(renderer.getEffectLayer(), this.store, this.opts.state,
      (id, at, volume) => { this.opts.sound?.(id, at, volume); }, this.opts.tuning.repair?.range ?? 0);
    this.bossFx = new BossFx(renderer.getEffectLayer(), this.opts.state, (id, at, volume, pitch) => this.opts.sound?.(id, at, volume, pitch) ?? null);
    // What glows gets bloom
    for (const c of [...this.renderer.glowLayers(), this.damageFx.glowLayer, this.beamFx.glowLayer, this.bossFx.glowLayer]) renderer.addBloomSource(c);
    this.jumpFx.onPhase = (id, prev, next, x, y) => {
      const local = id === this.opts.state.playerId;
      const at = local ? undefined : { x, y };
      if (next === 'charging' && prev === 'ready') {
        const stop = this.opts.sound?.('jump_charge', at) ?? null;
        if (local) this.chargeSound = stop;
      } else if (prev === 'charging' && next === 'ready') {
        if (local) { this.chargeSound?.(); this.chargeSound = null; }
      } else if (next === 'burn') {
        if (local) this.chargeSound = null;
        this.opts.sound?.('jump_launch', at);
      } else if (prev === 'burn') {
        this.opts.sound?.('jump_arrive', at);
      } else if (local && prev === 'cooldown' && next === 'ready') {
        this.opts.sound?.('jump_ready', undefined, 0.8);
      }
    };
  }

  /** The local ship's jump drive phase (ready when there's no ship) */
  localJump(): ReturnType<typeof jumpPhase> {
    const me = this.opts.state.entities.get(this.opts.state.playerId);
    const ship = me && this.store.get(me.id);
    return jumpPhase(me ? JumpFx.counter(me, true) : 0, ship?.derived.jumpCooldown ? { ...this.jump, cooldownTicks: ship.derived.jumpCooldown } : this.jump);
  }

  /** Jump range multiplier at a point (a star's charging ring), for a drive with `primed` ticks of a stillstone's priming (jumpFields.ts stepPrime) */
  jumpBoostAt(x: number, y: number, primed = 0): number {
    return fieldRangeBoost(inSolarRing(x, y, this.central, this.jump), primed, this.jump);
  }

  /** How far the local ship's drive reaches here */
  jumpReach(): number {
    const me = this.opts.state.entities.get(this.opts.state.playerId);
    const ship = me && this.store.get(me.id);
    if (!me || !ship) return 0;
    return jumpRange(ship.derived, this.jump, this.jumpBoostAt(me.x, me.y, me.jumpPrime ?? 0));
  }

  /** The charging fields the local ship is in now, and how long its drive stays primed (ticks) */
  localField(): JumpField & { prime: number } {
    const me = this.opts.state.entities.get(this.opts.state.playerId);
    if (!me) return { ring: false, lodestone: null, prime: 0 };
    const f = jumpFieldAt(me.renderX, me.renderY, { central: this.central, lodestones: this.lodestones }, this.opts.state.getRawServerTick(), this.jump);
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
    return lodestonePosition(l, this.opts.state.getRawServerTick());
  }

  /** The local ship's forward acceleration (world units / tick²), for the autopilot */
  /**
   * Your guns, one predicted tick (GameState.applyPhysics, after the ship's
   * step; never on a replay): the same gun step as the server's (guns.ts), so
   * shells leave your barrels on the tick the server fires them, with the same
   * spread. They're drawn at once; the server's copies take them over.
   */
  predictGuns(player: InterpolatedEntity, input: ClientInputMessage, tick: number, charge: Charge): Charge | null {
    const ship = this.store.get(player.id);
    if (!ship || ship.kind !== 'ship' || this.docked || !this.scene) return null;
    // (No firing mid-jump, nor knocked out by an EMP: ShipBridge.stepWeapons)
    const burning = jumpPhase(player.jump ?? 0, this.jump).phase === 'burn' || tick < (player.empUntil ?? 0);
    const hasMiners = ship.derived.miners.length > 0;
    const firing = (input.fireLeft || (input.fireRight && !hasMiners)) && !burning;
    const pose = { x: player.x, y: player.y, angle: player.angle };
    // Each shot spends stored energy, then the mining lasers pay for their segment, as on the server (energy.ts)
    const energy = { charge };
    // (Cold guns recycle slower, from the warmth the server tells: warmth.ts)
    const slow = warmthStage(player.warmth ?? 100).guns;
    const { shots, pulses } = stepGuns(ship, pose, { firing, aimWorld: input.targetAngle, aimDist: input.cursorDist ?? 0, energy, slow }, tick, this.opts.tuning);
    for (const { w } of pulses) this.beamFx?.startPulse(player.id, w.part, tick);
    if (burning) ship.mineUntil = 0;
    payMining(ship, !!input.fireRight && hasMiners && !burning, tick, energy);
    for (const { w, shot } of shots) {
      // (Homing missiles change course: those the server sends as they fly)
      if (!firesStraight(partWeaponDef(this.opts.tuning, w.kind, ship.blueprint.parts[w.part], w))) continue;
      // A pilot's shells move on the tick they're fired (as in preSnapshot)
      for (const s of volleyShells(player.id, ship, w, shot, { ...pose, vx: player.vx, vy: player.vy }, tick, this.opts.tuning, this.ownAmmo?.(w.kind))) {
        this.scene.predictShot({ owner: player.id, type: WEAPON_KIND_TYPE[w.kind] ?? 1, grade: w.grade, spawnX: s.x, spawnY: s.y, spawnTick: tick - 1, vx: s.vx, vy: s.vy, size: s.size, pose });
      }
    }
    return energy.charge;
  }

  /** The ship you fly (null between ships) */
  myShip(): ShipState | null {
    const ship = this.store.get(this.opts.state.playerId);
    return ship && ship.kind === 'ship' ? ship : null;
  }

  /** Your ship's rating as it stands (ships/rating.ts): worked out again when its parts change */
  private ratingCache: { ship: unknown; derived: unknown; rating: number } | null = null;
  myRating(): number {
    const ship = this.store.get(this.opts.state.playerId);
    if (!ship || ship.kind !== 'ship') return 0;
    if (this.ratingCache?.ship === ship && this.ratingCache.derived === ship.derived) return this.ratingCache.rating;
    const rating = rateShip(this.opts.catalog, this.opts.tuning, ship).rating;
    this.ratingCache = { ship, derived: ship.derived, rating };
    return rating;
  }

  localAccel(): number {
    const ship = this.store.get(this.opts.state.playerId);
    if (!ship || ship.kind !== 'ship' || ship.derived.mass <= 0) return 0;
    return accelAlong(ship.derived, [0, -1]);
  }

  /** How much harder the local ship's engines push boosting (×) */
  localBoostFactor(): number {
    const ship = this.store.get(this.opts.state.playerId);
    return ship && ship.kind === 'ship' ? ship.derived.boostFactor ?? 2.2 : 1;
  }

  /**
   * What's wrong with where the jump would drop you, if anything: into a
   * star's (or a black hole's) hazard, or among hostiles that aren't calm.
   */
  jumpDanger(): string | null {
    const me = this.opts.state.entities.get(this.opts.state.playerId);
    const reach = this.jumpReach();
    if (!me || !reach) return null;
    const d = Math.max(this.jump.minRange, Math.min(reach, this.jumpAimInfo.dist || reach));
    const x = me.renderX + Math.cos(me.renderAngle) * d, y = me.renderY + Math.sin(me.renderAngle) * d;
    const body = this.central?.radius ?? 0;
    if (body > 0 && this.central?.type !== 'none' && Math.hypot(x, y) < body + (this.central?.type === 'black_hole' ? 2500 : 1500)) {
      return this.central?.type === 'black_hole' ? 'That drops you into the black hole\'s pull' : 'That drops you into the star\'s heat';
    }
    let foes = 0;
    for (const e of this.opts.state.entities.values()) {
      if (e.type !== EntityType.ShipBody || e.data?.[0] !== 3 || e.data?.[9] === 1) continue;
      if (Math.hypot(e.renderX - x, e.renderY - y) < 3000) foes++;
    }
    return foes ? `Hostiles where you'd land (${foes})` : null;
  }

  /** Is the pilot lining up a jump (key held, latched or spooling)? */
  jumpAiming(): boolean {
    const ph = this.localJump().phase;
    return ph === 'charging' || (ph === 'ready' && (this.jumpLatched || this.opts.isKeyDown('KeyJ')));
  }

  /** Where the jump is aimed (Game sets it from the cursor, snapped to a destination) */
  setJumpAim(dist: number, label: string | null): void {
    this.jumpAimInfo = { dist, label };
  }

  /** Is the jump control on this tick? (J latches it; it releases once the burn starts.) */
  jumpHeld(): boolean {
    // Hold mode: the key itself is the control (let go while spooling to abort)
    if (settings.data.gameplay.jumpMode === 'hold') return !this.hangarOpen && this.opts.isKeyDown('KeyJ');
    if (this.jumpLatched) {
      const ph = this.localJump().phase;
      if (ph === 'burn' || ph === 'cooldown' || this.hangarOpen) this.jumpLatched = false;
    }
    return this.jumpLatched;
  }

  /** What the local pilot's keys ask the engines for (ship grid frame), for the thruster effects */
  private localThrustCommand(): ThrustCommand {
    const me = this.opts.state.entities.get(this.opts.state.playerId);
    const idle: ThrustCommand = { dir: [0, 0], turn: 0, boost: false };
    if (!me || this.hangarOpen || !(this.opts.inputEnabled?.() ?? true)) return idle;
    if (this.localJump().phase !== 'ready' && this.localJump().phase !== 'cooldown') return idle; // the drive has the engines
    const k = (...codes: string[]) => (codes.some((c) => this.opts.isKeyDown(c)) ? 1 : 0);
    const fwd = k('KeyW', 'ArrowUp'), back = k('KeyS', 'ArrowDown'), left = k('KeyA', 'ArrowLeft'), right = k('KeyD', 'ArrowRight');
    const boost = k('ShiftLeft', 'ShiftRight') === 1;
    let dir: [number, number], turn: number;
    if (this.helm) {
      dir = [k('KeyE') - k('KeyQ'), back - fwd];
      turn = right - left;
    } else {
      // Screen-relative keys, turned into the ship's frame; turning follows the spin
      dir = worldToLocalDir([right - left, back - fwd], me.renderAngle) as [number, number];
      turn = Math.max(-1, Math.min(1, (me.angVel ?? 0) / 0.05));
    }
    const m = Math.hypot(dir[0], dir[1]);
    if (m > 1) dir = [dir[0] / m, dir[1] / m];
    return { dir, turn, boost: boost && m > 0 };
  }

  /** Controls from settings: mouse-aim unless the pilot picked helm (on load, and when that setting changes) */
  applyControlMode(): void {
    const mode = settings.data.gameplay.controlMode;
    if (mode === this.appliedMode) return;
    this.appliedMode = mode;
    this.helm = mode === 'helm';
  }

  /** In a game or not (the ship schematic only shows in one) */
  setInGame(on: boolean): void {
    this.hud.setInGame(on);
  }

  /** Settings: ship schematic shown, and the jump drive's full-screen effects */
  setDisplay(opts: { hud: boolean; jumpScreenEffects: boolean }): void {
    this.hud.setVisible(opts.hud);
    if (this.jumpFx) this.jumpFx.screenEffects = opts.jumpScreenEffects;
  }

  /** The menu's ship readout */
  menuShipInfo(): MenuShipInfo | null {
    const ship = this.store.get(this.opts.state.playerId);
    if (!ship || ship.kind !== 'ship') return null;
    const d = ship.derived;
    const accel = d.mass > 0 ? accelAlong(d, [0, -1]) : 0;
    const core = coreHp(ship);
    const ph = this.localJump();
    return {
      name: ship.blueprint.name,
      parts: ship.blueprint.parts.length,
      mass: d.mass,
      accel,
      topSpeed: (accel * FRICTION) / (1 - FRICTION),
      turn: d.inertia > 0 ? Math.min(turnAccel(d).cw, turnAccel(d).ccw) : 0,
      radius: d.radius,
      coreHp: core.hp,
      coreMax: core.max,
      guns: d.weapons.length,
      turrets: d.weapons.filter((w) => w.mount === 'turret').length,
      engines: d.thrusters.length,
      power: { supply: d.networks.reduce((a, n) => a + n.supply, 0), demand: d.networks.reduce((a, n) => a + n.demand, 0) },
      controls: this.helm ? 'helm' : 'mouse-steer',
      jump: {
        phase: ph.phase, progress: ph.progress,
        // (The ship's own cooldown and reach: jump coils change both)
        cooldownSecs: ph.phase === 'cooldown' ? Math.ceil(((1 - ph.progress) * (d.jumpCooldown || this.jump.cooldownTicks)) / 60) : 0,
        distance: this.jumpReach(),
      },
    };
  }

  /** Name of the station whose docking ring we're in (for the menu) */
  dockableStationName(): string | null {
    if (this.opts.editAnywhere) return 'Hangar';
    return this.stationInRange()?.name ?? null;
  }

  /** Mid-jump: the camera follows tightly and pulls back a little */
  localBurning(): boolean {
    return this.localJump().phase === 'burn';
  }

  get hangarOpen(): boolean {
    return this.hangar.value?.isOpen ?? false;
  }

  helmMode(): boolean {
    return this.helm;
  }

  /** Returns true when the message was a ship message. */
  handleMessage(msg: ServerMessage): boolean {
    switch (msg.type) {
      case 'shipSync':
        for (const part of this.store.onSync(msg)) this.damageFx?.onPartRestored(msg.id, part);
        this.fillHull(msg.id);
        return true;
      case 'partDestroyed':
        this.damageFx?.onPartDestroyed(msg);
        return true;
      case 'contact':
        this.damageFx?.onContact(msg);
        return true;
      case 'detonation':
        this.damageFx?.onDetonation(msg.kind, msg.x, msg.y, msg.radius, msg.from);
        return true;
      case 'stationFire':
        const shot = this.scene?.stationFire(msg.station, msg.turret ?? 0, msg.target);
        // (A laser turret's shot is a pulse, as a pulse laser's: MiningBeamFx)
        if (shot?.weapon === 'laser' && this.beamFx) this.beamFx.stationPulse(shot.x, shot.y, msg.target, msg.station);
        else if (shot) this.damageFx?.onStationFire(shot, msg.target);
        return true;
      case 'ignite':
        this.damageFx?.onIgnite(msg.bodyId, msg.part, msg.ticks);
        return true;
      case 'bossCharge':
        this.damageFx?.onBossCharge(msg.bodyId, msg.kind, msg.ticks);
        return true;
      case 'bossTelegraph':
        this.bossFx?.onTelegraph(msg);
        return true;
      case 'bossPhase':
        // Its second stage: the frame under its plates glows white-hot
        this.renderer?.setHeat(msg.bodyId, msg.phase >= 2 ? 1 : 0);
        return false; // the game shows its line too
      case 'bossBeam':
        this.bossFx?.onBeam(msg);
        return true;
      case 'bossBlow':
        this.renderer?.blow(msg.bodyId, msg.part);
        return true;
      case 'bossDefeated':
        this.damageFx?.onBossDefeated(msg.x, msg.y);
        return false; // the game shows the card too
      case 'damage':
        this.renderer?.hit(msg.targetId, msg.amount);
        return false; // the game shows the number and the HUD's indicator
      case 'projectileHit':
        this.damageFx?.shieldHit(msg.x, msg.y);
        return false; // the game stops the tracer and throws the sparks
      case 'scanPulse':
        this.scannerFx?.pulse(msg.seconds);
        this.opts.sound?.('scan_ping');
        return true;
      case 'shipHp':
        this.store.onHp(msg);
        this.fillHull(msg.id);
        return true;
      case 'shipHps':
        this.store.onHps(msg);
        for (const [id] of msg.ships) this.fillHull(id);
        return true;
      case 'systemInfo':
        this.gravity = msg.centralBody.gravity ?? null;
        this.central = msg.centralBody;
        // A surface's rock (pushed out of it in prediction, as the server does)
        this.terrain = terrainFor(msg.systemId);
        this.lodestones = msg.lodestones ?? [];
        this.hazardSys = msg.hazardRatings ? { hazardRatings: msg.hazardRatings, starRadius: msg.hazardRadius, centralBody: { type: msg.centralBody.type } } : null;
        return false; // the game also handles it
      case 'dockResult':
        this.dockPending = false;
        if (msg.ok) {
          this.docked = !this.opts.editAnywhere;
          // Inside the station: held at its centre (the server puts you back where you came in when you leave)
          const st = this.stationInRange(), me = this.opts.state.entities.get(this.opts.state.playerId);
          this.berth = this.docked && st && me ? { station: st.id, ox: me.x - st.x, oy: me.y - st.y } : null;
          if (this.docked) this.opts.showMessage(`Docked at ${msg.station}`, '#7dd3fc');
          this.opts.sound?.(this.docked ? 'dock' : 'ui_open');
          if (this.opts.onDocked && this.docked) this.opts.onDocked(msg.station ?? 'Station');
          else this.hangar.use((h) => h.open());
        } else {
          this.opts.showMessage(`Can't dock: ${msg.error ?? 'refused'}`, '#f2d24b');
          this.opts.sound?.('error');
        }
        return true;
      case 'shipEditResult':
        if (msg.ok) this.opts.showMessage('Design saved', '#4ade80');
        else {
          this.opts.showMessage(`Not saved: ${msg.errors.join('; ')}`, '#f87171');
          this.opts.toast?.(`Not saved: ${msg.errors[0]}`, 'bad');
        }
        this.opts.sound?.(msg.ok ? 'level_up' : 'error');
        return true;
      case 'snapshot':
        for (const id of msg.removed) this.store.remove(id);
        return false;
    }
    return false;
  }

  /** Your mining beam is on (for its sound) */
  get mining(): boolean {
    return this.beamFx?.localActive ?? false;
  }

  /** Your own beam weapon firing now (from the server's flag): 'laser', 'lance' or null */
  weaponBeamKind(): string | null {
    const e = this.opts.state.entities.get(this.opts.state.playerId);
    const ship = this.store.get(this.opts.state.playerId);
    if (!e?.data?.length || !ship || !unpackCursorWeaponState(e.data[0]).leftActive) return null;
    const defs = this.opts.tuning.weapons ?? {};
    // (Pulse lasers have their own sound, a pulse at a time)
    const beam = ship.derived.weapons.find((w) => defs[w.kind]?.type === 'beam' && !defs[w.kind]?.pulse);
    return beam?.kind ?? null;
  }

  /**
   * Your pulse lasers' charge, for the HUD: how far the least-charged one is
   * to its next pulse (0..1; its reload, as your client steps it: guns.ts),
   * and how many are ready. Null without any.
   */
  laserCharge(): { charge: number; ready: number; total: number } | null {
    const ship = this.store.get(this.opts.state.playerId);
    if (!ship || ship.kind !== 'ship') return null;
    const defs = this.opts.tuning.weapons ?? {};
    let charge = 1, ready = 0, total = 0;
    for (const w of ship.derived.weapons) {
      if (!defs[w.kind]?.pulse) continue;
      total++;
      const c = 1 - Math.max(0, ship.cooldown[w.part] ?? 0) / Math.max(1, w.interval);
      charge = Math.min(charge, c);
      if (c >= 1) ready++;
    }
    return total ? { charge, ready, total } : null;
  }

  /** Your repair kit started or finished (its glints) */
  setKitActive(on: boolean): void {
    const id = this.opts.state.playerId;
    if (on) this.damageFx?.kitShips.add(id); else this.damageFx?.kitShips.delete(id);
  }

  /** Open the hangar (from the station screen), on a slot or the ship you fly */
  openHangar(slot?: number): void {
    this.hangar.use((h) => h.open(slot));
  }

  /** Leave the berth (station screen closed) */
  undock(): void {
    if (!this.docked) return;
    this.opts.send({ type: 'undock' });
    this.docked = false;
    // Out where we came in
    const st = this.berth && this.opts.state.entities.get(this.berth.station), me = this.opts.state.entities.get(this.opts.state.playerId);
    if (st && me && this.berth) { me.x = st.x + this.berth.ox; me.y = st.y + this.berth.oy; me.vx = 0; me.vy = 0; }
    this.berth = null;
    // (Its hull drawn afresh, whatever was done to it in the hangar)
    this.renderer?.refresh(this.opts.state.playerId);
    this.opts.sound?.('undock');
  }

  onKey(code: string): boolean {
    if (this.hangarOpen) return this.hangar.value!.handleKey(code);
    if (code === 'KeyV') {
      this.helm = !this.helm;
      return true;
    }
    if (code === 'KeyJ') {
      const ph = this.localJump();
      const hold = settings.data.gameplay.jumpMode === 'hold';
      if (hold && ph.phase !== 'cooldown') return true;
      if (this.jumpLatched || ph.phase === 'charging') this.jumpLatched = false; // abort
      else if (ph.phase === 'ready') this.jumpLatched = !!this.store.get(this.opts.state.playerId);
      else if (ph.phase === 'cooldown') {
        const cool = this.store.get(this.opts.state.playerId)?.derived.jumpCooldown || this.jump.cooldownTicks;
        const secs = Math.ceil(((1 - ph.progress) * cool) / 60 / (1 + fieldCharge(this.localField(), this.jump)));
        this.opts.showMessage(`Jump drive cooling down (${secs}s)`, '#9fd8ff');
      }
      return true;
    }
    if (code === 'KeyH') {
      if (this.opts.editAnywhere) this.hangar.use((h) => h.open());
      else if (this.dockPending) return true;
      else if (this.isDocked()) { this.dockPending = true; this.opts.send({ type: 'dock' }); }
      else this.opts.showMessage(`Fly into a station's docking ring and press ${boundKeyName('dock', settings.data.bindings)} to dock`, '#f2d24b');
      return true;
    }
    return false;
  }

  /** The station whose docking ring we're inside, if any. (The server checks again when we dock.) */
  stationInRange(): InterpolatedEntity | null {
    const me = this.opts.state.entities.get(this.opts.state.playerId);
    if (!me) return null;
    for (const e of this.opts.state.entities.values()) {
      if (e.type === EntityType.Station && Math.hypot(e.x - me.x, e.y - me.y) < stationInteractRadius(e.data?.[8] ?? 0, e.data?.[9] ?? 0)) return e;
    }
    return null;
  }

  isDocked(): boolean {
    return this.stationInRange() !== null;
  }

  /**
   * Client prediction for the local ship: the same shared physics the server
   * runs. Returns the new boost fuel, or null if there's no ship to predict.
   */
  predict(player: InterpolatedEntity, input: ClientInputMessage, charge: Charge, tick: number): Charge | null {
    const ship = this.store.get(player.id);
    if (!ship || ship.kind !== 'ship') return null;
    // Berthed: held at the station's centre, going nowhere
    const st = this.docked && this.berth ? this.opts.state.entities.get(this.berth.station) : undefined;
    if (st) {
      player.x = st.x; player.y = st.y; player.vx = 0; player.vy = 0; player.angVel = 0;
      return charge;
    }
    const body = { x: player.x, y: player.y, vx: player.vx, vy: player.vy, angle: player.angle, angVel: player.angVel ?? 0, jump: player.jump ?? 0, jumpScale: player.jumpScale };
    // Hit by an EMP (or frozen through): the drive crippled and no jump starting, exactly as the server has it (ShipBridge.stepMovement)
    const emp = tick < (player.empUntil ?? 0);
    // (and numb with cold, a sluggish drive: warmth.ts, from the warmth the server tells)
    const hazard = withNumb(this.hazardFor(ship.derived, player.x, player.y), warmthStage(player.warmth ?? 100));
    // Charging fields round the step, exactly as the server has them (ShipBridge.stepMovement): the range boost from
    // where it starts, then a faster cooldown and a lodestone's priming from where it ends
    let res!: ReturnType<typeof stepShipPhysics>;
    player.jumpPrime = pilotJumpStep(body, player.jumpPrime ?? 0, { central: this.central, lodestones: this.lodestones }, tick,
      ship.derived.jumpCooldown || this.jump.cooldownTicks, this.jump, (rangeBoost) => {
        res = stepShipPhysics(body, {
          forward: input.forward, backward: input.backward, left: input.left, right: input.right,
          boost: input.boost, targetAngle: input.targetAngle,
          helm: input.helm, strafeLeft: input.strafeLeft, strafeRight: input.strafeRight, jump: input.jump && !emp,
          jumpDist: input.cursorDist,
        }, ship.derived, this.opts.tuning, { charge, drainRate: 1 }, this.gravity, rangeBoost, emp ? withEmp(hazard) : hazard, this.terrain);
      });
    player.jumpScale = body.jumpScale;
    player.x = body.x;
    player.y = body.y;
    player.vx = body.vx;
    player.vy = body.vy;
    player.angle = body.angle;
    player.angVel = body.angVel;
    player.jump = body.jump;
    return res.charge;
  }

  /** All your ship's stored energy as one percentage (the HUD's gauge) */
  chargeTotal(charge: Charge): number {
    const ship = this.store.get(this.opts.state.playerId);
    return ship && ship.kind === 'ship' ? chargeTotal(ship.derived, charge) : charge.g;
  }

  /**
   * How hard the well is pulling compared with what the ship can push back:
   * 0 (no well / negligible) .. 1 (the pull matches full thrust or worse).
   */
  horizonDanger(): number {
    const g = this.gravity;
    const me = this.opts.state.entities.get(this.opts.state.playerId);
    const ship = me && this.store.get(me.id);
    if (!g || !me || !ship || ship.derived.mass <= 0) return 0;
    const pull = g.strength / Math.max(Math.hypot(me.x, me.y), g.minRadius) ** 2;
    const push = Math.max(ship.derived.maxThrust.forward, ship.derived.maneuverForce) / ship.derived.mass;
    return Math.min(1, pull / push);
  }

  /** What the jump gauge says about charging fields */
  private gaugeField(): { ring: boolean; lodestone: boolean; charge: number; primeSecs: number; boost: number; short: string } {
    const f = this.localField();
    return {
      ring: f.ring, lodestone: !!f.lodestone, charge: fieldCharge(f, this.jump), primeSecs: Math.ceil(Math.abs(f.prime) / 60),
      boost: primeBoost(f.prime, this.jump), short: this.jump.lodestoneShort,
    };
  }

  /** Once per frame, after interpolation. */
  update(now: number): void {
    const { state } = this.opts;
    this.store.prune((id) => state.entities.has(id), now);

    // (The last ship flown, for the hangar while its sync is away)
    const mine = this.store.get(state.playerId);
    if (mine && mine.blueprint !== this.lastBlueprint) this.lastBlueprint = mine.blueprint;

    // Turret visuals at tick rate (firing itself is decided by the server)
    const ticks = Math.min(4, Math.floor((now - this.lastTurretFrame) / (1000 / 60)));
    if (ticks > 0) {
      this.lastTurretFrame = now;
      for (let t = 0; t < ticks; t++) this.stepTurretVisuals();
    }

    this.renderer?.update();
    this.hud.update();
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    const me = state.entities.get(state.playerId);
    this.jumpFx?.update(dt, {
      hidden: this.hangarOpen || !this.store.get(state.playerId), latched: this.jumpLatched,
      aiming: this.jumpAiming(), aimDist: this.jumpAimInfo.dist, aimLabel: this.jumpAimInfo.label,
      reach: this.jumpReach(), field: me ? this.gaugeField() : undefined, danger: this.jumpAiming() ? this.jumpDanger() : null,
    });
    this.damageFx?.update(dt);
    this.beamFx?.update(dt);
    this.bossFx?.update(dt);
    this.scannerFx?.update(dt, this.zoom());
    this.updateRepairHint();

    // "Press H to dock" while inside a station's docking ring (not while docked: the station's screen is up);
    // in orbit close over a planet you can land on, "X to descend"
    const station = !this.opts.editAnywhere && !this.hangarOpen && !this.dockPending && !this.opts.stationOpen?.() ? this.stationInRange() : null;
    const planet = !station && !this.hangarOpen ? this.planetHint : null;
    setStyle(this.dockHint, 'display', station || planet ? 'block' : 'none');
    if (station) setHtml(this.dockHint, `<kbd>${boundKeyName('dock', settings.data.bindings)}</kbd> Dock at <b>${station.name ?? 'station'}</b>`);
    else if (planet) setHtml(this.dockHint, `<kbd>${boundKeyName('interact', settings.data.bindings)}</kbd> ${this.planetVerb} <b>${planet}</b>`);
  }

  /** "Repairing" while your ship is mending near a station: how far along, and parts still to regrow */
  private updateRepairHint(): void {
    const ship = this.store.get(this.opts.state.playerId);
    const me = this.opts.state.entities.get(this.opts.state.playerId);
    const range = this.opts.tuning.repair?.range ?? 0;
    let text = '';
    if (ship && me && range > 0 && ship.derived.root >= 0 && !this.hangarOpen) {
      let near = false;
      for (const e of this.opts.state.entities.values()) {
        if (e.type === EntityType.Station && Math.hypot(e.x - me.x, e.y - me.y) < (e.data?.[8] ?? 200) + range) { near = true; break; }
      }
      if (near) {
        let missing = 0, hp = 0, max = 0;
        for (let i = 0; i < ship.hp.length; i++) {
          max += ship.maxHp[i];
          if (ship.derived.alive[i]) hp += ship.hp[i];
          else missing++;
        }
        if (missing > 0 || hp < max - 1e-6) {
          text = `Station repair: <b>${Math.floor((100 * hp) / max)}%</b>${missing ? ` · ${missing} part${missing > 1 ? 's' : ''} to rebuild` : ''}`;
        }
      }
    }
    setStyle(this.repairHint, 'display', text ? 'block' : 'none');
    if (text) setHtml(this.repairHint, text);
  }

  private stepTurretVisuals(): void {
    const { state } = this.opts;
    for (const [id, ship] of this.store.bodies) {
      if (ship.kind !== 'ship' || !ship.derived.weapons.some((w) => w.window)) continue;
      const e = state.entities.get(id);
      if (!e) continue;
      let angle: number, dist: number;
      // Your own turrets aim on each predicted tick, as the server's do (predictGuns)
      if (id === state.playerId && state.predictionEnabled) continue;
      if (id === state.playerId) {
        ({ angle, dist } = this.opts.localAim());
      } else if (e.data && e.data.length >= 1) {
        angle = unpackCursorWeaponState(e.data[0]).aimAngle;
        dist = e.data[2] ?? 0;
      } else continue;
      const pose = { x: e.renderX, y: e.renderY, angle: e.renderAngle };
      const ax = pose.x + Math.cos(angle) * dist, ay = pose.y + Math.sin(angle) * dist;
      for (const w of ship.derived.weapons) {
        if (!w.window) continue;
        let worldAngle = angle;
        if (dist > 0) {
          const [px, py] = shipPointToWorld(ship, pose, w.window.pivot, this.opts.tuning.cellSize);
          worldAngle = Math.atan2(ay - py, ax - px);
        }
        ship.aim[w.part] = stepTurretAim(w.window, ship.aim[w.part], worldAngle - (pose.angle + Math.PI / 2), this.opts.tuning).offset;
      }
    }
  }
}
