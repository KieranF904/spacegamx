/**
 * @contract client.ship.fire-shells
 * owns:       other ships' fire events turned into shells, charge tells and sounds, plus the look (model, damage) each shell was fired with
 * needs:      FireShellsHost (store, state, tuning, own.firePose, replicas.preAt, gunFeel, otherGuns.built, beamFx), common rebuildVolley/partWeaponDef
 * invariants: a fire event's shells are rebuilt exactly as the server spawned them — client/src/ships/guns/FireShells.test.ts
 *             tell codes (TELL_*) never build shells — client/src/ships/guns/FireShells.test.ts
 * extend:     a new fire-event tell is one more `if (ammo === TELL_X)` branch in fromFire
 */

import { SHOT_AIM_STEPS, TELL_CHARGE_START, TELL_CHARGE_CANCEL, TELL_BEAM_PIECE, TELL_MINE_PULSE, TELL_NONE, TELL_PD, endsAtAim, rebuildVolley, partWeaponDef, shipPointToWorld, WEAPON_KIND_TYPE, EntityType, type EntityState, type ServerSnapshotMessage, type ShipTuning, type WeaponInfo } from '@space-game/common';
import type { GameState, InterpolatedEntity } from '../../state/GameState';
import type { ShipStore } from '../ShipStore';
import type { GunFeel } from '../gunFeel';
import type { MiningBeamFx } from '../MiningBeamFx';
import type { OtherGuns } from './OtherGuns';
import type { OwnTick } from '../own/OwnTick';
import type { ShipReplicaSet } from '@space-game/common';
import type { ShellLook } from '../../rendering/weapons/WeaponFx';
import { AUG } from '../../rendering/weapons/weaponStyles';

export interface FireShellsHost {
  readonly store: ShipStore;
  readonly state: GameState;
  readonly tuning: ShipTuning;
  readonly own: OwnTick;
  readonly replicas: ShipReplicaSet;
  readonly gunFeel: GunFeel;
  readonly otherGuns: OtherGuns;
  beamFx(): MiningBeamFx | null;
}

/**
 * The ticks a straight shell flies before the server drops it (its life: WeaponFx ends its flight there, however late
 * the removal comes); none for a shell whose life the server changes (one that ends at the aim, one that sticks in rock)
 */
export function straightLife(def: { stick?: unknown } & Parameters<typeof endsAtAim>[0], life: number | undefined): number | undefined {
  return life && !endsAtAim(def) && !def.stick ? life : undefined;
}

export class FireShells {
  constructor(private readonly h: FireShellsHost) {}
  /** Fire-event shells' firing poses (WeaponFx asks once, when it first sees the shell) */
  private firePoses = new Map<number, { x: number; y: number; angle: number }>();
  /**
   * Fire-event shells' gun model and damage, by shell id: client-only, kept from the fire event so the look survives the
   * server row taking the shell over (WeaponFx asks once, as it first sees the shell; shells first seen in a snapshot
   * have no entry and take their kind's look)
   */
  private shellLooks = new Map<number, ShellLook>();
  /** Others' charge guns charging now (a charge-start fire event, until it fires or is let go): owner * 256 + part → the tick it started */
  readonly chargeTells = new Map<number, number>();
  /** ...and the stop for the whine each started (cut by a cancel) */
  private readonly tellSounds = new Map<number, (() => void) | null>();

  /** The gun model a shell was fired with, where known (the look kept from its fire event) */
  modelOf(id: number): string | undefined {
    return this.shellLooks.get(id)?.model;
  }

  /** A shell's firing pose, handed out once (WeaponFx asks as it first sees the shell) */
  takeFirePose(id: number): { x: number; y: number; angle: number } | undefined {
    const p = this.firePoses.get(id);
    this.firePoses.delete(id);
    return p;
  }

