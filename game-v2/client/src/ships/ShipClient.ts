/**
 * @contract client.ship.client
 * owns:       the client's ship hub: builds the per-area pieces and exposes the one surface Game, the predictor and the UI call
 * needs:      ShipClientOptions (state, send, sound, ...), ShipStore, the pieces under ships/{own,guns,hits,jump,dock,replicas,fx,hud,wiring,messages}; npm: @space-game/common, pixi.js
 * events:     server messages via handleMessage; snapshots via preSnapshot / afterSnapshot / onReplication / frameEnd
 * invariants: hits are searched once per snapshot window, before anything that reads HP — none pinned
 *             your own ship is stepped on its tick layer only (own/OwnTick), never here — server/src/golden/parity.test.ts
 *             replicated ships are placed as the pose says, a keyframe correction is not eased twice — server/src/golden/parity.test.ts
 * extend:     a new area is a new class under ships/<area>/ built in the constructor and delegated to below
 */

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

import { chargeGroupsEnd, EntityType, type ServerGunSyncMessage, type GunCtlRows, type LaneRec, type ReplicaEnv } from '@space-game/common';
import { GunFeel } from './gunFeel';
import './energyLooks';
import { groupSelection } from './weaponGroups/selection';
import type { RingGroup } from './gunHud';
import type { ServerOwnSyncMessage, ServerPullsMessage, WeaponInfo, Charge, ShipState, WeaponMods, ShipDerived, FlightBody, CustomStats } from '@space-game/common';
import type { Application } from 'pixi.js';
import {
  Blueprint, Catalog, ClientInputMessage, ClientMessage, ServerMessage, ShipTuning, jumpPhase,
  type JumpField, type LodestoneData, ShipReplicaSet, ServerSnapshotMessage, EntityState,
  type ServerHitsMessage, type ServerHpCheckMessage, type ServerHitFixMessage, type HitReport, type OwnCheck, type BodyCheck,
} from '@space-game/common';
import type { MenuShipInfo } from '../ui/GameMenuUI';
import type { GameState, InterpolatedEntity, OwnStepped } from '../state/GameState';
import type { Renderer } from '../rendering/Renderer';
import { ShipStore } from './ShipStore';
import { ShipRenderer } from './ShipRenderer';
import { ShipHud } from './ShipHud';
import type { HangarUI } from './HangarUI';
import type { Lazy } from '../lazy';
import type { LitBeam } from './MiningBeamFx';
import { DrawnWorld } from './drawnHit';
import { ConfirmedHits } from './hits/ConfirmedHits';
import { SelfHits } from './hits/SelfHits';
import { OtherGuns } from './guns/OtherGuns';
import { OwnShells } from './hits/OwnShells';
import { OwnTick } from './own/OwnTick';
import { ShipCauses } from './causes/ShipCauses';
import { ContactWorld } from './causes/ContactWorld';
import { DebrisSplits } from './debris/DebrisSplits';
import { BodyRunner, type BodyRunnerHost } from './bodies/BodyRunner';
import { MoveRunner, type MoveRunnerHost } from './bodies/MoveRunner';
import factionsData from '../../../data/factions.json';
import { GuideRunner } from './guides/GuideRunner';
import type { PilotState } from '../econ/clientEcon';
import type { ThrustCommand } from './ThrusterFx';
import { settings } from '../settings/Settings';
import type { ClientFeatures } from './features/host';
import type { QualityProfile } from '../settings/quality';
import { ShipMemory } from './cells/ShipMemory';
import type { ShellLook } from '../rendering/weapons/WeaponFx';
import { TurretVisuals } from './guns/TurretVisuals';
import { FireShells } from './guns/FireShells';
import { OwnPresent } from './own/OwnPresent';
import { localThrustCommand } from './own/thrustCommand';
import { JumpControl } from './jump/JumpControl';
import { DockControl } from './dock/DockControl';
import { StrikeFx } from './hits/StrikeFx';
import { HitFlow, type PtMoves } from './hits/HitFlow';
import { fillHull } from './hits/fillHull';
import { ReplicaPlacement } from './replicas/ReplicaPlacement';
import { ShipFx } from './fx/ShipFx';
import { ShipReadouts } from './hud/ShipReadouts';
import { handleShipMessage, type ShipMessageHost } from './messages/ShipMessages';
import { wireRendererHooks } from './wiring/rendererHooks';
import { makeHangar } from './wiring/hangarFactory';
import { makeFeatures, mountFieldFor, type FeatureWiringHost } from './wiring/featuresWiring';
import { inGunRange } from '../ui/gunRange/rangeState';

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
  /** The flight zoom (the build overlay zooms in on the ship and puts it back) */
  zoom?: { get(): number; set(z: number): void };
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
  /** Gun sounds that follow the firing models (charge whine, clip clack and vent, spin-up) */
  private gunFeel = new GunFeel((id, at, volume, pitch) => this.opts.sound?.(id, at, volume, pitch) ?? null);
  /** Part features' client side (ships/features/host.ts): keys, controls, pilot-row values, drawing and chips (the Tow Beam's, the Burst Strafer's) */
  private features: ClientFeatures;
  /** The Burst Strafer's dodge control (features/strafer: it latches and buffers a press) */
  private dodgeCtl: () => boolean;
  private lastFrame = 0;

  // The per-area pieces (each file states its own contract)
  /** Jump drive, aim and the system's flight world (jump/JumpControl.ts) */
  private readonly jc: JumpControl;
  /** Docking, the berth and the hint lines (dock/DockControl.ts) */
  private readonly dock: DockControl;
  /** Where shells are seen to strike, and mining progress (hits/StrikeFx.ts) */
  private readonly strike: StrikeFx;
  /** Others' fire events as shells, charge tells, shell looks (guns/FireShells.ts) */
  private readonly fire: FireShells;
  /** What your own tick layer fired, drawn as the prediction reaches it (own/OwnPresent.ts) */
  private readonly ownPresent: OwnPresent;
  /** Look-only turret and point-defence gimbals (guns/TurretVisuals.ts) */
  private readonly turrets: TurretVisuals;
  /** Where replicated ships are drawn, sides, far-ship ghosts (replicas/ReplicaPlacement.ts) */
  private readonly placement: ReplicaPlacement;
  /** Order of the frame's hit searching, hand-out and corrections (hits/HitFlow.ts) */
  private readonly flow: HitFlow;
  /** The effect layers (fx/ShipFx.ts) */
  private readonly fx: ShipFx;
  /** HUD and menu readouts (hud/ShipReadouts.ts) */
  private readonly readouts: ShipReadouts;
  private readonly msgHost: ShipMessageHost;

  /** The ammunition your guns of a kind fire next (the crate the server will open: launch.ts chooseCrate) */
  ownAmmo?: (kind: string) => WeaponMods | undefined;

  constructor(private opts: ShipClientOptions) {
    const sound = (id: string, at?: { x: number; y: number }, volume?: number, pitch?: number) => opts.sound?.(id, at, volume, pitch) ?? null;
    this.store = new ShipStore(opts.catalog, opts.tuning);
    this.debris = new DebrisSplits({ store: this.store, reps: () => this.replicas, splitPose: () => (id, t) => this.causes.beforeRebuild(id, t), crumbled: (m) => this.fx.damageFx?.onPartDestroyed(m) });
    this.jc = new JumpControl({
      state: opts.state, store: this.store, isKeyDown: (code) => opts.isKeyDown(code), hangarOpen: () => this.hangarOpen, helm: () => this.helm,
      showMessage: (text, color) => opts.showMessage(text, color),
    }, opts.tuning);
    const wiring: FeatureWiringHost = {
      store: this.store, replicas: () => this.replicas, scene: () => this.scene, sideOf: (id) => this.placement.sideOf(id),
      hangarOpen: () => this.hangarOpen, docked: () => this.dock.docked, helm: () => this.helm, setHelm: (on) => { this.helm = on; },
    };
    this.features = makeFeatures(opts, wiring);
    this.dodgeCtl = this.features.controlFor('dodge');
    // (The field machines' HUD and build overlay, ships/field: they read the game through this)
    mountFieldFor(opts, wiring);
    this.dock = new DockControl({
      state: opts.state, tuning: opts.tuning, store: this.store, editAnywhere: opts.editAnywhere,
      stationOpen: () => opts.stationOpen?.() ?? false, onDocked: opts.onDocked ? (station) => opts.onDocked!(station) : undefined,
      send: (msg) => opts.send(msg), showMessage: (text, color) => opts.showMessage(text, color), sound,
      hangarOpen: () => this.hangarOpen, openHangar: () => this.hangar.use((h) => h.open()), refreshShip: (id) => this.renderer?.refresh(id),
    });
    this.hud = new ShipHud(this.store, () => opts.state.playerId, () => this.helm, () => this.readouts.statusInput());
    this.hangar = makeHangar(opts, { store: this.store, shared: this.shared, lastBlueprint: () => this.lastBlueprint, undock: () => this.undock() });
    opts.pilot.onChange(() => this.hangar.value?.onHangarUpdate());
    this.store.onMissing = (id) => opts.send({ type: 'shipNeed', id });
    this.replicas = new ShipReplicaSet(opts.tuning, (id) => this.store.get(id)?.derived, () => this.jc.replicaEnv(),
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
    this.drawnWorld = new DrawnWorld(this.store, opts.state, (id) => this.placement.sideOf(id));
    this.selfHits = new SelfHits({
      store: this.store,
      self: () => opts.state.playerId,
      ships: () => this.replicas.ids(),
      at: (id, tick) => this.replicas.at(id, tick)?.body ?? null,
      side: (id) => this.placement.sideOf(id),
      passes: (shell) => this.hits.passesOf(shell),
      ownExact: () => this.own.on,
      window: (from, to, ids) => this.features.onWindow(from, to, ids),
    });
    this.ownShells = new OwnShells({ self: () => opts.state.playerId, ship: (id) => { const s = this.store.get(id); return s && s.kind === 'ship' ? s : undefined; }, tuning: opts.tuning, firePose: (t) => this.own.firePose(t) });
    this.own = new OwnTick({ store: this.store, reps: this.replicas, self: () => opts.state.playerId, tuning: opts.tuning, extraHash: (t) => (this.causes.heldByte(t) ?? 0) + this.guides.byte(t),
      contacts: () => this.contacts, otherMid: (id, t, place) => this.causes.midOf(id, t, place) });
    this.bodies = new BodyRunner((this.bodyHost = { reps: this.replicas, radius: (id) => this.store.get(id)?.derived.radius }));
    // (Other ships' guns stepped here from their inputs: ships/guns/OtherGuns.ts)
    this.otherGuns = new OtherGuns({ reps: this.replicas, ship: (id) => { const s = this.store.get(id); return s && s.kind === 'ship' ? s : undefined; }, tuning: opts.tuning, self: () => opts.state.playerId });
    // (Their moves worked out here: ships/bodies/MoveRunner.ts)
    this.moves = new MoveRunner({
      reps: this.replicas, bodies: this.bodies, store: this.store, tuning: opts.tuning, terrain: () => this.jc.terrain,
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
    // (The pieces split out by area, built last: they read the ones above)
    const state = opts.state, tuning = opts.tuning, store = this.store;
    this.flow = new HitFlow({ store, state, hits: this.hits, selfHits: this.selfHits, ownShells: this.ownShells, otherGuns: this.otherGuns, guides: this.guides, bodies: this.bodies, moves: this.moves });
    this.turrets = new TurretVisuals({ store, state, tuning, localAim: () => opts.localAim() });
    this.placement = new ReplicaPlacement({ state, store, replicas: this.replicas, own: this.own, otherGuns: this.otherGuns, scene: () => this.scene });
    this.fire = new FireShells({ store, state, tuning, own: this.own, replicas: this.replicas, gunFeel: this.gunFeel, otherGuns: this.otherGuns, beamFx: () => this.fx.beamFx });
    this.ownPresent = new OwnPresent({
      store, state, tuning, own: this.own, replicas: this.replicas, ownShells: this.ownShells, gunFeel: this.gunFeel, jump: this.jc.jump,
      scene: () => this.scene, beamFx: () => this.fx.beamFx, docked: () => this.dock.docked, ownAmmo: () => this.ownAmmo,
    });
    this.strike = new StrikeFx({ state, store, scene: () => this.scene, damageFx: () => this.fx.damageFx, shellModel: (id) => this.fire.modelOf(id), sound });
    this.fx = new ShipFx({
      state, store, tuning, econ: opts.pilot.econ, jump: this.jc.jump, ownBeams: this.ownPresent.ownBeams, chargeTells: this.fire.chargeTells, strike: this.strike,
      localAim: () => opts.localAim(), miningHeld: opts.miningHeld ? () => opts.miningHeld!() : undefined, hangarOpen: () => this.hangarOpen, sound,
    });
    this.readouts = new ShipReadouts({
      state, store, catalog: opts.catalog, tuning, pilot: opts.pilot, features: this.features, jump: this.jc.jump,
      thrustCommand: () => this.thrustCommand(), helm: () => this.helm, localJump: () => this.jc.localJump(), jumpReach: () => this.jc.jumpReach(),
    });
    this.msgHost = {
      state, store, debris: this.debris, away: this.away, selfHits: this.selfHits, hits: this.hits, own: this.own, causes: this.causes, moves: this.moves,
      flow: this.flow, turrets: this.turrets, dock: this.dock, jump: this.jc, strike: this.strike,
      scene: () => this.scene, renderer: () => this.renderer, damageFx: () => this.fx.damageFx, bossFx: () => this.fx.bossFx, beamFx: () => this.fx.beamFx, scannerFx: () => this.fx.scannerFx,
      showMessage: (text, color) => opts.showMessage(text, color), toast: opts.toast ? (text, kind) => opts.toast!(text, kind) : undefined, sound,
    };
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

  /** The world as drawn, for where a shell is seen to strike (ships/drawnHit.ts) */
  private readonly drawnWorld: DrawnWorld;

  /** Is a raised shield's bubble at (x, y)? A shell's impact there is heard as shield_hit (audio/CombatSounds.ts) */
  shieldAt(x: number, y: number): boolean {
    return this.fx.damageFx?.bubbleAt(x, y) ?? false;
  }

  /** Ore you broke off came into your hold (serverMessages 'gained'): your progress ring's drop */
  minedDrop(): void {
    this.strike.minedDrop();
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
  ptMoves: PtMoves | null = null;
  /** The frame's message handler (Game's), for what the PT timeline draws between frames */
  private handler: ((m: ServerMessage) => void) | null = null;

  /** A fork of one body's moves, its runs beginning at `from` (the PT timeline's moves: predict/kinds/movesKind.ts) */
  forkMoves(from: number, id: number, read: MoveRunnerHost['read']): MoveRunner {
    return new MoveRunner({
      reps: this.replicas, bodies: this.bodies, store: this.store, tuning: this.opts.tuning, terrain: () => this.jc.terrain,
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

  // ---- Hits (hits/HitFlow.ts)
  /** A confirmed hits message: the messages the server would have sent go through `handle` (hits/HitFlow.ts) */
  onHits(msg: ServerHitsMessage, handle: (m: ServerMessage) => void): void { this.flow.onHits(msg, handle); }

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
    // (The server may hold another group selection for this ship: the next input carries ours)
    groupSelection.forget();
    this.own.start();
  }

  /** netCaps: finding hits here starts with the next snapshot; `lvl` is the confirmation level (hits/HitFlow.ts) */
  onNetCaps(lvl?: number): void { this.flow.onNetCaps(lvl); }

  /** A snapshot applied (its replicas, rows and removals): its shells onto the tick-faithful layer (hits/HitFlow.ts) */
  afterSnapshot(m: ServerSnapshotMessage): void { this.flow.afterSnapshot(m); }

  /** The frame's end: this frame's hits (found here and told) handed out, and into the chain */
  frameEnd(handle: (m: ServerMessage) => void): void {
    this.handler = handle;
    this.flow.frameEnd(handle, this.ptMoves);
  }

  /** A correction (hitFix): the hits missed worked out and drawn, the wrong ones taken back, the chain the server's */
  onHitFix(msg: ServerHitFixMessage, handle: (m: ServerMessage) => void): void { this.flow.onHitFix(msg, handle); }

  /** The hit report for this input tick, if one is due (`riding`: an input goes anyway) */
  takeHitReport(riding: boolean): HitReport | undefined { return this.flow.takeHitReport(riding); }

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
  onGunCtl(m: GunCtlRows): void {
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
    this.flow.findHits();
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
  /** Others' charge guns charging now (a charge-start fire event, until it fires or is let go): owner * 256 + part → the tick it started */
  get chargeTells(): Map<number, number> { return this.fire.chargeTells; }

  /** The gun behind a shell, with its look (guns/FireShells.ts shellInfo) */
  shellInfo(e: InterpolatedEntity): ShellLook | undefined { return this.fire.shellInfo(e); }

  /**
   * A snapshot arriving, before anything else: its keyframes and control
   * changes, then its fire events as shells (built from the firing ship's
   * replicated pose and its blueprint: common/src/ships/launch.ts)
   */
  preSnapshot(m: ServerSnapshotMessage): EntityState[] {
    this.flow.snapTick = m.tick;
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
    this.ownPresent.confirmOwnFires(m.tick);
    const keyed = !!m.ships?.some((k) => k[0] === this.opts.state.playerId) || this.own.syncedAt === m.tick, ended: number[] = [];
    out.push(...this.ownShells.snapshot(m.tick, ended, keyed));
    // (other ships' shells built here from their gun lanes: those whose life has ended; then this window's, as fire rows)
    this.otherGuns.expire(m.tick, ended);
    if (ended.length) { m.removed.push(...ended); this.selfHits.onRemoved(ended); }
    this.otherGuns.confirm(m);
    this.fire.fromFire(m, out);
    return out;
  }

  /** After a snapshot: ships that are gone (and new status rows get their hull %) */
  onReplication(m: ServerSnapshotMessage): void {
    for (const s of m.entities) if (s.type === EntityType.ShipBody) fillHull(this.store, this.opts.state.entities, s.id);
    // (debris it runs knocks in the world till the removal's tick: ShipReplicaSet.remove)
    for (const id of m.removed) { this.bodies.remove(id); this.causes.remove(id); this.replicas.remove(id, m.tick); }
    this.otherGuns.gone(m.removed);
    for (const id of m.out ?? []) { this.bodies.remove(id); this.causes.remove(id); this.replicas.remove(id); }
    // (the ships it holds now, for its check: CAPS.CAUSES)
    this.causes.noteHeld(m.tick);
    // (the pairs it found itself through the window: their ships' hits told, their sparks drawn, CAPS.CONTACTS)
    const found = this.contacts.endSnapshot(m.tick);
    this.flow.touched = found.touched;
    for (const fx of found.fx) this.fx.damageFx?.onContact({ type: 'contact', ...fx });
    for (const id of m.removed) this.guides.remove(id, m.tick);
    // (the shells it runs now, for its check: CAPS.WAYPOINTS)
    this.guides.noteHeld(m.tick);
  }

  // ---- Your own ship's tick layer, drawn (own/OwnPresent.ts)
  /** Your own ship stepped to `tick` on its tick layer (GameState, once per prediction tick); null: not on the layer yet */
  ownStepTo(tick: number): OwnStepped | null { return this.ownPresent.ownStepTo(tick); }

  /** Where your own ship is drawn at a fractional tick on its layer (a keyframe's or a re-step's change eased in) */
  ownPose(t: number): { x: number; y: number; angle: number } | null { return this.placement.ownPose(t); }

  /** Place a replicated ship for this frame (false: not one, or not ready yet) */
  placeReplica(e: InterpolatedEntity, renderTick: number): boolean { return this.placement.placeReplica(e, renderTick); }

  /** Another ship's volley drawn ahead of the snapshots (the PT timeline, predict/kinds/shellsKind.ts) */
  predictOtherVolley(owner: number, t: number, rec: LaneRec, pose: FlightBody, pilot: boolean): number[] { return this.ownPresent.predictOtherVolley(owner, t, rec, pose, pilot); }

  /** Take back a shell drawn ahead that never was */
  retractOther(handle: number): void { this.ownPresent.retractOther(handle); }

  /** The graphics tier's effect settings (kept for the effects made at init) */
  setQuality(q: QualityProfile): void { this.fx.setQuality(q); }

  init(app: Application, renderer: Renderer): void {
    void app;
    this.scene = renderer;
    this.placement.initGhosts(renderer.getShipLayer());
    this.renderer = new ShipRenderer(this.store, renderer, this.opts.state, (id) =>
      id === this.opts.state.playerId ? this.thrustCommand() : null,
    // Docked ships are inside their station: yours while you're berthed, others as the server says
    (id) => (id === this.opts.state.playerId ? this.dock.docked : this.replicas.isDocked(id)), this.features);
    wireRendererHooks({
      state: this.opts.state, store: this.store, placement: this.placement, jump: this.jc, fire: this.fire, drawnWorld: this.drawnWorld,
      strike: this.strike, ownPresent: this.ownPresent, localAim: () => this.opts.localAim(),
    }, renderer, this.renderer);
    this.fx.init(renderer, this.renderer);
  }

  // ---- Jump drive and the system's flight world (jump/JumpControl.ts)
  /** The local ship's jump drive phase (ready when there's no ship) */
  localJump(): ReturnType<typeof jumpPhase> { return this.jc.localJump(); }
  /** Jump range multiplier at a point (a star's charging ring), for a drive with `primed` ticks of a stillstone's priming */
  jumpBoostAt(x: number, y: number, primed = 0): number { return this.jc.jumpBoostAt(x, y, primed); }
  /** How far the local ship's drive reaches here */
  jumpReach(): number { return this.jc.jumpReach(); }
  /** Where the local ship's jump would stop it (null: no ship or no reach) */
  jumpLanding(): { x: number; y: number; reach: number } | null { return this.jc.jumpLanding(); }
  /** The charging fields the local ship is in now, and how long its drive stays primed (ticks) */
  localField(): JumpField & { prime: number } { return this.jc.localField(); }
  /** How brightly a stillstone's veins pulse: up as your drive charges in its field (0 when you're not in it) */
  lodestoneGlow(id: string): number { return this.jc.lodestoneGlow(id); }
  /** This system's stillstones (the map and markers draw them) */
  systemLodestones(): readonly LodestoneData[] { return this.jc.systemLodestones(); }
  /** Where a stillstone is now */
  lodestoneNow(l: LodestoneData): { x: number; y: number } { return this.jc.lodestoneNow(l); }
  /** The world the replicas fly in (gravity, the central body, lodestones, hazards, a surface's rock): the gun lanes' too */
  replicaEnv(): ReplicaEnv { return this.jc.replicaEnv(); }
  /** What's wrong with where the jump would drop you, if anything */
  jumpDanger(): string | null { return this.jc.jumpDanger(); }
  /** Is the pilot lining up a jump (key held, latched or spooling)? */
  jumpAiming(): boolean { return this.jc.jumpAiming(); }
  /** A charge under way: where it goes, locked as it started (null when not charging or there's no lock) */
  jumpLocked(): { angle: number; dist: number; label: string | null } | null { return this.jc.jumpLocked(); }
  /** Where the jump is aimed (Game sets it from the cursor, snapped to a destination) */
  setJumpAim(dist: number, label: string | null): void { this.jc.setJumpAim(dist, label); }
  /** The aim and distance the input says this tick, as the server gets them */
  setJumpSent(angle: number, dist: number): void { this.jc.setJumpSent(angle, dist); }
  /** Is the jump control on this tick? (J latches it; it releases once the burn starts.) */
  jumpHeld(): boolean { return this.jc.jumpHeld(); }
  /** How hard the well is pulling compared with what the ship can push back: 0..1 */
  horizonDanger(): number { return this.jc.horizonDanger(); }

  // ---- Readouts (hud/ShipReadouts.ts)
  /** The ship you fly (null between ships) */
  myShip(): ShipState | null { return this.readouts.myShip(); }
  /** Your ship's rating as it stands (ships/rating.ts) */
  myRating(): number { return this.readouts.myRating(); }
  localAccel(): number { return this.readouts.localAccel(); }
  /** How much harder the local ship's engines push boosting (×) */
  localBoostFactor(): number { return this.readouts.localBoostFactor(); }
  /** The menu's ship readout */
  menuShipInfo(): MenuShipInfo | null { return this.readouts.menuShipInfo(); }
  /** Your charge guns' charge, for the HUD (the fullest one being charged: 0..1), null when none is charging */
  gunCharge(): { charge: number; gun: WeaponInfo } | null { return this.readouts.gunCharge(); }
  /** The weapon ring's groups (ui/WeaponRing.ts): your guns by model, off your own predicted gun state */
  ringGroups(): RingGroup[] { return this.readouts.ringGroups(); }
  /** The weapon ring's chip, "L: 2  R: all" */
  ringChip(): string { return this.readouts.ringChip(); }
  /** Your pulse lasers' charge, for the HUD */
  laserCharge(): { charge: number; ready: number; total: number } | null { return this.readouts.laserCharge(); }
  /** All your ship's stored energy as one percentage (the HUD's gauge) */
  chargeTotal(charge: Charge): number { return this.readouts.chargeTotal(charge); }

  /** The Burst Strafer's dodge control this input tick (features/strafer: a press asks for one burst, the way you steer) */
  dodgeControl(): boolean {
    return this.dodgeCtl();
  }

  /** What the local pilot's keys ask the engines for (ship grid frame), for the thruster effects */
  private thrustCommand(): ThrustCommand {
    return localThrustCommand({
      state: this.opts.state, hangarOpen: () => this.hangarOpen, inputEnabled: this.opts.inputEnabled && (() => this.opts.inputEnabled!()),
      jumpPhase: () => this.jc.localJump().phase, helm: () => this.helm, noseThrust: this.opts.noseThrust && (() => this.opts.noseThrust!()),
      isKeyDown: (code) => this.opts.isKeyDown(code),
    });
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
    if (this.fx.jumpFx) this.fx.jumpFx.screenEffects = opts.jumpScreenEffects;
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

  /** Returns true when the message was a ship message (messages/ShipMessages.ts) */
  handleMessage(msg: ServerMessage): boolean {
    return handleShipMessage(this.msgHost, msg);
  }

  /** Your mining beam is on (for its sound) */
  get mining(): boolean {
    return this.fx.beamFx?.localActive ?? false;
  }

  /** Every ship's held beams lit this frame, as drawn (MiningBeamFx: yours as predicted, others' by their flag or piece clock) */
  litBeams(): readonly LitBeam[] {
    return this.fx.beamFx?.litBeams ?? [];
  }

  // ---- Docking (dock/DockControl.ts)
  /** The planet below you that you could land on (null: none); `verb`: what X does there ("Enter" a pocket's way in) */
  setPlanetHint(name: string | null, verb = 'Descend to'): void { this.dock.setPlanetHint(name, verb); }
  /** Name of the station whose docking ring we're in (for the menu) */
  dockableStationName(): string | null { return this.dock.dockableStationName(); }
  /** Open the hangar (from the station screen), on a slot or the ship you fly */
  openHangar(slot?: number): void {
    this.hangar.use((h) => h.open(slot));
  }
  /** Leave the berth (station screen closed) */
  undock(): void { this.dock.undock(); }
  /** Out of the berth by the server's hand (the gun range): nothing sent */
  leftBerth(): void { this.dock.leftBerth(); }
  /** The station whose docking ring we're inside, if any. (The server checks again when we dock.) */
  stationInRange(): InterpolatedEntity | null { return this.dock.stationInRange(); }
  isDocked(): boolean { return this.dock.isDocked(); }
  /** Berthed at a station (the server took the dock: it holds our controls neutral, so no inputs go: app/inputSend.ts) */
  berthed(): boolean { return this.dock.berthed(); }

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
      this.jc.press();
      return true;
    }
    if (code === 'KeyH') {
      this.dock.pressDock();
      return true;
    }
    return false;
  }

  /** Once per frame, after interpolation. */
  update(now: number): void {
    const { state } = this.opts, fx = this.fx, jc = this.jc;
    // (a ship kept while away keeps its structure: it comes back without a sync)
    this.store.prune((id) => state.entities.has(id) || this.away.has(id), now);

    // (The last ship flown, for the hangar while its sync is away)
    const mine = this.store.get(state.playerId);
    if (mine && mine.blueprint !== this.lastBlueprint) this.lastBlueprint = mine.blueprint;

    // Turret visuals at tick rate (firing itself is decided by the server)
    const ticks = Math.min(4, Math.floor((now - this.lastTurretFrame) / (1000 / 60)));
    if (ticks > 0) {
      this.lastTurretFrame = now;
      for (let t = 0; t < ticks; t++) { this.turrets.stepTurrets(); this.turrets.stepPointDefence(now); }
    }

    // (Part features: the pilot row's values, read before anything draws or shows them)
    { const mine = state.entities.get(state.playerId);
      if (mine) {
        if (mine.data && this.features.hasParsers) this.features.parsePilot(mine.data, chargeGroupsEnd(mine.data), mine.fx ??= {});
        else mine.fx = undefined;
      } }
    this.placement.trackOwn();
    this.renderer?.update();
    this.placement.drawGhosts();
    this.hud.update();
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    const me = state.entities.get(state.playerId);
    fx.jumpFx?.update(dt, {
      hidden: this.hangarOpen || !this.store.get(state.playerId) || inGunRange(), latched: jc.jumpLatched,
      aiming: jc.jumpAiming(), aimDist: jc.jumpLocked()?.dist ?? jc.jumpAimInfo.sent ?? jc.jumpAimInfo.dist, aimLabel: jc.jumpAimInfo.label,
      reach: jc.jumpReach(), landing: jc.jumpAiming() ? jc.jumpLanding() : null, field: me ? jc.gaugeField() : undefined, danger: jc.jumpAiming() ? jc.jumpDanger() : null,
    });
    // (Part features' chips: the Burst Strafer's, ready or cooling and whether the ship can pay; the Tow Beam's while it tows)
    this.features.updateIndicators();
    fx.damageFx?.update(dt);
    fx.beamFx?.update(dt);
    fx.chargeFx?.update(dt, Math.round(state.getRawServerTick()));
    // A shell heading at you that warns of it (the Leviathan): an arrow on the screen edge toward it
    if (this.scene && fx.incomingUI) fx.incomingUI.update(dt, this.scene.incomingShells, (x, y) => this.scene!.worldToScreen(x, y), this.scene.screenSize());
    fx.bossFx?.update(dt);
    fx.scannerFx?.update(dt, fx.zoom());
    this.strike.miningProgress?.update(dt, fx.zoom(), (id) => { const e = state.entities.get(id); return e?.type === EntityType.Asteroid ? e : undefined; });
    this.dock.update();
  }
}
