/**
 * @contract client.ship.turretVisuals
 * owns:       the look-only gimbal steps for turrets and fixed guns on ships whose guns this client does not step, and point-defence aim
 * needs:      TurretVisualsHost (store, state, tuning, localAim), common stepTurretAim/stepFixedGunAim/stepPointDefenceAim
 * invariants: point defence turns to its last intercept and rests after 900 ms — none pinned
 *             your own ship with prediction on is skipped (its guns are stepped on the tick layer) — none pinned
 * extend:     a new gimbal rule is one more branch in stepTurrets
 */

import { stepTurretAim, stepFixedGunAim, stepPointDefenceAim, pointDefenceOf, shipPointToWorld, unpackCursorWeaponState, EntityType, type ShipTuning } from '@space-game/common';
import type { GameState } from '../../state/GameState';
import type { ShipStore } from '../ShipStore';

export interface TurretVisualsHost {
  readonly store: ShipStore;
  readonly state: GameState;
  readonly tuning: ShipTuning;
  /** Local cursor in world units, for this client's own turrets */
  localAim(): { angle: number; dist: number };
}

export class TurretVisuals {
  constructor(private readonly h: TurretVisualsHost) {}
  /** Point-defence turrets' last shots, by ship × 1024 + part: where to point (they aim themselves: support.ts) */
  private pdAim = new Map<number, { x: number; y: number; at: number }>();

  /** An `intercept` message: the turret turns to where it fired (see stepPointDefence) */
  noteIntercept(bodyId: number, part: number, x: number, y: number): void {
    this.pdAim.set(bodyId * 1024 + part, { x, y, at: performance.now() });
  }

  /**
   * Point-defence turrets don't follow the cursor: each turns to where it last fired (an `intercept`), and back to rest
   * a moment after (the server aims them; this is only how they look)
   */
  stepPointDefence(now: number): void {
    const { state, tuning } = this.h;
    for (const [key, a] of this.pdAim) if (now - a.at > 900) this.pdAim.delete(key);
    for (const [id, ship] of this.h.store.bodies) {
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
  stepTurrets(): void {
    const { state, tuning } = this.h;
    const weapons = tuning.weapons ?? {};
    for (const [id, ship] of this.h.store.bodies) {
      if (ship.kind !== 'ship' || !ship.derived.weapons.length) continue;
      const e = state.entities.get(id);
      if (!e) continue;
      let angle: number, dist: number;
      if (id === state.playerId && state.predictionEnabled) continue;
      if (id === state.playerId) {
        ({ angle, dist } = this.h.localAim());
      } else if (e.type === EntityType.Player && e.data && e.data.length >= 1) {
        angle = unpackCursorWeaponState(e.data[0]).aimAngle;
        dist = e.data[2] ?? 0;
      } else continue;
      const pose = { x: e.renderX, y: e.renderY, angle: e.renderAngle };
      const ax = pose.x + Math.cos(angle) * dist, ay = pose.y + Math.sin(angle) * dist;
      for (const w of ship.derived.weapons) {
        // (Point defence aims itself: stepPointDefence)
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
