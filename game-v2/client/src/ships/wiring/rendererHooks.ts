/**
 * @contract client.ship.renderer-hooks
 * owns:       the callbacks the scene renderer calls into the ship client for (muzzle kicks, barrel tips, shell looks and fire poses, struck surfaces, drawn-hit casts, guide line, flak burst marks)
 * needs:      RendererHooksHost (state, store, placement, jump, fire, drawnWorld, strike, ownPresent, localAim), Renderer hook fields
 * invariants: every drawn shell stops at the first drawn surface it touches — client/src/ships/drawnHit.test.ts
 * extend:     a new renderer callback is one more assignment below
 */

import type { GameState } from '../../state/GameState';
import type { Renderer } from '../../rendering/Renderer';
import type { ShipStore } from '../ShipStore';
import type { ShipRenderer } from '../ShipRenderer';
import type { ReplicaPlacement } from '../replicas/ReplicaPlacement';
import type { JumpControl } from '../jump/JumpControl';
import type { FireShells } from '../guns/FireShells';
import type { DrawnWorld } from '../drawnHit';
import type { StrikeFx } from '../hits/StrikeFx';
import type { OwnPresent } from '../own/OwnPresent';
import { hitSurface } from '../hitSurface';
import { groupSelection } from '../weaponGroups/selection';

export interface RendererHooksHost {
  readonly state: GameState;
  readonly store: ShipStore;
  readonly placement: ReplicaPlacement;
  readonly jump: JumpControl;
  readonly fire: FireShells;
  readonly drawnWorld: DrawnWorld;
  readonly strike: StrikeFx;
  readonly ownPresent: OwnPresent;
  localAim(): { angle: number; dist: number };
}

export function wireRendererHooks(h: RendererHooksHost, renderer: Renderer, ship: ShipRenderer): void {
  // (Holding cells: a ship 18 km off and more fades to its ghost, GhostLayer)
  ship.ghostOf = (id) => h.placement.ghostOf(id);
  const cursorPoint = { x: 0, y: 0 };
  renderer.onMuzzle = (owner, x, y, power) => {
    ship.kick(owner, x, y, power);
    // A heavy shot shoves the shooter's view (a small nudge, only for your own gun)
    if (owner === h.state.playerId && power > 1.3) h.state.triggerScreenShake(1.2 * (power - 1.2), 0.12);
  };
  renderer.spinAtOf = (owner, x, y) => ship.spinAt(owner, x, y) ?? 0;
  // Muzzle flashes (and the shells' first stretch) from the drawn barrel's tip, not the facing edge they spawn at
  renderer.barrelTip = (owner, x, y, angle) => ship.barrelTip(owner, x, y, angle) ?? null;
  renderer.lodestoneGlow = (id) => h.jump.lodestoneGlow(id);
  renderer.firePoseOf = (id) => h.fire.takeFirePose(id);
  renderer.shellLookOf = (id, e) => h.fire.shellInfo(e);
  // The surface a shell struck (its impact throws off it: WeaponFx.surfaceAt), from the drawn ships and rocks
  renderer.surfaceAt = (x, y, dx, dy, owner, out) => hitSurface(h.store, h.state, x, y, dx, dy, owner, out);
  // Every drawn shell stops at the first drawn surface it touches (ships/drawnHit.ts), and its hit shows there
  renderer.castHit = (x0, y0, x1, y1, owner, skip, out) => h.drawnWorld.cast(x0, y0, x1, y1, owner, skip, out);
  renderer.onStruck = (id, x, y, type, target, owner) => h.strike.struck(id, x, y, type, target, owner);
  // Your mining progress: a ring round the rock you're working, filling towards your next drop (when it drops is public: common econ/miningChunks.ts)
  h.strike.init(renderer.getEffectLayer());
  // The cursor in the world: in a bunch of ships, the one under it keeps its name (ships/render/labelCrowd.ts)
  const pointerPoint = { x: 0, y: 0 };
  renderer.pointerWorld = () => {
    const me = h.state.entities.get(h.state.playerId);
    if (!me) return null;
    const a = h.localAim();
    pointerPoint.x = me.renderX + Math.cos(a.angle) * a.dist;
    pointerPoint.y = me.renderY + Math.sin(a.angle) * a.dist;
    return pointerPoint;
  };
  // A guided shell's guide line runs to your cursor while you hold fire
  renderer.guideTo = () => {
    if (!h.ownPresent.fireHeld) return null;
    const me = h.state.entities.get(h.state.playerId);
    if (!me) return null;
    const a = h.localAim();
    cursorPoint.x = me.renderX + Math.cos(a.angle) * a.dist;
    cursorPoint.y = me.renderY + Math.sin(a.angle) * a.dist;
    return cursorPoint;
  };
  // Where your flak guns' shells will burst along their aim: a faint circle of the burst's radius there (FlakAimFx)
  renderer.aimMarks = (out) => {
    if (!h.state.entities.get(h.state.playerId)) return 0;
    return ship.flakMarks(h.state.playerId, h.localAim().dist, groupSelection.packed, h.ownPresent.fireHeld ? 1 : 0, out);
  };
}
