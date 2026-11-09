/**
 * @contract client.render.frame-effects
 * owns:       Renderer's per-frame animation of effects, gates, rifts, pods and stations, and the lights the renderer itself adds
 * needs:      Renderer (its fields, as the first argument), WeaponFx, Lighting; npm: pixi.js, @space-game/common
 * invariants: behaviour is the one it had inside Renderer — none pinned
 * extend:     a new animated scene object is a loop in updateEffects; a new light is a case in collectLights
 */

import { shotTimelines } from '../weapons/WeaponFx';
import { EntityType } from '@space-game/common';
import { Lighting } from '../lighting/Lighting';
import type { Renderer } from '../Renderer';

export function updateEffects(rend: Renderer, delta: number): void {
  rend.fx.update(delta);

  for (const rift of rend.rifts.values()) rift.update(delta);
  // Jump gates: the rings turn slowly against each other and the whole gate breathes (its light with it, see collectLights)
  for (const gate of rend.gates.values()) {
    gate.pulse = 0.82 + 0.18 * Math.sin(rend.time * 1.3 + gate.phase);
    gate.outer.rotation = rend.time * 0.12 + gate.phase;
    gate.inner.rotation = -rend.time * 0.2 - gate.phase;
    gate.outer.alpha = gate.pulse;
    gate.inner.alpha = 0.6 + 0.4 * Math.sin(rend.time * 1.3 + gate.phase + 0.8);
    gate.core.scale.set(0.94 + 0.06 * gate.pulse);
  }
  rend.seamTime += delta;
  for (const [id, s] of rend.asteroidSeams) {
    if (!rend.entityGraphics.has(id)) { rend.asteroidSeams.delete(id); continue; }
    s.glow.alpha = 0.55 + 0.45 * Math.sin(rend.seamTime * 2.2 + s.phase);
  }
  for (const [id, pod] of rend.lootPods) {
    const c = rend.entityGraphics.get(id);
    if (!c) { rend.lootPods.delete(id); continue; }
    pod.update(delta);
    if (c.visible) pod.light(rend.lighting.levelAt(c.x, c.y, rend.podLight));
  }
  const me = rend.state.entities.get(rend.state.playerId);
  for (const [id, station] of rend.stations) {
    const e = rend.state.entities.get(id);
    station.update(delta, me && e ? Math.hypot(e.renderX - me.renderX, e.renderY - me.renderY) : Infinity,
      e ? { x: e.renderX, y: e.renderY } : undefined, rend.entityAt);
  }

  // Projectile tracers, muzzle flashes and impacts
  // (Each shell on the timeline its firing ship is drawn on: shotTimelines)
  rend.weaponFx.update(rend.state, delta, ...shotTimelines(rend.state));
}

/** The renderer's own lights: old-style flashes, loot, rifts, stations */
export function collectLights(rend: Renderer, L: Lighting): void {
  rend.weaponFx.collectLights(L);
  rend.fx.collectLights(L);
  const RARITY = [0xc8d0dc, 0x5fd38d, 0x4fa3ff, 0xc77dff, 0xffb347];
  for (const [id, c] of rend.entityGraphics) {
    if (!c.visible) continue;
    const e = rend.state.entities.get(id);
    if (!e) continue;
    if (e.type === EntityType.DroppedItem) L.point(c.x, c.y, RARITY[Math.max(0, Math.min(4, e.data?.[0] ?? 0))], 170, 0.45, 50);
    else if (e.type === EntityType.Portal) L.point(c.x, c.y, e.data?.[1] === 1 ? 0xb28cff : 0x7dd3fc, 1600, 0.8 * (rend.gates.get(id)?.pulse ?? 1), 300);
    else if (e.type === EntityType.Station) rend.stations.get(id)?.collectLights(L, c.x, c.y, c.rotation);
  }
  // In space, ships shade the structures under them (on a surface they have their shadows on the ground)
  if (!rend.surface.active) for (const [id, r] of rend.shipRadius) {
    const e = rend.state.entities.get(id);
    if (e) L.shadow(e.renderX, e.renderY, r);
  }
}
