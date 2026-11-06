/**
 * Everything the client does for modular ships, in live play and proto alike:
 * mirrors ship state from the server (ShipStore), draws ships (ShipRenderer),
 * the HUD schematic (ShipHud), the hangar (HangarUI, docked only), helm vs
 * mouse-steer controls, your own ship on its tick layer (the one stepper, own/OwnTick.ts), drawn ahead,
 * and turret visuals.
 *
 *   H  dock at a station in range and open the hangar (closing it undocks)
 *   V  switch controls: mouse-steer ↔ helm (A/D turn, W/S thrust, Q/E strafe)
 *   J  jump drive: spool up, then fly far and fast along the nose (J again aborts)
 */

import { endsAtAim, ensurePortsCharge, stepPointDefenceAim, stepFixedGunAim, SHOT_AIM_STEPS, pointDefenceOf, chargeGroupsEnd, TELL_CHARGE_START, TELL_CHARGE_CANCEL, TELL_BEAM_PIECE, TELL_MINE_PULSE, TELL_NONE, TELL_PD, type ServerGunSyncMessage, type ServerGunCtlMessage, type LaneRec, type ReplicaEnv } from '@space-game/common';
import { bossRise, clearBossLives } from './bossLife';
import { GunFeel } from './gunFeel';
import './energyLooks';
import { ChargeFx } from './ChargeFx';
import { RingModel, type RingGroup, type RingSources } from './gunHud';
import { cloneCharge, type SimShipState, type ServerOwnSyncMessage, type ServerPullsMessage } from '@space-game/common';
import { boostOf, stagedIntegrity, type Terrain, chargeTotal, hazardFlight, type WeaponInfo, type Charge, type ShipState, type WeaponMods, type ShipDerived, type HazardRules, type FlightBody } from '@space-game/common';
import hazardData from '../../../data/hazards.json';

const HAZARD_RULES = hazardData as unknown as HazardRules;
import { setHtml, setStyle } from '../ui/domWrite';
import type { Application } from 'pixi.js';
import {
  Blueprint, Catalog, ClientInputMessage, ClientMessage, EntityType, InventoryStub, ServerMessage, ShipTuning,
  stationInteractRadius, stepTurretAim, shipPointToWorld, unpackCursorWeaponState, GravityWell,
  JumpTuning, jumpPhase, jumpTuning, coreHp, FRICTION, worldToLocalDir, partItemId, inSolarRing, jumpReachAt, jumpLanding,
  jumpFieldAt, fieldRangeBoost, fieldCharge, primeBoost, lodestonePosition, type JumpField, type LodestoneData,
  ShipReplicaSet, ServerSnapshotMessage,
  packCursorWeaponState, rebuildVolley, WEAPON_KIND_TYPE, EntityState, accelAlong, turnAccel, rateShip, gunControls, GUN_FX, ammoCodeOfMods, fireVolley, type SimEvent, firesStraight, partWeaponDef,
  type ServerHitsMessage, type ServerHpCheckMessage, type ServerHitFixMessage, type HitReport, type OwnCheck, type BodyCheck, SIDE, ghostWeight, FOCUS_RANGE, EffectType, gunShell,
} from '@space-game/common';
import type { MenuShipInfo } from '../ui/GameMenuUI';
import type { GameState, InterpolatedEntity } from '../state/GameState';
import type { Renderer } from '../rendering/Renderer';
import { ShipStore } from './ShipStore';
import { ShipRenderer } from './ShipRenderer';
import { ShipHud } from './ShipHud';
import type { StatusInput, FeatureStatusLine } from '../ui/shipStatus/source';
import type { HangarUI } from './HangarUI';
import { Lazy } from '../lazy';
import { JumpFx } from './JumpFx';
import { terrainFor } from '../rendering/terrainData';
import { BossFx } from './BossFx';
import { DamageFx, PLAIN_HIT_LOOKS } from './DamageFx';
import { MiningBeamFx, type LitBeam } from './MiningBeamFx';
import { ScannerFx } from './ScannerFx';
import { IncomingWarning } from '../ui/IncomingWarning';
import type { ShellLook } from '../rendering/weapons/WeaponFx';
import { AUG } from '../rendering/weapons/weaponStyles';
import { strikeRolls } from '../rendering/weapons/MiningStrikeFx';
import { rockMaterial } from '../rendering/rocks/RockMaterials';
import { hitSurface } from './hitSurface';
import { DrawnWorld } from './drawnHit';
import { ConfirmedHits } from './hits/ConfirmedHits';
import { SelfHits, toldHits } from './hits/SelfHits';
import { OtherGuns } from './guns/OtherGuns';
import { OwnShells } from './hits/OwnShells';
import { OwnTick, type OwnTickEvents } from './own/OwnTick';
import type { OwnStepped } from '../state/GameState';
import { ShipCauses } from './causes/ShipCauses';
import { ContactWorld } from './causes/ContactWorld';
import { DebrisSplits } from './debris/DebrisSplits';
import { BodyRunner, type BodyRunnerHost } from './bodies/BodyRunner';
import { MoveRunner, type MoveRunnerHost, type TimedMoveMsg } from './bodies/MoveRunner';
import type { CustomStats } from '@space-game/common';
import factionsData from '../../../data/factions.json';
import { GuideRunner } from './guides/GuideRunner';
import type { PilotState } from '../econ/clientEcon';
import type { ThrustCommand } from './ThrusterFx';
import { settings } from '../settings/Settings';
import { boundKeyName } from '../input/keybindings';
import { ClientFeatures } from './features/host';
import { CLIENT_FEATURES } from './features/index';
import type { QualityProfile } from '../settings/quality';
import { ShipMemory } from './cells/ShipMemory';
import { GhostLayer, type Ghost } from './cells/GhostLayer';

/** A pulse laser's sound by its grade, Mk I-V: subtle, and centred low (the wide Mk IV deepest, the x-ray Mk V a touch brighter) */
const PULSE_GRADE_PITCH = [0.98, 0.94, 1.01, 0.9, 1.04];
/** A shell's weapon kind from its snapshot weapon type (WEAPON_KIND_TYPE turned round) */
const KIND_OF_TYPE = new Map(Object.entries(WEAPON_KIND_TYPE).map(([k, t]) => [t, k]));

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
  /** Mouse-steer's keys push along the ship (the view on the heading, CAPS.NOSE: common flight.ts noseFrame) */
  noseThrust?(): boolean;
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

