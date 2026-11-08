/**
 * @contract client.ship.placement
 * owns:       where replicated ships are drawn each frame (pose, docked-to-you placement, pilot data rows), a ship's side bits and the far-ship ghosts
 * needs:      PlacementHost (state, store, replicas, own, otherGuns, scene), GhostLayer, features/clamp dockedDraw; npm: @space-game/common
 * invariants: a keyframe correction is already blended into the pose: drawn as it is — server/src/golden/parity.test.ts
 *             a ship docked to yours is placed at your draw tick — none pinned
 * extend:     a new per-pilot data column is one more entry in placeReplica's data row
 */

import { EntityType, SIDE, ghostWeight, FOCUS_RANGE, packCursorWeaponState, type ShipReplicaSet } from '@space-game/common';
import type { GameState, InterpolatedEntity } from '../../state/GameState';
import type { Renderer } from '../../rendering/Renderer';
import type { ShipStore } from '../ShipStore';
import type { OwnTick } from '../own/OwnTick';
import type { OtherGuns } from '../guns/OtherGuns';
import { GhostLayer, type Ghost } from '../cells/GhostLayer';
import { dockedPlace, type Place } from '../features/clamp/dockedDraw';
import { bossRise } from '../bossLife';

export interface PlacementHost {
  readonly state: GameState;
  readonly store: ShipStore;
  readonly replicas: ShipReplicaSet;
  readonly own: OwnTick;
  readonly otherGuns: OtherGuns;
  scene(): Renderer | null;
}

export class ReplicaPlacement {
  constructor(private readonly h: PlacementHost) {}
  private readonly dockedAt: Place = { x: 0, y: 0, angle: 0 };

  private ghosts: GhostLayer | null = null;

  private ghostList: Ghost[] = [];

  private ghostOwn = { x: 0, y: 0 };

  /** The focus radius in effect (a crowd shrinks it: GameState.crowd): the ghost fade is its last km */
  private ghostFocus = FOCUS_RANGE;

  /** A ship docked to yours, drawn on your ship as drawn (features/clamp dockedDraw) */
  private placeDocked(e: InterpolatedEntity): void {
    const self = this.h.state.playerId, t = this.h.state.ownDrawTick(), own = this.ownPose(t);
    if (!own || !dockedPlace(this.h.replicas.clamps.recAt(self, Math.floor(t)), self, e.id, own, this.dockedAt)) return;
    e.renderX = e.x = this.dockedAt.x;
    e.renderY = e.y = this.dockedAt.y;
    e.renderAngle = e.angle = this.dockedAt.angle;
  }

  /** Place a replicated ship for this frame (false: not one, or not ready yet) */
  placeReplica(e: InterpolatedEntity, renderTick: number): boolean {
    const p = this.h.replicas.pose(e.id, renderTick);
    if (!p) return false;
    // (A keyframe's correction is already blended into the pose (ShipReplicaSet.pose): drawn as it is. Easing the
    // drawn position here as well trailed any ship moving more than 4 units a frame, a boss tens of units behind.)
    e.x = p.x; e.y = p.y; e.angle = p.angle; e.vx = p.vx; e.vy = p.vy;
    e.renderX = p.x;
    e.renderY = p.y;
    e.renderAngle = p.angle;
    // (Docked to you: drawn on your ship as drawn, at your tick, not trailing it at the render tick)
    if (this.h.replicas.clamps.size && this.h.own.on) this.placeDocked(e);
    e.angVel = 0;
    // (Its Burst Strafer's dodge: the jets, ShipRenderer)
    e.dodge = p.dodge;
    e.dodgeDir = p.dodgeDir;
    if (e.type === EntityType.Player) {
      // Rebuild the per-pilot data the effects read (see the server's player snapshot row)
      const s = e.status ?? [];
      e.data = [
        packCursorWeaponState(p.aim, (s[2] ?? 10) / 10, s[3] === 1, s[4] === 1),
        // (its cursor distance: from its gun lane where this client steps one, eased between the rough idle
        // updates, else the status row's hundreds)
        0, this.h.otherGuns.distAt(e.id, renderTick) ?? (s[5] ?? 0) * 100, p.jump, s[0] ?? 0, s[1] ?? 0, Math.round(p.jumpScale * 1000), 0,
      ];
    }
    return true;
  }

  /** Where your own ship is drawn at a fractional tick on its layer (a keyframe's or a re-step's change eased in) */
  ownPose(t: number): { x: number; y: number; angle: number } | null {
    return this.h.own.on ? this.h.replicas.pose(this.h.state.playerId, t) : null;
  }

  /** A ship's side, as this client knows it (hitRules SIDE bits: who may hurt whom) */
  sideOf(id: number): number {
    const { state } = this.h;
    const e = state.entities.get(id), d = e?.data;
    const pilot = id === state.playerId || e?.type === EntityType.Player;
    const side = !pilot && e?.type === EntityType.ShipBody && d ? d[10] : 0;
    return (pilot ? SIDE.PILOT : 0) | (side === 1 ? SIDE.WARD : 0) | (side === 2 ? SIDE.PERSON : 0) | (this.h.replicas.isDocked(id) ? SIDE.DOCKED : 0);
  }

  /** The focus grid's ghosts this frame: the ring's ships from their legs, and held ships 18 km off and more */
  drawGhosts(): void {
    const state = this.h.state, scene = this.h.scene();
    if (!this.ghosts || !scene) return;
    const list = this.ghostList;
    list.length = 0;
    for (const [id, e] of state.entities) {
      if (id === state.playerId || (e.type !== EntityType.Player && e.type !== EntityType.ShipBody) || !this.h.store.get(id)) continue;
      const w = ghostWeight(Math.hypot(e.renderX - this.ghostOwn.x, e.renderY - this.ghostOwn.y), this.ghostFocus);
      if (w > 0) list.push({ x: e.renderX, y: e.renderY, kind: e.type === EntityType.Player ? 4 : e.data?.[0] ?? 0, rank: e.type === EntityType.ShipBody ? (e.data?.[4] ?? 0) : 0, w });
    }
    for (const f of state.farShips.list(state.systemId, state.getRawServerTick(), (id) => state.entities.has(id) || id === state.playerId)) {
      list.push({ x: f.renderX, y: f.renderY, kind: f.kind, rank: f.rank, w: 1 });
    }
    this.ghosts.draw(list, scene.getZoom(), (x, y) => scene.inView(x, y, 400));
  }

  /** The ghost layer, on the ship layer (Renderer init) */
  initGhosts(layer: ConstructorParameters<typeof GhostLayer>[0]): void {
    this.ghosts = new GhostLayer(layer);
  }

  /** A ship's fade to its ghost: 1 = fully drawn (a lair boss rising out of its lair or sinking back counts: ships/bossLife.ts) */
  ghostOf(id: number): number {
    const rise = bossRise(id, this.h.state.renderTickNow);
    if (id === this.h.state.playerId) return 1 - rise;
    const e = this.h.state.entities.get(id);
    const g = e ? ghostWeight(Math.hypot(e.renderX - this.ghostOwn.x, e.renderY - this.ghostOwn.y), this.ghostFocus) : 0;
    return 1 - (1 - g) * rise;
  }

  /** Once per frame, before drawing: where the ghost fade is measured from */
  trackOwn(): void {
    const state = this.h.state, me = state.entities.get(state.playerId);
    if (me) { this.ghostOwn.x = me.renderX; this.ghostOwn.y = me.renderY; }
    this.ghostFocus = state.crowd.focus;
  }
}