  /**
   * The gun behind a shell: from its fire event if it came by one, else (shells sent as rows: homing, aimed, guided)
   * worked out from its owner's guns, the one of its weapon type whose muzzle was nearest where it spawned. Kept per
   * shell id (WeaponFx and the landing rings both ask).
   */
  shellInfo(e: InterpolatedEntity): ShellLook | undefined {
    let l = this.shellLooks.get(e.id);
    if (l) return l;
    const owner = e.data?.[6] ?? -1, type = e.data?.[0] ?? -1;
    const ship = this.h.store.get(owner), ent = this.h.state.entities.get(owner);
    if (!ship || ship.kind !== 'ship' || !ent) return undefined;
    const sx = e.spawnX ?? e.x, sy = e.spawnY ?? e.y;
    const pose = { x: ent.renderX, y: ent.renderY, angle: ent.renderAngle };
    let best: WeaponInfo | null = null, bd = Infinity;
    for (const w of ship.derived.weapons) {
      if ((WEAPON_KIND_TYPE[w.kind] ?? 1) !== type) continue;
      const [mx, my] = shipPointToWorld(ship, pose, w.window ? w.window.pivot : w.muzzle, this.h.tuning.cellSize);
      const d = Math.hypot(mx - sx, my - sy);
      if (d < bd) { bd = d; best = w; }
    }
    if (!best) return undefined;
    const part = ship.blueprint.parts[best.part];
    const def = partWeaponDef(this.h.tuning, best.kind, part, best);
    l = { model: part?.fn, damage: def.damage, splash: def.splash?.radius, pierce: def.pierce, arm: def.arm };
    this.shellLooks.set(e.id, l);
    while (this.shellLooks.size > 512) this.shellLooks.delete(this.shellLooks.keys().next().value!);
    return l;
  }

