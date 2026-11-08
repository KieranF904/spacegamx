/**
 * @contract client.ship.ownPresent
 * owns:       what your own ship's tick layer fired, drawn as the prediction reaches each tick, and confirmed to OwnShells when a snapshot lands
 * needs:      OwnPresentHost (store, state, tuning, own, replicas, ownShells, gunFeel, scene, beamFx, docked, jump, ownAmmo), common fireVolley/gunControls
 * invariants: each tick's events are drawn once — none pinned
 *             no volley is drawn while berthed — none pinned
 * extend:     a new own-ship gun event kind is one more branch in presentOwn
 */

import { cloneCharge, GUN_ARRAYS, gunScalarsOntoRecord, gunControls, GUN_FX, ammoCodeOfMods, fireVolley, firesStraight, partWeaponDef, WEAPON_KIND_TYPE, jumpPhase, type SimShipState, type ShipState, type ShipTuning, type JumpTuning, type WeaponMods, type LaneRec, type FlightBody, type ShipReplicaSet } from '@space-game/common';
import type { GameState, OwnStepped } from '../../state/GameState';
import type { Renderer } from '../../rendering/Renderer';
import type { ShipStore } from '../ShipStore';
import type { GunFeel } from '../gunFeel';
import type { MiningBeamFx } from '../MiningBeamFx';
import type { OwnShells } from '../hits/OwnShells';
import type { OwnTick, OwnTickEvents } from './OwnTick';
import { AUG } from '../../rendering/weapons/weaponStyles';
import { straightLife } from '../guns/FireShells';

export interface OwnPresentHost {
  readonly store: ShipStore;
  readonly state: GameState;
  readonly tuning: ShipTuning;
  readonly own: OwnTick;
  readonly replicas: ShipReplicaSet;
  readonly ownShells: OwnShells;
  readonly gunFeel: GunFeel;
  readonly jump: JumpTuning;
  scene(): Renderer | null;
  beamFx(): MiningBeamFx | null;
  docked(): boolean;
  /** The ammunition your guns of a kind fire next (ShipClient.ownAmmo) */
  ownAmmo(): ((kind: string) => WeaponMods | undefined) | undefined;
}

/** The own layer's events handed out per tick (OwnPresent.ownStepTo's scratch) */
const OWN_EVENTS: OwnTickEvents[] = [];
const CONFIRMED: OwnTickEvents[] = [];

export class OwnPresent {
  constructor(private readonly h: OwnPresentHost) {}
  /** Your held beams on the newest tick drawn (by part), so your own beam shows the moment it fires, as your shells do */
  readonly ownBeams = new Set<number>();

  /** Was your trigger held on the last predicted tick (the guide line shows only while it is) */
  fireHeld = false;

  /** The ammunition each own volley was drawn with (by tick * 256 + part), for the shells built on the tick layer */
  private readonly ownAmmoAt = new Map<number, number>();

  /**
   * Your own ship stepped to `tick` on its tick layer (GameState, once per prediction tick: OwnTick's whole step, each
   * tick once), what it fired on the ticks it got to drawn now (presentOwn), and its state there. Null: not on the
   * layer yet (no keyframe of it), or not flying one
   */
  ownStepTo(tick: number): OwnStepped | null {
    const self = this.h.state.playerId;
    if (!this.h.own.on) return null;
    const st = this.h.replicas.at(self, tick);
    if (!st) return null;
    const ship = this.h.store.get(self);
    if (ship && ship.kind === 'ship') for (const e of this.h.own.takeEvents(tick, OWN_EVENTS)) this.presentOwn(ship, e);
    const x = this.h.own.extrasAt(tick);
    return { body: st.body, charge: x ? cloneCharge(x.charge) : undefined, jumpPrime: x?.jumpPrime ?? st.body.jumpPrime ?? 0 };
  }