/** The own layer's events handed out per tick (ShipClient.ownStepTo's scratch) */
const OWN_EVENTS: OwnTickEvents[] = [];
const CONFIRMED: OwnTickEvents[] = [];

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
  private jumpAimInfo: { dist: number; label: string | null; bearing?: number; sent?: number } = { dist: 0, label: null };
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
  /** Charge guns' tells (Longbarrel's sight line, Blackout's darkening) */
  private chargeFx: ChargeFx | null = null;
  /** Gun sounds that follow the firing models (charge whine, clip clack and vent, spin-up) */
  private gunFeel = new GunFeel((id, at, volume, pitch) => this.opts.sound?.(id, at, volume, pitch) ?? null);
  /** The weapon ring's data (own guns, predicted) */
  private ringModel = new RingModel();
  private readonly ringAmmo = { loose: 0, crates: 0 };
  private scannerFx: ScannerFx | null = null;
  private zoom: () => number = () => 1;
  private jump: JumpTuning;
  /** J was pressed: the jump control stays on until the burn starts (or J again cancels) */
  private jumpLatched = false;
  /** Part features' client side (ships/features/host.ts): keys, controls, pilot-row values, drawing and chips (the Tow Beam's, the Burst Strafer's) */
  private features: ClientFeatures;
  /** The Burst Strafer's dodge control (features/strafer: it latches and buffers a press) */
  private dodgeCtl: () => boolean;
  private lastFrame = 0;
  /** The local jump charge sound, so an abort can cut it */
  private chargeSound: (() => void) | null = null;

  /** The ammunition your guns of a kind fire next (the crate the server will open: launch.ts chooseCrate) */
  ownAmmo?: (kind: string) => WeaponMods | undefined;

  constructor(private opts: ShipClientOptions) {
    this.store = new ShipStore(opts.catalog, opts.tuning);
    this.debris = new DebrisSplits({ store: this.store, reps: () => this.replicas, splitPose: () => (id, t) => this.causes.beforeRebuild(id, t), crumbled: (m) => this.damageFx?.onPartDestroyed(m) });
    this.features = new ClientFeatures(CLIENT_FEATURES, {
      catalog: opts.catalog,
      playerId: () => opts.state.playerId,
      entity: (eid) => opts.state.entities.get(eid),
      ship: (eid) => this.store.get(eid),
      send: (msg) => opts.send(msg),
      showMessage: (text, color) => opts.showMessage(text, color),
      keyName: (id) => boundKeyName(id, settings.data.bindings),
      hangarOpen: () => this.hangarOpen,
      isKeyDown: (code) => opts.isKeyDown(code),
      inputEnabled: () => opts.inputEnabled?.() ?? true,
      helm: () => this.helm,
      charge: () => opts.state.charge,
    });
    this.dodgeCtl = this.features.controlFor('dodge');
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
    this.hud = new ShipHud(this.store, () => opts.state.playerId, () => this.helm, () => this.statusInput());
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
      learned: () => opts.pilot.profile?.recipes ?? [],
      have: (id) => opts.pilot.count(id),
      cargoMass: () => opts.pilot.econ.items.massOf(opts.pilot.cargo),
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
      },
      this.debris);
    this.hits = new ConfirmedHits({
      store: this.store,
      // (a shell from a gun: its row's data[10], or its fire event's part packing, preSnapshot)
      shell: (id) => {
        const e = opts.state.entities.get(id), d = e?.data;
        if (!e || e.type !== EntityType.Projectile || !d || !((d[10] ?? -1) >= 0)) return null;
        return { owner: d[6], gun: d[10], spawnTick: e.spawnTick ?? d[3], x: e.spawnX ?? d[4], y: e.spawnY ?? d[5], vx: e.vx, vy: e.vy };
      },
      pose: (id, tick) => {
        // (yours: as predicted for that tick, which is where the server had it while the prediction held)
        const st = id === opts.state.playerId ? opts.state.selfPoseAt(tick) : this.replicas.at(id, tick)?.body;
        if (st) return st;
        const e = opts.state.entities.get(id);
        return e ? { x: e.x, y: e.y, angle: e.angle } : null;
      },
      pilot: (id) => id === opts.state.playerId || opts.state.entities.get(id)?.type === EntityType.Player,
      send: (m) => opts.send(m),
      self: () => opts.state.playerId,
    });
    this.drawnWorld = new DrawnWorld(this.store, opts.state, (id) => this.sideOf(id));
    this.selfHits = new SelfHits({
      store: this.store,
      self: () => opts.state.playerId,
      ships: () => this.replicas.ids(),
      at: (id, tick) => this.replicas.at(id, tick)?.body ?? null,
      side: (id) => this.sideOf(id),
      passes: (shell) => this.hits.passesOf(shell),
      ownExact: () => this.own.on,
    });
    this.ownShells = new OwnShells({ self: () => opts.state.playerId, ship: (id) => { const s = this.store.get(id); return s && s.kind === 'ship' ? s : undefined; }, tuning: opts.tuning, firePose: (t) => this.own.firePose(t) });
    this.own = new OwnTick({ store: this.store, reps: this.replicas, self: () => opts.state.playerId, tuning: opts.tuning, extraHash: (t) => (this.causes.heldByte(t) ?? 0) + this.guides.byte(t),
      contacts: () => this.contacts, otherMid: (id, t, place) => this.causes.midOf(id, t, place) });
    this.bodies = new BodyRunner((this.bodyHost = { reps: this.replicas, radius: (id) => this.store.get(id)?.derived.radius }));
    // (Other ships' guns stepped here from their inputs: ships/guns/OtherGuns.ts)
    this.otherGuns = new OtherGuns({ reps: this.replicas, ship: (id) => { const s = this.store.get(id); return s && s.kind === 'ship' ? s : undefined; }, tuning: opts.tuning, self: () => opts.state.playerId });
    // (Their moves worked out here: ships/bodies/MoveRunner.ts)
    this.moves = new MoveRunner({
      reps: this.replicas, bodies: this.bodies, store: this.store, tuning: opts.tuning, terrain: () => this.terrain,
      custom: (factionsData as { custom?: { designs: Record<string, CustomStats> } }).custom,
    });
    // (Homing shells on the tick layer: ships/guides/GuideRunner.ts)
    this.guides = new GuideRunner({ reps: this.replicas });
    // (Other ships' causes on the tick layer: ships/causes/ShipCauses.ts)
    this.causes = new ShipCauses({ store: this.store, reps: this.replicas, self: () => opts.state.playerId, ownDerived: (t) => this.own.derived(t), ownMid: (t, o) => (this.own.on ? this.own.midOf(t, o) : null), tuning: opts.tuning, contacts: () => this.contacts });
    // (Contact pairs found on the tick layer: ships/causes/ContactWorld.ts)
    this.contacts = new ContactWorld({
      reps: this.replicas, store: this.store, self: () => opts.state.playerId, ownOn: () => this.own.on, tuning: opts.tuning,
      derivedAt: (id, t) => this.derivedAt(id, t),
      mid: (id, t, place) => (id === opts.state.playerId ? this.own.midAt(t, place) : this.causes.midOf(id, t, place)),
      forget: (t) => { this.causes.cursors.forget(t); this.own.cursors.forget(t); },
    });
    // (Ships out of view kept a while, structure and status row: ships/cells/ShipMemory.ts)
    this.away = new ShipMemory<InterpolatedEntity>({
      entity: (id) => opts.state.entities.get(id),
      // (Back as it was left: placed by its keyframe, which comes in the snapshot just after)
      restore: (id, e) => { e.hist = undefined; opts.state.entities.set(id, e); },
      send: (m) => opts.send(m),
    });
  }

  /** Ships out of view it keeps: back, the server sends only what changed */
  readonly away: ShipMemory<InterpolatedEntity>;
  /** The flight tuning (the PT layer's contact pass reads it: predict/world.ts) */
  get tuning(): ShipTuning { return this.opts.tuning; }
  /** The structure a ship flew tick t with (its own: OwnTick's; others: by tick where kept, else its current) */
  derivedAt(id: number, t: number): ShipDerived | null | undefined {
    return id === this.opts.state.playerId ? this.own.derived(t) : this.causes.derived(id, t) ?? this.store.get(id)?.derived;
  }
  /** Other ships' causes */
  private readonly causes: ShipCauses;
  private readonly contacts: ContactWorld;
  /** The ships the pairs it found itself touched in the last snapshot's window (their hits told) */
  private touched: Set<number> | undefined;
  private ghosts: GhostLayer | null = null;
  private ghostList: Ghost[] = [];
  private ghostOwn = { x: 0, y: 0 };
  /** The focus radius in effect (a crowd shrinks it: GameState.crowd): the ghost fade is its last km */
  private ghostFocus = FOCUS_RANGE;

  /** The focus grid's ghosts this frame: the ring's ships from their legs, and held ships 18 km off and more */
  private drawGhosts(): void {
    const { state } = this.opts, scene = this.scene;
    if (!this.ghosts || !scene) return;
    const list = this.ghostList;
    list.length = 0;
    for (const [id, e] of state.entities) {
      if (id === state.playerId || (e.type !== EntityType.Player && e.type !== EntityType.ShipBody) || !this.store.get(id)) continue;
      const w = ghostWeight(Math.hypot(e.renderX - this.ghostOwn.x, e.renderY - this.ghostOwn.y), this.ghostFocus);
      if (w > 0) list.push({ x: e.renderX, y: e.renderY, kind: e.type === EntityType.Player ? 4 : e.data?.[0] ?? 0, rank: e.type === EntityType.ShipBody ? (e.data?.[4] ?? 0) : 0, w });
    }
    for (const f of state.farShips.list(state.systemId, state.getRawServerTick(), (id) => state.entities.has(id) || id === state.playerId)) {
      list.push({ x: f.renderX, y: f.renderY, kind: f.kind, rank: f.rank, w: 1 });
    }
    this.ghosts.draw(list, scene.getZoom(), (x, y) => scene.inView(x, y, 400));
  }

  /** A ship's side, as this client knows it (hitRules SIDE bits: who may hurt whom) */
  private sideOf(id: number): number {
    const { state } = this.opts;
    const e = state.entities.get(id), d = e?.data;
    const pilot = id === state.playerId || e?.type === EntityType.Player;
    const side = !pilot && e?.type === EntityType.ShipBody && d ? d[10] : 0;
    return (pilot ? SIDE.PILOT : 0) | (side === 1 ? SIDE.WARD : 0) | (side === 2 ? SIDE.PERSON : 0) | (this.replicas.isDocked(id) ? SIDE.DOCKED : 0);
  }

  /** The world as drawn, for where a shell is seen to strike (ships/drawnHit.ts) */
  private readonly drawnWorld: DrawnWorld;

  /**
   * A shell's hit, where it's seen to strike (WeaponFx.onStruck), or where the server says for one not drawn here: a
   * raised shield's ripple and plating's sparks there, and the hit look a shell with no detonation of its own has; on
   * a rock (`target`, as drawn here), its mining strike or sparks, which the server no longer sends (GameServer.hurtAsteroid).
   * Every hit's sound is its drawn impact's (WeaponFx.impactAt -> audio/CombatSounds.ts)
   */
  private struckFx(id: number, x: number, y: number, type: number, target = -1): void {
    this.damageFx?.shieldHit(x, y, this.shellLooks.get(id)?.model);
    // (A shell with a look of its own that no detonation tells now: a Prism's shards, DamageFx PLAIN_HIT_LOOKS)
    const kind = KIND_OF_TYPE.get(type);
    if (kind && PLAIN_HIT_LOOKS.has(kind)) this.damageFx?.onDetonation(kind, x, y, 40);
    const rockAt = target >= 0 ? this.opts.state.entities.get(target) : undefined;
    if (rockAt?.type === EntityType.Asteroid) {
      // A hit that mines rolls for ore on the server (Mining.extract): a mining strike, rock dust and grit off the face
      // (nothing's sent for it, so it plays whatever the roll); one that can't mine there, a shell's plain sparks
      if (strikeRolls(kind, rockAt.composition?.hardness)) this.scene?.miningStrike(x, y, x - rockAt.renderX, y - rockAt.renderY, rockMaterial(rockAt.composition));
      else this.scene?.showEffect(EffectType.LaserHit, x, y, [this.shellDamage(id), 30]);
      // (its sound is the impact's, heard as WeaponFx draws it: audio/CombatSounds.ts)
    }
  }

  /** Is a raised shield's bubble at (x, y)? A shell's impact there is heard as shield_hit (audio/CombatSounds.ts) */
  shieldAt(x: number, y: number): boolean {
    return this.damageFx?.bubbleAt(x, y) ?? false;
  }

  /** About what a shell hits with (a rock's sparks are sized by it), from its gun where known */
  private shellDamage(id: number): number {
    const d = this.opts.state.entities.get(id)?.data, ship = d ? this.store.get(d[6]) : undefined;
    const sh = ship && (d![10] ?? -1) >= 0 ? gunShell(this.store.tuning, ship, d![10]) : null;
    return sh ? Math.round((sh.def.damage ?? 14) * sh.strength * 10) / 10 : 10;
  }

  /** Confirmed hits (docs/design/confirmed-hits.md): what the server's records came to, worked out here */
  readonly hits: ConfirmedHits;
  /** Client-detected hits (part D): the hits found here on the tick-faithful layer, and the chain reported */
  readonly selfHits: SelfHits;
  /** Your own straight shells worked out here, named by shot id (hits/OwnShells.ts) */
  readonly ownShells: OwnShells;
  /** Other ships' guns on the tick layer, stepped from their inputs (common sim/otherGuns.ts) */
  readonly otherGuns: OtherGuns;
  /** Its own ship on the tick-aligned layer, stepped from its own inputs and the causes it's told (own/OwnTick.ts) */
  readonly own: OwnTick;
  /** Bosses flown by their bodies on the tick-aligned layer, from their brains' decisions (bodies/BodyRunner.ts) */
  readonly bodies: BodyRunner;
  /** Its host (the PT timeline sets how a body stepped past the snapshots reads other ships: predict/aheadReads.ts) */
  readonly bodyHost: BodyRunnerHost;
  /**
   * The PT timeline's moves (dev prediction modes C2/C3: predict/kinds/movesKind.ts): the snapshots' moves' shells and
   * looks go by it, which draws the looks it drew ahead once, and those it didn't late. Null: drawn as they come
   */
  ptMoves: { stRows(rows: readonly EntityState[]): void; stMsgs(timed: readonly TimedMoveMsg[]): ServerMessage[] } | null = null;
  /** The frame's message handler (Game's), for what the PT timeline draws between frames */
  private handler: ((m: ServerMessage) => void) | null = null;

  /** A fork of one body's moves, its runs beginning at `from` (the PT timeline's moves: predict/kinds/movesKind.ts) */
  forkMoves(from: number, id: number, read: MoveRunnerHost['read']): MoveRunner {
    return new MoveRunner({
      reps: this.replicas, bodies: this.bodies, store: this.store, tuning: this.opts.tuning, terrain: () => this.terrain,
      custom: (factionsData as { custom?: { designs: Record<string, CustomStats> } }).custom, from, only: (x) => x === id, read,
    });
  }

  /** Draw a message as the server's would be (the PT timeline's looks, as their body's draw tick reaches them) */
  show(m: ServerMessage): void {
    this.handler?.(m);
  }
  /** Their moves' looks and straight shells worked out on the tick-aligned layer (bodies/MoveRunner.ts) */
  readonly moves: MoveRunner;
  /** Homing shells flown on the tick-aligned layer by the waypoint law (guides/GuideRunner.ts) */
  readonly guides: GuideRunner;
  /** The tick of the snapshot last applied (a confirmed hit's tick counts back from it) */
  private snapTick = 0;
  /** Handing out this frame's hits (their projectileHit messages aren't the old way) */
  private handingOut = false;

  /**
   * A confirmed hits message (ships/hits/ConfirmedHits.ts): the messages the server would have sent go through
   * `handle` (the usual handlers draw them), then the hull bars, then the spent shells go. Finding hits here
   * (SelfHits on), they're the server's word on this frame's hits, and wait with them for the frame's end
   */
  onHits(msg: ServerHitsMessage, handle: (m: ServerMessage) => void): void {
    // (the snapshot's window searched with these records in: a shell told struck on a tick struck only that, SelfHits.detect)
    this.findHits(msg);
    if (this.selfHits.on) { this.hits.told(msg, this.snapTick); return; }
    this.handOut(this.hits.expand(msg, this.snapTick), handle);
  }

  /**
   * The last snapshot's window searched (SelfHits.detect), once: at its hits message (with its records), or before
   * anything else after it that reads the HP (shipHps, hpCheck, hitFix, the frame's end). The hits found are worked out
   * at once, before the told ones, as the server orders them (HitLedger.plan)
   */
  private findHits(told?: ServerHitsMessage): void {
    if (!this.selfHits.waiting) return;
    const found = this.selfHits.detect(told ? toldHits(told.h, this.snapTick) : undefined);
    if (found.length) this.hits.own(found);
  }

  private handOut(r: { msgs: ServerMessage[]; ships: Set<number>; gone: number[] }, handle: (m: ServerMessage) => void): void {
    this.handingOut = true;
    try {
      for (const m of r.msgs) handle(m);
    } finally {
      this.handingOut = false;
    }
    for (const id of r.ships) this.fillHull(id);
    for (const id of r.gone) { this.opts.state.removeShell(id); this.guides.remove(id); }
    this.selfHits.spent(r.gone);
    this.ownShells.gone(r.gone);
    this.otherGuns.gone(r.gone);
  }

  /** A connection afresh: confirmed and client-detected hits start over, as the server's do, and so do bosses' bodies (BodyRunner.reset) */
  resetHits(): void {
    this.away.clear();
    this.hits.reset();
    this.selfHits.reset();
    this.ownShells.reset();
    this.otherGuns.reset();
    this.bodies.reset();
    this.moves.reset();
    this.guides.reset();
    this.causes.clear();
    this.contacts.clear();
    this.debris.reset();
    // (The server's pull fields come again, every one: its ids may start over)
    this.replicas.pulls.clear();
  }

  /** Its pilot is known (welcome, a respawn's too): its own ship is stepped on its tick layer from its own inputs */
  onWelcome(): void {
    this.own.start();
  }

  /**
   * netCaps: the first after a join says finding hits here starts with the next snapshot (the server's journal starts
   * there too); each says the confirmation level (`lvl`: how often it reports; at STRICT the server tells every hit)
   */
  onNetCaps(lvl?: number): void {
    // (the snapshot before it was searched as it was)
    this.findHits();
    this.selfHits.setOn(true, this.snapTick);
    this.selfHits.setLevel(lvl);
  }

  /**
   * A snapshot applied (its replicas, rows and removals): its shells onto the tick-faithful layer (rows, and the fire
   * events' shells preSnapshot rebuilt, as the server spawned them); its window is searched with the frame's told
   * records (findHits: the hits found worked out before the frame's shipHps and hpCheck)
   */
  afterSnapshot(m: ServerSnapshotMessage): void {
    this.findHits();
    if (this.selfHits.on) {
      // (a fire event's shells, rebuilt exactly; a row's are rounded: they sit out, and the server tells their hits)
      const fired = new Set<number>();
      for (const f of m.fire ?? []) for (let i = 4; i < f.length; i++) fired.add(f[i]);
      for (const e of m.entities) {
        const d = e.data;
        if (e.type !== EntityType.Projectile) continue;
        // (your own built here, CAPS.SHOT_IDS: exact, unless your ship was keyframed in the window: then told, as the server has it)
        const own = this.ownShells.freshExact(e.id);
        if (own === false) { this.selfHits.row(e.id); continue; }
        if (!fired.has(e.id) && own === undefined) this.selfHits.row(e.id);
        else if (d && (d[10] ?? -1) >= 0) this.selfHits.addShell(e.id, d[6], d[10], d[3], d[4], d[5], e.vx ?? 0, e.vy ?? 0, d[7]);
      }
    }
    this.selfHits.onKeyframes(m.ships);
    this.selfHits.onCaused(m.causes);
    this.selfHits.onTouched(this.touched);
    this.touched = undefined;
    // (a boss its body flies here: its hits are the server's records until its body has its hit rules, HitLedger 'body')
    for (const id of this.bodies.told()) this.selfHits.onSync(id);
    // (searched once this frame's told records are in: findHits)
    this.selfHits.open(m.tick);
  }

  /** The frame's end: this frame's hits (found here and told) handed out, and into the chain */
  frameEnd(handle: (m: ServerMessage) => void): void {
    this.handler = handle;
    // (what bodies' moves drew this frame, CAPS.MOVES: as if the server had sent it; on the PT timeline, by it)
    const timed = this.moves.takeTimed();
    for (const msg of this.ptMoves ? this.ptMoves.stMsgs(timed) : timed.map((t) => t.msg)) handle(msg);
    this.findHits();
    // (Switched off in this frame, its hits still go: the netCaps came after the snapshot's records)
    if (!this.selfHits.on && !this.hits.hasPending) return;
    const { out, done } = this.hits.flushPending();
    this.selfHits.settle(done);
    if (done.length || out.gone.length) this.handOut(out, handle);
  }

  /** A correction (hitFix): the hits missed worked out and drawn, the wrong ones taken back, the chain the server's */
  onHitFix(msg: ServerHitFixMessage, handle: (m: ServerMessage) => void): void {
    this.findHits();
    if (!this.selfHits.on) return;
    const { missed, wrong } = this.selfHits.fix(msg);
    this.handOut(this.hits.corrected(missed, msg.t, wrong), handle);
  }

  /** The hit report for this input tick, if one is due (`riding`: an input goes anyway) */
  takeHitReport(riding: boolean): HitReport | undefined {
    return this.selfHits.on ? this.selfHits.takeReport(riding) : undefined;
  }

  /** Its own ship's check for this input tick, if one is due (CAPS.OWN_SIM; `riding`: an input goes anyway) */
  takeOwnCheck(riding: boolean): OwnCheck | undefined {
    return this.own.takeCheck(riding, this.opts.state.serverTick);
  }

  /** The bosses' bodies' check for this input tick, if one is due (CAPS.BODIES; it only rides an input going anyway) */
  takeBodyCheck(riding: boolean): BodyCheck | undefined {
    return this.bodies.takeCheck(riding, this.opts.state.serverTick);
  }

  /** Its own ship's stores, guns, hazards and priming as the server has them at a snapshot's tick (OwnTick.onOwnSync) */
  onOwnSync(m: ServerOwnSyncMessage): void {
    this.own.onOwnSync(m);
  }

  /** Another ship's gun lane as the server has it at a snapshot's tick: stepped here from there (OtherGuns) */
  onGunSync(m: ServerGunSyncMessage): void {
    this.otherGuns.onGunSync(m);
  }

  /** Pilots' gun controls through a snapshot's window (OtherGuns) */
  onGunCtl(m: ServerGunCtlMessage): void {
    this.otherGuns.onGunCtl(m);
  }

  /**
   * Pull fields opened or ended early (common sim/pullFields.ts; just before the snapshot they go with): every pilot's
   * step on its tick layer (its own, the replicas', the dev PT layer's) works their pulls out itself
   */
  onPulls(m: ServerPullsMessage): void {
    if (m.r) this.replicas.pulls.clear();
    this.replicas.notePulls(m.f, this.opts.state.serverTick);
  }

  /** An input it sent: its own ship's controls on the tick-aligned layer from its target tick (OwnTick) */
  noteInput(msg: ClientInputMessage): void {
    this.own.noteInput(msg);
  }

  /** The server's check of a ship's HP as this client should have it */
  onHpCheck(msg: ServerHpCheckMessage): void {
    this.findHits();
    this.hits.check(msg);
  }

  /** Debris worked out here (debrisSplit): its pieces, their rows and checks (ships/debris/DebrisSplits.ts) */
  private readonly debris: DebrisSplits;

  /** The debris to confirm, taken (the input path sends them) */
  takeAcks(): number[] | undefined {
    return this.debris.takeAcks();
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
   * Fire-event shells' gun model and damage, by shell id: client-only, kept from the fire event so the look survives the
   * server row taking the shell over (WeaponFx asks once, as it first sees the shell; shells first seen in a snapshot
   * have no entry and take their kind's look)
   */
  private shellLooks = new Map<number, ShellLook>();
  /** Your cursor in the world (a guided shell's guide), reused */
  private readonly cursorPoint = { x: 0, y: 0 };
  /** Was your trigger held on the last predicted tick (the guide line shows only while it is) */
  private fireHeld = false;
  private incomingUI: IncomingWarning | null = null;

  /**
   * The gun behind a shell: from its fire event if it came by one, else (shells sent as rows: homing, aimed, guided)
   * worked out from its owner's guns, the one of its weapon type whose muzzle was nearest where it spawned. Kept per
   * shell id (WeaponFx and the landing rings both ask).
   */
  shellInfo(e: InterpolatedEntity): ShellLook | undefined {
    let l = this.shellLooks.get(e.id);
    if (l) return l;
    const owner = e.data?.[6] ?? -1, type = e.data?.[0] ?? -1;
    const ship = this.store.get(owner), ent = this.opts.state.entities.get(owner);
    if (!ship || ship.kind !== 'ship' || !ent) return undefined;
    const sx = e.spawnX ?? e.x, sy = e.spawnY ?? e.y;
    const pose = { x: ent.renderX, y: ent.renderY, angle: ent.renderAngle };
    let best: WeaponInfo | null = null, bd = Infinity;
    for (const w of ship.derived.weapons) {
      if ((WEAPON_KIND_TYPE[w.kind] ?? 1) !== type) continue;
      const [mx, my] = shipPointToWorld(ship, pose, w.window ? w.window.pivot : w.muzzle, this.opts.tuning.cellSize);
      const d = Math.hypot(mx - sx, my - sy);
      if (d < bd) { bd = d; best = w; }
    }
    if (!best) return undefined;
    const part = ship.blueprint.parts[best.part];
    const def = partWeaponDef(this.opts.tuning, best.kind, part, best);
    l = { model: part?.fn, damage: def.damage, splash: def.splash?.radius, pierce: def.pierce, arm: def.arm };
    this.shellLooks.set(e.id, l);
    while (this.shellLooks.size > 512) this.shellLooks.delete(this.shellLooks.keys().next().value!);
    return l;
  }

  /**
   * A snapshot arriving, before anything else: its keyframes and control
   * changes, then its fire events as shells (built from the firing ship's
   * replicated pose and its blueprint: common/src/ships/launch.ts)
   */
  preSnapshot(m: ServerSnapshotMessage): EntityState[] {
    this.snapTick = m.tick;
    // (its own contact pass's window: who it leaves out; before the keyframes go in)
    this.contacts.beginSnapshot(m);
    this.replicas.apply(m.tick, m.ships, m.ctl);
    // (its own ship's causes and controls: before its own fire events are built from it)
    this.own.onSnapshot(m);
    // (other ships' causes: before their fire events are built from them)
    this.causes.onSnapshot(m);
    // (bosses' decisions: their bodies fly them on the tick layer from here: ships/bodies/BodyRunner.ts)
    this.bodies.onSnapshot(m.tick, m.decisions);
    // (splits that waited for them, and for the decisions: their parents' poses as the server split them)
    this.debris.flush(new Set(m.ships?.map((k) => k[0])));
    const out: EntityState[] = [];
    // (Debris worked out here since the last snapshot: its rows, as the server would have sent them)
    out.push(...this.debris.takeRows());
    // (bodies' moves through this window: their straight shells as rows, those spent gone; their looks at the frame's end)
    const mv = this.moves.advance(m.tick, this.opts.state.playerId);
    this.ptMoves?.stRows(mv.rows);
    out.push(...mv.rows);
    if (mv.removed.length) m.removed.push(...mv.removed);
    // (homing shells: flown on the tick layer from their SYNCs and waypoints; drawn where it has them)
    this.guides.onSnapshot(m.tick, m.guides);
    out.push(...this.guides.draw(m.tick, m.entities, (id) => this.opts.state.entities.get(id)?.data));
    // (your own straight shells: built here from your own gun step's volleys, at your confirmed ship, named by
    // shot id; those whose life has ended removed here, the server sending no removal for them: hits/OwnShells.ts)
    // (Which volleys: its own layer's fire events through this snapshot's tick, as the layer has them now that the
    // snapshot's keyframe, causes and ownSync are in. A window its ship was keyframed in, or put right by an ownSync, has
    // its shells' hits told: the server's rowShell)
    this.confirmOwnFires(m.tick);
    const keyed = !!m.ships?.some((k) => k[0] === this.opts.state.playerId) || this.own.syncedAt === m.tick, ended: number[] = [];
    out.push(...this.ownShells.snapshot(m.tick, ended, keyed));
    // (other ships' shells built here from their gun lanes: those whose life has ended; then this window's, as fire rows)
    this.otherGuns.expire(m.tick, ended);
    if (ended.length) { m.removed.push(...ended); this.selfHits.onRemoved(ended); }
    this.otherGuns.confirm(m);
    for (const [owner, ago, partAmmo, aimQ, ...ids] of m.fire ?? []) {
      const tick = m.tick - ago, part = partAmmo % 256, ammo = Math.floor(partAmmo / 256) % 256, aug = partAmmo >= 65536 ? (1 as const) : undefined;
      // A charge gun's tell (no shells): it started charging, or was let go (guns.ts TELL_CHARGE_*; drawn by the charge FX)
      if (ammo === TELL_CHARGE_START) {
        this.chargeTells.set(owner * 256 + part, tick);
        // (The whine of another ship's gun: yours is heard off your own gun state, gunFeel.ts)
        const src = owner !== this.opts.state.playerId ? this.store.get(owner) : null, ent = this.opts.state.entities.get(owner);
        const gun = src?.derived.weapons.find((w) => w.part === part);
        if (gun && ent) {
          this.tellSounds.get(owner * 256 + part)?.();
          this.tellSounds.set(owner * 256 + part, this.gunFeel.otherCharge({ x: ent.renderX, y: ent.renderY }, gun));
          while (this.tellSounds.size > 64) this.tellSounds.delete(this.tellSounds.keys().next().value!);
        }
        continue;
      }
      // A beam in pieces spent a piece (no shells): its pulse runs from that tick (power/ports.ts; drawn by MiningBeamFx)
      if (ammo === TELL_BEAM_PIECE) { this.beamFx?.startPiece(owner, part, tick); continue; }
      // A ports ship's mining laser started a pulse (its aim field: the fulfilment it started at, 0..255)
      if (ammo === TELL_MINE_PULSE) { this.beamFx?.startMinePulse(owner, part, tick, aimQ / 255); continue; }
      // (Nothing fired there, a point-defence shot: for the gun lanes, OtherGuns.confirm; drawn by nothing, or its intercept)
      if (ammo === TELL_NONE || ammo === TELL_PD) continue;
      if (ammo === TELL_CHARGE_CANCEL) {
        this.chargeTells.delete(owner * 256 + part);
        this.tellSounds.get(owner * 256 + part)?.();
        this.tellSounds.delete(owner * 256 + part);
        continue;
      }
      const ship = this.store.get(owner);
      // (Your own shells that come as fire events (not built by OwnShells): from your ship on the tick layer where it was
      // as its guns fired, before that tick's pulls and contacts (OwnTick.firePose), not your prediction. Your drawn
      // shells are your prediction's, WeaponFx)
      const fp = owner === this.opts.state.playerId && this.own.on ? this.own.firePose(tick) : null;
      // (another ship where it was as its guns fired: before that tick's causes)
      const pose = fp ?? this.replicas.preAt(owner, tick), st = pose ? { body: pose } : null;
      if (!ship || !st) continue;
      this.chargeTells.delete(owner * 256 + part);
      this.tellSounds.delete(owner * 256 + part);
      // Another ship's clip gun: count its rounds, the vent on the last
      if (owner !== this.opts.state.playerId) {
        const gun = ship.derived.weapons.find((w) => w.part === part);
        if (gun) this.gunFeel.otherRound(owner, gun, tick, { x: st.body.x, y: st.body.y });
      }
      while (this.chargeTells.size > 256) this.chargeTells.delete(this.chargeTells.keys().next().value!);
      // A pulse laser's pulse (a fire event with no shells): drawn from the tick it started
      const gun = ship.derived.weapons.find((w) => w.part === part);
      // (Another ship's gun points where this shot left: a pilotless ship's aim is known only from its shots; a pilot's
      // follows their cursor between them, stepTurretVisuals)
      if (gun && owner !== this.opts.state.playerId && !this.opts.tuning.weapons?.[gun.kind]?.pointDefence) ship.aim[part] = aimQ / SHOT_AIM_STEPS;
      if (gun && this.opts.tuning.weapons?.[gun.kind]?.pulse) { this.beamFx?.startPulse(owner, part, tick); continue; }
      const v = rebuildVolley({ owner, tick, part, aimQ, ids, ammo, aug }, ship, st.body, this.opts.tuning);
      if (!v) continue;
      // The ship's pose as it fired: the muzzle flash sits on the barrel in its frame
      for (const id of ids) this.firePoses.set(id, { x: st.body.x, y: st.body.y, angle: st.body.angle });
      while (this.firePoses.size > 512) this.firePoses.delete(this.firePoses.keys().next().value!);
      // The gun's model and what a shot of it does (a model's look; the flash, recoil and impact scale with the damage)
      const wdef = partWeaponDef(this.opts.tuning, v.kind, ship.blueprint.parts[part], gun);
      // (An augmented shot looks charged up: weaponStyles AUG)
      const fn = ship.blueprint.parts[part]?.fn, look = { model: fn && aug ? fn + AUG : fn, damage: wdef.damage, splash: wdef.splash?.radius, pierce: wdef.pierce, life: straightLife(wdef, v.shells[0]?.life), arm: wdef.arm };
      for (const id of ids) this.shellLooks.set(id, look);
      while (this.shellLooks.size > 512) this.shellLooks.delete(this.shellLooks.keys().next().value!);
      // A pilot's shots move on the tick they're fired (they're fired before shells move; pilotless ships' after)
      const spawnTick = this.opts.state.entities.get(owner)?.type === EntityType.Player ? tick - 1 : tick;
      // (Its gun's grade, as the server's shells carry it: each mark's shells look their own way)
      const grade = ship.derived.weapons.find((w) => w.part === part)?.grade ?? 1;
      for (const s of v.shells) {
        const age = m.tick - spawnTick;
        // (built from a gun lane: it ends on its own, OtherGuns.expire)
        this.otherGuns.built(s.id, tick + s.life - 1);
        out.push({
          id: s.id, type: EntityType.Projectile, x: s.x + s.vx * age, y: s.y + s.vy * age, vx: s.vx, vy: s.vy,
          // (no end; the gun as the fire event packs it, which a confirmed hit works out from: data[10])
          data: [WEAPON_KIND_TYPE[v.kind] ?? 1, grade, (owner * 137) % 360, spawnTick, s.x, s.y, owner, s.size, v.turret ? 1 : 0, 0, partAmmo],
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
    // (debris it runs knocks in the world till the removal's tick: ShipReplicaSet.remove)
    for (const id of m.removed) { this.bodies.remove(id); this.causes.remove(id); this.replicas.remove(id, m.tick); }
    this.otherGuns.gone(m.removed);
    for (const id of m.out ?? []) { this.bodies.remove(id); this.causes.remove(id); this.replicas.remove(id); }
    // (the ships it holds now, for its check: CAPS.CAUSES)
    this.causes.noteHeld(m.tick);
    // (the pairs it found itself through the window: their ships' hits told, their sparks drawn, CAPS.CONTACTS)
    const found = this.contacts.endSnapshot(m.tick);
    this.touched = found.touched;
    for (const fx of found.fx) this.damageFx?.onContact({ type: 'contact', ...fx });
    for (const id of m.removed) this.guides.remove(id, m.tick);
    // (the shells it runs now, for its check: CAPS.WAYPOINTS)
    this.guides.noteHeld(m.tick);
  }

  /**
   * Your own ship stepped to `tick` on its tick layer (GameState, once per prediction tick: OwnTick's whole step, each
   * tick once), what it fired on the ticks it got to drawn now (presentOwn), and its state there. Null: not on the
   * layer yet (no keyframe of it), or not flying one
   */
  ownStepTo(tick: number): OwnStepped | null {
    const self = this.opts.state.playerId;
    if (!this.own.on) return null;
    const st = this.replicas.at(self, tick);
    if (!st) return null;
    const ship = this.store.get(self);
    if (ship && ship.kind === 'ship') for (const e of this.own.takeEvents(tick, OWN_EVENTS)) this.presentOwn(ship, e);
    const x = this.own.extrasAt(tick);
    return { body: st.body, charge: x ? cloneCharge(x.charge) : undefined, jumpPrime: x?.jumpPrime ?? st.body.jumpPrime ?? 0 };
  }

  /** Where your own ship is drawn at a fractional tick on its layer (a keyframe's or a re-step's change eased in) */
  ownPose(t: number): { x: number; y: number; angle: number } | null {
    return this.own.on ? this.replicas.pose(this.opts.state.playerId, t) : null;
  }

  /** Place a replicated ship for this frame (false: not one, or not ready yet) */  /** Place a replicated ship for this frame (false: not one, or not ready yet) */
  placeReplica(e: InterpolatedEntity, renderTick: number): boolean {
    const p = this.replicas.pose(e.id, renderTick);
    if (!p) return false;
    // (A keyframe's correction is already blended into the pose (ShipReplicaSet.pose): drawn as it is. Easing the
    // drawn position here as well trailed any ship moving more than 4 units a frame, a boss tens of units behind.)
    e.x = p.x; e.y = p.y; e.angle = p.angle; e.vx = p.vx; e.vy = p.vy;
    e.renderX = p.x;
    e.renderY = p.y;
    e.renderAngle = p.angle;
    e.angVel = 0;
    // (Its Burst Strafer's dodge: the jets, ShipRenderer)
    e.dodge = p.dodge;
    e.dodgeDir = p.dodgeDir;
    if (e.type === EntityType.Player) {
      // Rebuild the per-pilot data the effects read (see the server's player snapshot row)
      const s = e.status ?? [];
      e.data = [
        packCursorWeaponState(p.aim, (s[2] ?? 10) / 10, s[3] === 1, s[4] === 1),
        0, (s[5] ?? 0) * 100, p.jump, s[0] ?? 0, s[1] ?? 0, Math.round(p.jumpScale * 1000), 0,
      ];
    }
    return true;
  }

  /** The graphics tier's effect settings (kept for the effects made at init) */
  private quality: Pick<QualityProfile, 'particles' | 'effectCap'> = { particles: 1, effectCap: Infinity };
  setQuality(q: QualityProfile): void {
    this.quality = q;
    this.damageFx?.setQuality(q.particles, q.effectCap);
  }

  init(app: Application, renderer: Renderer): void {
    void app;
    this.scene = renderer;
    this.ghosts = new GhostLayer(renderer.getShipLayer());
    this.renderer = new ShipRenderer(this.store, renderer, this.opts.state, (id) =>
      id === this.opts.state.playerId ? this.localThrustCommand() : null,
    // Docked ships are inside their station: yours while you're berthed, others as the server says
    (id) => (id === this.opts.state.playerId ? this.docked : this.replicas.isDocked(id)), this.features);
    // (Holding cells: a ship 18 km off and more fades to its ghost, GhostLayer; the drawn own ship's place, drawGhosts)
    this.renderer.ghostOf = (id) => {
      // (A lair boss rising out of its lair or sinking back: ships/bossLife.ts)
      const rise = bossRise(id, this.opts.state.renderTickNow);
      if (id === this.opts.state.playerId) return 1 - rise;
      const e = this.opts.state.entities.get(id);
      const g = e ? ghostWeight(Math.hypot(e.renderX - this.ghostOwn.x, e.renderY - this.ghostOwn.y), this.ghostFocus) : 0;
      return 1 - (1 - g) * rise;
    };
    renderer.onMuzzle = (owner, x, y, power) => {
      this.renderer?.kick(owner, x, y, power);
      // A heavy shot shoves the shooter's view (a small nudge, only for your own gun)
      if (owner === this.opts.state.playerId && power > 1.3) this.opts.state.triggerScreenShake(1.2 * (power - 1.2), 0.12);
    };
    renderer.spinAtOf = (owner, x, y) => this.renderer?.spinAt(owner, x, y) ?? 0;
    // Muzzle flashes (and the shells' first stretch) from the drawn barrel's tip, not the facing edge they spawn at
    renderer.barrelTip = (owner, x, y, angle) => this.renderer?.barrelTip(owner, x, y, angle) ?? null;
    renderer.lodestoneGlow = (id) => this.lodestoneGlow(id);
    renderer.firePoseOf = (id) => { const p = this.firePoses.get(id); this.firePoses.delete(id); return p; };
    renderer.shellLookOf = (id, e) => this.shellInfo(e);
    // The surface a shell struck (its impact throws off it: WeaponFx.surfaceAt), from the drawn ships and rocks
    renderer.surfaceAt = (x, y, dx, dy, owner, out) => hitSurface(this.store, this.opts.state, x, y, dx, dy, owner, out);
    // Every drawn shell stops at the first drawn surface it touches (ships/drawnHit.ts), and its hit shows there
    renderer.castHit = (x0, y0, x1, y1, owner, skip, out) => this.drawnWorld.cast(x0, y0, x1, y1, owner, skip, out);
    renderer.onStruck = (id, x, y, type, target) => this.struckFx(id, x, y, type, target);
    // A guided shell's guide line runs to your cursor while you hold fire
    renderer.guideTo = () => {
      if (!this.fireHeld) return null;
      const me = this.opts.state.entities.get(this.opts.state.playerId);
      if (!me) return null;
      const a = this.opts.localAim();
      this.cursorPoint.x = me.renderX + Math.cos(a.angle) * a.dist;
      this.cursorPoint.y = me.renderY + Math.sin(a.angle) * a.dist;
      return this.cursorPoint;
    };
    this.incomingUI = new IncomingWarning();
    renderer.lighting.addSource((L) => this.damageFx?.collectLights(L));
    this.jumpFx = new JumpFx(renderer.getShipLayer(), this.store, this.opts.state, this.jump);
    this.beamFx = new MiningBeamFx(renderer.getEffectLayer(), this.store, this.opts.state, this.opts.tuning, () => {
      const aim = this.opts.localAim();
      const ship = this.store.get(this.opts.state.playerId);
      return { firing: !!this.opts.miningHeld?.() && !!ship?.derived.miners.length && !this.hangarOpen, aim: aim.angle, dist: aim.dist };
    });
    this.beamFx.ownBeams = () => this.ownBeams;
    // A held beam's burn throws impacts off what it lights (BeamLook.burn: the Cutter's, the Tesla's, the Searchlight's)
    this.beamFx.onBurn = (x, y, dx, dy, owner, burn) => this.scene?.beamBurn(x, y, dx, dy, owner, burn);
    // A pulse laser's pulse: its charge whine, the crack at its peak and its fading tail (pitched by its grade)
    this.beamFx.onPulse = (x, y, grade, own) => { this.opts.sound?.('laser_pulse', own ? undefined : { x, y }, own ? 0.42 : 0.7, PULSE_GRADE_PITCH[Math.max(0, Math.min(4, grade - 1))]); };
    // A mining laser's pulse: a deep, soft throb, one a ship however many miners it has
    this.beamFx.onMiningPulse = (x, y, own) => { this.opts.sound?.('mining_pulse', own ? undefined : { x, y }, own ? 0.5 : 0.6); };
    // ...and where it lands on rock, a mining strike (a roll for ore: nothing's sent for it)
    this.beamFx.onMiningStrike = (x, y, dx, dy, material) => this.scene?.miningStrike(x, y, dx, dy, material, 1.4);
    this.chargeFx = new ChargeFx(renderer.getEffectLayer(), this.store, this.opts.state, this.opts.tuning, this.chargeTells);
    renderer.addBloomSource(this.chargeFx.glowLayer);
    this.scannerFx = new ScannerFx(renderer.getEffectLayer(), this.store, this.opts.state, this.opts.pilot.econ);
    this.zoom = () => renderer.getZoom();
    this.damageFx = new DamageFx(renderer.getEffectLayer(), this.store, this.opts.state,
      (id, at, volume) => { this.opts.sound?.(id, at, volume); }, this.opts.tuning.repair?.range ?? 0);
    this.damageFx.setQuality(this.quality.particles, this.quality.effectCap);
    this.bossFx = new BossFx(renderer.getEffectLayer(), this.opts.state, (id, at, volume, pitch) => this.opts.sound?.(id, at, volume, pitch) ?? null);
    this.bossFx.partsAt = (id, byStage) => this.renderer?.exposedAt(id, byStage) ?? [];
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

  /** How far the local ship's drive reaches here (the burn's own rule: jumpReachAt, a gravity hazard's share too) */
  jumpReach(): number {
    const me = this.opts.state.entities.get(this.opts.state.playerId);
    const ship = me && this.store.get(me.id);
    if (!me || !ship) return 0;
    return jumpReachAt(ship.derived, this.jump, this.jumpBoostAt(me.x, me.y, me.jumpPrime ?? 0), this.hazardFor(ship.derived, me.x, me.y));
  }

  /**
   * Where the local ship's jump would stop it (null: no ship or no reach): its slide while the drive spools, then the
   * aimed distance along the aim (the cursor's bearing; helm: the nose), as stepFlight flies it (jumpAim.ts). Drawn
   * from where the ship is drawn
   */
  jumpLanding(): { x: number; y: number; reach: number } | null {
    const me = this.opts.state.entities.get(this.opts.state.playerId);
    const ship = me && this.store.get(me.id);
    const reach = this.jumpReach();
    if (!me || !ship || !reach) return null;
    const bearing = this.helmMode() ? me.renderAngle : this.jumpAimInfo.bearing ?? me.renderAngle;
    const at = jumpLanding({ x: me.renderX, y: me.renderY, vx: me.vx, vy: me.vy }, me.jump ?? 0, bearing, this.jumpAimInfo.sent ?? this.jumpAimInfo.dist, reach, this.jump,
      { friction: FRICTION, gravity: this.gravity, hazard: this.hazardFor(ship.derived, me.x, me.y) });
    return { x: at[0], y: at[1], reach };
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

  /** Your held beams on the newest tick drawn (by part), so your own beam shows the moment it fires, as your shells do */
  private ownBeams = new Set<number>();

  /**
   * What your guns did on one tick of your own ship's step (OwnTick's whole step: the same gun core as the server's
   * fireWeapons, common sim/guns.ts), drawn as the prediction reaches that tick, once: its shells from its fire events
   * (built on the ship as it fired), pulses and beams, the guns' sounds and HUD from the gun state it ended with
   */
  private presentOwn(ship: ShipState, e: OwnTickEvents): void {
    const { tick, events, state } = e;
    if (this.docked || !this.scene) return;
    this.ownBeams.clear();
    // (Your gun state as of the newest tick drawn: the HUD's ring, turrets, the gun sounds read it off your ship's record)
    mirrorGuns(ship, state);
    // (No firing mid-jump, nor knocked out by an EMP: the trigger as the step read it, common sim/guns.ts)
    const input = this.own.inputAt(tick);
    const burning = jumpPhase(state.body.jump ?? 0, this.jump).phase === 'burn' || tick < state.hazard.empUntil;
    this.fireHeld = gunControls(ship, input.fire, input.fireAlt, burning).firing;
    this.gunFeel.own(ship, tick);
    const pose = { x: state.body.x, y: state.body.y, angle: state.body.angle };
    for (const ev of events) {
      if (ev.k === 'fx') {
        if (ev.fx === GUN_FX.beam) this.ownBeams.add(ev.part);
        else if (ev.fx === GUN_FX.pulse) this.beamFx?.startPulse(ship.id, ev.part, tick);
        continue;
      }
      // (a volley: its first barrel's event builds it)
      if (ev.k !== 'fire' || ev.barrel !== 0) continue;
      const w = ship.derived.weapons.find((x) => x.part === ev.slot);
      if (!w) continue;
      // (Homing missiles change course: those the server sends as they fly)
      const pdef = partWeaponDef(this.opts.tuning, w.kind, ship.blueprint.parts[w.part], w);
      if (!firesStraight(pdef)) continue;
      const aug = (ev as { aug?: 1 }).aug, ammo = ammoCodeOfMods(this.ownAmmo?.(w.kind));
      const fire = { owner: ship.id, tick, part: w.part, aimQ: ev.aimQ, ammo, aug };
      // (the ammunition it fired, for your own shells on the tick layer, built when a snapshot confirms the tick: confirmOwnFires)
      this.ownAmmoAt.set(tick * 256 + w.part, ammo);
      while (this.ownAmmoAt.size > 256) this.ownAmmoAt.delete(this.ownAmmoAt.keys().next().value!);
      // A pilot's shells move on the tick they're fired (as in preSnapshot)
      const v = fireVolley(fire, ship, { ...pose, vx: state.body.vx, vy: state.body.vy }, this.opts.tuning);
      if (!v) continue;
      for (const sh of v.shells) {
        this.scene.predictShot({ owner: ship.id, type: WEAPON_KIND_TYPE[w.kind] ?? 1, grade: w.grade, model: (ship.blueprint.parts[w.part]?.fn ?? '') + (aug ? AUG : ''), damage: pdef.damage, pierce: pdef.pierce, life: straightLife(pdef, sh.life), arm: pdef.arm, turret: v.turret, spawnX: sh.x, spawnY: sh.y, spawnTick: tick - 1, vx: sh.vx, vy: sh.vy, size: sh.size, pose });
      }
    }
  }

  /** The world the replicas fly in (gravity, the central body, lodestones, hazards, a surface's rock): the gun lanes' too */
  replicaEnv(): ReplicaEnv {
    return { gravity: this.gravity, central: this.central, lodestones: this.lodestones, hazard: this.hazardFor, terrain: this.terrain };
  }

  /**
   * Another ship's volley drawn ahead of the snapshots (the PT timeline, predict/kinds/shellsKind.ts): fired on tick t
   * from `pose` (a pilot's shells move on their fire tick: spawned a tick earlier, as the fire rows have it). The drawn
   * shells' handles (the snapshot's built shell, the same shot, takes one over: WeaponFx.claim)
   */
  predictOtherVolley(owner: number, t: number, rec: LaneRec, pose: FlightBody, pilot: boolean): number[] {
    const ship = this.store.get(owner), scene = this.scene;
    if (!ship || ship.kind !== 'ship' || !scene) return [];
    const w = ship.derived.weapons.find((x) => x.part === rec.part);
    if (!w) return [];
    const v = fireVolley({ owner, tick: t, part: rec.part, aimQ: rec.aimQ, ammo: 0, aug: rec.aug ? 1 : undefined }, ship, pose, this.opts.tuning);
    if (!v) return [];
    const pdef = partWeaponDef(this.opts.tuning, w.kind, ship.blueprint.parts[w.part], w), at = { x: pose.x, y: pose.y, angle: pose.angle };
    const model = (ship.blueprint.parts[w.part]?.fn ?? '') + (rec.aug ? AUG : '');
    return v.shells.map((sh) => scene.predictShot({ owner, type: WEAPON_KIND_TYPE[w.kind] ?? 1, grade: w.grade, model, damage: pdef.damage, pierce: pdef.pierce, life: straightLife(pdef, sh.life), arm: pdef.arm, turret: v.turret, spawnX: sh.x, spawnY: sh.y, spawnTick: pilot ? t - 1 : t, vx: sh.vx, vy: sh.vy, size: sh.size, pose: at }));
  }

  /** Take back a shell drawn ahead that never was */
  retractOther(handle: number): void {
    this.scene?.retractShot(handle);
  }

  /** The ammunition each own volley was drawn with (by tick * 256 + part), for the shells built on the tick layer */
  private readonly ownAmmoAt = new Map<number, number>();

  /**
   * Your own straight shells on the tick layer (OwnShells): the volleys your own layer fired through a snapshot's tick,
   * as it has them once that snapshot is in (its keyframe, causes and ownSync)
   */
  private confirmOwnFires(tick: number): void {
    const self = this.opts.state.playerId, ship = this.store.get(self);
    if (!this.own.on || !ship || ship.kind !== 'ship' || !this.replicas.at(self, tick)) return;
    for (const { tick: t, events } of this.own.takeConfirmed(tick, CONFIRMED)) {
      for (const ev of events) {
        if (ev.k !== 'fire' || ev.barrel !== 0) continue;
        const aug = (ev as { aug?: 1 }).aug, w = ship.derived.weapons.find((x) => x.part === ev.slot);
        if (!w) continue;
        const ammo = this.ownAmmoAt.get(t * 256 + w.part) ?? ammoCodeOfMods(this.ownAmmo?.(w.kind));
        if (this.ownShells.derivable(ship, w.part + 256 * ammo + (aug ? 65536 : 0))) this.ownShells.fired({ tick: t, part: w.part, aimQ: ev.aimQ, ammo, aug });
      }
    }
  }

  /** The ship you fly (null between ships) */  /** The ship you fly (null between ships) */
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
    return ship && ship.kind === 'ship' ? boostOf(ship.derived) : 1;
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
    if (settings.data.gameplay.jumpMode === 'hold') return !this.hangarOpen && this.opts.isKeyDown('KeyJ');
    if (this.jumpLatched) {
      const ph = this.localJump().phase;
      if (ph === 'burn' || ph === 'cooldown' || this.hangarOpen) this.jumpLatched = false;
    }
    return this.jumpLatched;
  }

  /** The Burst Strafer's dodge control this input tick (features/strafer: a press asks for one burst, the way you steer) */
  dodgeControl(): boolean {
    return this.dodgeCtl();
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
    } else if (this.opts.noseThrust?.()) {
      // Along the ship (W the nose); turning follows the spin
      dir = [right - left, back - fwd];
      turn = Math.max(-1, Math.min(1, (me.angVel ?? 0) / 0.05));
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
      case 'debrisSplit':
        this.debris.onSplit(msg);
        return true;
      case 'cells':
        this.away.onCells(msg);
        return true;
      case 'shipSync':
        this.debris.onSync(msg);
        this.selfHits.onSync(msg.id, this.store.keepsBefore(msg));
        this.own.beforeSync(msg.id);
        this.causes.beforeSync(msg.id);
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
      case 'intercept':
        // Point defence fired (support.ts): its tracer and the shot popping; the shell's own tracer stops there; the turret turns to it
        this.damageFx?.onIntercept(msg);
        if (msg.down) this.scene?.showProjectileHit(msg.proj, msg.x, msg.y);
        this.pdAim.set(msg.bodyId * 1024 + msg.part, { x: msg.x, y: msg.y, at: performance.now() });
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
      case 'bossWindow':
        // Its exposed pieces blaze while its window runs (drawn from this message alone)
        this.bossFx?.onWindow(msg);
        return false; // the game shows the meter too
      case 'bossBlow':
        this.renderer?.blow(msg.bodyId, msg.part);
        return true;
      case 'bossDefeated':
        this.damageFx?.onBossDefeated(msg.x, msg.y);
        return false; // the game shows the card too
      case 'damage':
        this.renderer?.hit(msg.targetId, msg.amount);
        return false; // the game shows the number and the HUD's indicator
      case 'effect':
        if (msg.effectType === 12) this.damageFx?.shieldReform(msg.x, msg.y); // EffectType.ShieldFlash
        return false; // the game draws its own
      case 'projectileHit':
        // (Told the old way: a hit found here for this shell wasn't one)
        if (this.selfHits.on && !this.handingOut) { this.hits.oldWay(msg.id); this.selfHits.drop(msg.id); }
        // (a shell it doesn't have: one a body's move fired, made here: the one there goes)
        if (!this.opts.state.entities.has(msg.id)) this.moves.struck(msg.x, msg.y, this.snapTick);
        // (A shell drawn here shows its hit where it's seen to strike, struckFx; the server's only confirms it)
        if (!this.scene?.drawsShell(msg.id)) this.struckFx(msg.id, msg.x, msg.y, this.opts.state.entities.get(msg.id)?.data?.[0] ?? -1);
        return false; // the game stops the tracer and throws the sparks
      case 'scanPulse':
        this.scannerFx?.pulse(msg.seconds);
        this.opts.sound?.('scan_ping');
        return true;
      case 'shipHp':
        this.findHits();
        this.store.onHp(msg);
        this.fillHull(msg.id);
        return true;
      case 'shipHps':
        this.findHits();
        this.store.onHps(msg);
        for (const [id] of msg.ships) this.fillHull(id);
        return true;
      case 'systemInfo':
        this.gravity = msg.centralBody.gravity ?? null;
        this.central = msg.centralBody;
        // A surface's rock (pushed out of it in prediction, as the server does)
        this.terrain = terrainFor(msg.systemId);
        // (Another system: no lair boss of the last one is rising or sinking here)
        clearBossLives();
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
        this.away.onSnapshot(msg.tick, msg.removed);
        this.hits.forget(msg.removed);
        this.selfHits.onRemoved(msg.removed);
        return false;
    }
    return false;
  }

  /** Your mining beam is on (for its sound) */
  get mining(): boolean {
    return this.beamFx?.localActive ?? false;
  }

  /** Every ship's held beams lit this frame, as drawn (MiningBeamFx: yours as predicted, others' by their flag or piece clock) */
  litBeams(): readonly LitBeam[] {
    return this.beamFx?.litBeams ?? [];
  }

  /**
   * Your charge guns' charge, for the HUD (the fullest one being charged: 0..1, as your client steps it: guns.ts),
   * null when none is charging
   */
  gunCharge(): { charge: number; gun: WeaponInfo } | null {
    const ship = this.store.get(this.opts.state.playerId);
    if (!ship || ship.kind !== 'ship') return null;
    let best: { charge: number; gun: WeaponInfo } | null = null;
    for (const w of ship.derived.weapons) {
      if (w.fire.model !== 'charge' || !(ship.charge[w.part] > 0)) continue;
      const c = Math.min(1, ship.charge[w.part] / Math.max(1, w.fire.charge ?? 60));
      if (!best || c > best.charge) best = { charge: c, gun: w };
    }
    return best;
  }

  /** Others' charge guns charging now (a charge-start fire event, until it fires or is let go): owner * 256 + part → the tick it started */
  readonly chargeTells = new Map<number, number>();
  /** ...and the stop for the whine each started (cut by a cancel) */
  private readonly tellSounds = new Map<number, (() => void) | null>();

  /**
   * The weapon ring's groups (ui/WeaponRing.ts): your guns by model, with clip, charge, spin, ammo and bank, off your
   * own predicted gun state. Empty when you fly nothing with guns. The records are reused every call.
   */
  ringGroups(): RingGroup[] {
    const ship = this.store.get(this.opts.state.playerId);
    this.ringSrc.charge = this.opts.state.charge;
    return this.ringModel.update(ship ?? null, this.ringSrc);
  }

  /**
   * What the ship status panel reads (ui/shipStatus/source.ts), at its own rate: the ship, the predicted charge, the
   * shield, the keys' thrust, the weapon ring's groups (as the ring last stepped them) and the part features' lines.
   * The record is reused.
   */
  private statusInput(): StatusInput | null {
    const st = this.opts.state, ship = this.store.get(st.playerId);
    if (!ship || ship.kind !== 'ship') return null;
    const inp = this.statusRec;
    inp.ship = ship;
    inp.charge = st.charge;
    inp.shieldPct = st.entities.get(st.playerId)?.data?.[4] ?? 0;
    const cmd = this.localThrustCommand();
    inp.thrust.on = cmd.dir[0] !== 0 || cmd.dir[1] !== 0;
    inp.thrust.boost = cmd.boost;
    inp.tick = st.serverTick;
    inp.tuning = this.opts.tuning;
    // (The ring's groups as Game stepped them this frame; stepped here only when nothing has)
    inp.groups = this.ringModel.groups.length || !ship.derived.weapons.length ? this.ringModel.groups : this.ringGroups();
    inp.features = this.features.statusLines(this.statusLines);
    inp.now = performance.now();
    return inp;
  }
  private readonly statusLines: FeatureStatusLine[] = [];
  private readonly statusRec: StatusInput = {
    ship: null, charge: { g: 100, b: [] }, shieldPct: 0, thrust: { on: false, boost: false }, tick: 0, tuning: {} as StatusInput['tuning'],
    groups: [], features: [], now: 0,
    nameOf: (fn) => this.opts.catalog.functions.get(fn)?.name ?? fn,
  };

  private readonly ringSrc: RingSources = {
    charge: { g: 100, b: [] },
    ammoOf: (kind) => {
      const item = this.opts.tuning.weapons?.[kind]?.ammo?.item;
      if (!item) return null;
      const a = this.ringAmmo;
      a.loose = this.opts.pilot.profile?.ammo?.[item] ?? 0;
      a.crates = 0;
      for (const s of this.opts.pilot.cargo) if (s.id === item) a.crates += s.n;
      return a;
    },
  };

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
    if (this.features.onKey(code)) return true;
    if (code === 'KeyV') {
      this.helm = !this.helm;
      return true;
    }
    // Switch feeds (a ports ship's Selectors: common/src/ships/power/ports.ts)
    if (code === 'KeyY') {
      const ship = this.store.get(this.opts.state.playerId);
      if (!ship?.derived.ports) this.opts.showMessage('No feed Selector fitted: nothing to switch', '#f2d24b');
      else this.opts.send({ type: 'feedSwitch' });
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

  /** Berthed at a station (the server took the dock: it holds our controls neutral, so no inputs go: app/inputSend.ts) */
  berthed(): boolean {
    return this.docked;
  }

  /** All your ship's stored energy as one percentage (the HUD's gauge) */
  chargeTotal(charge: Charge): number {
    const ship = this.store.get(this.opts.state.playerId);
    return ship && ship.kind === 'ship' ? chargeTotal(ship.derived, charge) : 100;
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
    // (a ship kept while away keeps its structure: it comes back without a sync)
    this.store.prune((id) => state.entities.has(id) || this.away.has(id), now);

    // (The last ship flown, for the hangar while its sync is away)
    const mine = this.store.get(state.playerId);
    if (mine && mine.blueprint !== this.lastBlueprint) this.lastBlueprint = mine.blueprint;

    // Turret visuals at tick rate (firing itself is decided by the server)
    const ticks = Math.min(4, Math.floor((now - this.lastTurretFrame) / (1000 / 60)));
    if (ticks > 0) {
      this.lastTurretFrame = now;
      for (let t = 0; t < ticks; t++) { this.stepTurretVisuals(); this.stepPointDefenceVisuals(now); }
    }

    // (Part features: the pilot row's values, read before anything draws or shows them)
    { const mine = state.entities.get(state.playerId);
      if (mine) {
        if (mine.data && this.features.hasParsers) this.features.parsePilot(mine.data, chargeGroupsEnd(mine.data), mine.fx ??= {});
        else mine.fx = undefined;
      } }
    { const me = state.entities.get(state.playerId); if (me) { this.ghostOwn.x = me.renderX; this.ghostOwn.y = me.renderY; } this.ghostFocus = state.crowd.focus; }
    this.renderer?.update();
    this.drawGhosts();
    this.hud.update();
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    const me = state.entities.get(state.playerId);
    this.jumpFx?.update(dt, {
      hidden: this.hangarOpen || !this.store.get(state.playerId), latched: this.jumpLatched,
      aiming: this.jumpAiming(), aimDist: this.jumpAimInfo.sent ?? this.jumpAimInfo.dist, aimLabel: this.jumpAimInfo.label,
      reach: this.jumpReach(), landing: this.jumpAiming() ? this.jumpLanding() : null, field: me ? this.gaugeField() : undefined, danger: this.jumpAiming() ? this.jumpDanger() : null,
    });
    // (Part features' chips: the Burst Strafer's, ready or cooling and whether the ship can pay; the Tow Beam's while it tows)
    this.features.updateIndicators();
    this.damageFx?.update(dt);
    this.beamFx?.update(dt);
    this.chargeFx?.update(dt, Math.round(state.getRawServerTick()));
    // A shell heading at you that warns of it (the Leviathan): an arrow on the screen edge toward it
    if (this.scene && this.incomingUI) this.incomingUI.update(dt, this.scene.incomingShells, (x, y) => this.scene!.worldToScreen(x, y), this.scene.screenSize());
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

  /** Point-defence turrets' last shots, by ship × 1024 + part: where to point (they aim themselves: support.ts) */
  private pdAim = new Map<number, { x: number; y: number; at: number }>();

  /**
   * Point-defence turrets don't follow the cursor: each turns to where it last fired (an `intercept`), and back to rest
   * a moment after (the server aims them; this is only how they look)
   */
  private stepPointDefenceVisuals(now: number): void {
    const { state, tuning } = this.opts;
    for (const [key, a] of this.pdAim) if (now - a.at > 900) this.pdAim.delete(key);
    for (const [id, ship] of this.store.bodies) {
      if (ship.kind !== 'ship') continue;
      for (const w of ship.derived.weapons) {
        const def = tuning.weapons?.[w.kind];
        if (!def?.pointDefence || !w.window) continue;
        const e = state.entities.get(id);
        if (!e) continue;
        const pose = { x: e.renderX, y: e.renderY, angle: e.renderAngle };
        const a = this.pdAim.get(id * 1024 + w.part);
        let local: number | undefined;
        if (a) {
          const [px, py] = shipPointToWorld(ship, pose, w.window.pivot, tuning.cellSize);
          local = Math.atan2(a.y - py, a.x - px) - (pose.angle + Math.PI / 2);
        }
        ship.aim[w.part] = stepPointDefenceAim(w.window, ship.aim[w.part], local, tuning, pointDefenceOf(def).slew).offset;
      }
    }
  }

  /**
   * Turrets and fixed guns' gimbals on ships whose guns your client doesn't step (yours does on each predicted tick, as
   * the server's: predictGuns), aimed as the server aims them (guns.ts stepGuns): your own without prediction from your
   * cursor, another pilot's from the cursor it sends. A pilotless ship sends none: its guns point where its last shot
   * left (preSnapshot)
   */
  private stepTurretVisuals(): void {
    const { state, tuning } = this.opts;
    const weapons = tuning.weapons ?? {};
    for (const [id, ship] of this.store.bodies) {
      if (ship.kind !== 'ship' || !ship.derived.weapons.length) continue;
      const e = state.entities.get(id);
      if (!e) continue;
      let angle: number, dist: number;
      if (id === state.playerId && state.predictionEnabled) continue;
      if (id === state.playerId) {
        ({ angle, dist } = this.opts.localAim());
      } else if (e.type === EntityType.Player && e.data && e.data.length >= 1) {
        angle = unpackCursorWeaponState(e.data[0]).aimAngle;
        dist = e.data[2] ?? 0;
      } else continue;
      const pose = { x: e.renderX, y: e.renderY, angle: e.renderAngle };
      const ax = pose.x + Math.cos(angle) * dist, ay = pose.y + Math.sin(angle) * dist;
      for (const w of ship.derived.weapons) {
        // (Point defence aims itself: stepPointDefenceVisuals)
        const def = weapons[w.kind];
        if (def?.pointDefence || w.fire.model === 'auto') continue;
        if (w.window) {
          let worldAngle = angle;
          if (dist > 0) {
            const [px, py] = shipPointToWorld(ship, pose, w.window.pivot, tuning.cellSize);
            worldAngle = Math.atan2(ay - py, ax - px);
          }
          ship.aim[w.part] = stepTurretAim(w.window, ship.aim[w.part], worldAngle - (pose.angle + Math.PI / 2), tuning).offset;
        } else {
          // A fixed gun: as close to the cursor point as its gimbal lets it, from its muzzle
          let worldAngle = angle;
          if (dist > 0) {
            const [mx, my] = shipPointToWorld(ship, pose, w.muzzle, tuning.cellSize);
            worldAngle = Math.atan2(ay - my, ax - mx);
          }
          const base = pose.angle + Math.PI / 2 + Math.atan2(w.dir[1], w.dir[0]);
          ship.aim[w.part] = stepFixedGunAim(worldAngle - base, tuning, angle - base, w.fire.model === 'beam' || def?.type === 'beam', def?.gimbalDeg).offset;
        }
      }
    }
  }
}

/**
 * The ticks a straight shell flies before the server drops it (its life: WeaponFx ends its flight there, however late
 * the removal comes); none for a shell whose life the server changes (one that ends at the aim, one that sticks in rock)
 */
function straightLife(def: { stick?: unknown } & Parameters<typeof endsAtAim>[0], life: number | undefined): number | undefined {
  return life && !endsAtAim(def) && !def.stick ? life : undefined;
}

/** A step's gun state onto your ship's record (what the HUD, turrets and gun sounds read), its arrays kept */
function mirrorGuns(ship: ShipState, st: Readonly<SimShipState>): void {
  const g = st.guns;
  copyInto(ship.cooldown, g.cooldown); copyInto(ship.rounds, g.rounds); copyInto(ship.reload, g.reload);
  copyInto(ship.charge, g.charge); copyInto(ship.spin, g.spin); copyInto(ship.aim, g.aim);
  ship.triggerHeld = g.triggerHeld; ship.clickAt = g.clickAt;
  ship.minePaid = g.minePaid; ship.mineUntil = g.mineUntil; ship.mineShare = g.mineShare; ship.tow = g.tow;
}

function copyInto(to: number[], from: readonly number[]): void {
  to.length = from.length;
  for (let i = 0; i < from.length; i++) to[i] = from[i];
}