  /**
   * A snapshot's fire events: tells (charge, beam piece, mining pulse) acted on, volleys rebuilt as the server spawned
   * them and pushed onto `out` as projectile rows. `m.tick` is the snapshot's tick
   */
  fromFire(m: ServerSnapshotMessage, out: EntityState[]): void {
    for (const [owner, ago, partAmmo, aimQ, ...ids] of m.fire ?? []) {
      const tick = m.tick - ago, part = partAmmo % 256, ammo = Math.floor(partAmmo / 256) % 256, aug = partAmmo >= 65536 ? (1 as const) : undefined;
      // A charge gun's tell (no shells): it started charging, or was let go (guns.ts TELL_CHARGE_*; drawn by the charge FX)
      if (ammo === TELL_CHARGE_START) {
        this.chargeTells.set(owner * 256 + part, tick);
        // (The whine of another ship's gun: yours is heard off your own gun state, gunFeel.ts)
        const src = owner !== this.h.state.playerId ? this.h.store.get(owner) : null, ent = this.h.state.entities.get(owner);
        const gun = src?.derived.weapons.find((w) => w.part === part);
        if (gun && ent) {
          this.tellSounds.get(owner * 256 + part)?.();
          this.tellSounds.set(owner * 256 + part, this.h.gunFeel.otherCharge({ x: ent.renderX, y: ent.renderY }, gun));
          while (this.tellSounds.size > 64) this.tellSounds.delete(this.tellSounds.keys().next().value!);
        }
        continue;
      }
      // A beam in pieces spent a piece (no shells): its pulse runs from that tick (power/ports.ts; drawn by MiningBeamFx)
      if (ammo === TELL_BEAM_PIECE) { this.h.beamFx()?.startPiece(owner, part, tick); continue; }
      // A ports ship's mining laser started a pulse (its aim field: the fulfilment it started at, 0..255)
      if (ammo === TELL_MINE_PULSE) { this.h.beamFx()?.startMinePulse(owner, part, tick, aimQ / 255); continue; }
      // (Nothing fired there, a point-defence shot: for the gun lanes, OtherGuns.confirm; drawn by nothing, or its intercept)
      if (ammo === TELL_NONE || ammo === TELL_PD) continue;
      if (ammo === TELL_CHARGE_CANCEL) {
        this.chargeTells.delete(owner * 256 + part);
        this.tellSounds.get(owner * 256 + part)?.();
        this.tellSounds.delete(owner * 256 + part);
        continue;
      }
      const ship = this.h.store.get(owner);
      // (Your own shells that come as fire events (not built by OwnShells): from your ship on the tick layer where it was
      // as its guns fired, before that tick's pulls and contacts (OwnTick.firePose), not your prediction. Your drawn
      // shells are your prediction's, WeaponFx)
      const fp = owner === this.h.state.playerId && this.h.own.on ? this.h.own.firePose(tick) : null;
      // (another ship where it was as its guns fired: before that tick's causes)
      const pose = fp ?? this.h.replicas.preAt(owner, tick), st = pose ? { body: pose } : null;
      if (!ship || !st) continue;
      this.chargeTells.delete(owner * 256 + part);
      this.tellSounds.delete(owner * 256 + part);
      // Another ship's clip gun: count its rounds, the vent on the last
      if (owner !== this.h.state.playerId) {
        const gun = ship.derived.weapons.find((w) => w.part === part);
        if (gun) this.h.gunFeel.otherRound(owner, gun, tick, { x: st.body.x, y: st.body.y });
      }
      while (this.chargeTells.size > 256) this.chargeTells.delete(this.chargeTells.keys().next().value!);
      // A pulse laser's pulse (a fire event with no shells): drawn from the tick it started
      const gun = ship.derived.weapons.find((w) => w.part === part);
      // (Another ship's gun points where this shot left: a pilotless ship's aim is known only from its shots; a pilot's
      // follows their cursor between them, stepTurretVisuals)
      if (gun && owner !== this.h.state.playerId && !this.h.tuning.weapons?.[gun.kind]?.pointDefence) ship.aim[part] = aimQ / SHOT_AIM_STEPS;
      if (gun && this.h.tuning.weapons?.[gun.kind]?.pulse) { this.h.beamFx()?.startPulse(owner, part, tick); continue; }
      const v = rebuildVolley({ owner, tick, part, aimQ, ids, ammo, aug }, ship, st.body, this.h.tuning);
      if (!v) continue;
      // The ship's pose as it fired: the muzzle flash sits on the barrel in its frame
      for (const id of ids) this.firePoses.set(id, { x: st.body.x, y: st.body.y, angle: st.body.angle });
      while (this.firePoses.size > 512) this.firePoses.delete(this.firePoses.keys().next().value!);
      // The gun's model and what a shot of it does (a model's look; the flash, recoil and impact scale with the damage)
      const wdef = partWeaponDef(this.h.tuning, v.kind, ship.blueprint.parts[part], gun);
      // (An augmented shot looks charged up: weaponStyles AUG)
      const fn = ship.blueprint.parts[part]?.fn, look = { model: fn && aug ? fn + AUG : fn, damage: wdef.damage, splash: wdef.splash?.radius, pierce: wdef.pierce, life: straightLife(wdef, v.shells[0]?.life), arm: wdef.arm };
      for (const id of ids) this.shellLooks.set(id, look);
      while (this.shellLooks.size > 512) this.shellLooks.delete(this.shellLooks.keys().next().value!);
      // A pilot's shots move on the tick they're fired (they're fired before shells move; pilotless ships' after)
      const spawnTick = this.h.state.entities.get(owner)?.type === EntityType.Player ? tick - 1 : tick;
      // (Its gun's grade, as the server's shells carry it: each mark's shells look their own way)
      const grade = ship.derived.weapons.find((w) => w.part === part)?.grade ?? 1;
      for (const s of v.shells) {
        const age = m.tick - spawnTick;
        // (built from a gun lane: it ends on its own, OtherGuns.expire)
        this.h.otherGuns.built(s.id, tick + s.life - 1);
        out.push({
          id: s.id, type: EntityType.Projectile, x: s.x + s.vx * age, y: s.y + s.vy * age, vx: s.vx, vy: s.vy,
          // (no end; the gun as the fire event packs it, which a confirmed hit works out from: data[10])
          data: [WEAPON_KIND_TYPE[v.kind] ?? 1, grade, (owner * 137) % 360, spawnTick, s.x, s.y, owner, s.size, v.turret ? 1 : 0, 0, partAmmo],
        });
      }
    }
  }
}