  /**
   * What your guns did on one tick of your own ship's step (OwnTick's whole step: the same gun core as the server's
   * fireWeapons, common sim/guns.ts), drawn as the prediction reaches that tick, once: its shells from its fire events
   * (built on the ship as it fired), pulses and beams, the guns' sounds and HUD from the gun state it ended with
   */
  private presentOwn(ship: ShipState, e: OwnTickEvents): void {
    const { tick, events, state } = e;
    const scene = this.h.scene();
    if (this.h.docked() || !scene) return;
    this.ownBeams.clear();
    // (Your gun state as of the newest tick drawn: the HUD's ring, turrets, the gun sounds read it off your ship's record)
    mirrorGuns(ship, state);
    // (No firing mid-jump, nor knocked out by an EMP: the trigger as the step read it, common sim/guns.ts)
    const input = this.h.own.inputAt(tick);
    const burning = jumpPhase(state.body.jump ?? 0, this.h.jump).phase === 'burn' || tick < state.hazard.empUntil;
    this.fireHeld = gunControls(ship, input.fire, input.fireAlt, burning, input.sel).firing;
    this.h.gunFeel.own(ship, tick);
    const pose = { x: state.body.x, y: state.body.y, angle: state.body.angle };
    for (const ev of events) {
      if (ev.k === 'fx') {
        if (ev.fx === GUN_FX.beam) this.ownBeams.add(ev.part);
        else if (ev.fx === GUN_FX.pulse) this.h.beamFx()?.startPulse(ship.id, ev.part, tick);
        continue;
      }
      // (a volley: its first barrel's event builds it)
      if (ev.k !== 'fire' || ev.barrel !== 0) continue;
      const w = ship.derived.weapons.find((x) => x.part === ev.slot);
      if (!w) continue;
      // (Homing missiles change course: those the server sends as they fly)
      const pdef = partWeaponDef(this.h.tuning, w.kind, ship.blueprint.parts[w.part], w);
      if (!firesStraight(pdef)) continue;
      const aug = (ev as { aug?: 1 }).aug, ammo = ammoCodeOfMods(this.h.ownAmmo()?.(w.kind));
      const fire = { owner: ship.id, tick, part: w.part, aimQ: ev.aimQ, ammo, aug };
      // (the ammunition it fired, for your own shells on the tick layer, built when a snapshot confirms the tick: confirmOwnFires)
      this.ownAmmoAt.set(tick * 256 + w.part, ammo);
      while (this.ownAmmoAt.size > 256) this.ownAmmoAt.delete(this.ownAmmoAt.keys().next().value!);
      // A pilot's shells move on the tick they're fired (as in preSnapshot)
      const v = fireVolley(fire, ship, { ...pose, vx: state.body.vx, vy: state.body.vy }, this.h.tuning);
      if (!v) continue;
      for (const sh of v.shells) {
        scene.predictShot({ owner: ship.id, type: WEAPON_KIND_TYPE[w.kind] ?? 1, grade: w.grade, model: (ship.blueprint.parts[w.part]?.fn ?? '') + (aug ? AUG : ''), damage: pdef.damage, pierce: pdef.pierce, life: straightLife(pdef, sh.life), arm: pdef.arm, turret: v.turret, spawnX: sh.x, spawnY: sh.y, spawnTick: tick - 1, vx: sh.vx, vy: sh.vy, size: sh.size, pose });
      }
    }
  }

  /**
   * Another ship's volley drawn ahead of the snapshots (the PT timeline, predict/kinds/shellsKind.ts): fired on tick t
   * from `pose` (a pilot's shells move on their fire tick: spawned a tick earlier, as the fire rows have it). The drawn
   * shells' handles (the snapshot's built shell, the same shot, takes one over: WeaponFx.claim)
   */
  predictOtherVolley(owner: number, t: number, rec: LaneRec, pose: FlightBody, pilot: boolean): number[] {
    const ship = this.h.store.get(owner), scene = this.h.scene();
    if (!ship || ship.kind !== 'ship' || !scene) return [];
    const w = ship.derived.weapons.find((x) => x.part === rec.part);
    if (!w) return [];
    const v = fireVolley({ owner, tick: t, part: rec.part, aimQ: rec.aimQ, ammo: 0, aug: rec.aug ? 1 : undefined }, ship, pose, this.h.tuning);
    if (!v) return [];
    const pdef = partWeaponDef(this.h.tuning, w.kind, ship.blueprint.parts[w.part], w), at = { x: pose.x, y: pose.y, angle: pose.angle };
    const model = (ship.blueprint.parts[w.part]?.fn ?? '') + (rec.aug ? AUG : '');
    return v.shells.map((sh) => scene.predictShot({ owner, type: WEAPON_KIND_TYPE[w.kind] ?? 1, grade: w.grade, model, damage: pdef.damage, pierce: pdef.pierce, life: straightLife(pdef, sh.life), arm: pdef.arm, turret: v.turret, spawnX: sh.x, spawnY: sh.y, spawnTick: pilot ? t - 1 : t, vx: sh.vx, vy: sh.vy, size: sh.size, pose: at }));
  }

  /** Take back a shell drawn ahead that never was */
  retractOther(handle: number): void {
    this.h.scene()?.retractShot(handle);
  }

  /**
   * Your own straight shells on the tick layer (OwnShells): the volleys your own layer fired through a snapshot's tick,
   * as it has them once that snapshot is in (its keyframe, causes and ownSync)
   */
  confirmOwnFires(tick: number): void {
    const self = this.h.state.playerId, ship = this.h.store.get(self);
    if (!this.h.own.on || !ship || ship.kind !== 'ship' || !this.h.replicas.at(self, tick)) return;
    for (const { tick: t, events } of this.h.own.takeConfirmed(tick, CONFIRMED)) {
      for (const ev of events) {
        if (ev.k !== 'fire' || ev.barrel !== 0) continue;
        const aug = (ev as { aug?: 1 }).aug, w = ship.derived.weapons.find((x) => x.part === ev.slot);
        if (!w) continue;
        const ammo = this.ownAmmoAt.get(t * 256 + w.part) ?? ammoCodeOfMods(this.h.ownAmmo()?.(w.kind));
        if (this.h.ownShells.derivable(ship, w.part + 256 * ammo + (aug ? 65536 : 0))) this.h.ownShells.fired({ tick: t, part: w.part, aimQ: ev.aimQ, ammo, aug });
      }
    }
  }
}

/** A step's gun state onto your ship's record (what the HUD, turrets and gun sounds read), its arrays kept */
function mirrorGuns(ship: ShipState, st: Readonly<SimShipState>): void {
  const g = st.guns;
  for (const k of GUN_ARRAYS) copyInto(ship[k], g[k]);
  gunScalarsOntoRecord(g, ship);
}

function copyInto(to: number[], from: readonly number[]): void {
  to.length = from.length;
  for (let i = 0; i < from.length; i++) to[i] = from[i];
}
