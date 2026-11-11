/**
 * @contract client.render.entity-views
 * owns:       Renderer's per-frame entity pass: make, place, fade and dispose each entity's graphics, and the asteroid hit flash
 * needs:      Renderer (its fields, as the first argument), GameState, entityParts, the entity views (rocks, stations, rifts, pods, mobs); npm: pixi.js, @space-game/common
 * invariants: a view is made once per entity and kept while it lives, shots get none, one out of view is hidden and a gone one disposed — client/src/rendering/renderer/rendererModules.test.ts
 * extend:     a new entity kind's graphics is a case in createEntityGraphics
 */

import { placeUpright, buildPlayerParts, buildPortalParts, updateHealthBar } from './entityParts';
import { Container, Graphics } from 'pixi.js';
import { LootPodView } from '../LootPodView';
import { MobView } from '../MobView';
import { drawAsteroid } from '../AsteroidLook';
import { drawTrainingLook } from '../TrainingLook';
import { RiftShader } from '../RiftShader';
import { StationView } from '../StationView';
import { EntityType, getAsteroidPolygon } from '@space-game/common';
import type { Renderer } from '../Renderer';

/** Seconds to fade an entity in as it appears, or out as it goes */
const FADE = 0.25;

export function renderEntities(rend: Renderer, dt: number): void {
  // Track which entities are still alive
  const aliveIds = rend.aliveIds;
  aliveIds.clear();

  // Calculate visible bounds for culling (each entity's own size is added below, so big ones don't pop at the edge)
  const vb = rend.viewBox();
  const halfW = vb.hw + rend.CULL_MARGIN;
  const halfH = vb.hh + rend.CULL_MARGIN;
  const k = rend.tagScale;

  for (const entity of rend.state.entities.values()) {
    // Shots are drawn by WeaponFx: no view of their own (one made and dropped per shot rebuilt the scene's draw list)
    if (entity.type === EntityType.Projectile) continue;
    aliveIds.add(entity.id);

    // Culling - skip entities outside viewport (but always render player)
    if (entity.id !== rend.state.playerId) {
      const r = radiusOf(rend, entity);
      if (Math.abs(entity.x - rend.cameraX) > halfW + r || Math.abs(entity.y - rend.cameraY) > halfH + r) {
        // Hide if exists but out of view
        const existing = rend.entityGraphics.get(entity.id);
        if (existing) {
          existing.visible = false;
        }
        continue;
      }
    }

    let container = rend.entityGraphics.get(entity.id);

    if (!container) {
      // Create new graphics for this entity, passing entity data for size/type info
      container = createEntityGraphics(rend, entity.type, entity.id, entity.data);
      rend.entityGraphics.set(entity.id, container);
      rend.entityContainer.addChild(container);
      // It fades in (asteroids are drawn in batches, which don't fade: they just appear; ship bodies are drawn elsewhere)
      if (entity.type !== EntityType.ShipBody && entity.type !== EntityType.Asteroid) {
        container.alpha = 0;
        rend.fadingIn.set(entity.id, 0);
      }
    }

    // Make visible (modular ships keep only their name tag and health bar here)
    container.visible = true;
    if (rend.hiddenEntityIds.has(entity.id)) {
      // (the tag's name and bar are shown or not below: set here too, an undamaged ship's bar went on and off every frame)
      for (const c of container.children) if (c.label !== 'nameTag' && c.label !== 'healthBar') c.visible = false;
    }
    const fade = rend.fadingIn.get(entity.id);
    if (fade !== undefined) {
      const a = Math.min(1, fade + dt / FADE);
      container.alpha = a;
      if (a >= 1) rend.fadingIn.delete(entity.id);
      else rend.fadingIn.set(entity.id, a);
    }

    // Update position (use smooth render position)
    container.x = entity.renderX;
    container.y = entity.renderY;
    container.rotation = entity.renderAngle;
    if (entity.type === EntityType.Enemy) rend.mobs.get(entity.id)?.update(dt, entity.hp);

    if (rend.rockHits.size && rend.rockHits.has(entity.id)) animateRockHit(rend, container, entity.id, entity.data?.[0] || 30);

    // Name tag and health bar: upright, fixed on screen however the ship turns, counter-scaled zoomed out
    const tag = rend.tags.get(entity.id);
    if (tag) {
      const r = rend.shipRadius.get(entity.id) ?? 20;
      // (Upright on screen: the view's roll less the ship's)
      const up = rend.cameraAngle - entity.renderAngle;
      const c = Math.cos(up), sn = Math.sin(up);
      if (tag.name) {
        if (entity.name) {
          if (tag.name.text !== entity.name) tag.name.text = entity.name;
          tag.name.visible = rend.showNames;
        }
        tag.name.scale.set(k);
        placeUpright(tag.name, c, sn, up, 0, r + 14);
      }
      if (tag.bar) {
        updateHealthBar(tag, entity);
        // Drawn from its left edge, 35 × 4 (the shield strip above it)
        tag.bar.scale.set(k);
        placeUpright(tag.bar, c, sn, up, -17.5 * k, -(r + 10) - 4 * k);
      }
    }
  }

  // Remove dead entities: stations, gates and loot fade out where they were, then go
  for (const [id, container] of rend.entityGraphics) {
    if (!aliveIds.has(id)) {
      rend.entityGraphics.delete(id);
      rend.fadingIn.delete(id);
      rend.tags.delete(id);
      rend.rocks.remove(id);
      rend.rockObjs.delete(id);
      const type = rend.typeOf.get(id);
      rend.typeOf.delete(id);
      if (container.visible && (type === EntityType.Station || type === EntityType.Portal || type === EntityType.DroppedItem)) {
        rend.fadingOut.push({ id, container });
      } else {
        disposeEntity(rend, id, container);
      }
    }
  }
  let w = 0;
  for (const f of rend.fadingOut) {
    f.container.alpha -= dt / FADE;
    if (f.container.alpha <= 0 || rend.entityGraphics.has(f.id)) { disposeEntity(rend, f.id, f.container); continue; }
    rend.fadingOut[w++] = f;
  }
  rend.fadingOut.length = w;
}

/** An entity's views gone for good */
export function disposeEntity(rend: Renderer, id: number, container: Container): void {
  // (Its id may be back already, with new views of its own)
  if (!rend.entityGraphics.has(id)) {
    rend.rifts.delete(id);
    rend.gates.delete(id);
    rend.stations.get(id)?.dispose();
    rend.stations.delete(id);
    rend.mobs.delete(id);
  }
  rend.entityContainer.removeChild(container);
  container.destroy({ children: true });
}

/** How far an entity reaches from its centre (world units), for culling */
export function radiusOf(rend: Renderer, e: { id: number; type: EntityType; data?: number[] }): number {
  switch (e.type) {
    // (Its look reaches well past its radius: a citadel's arms nearly four times it)
    case EntityType.Station: return rend.stations.get(e.id)?.reach ?? (e.data?.[8] ?? 200) * 3.8;
    case EntityType.Asteroid: return (e.data?.[0] || 30) * 1.3;
    case EntityType.Portal: return e.data?.[1] === 1 ? 600 : 220;
    case EntityType.Enemy: return 80;
    // Ships: the hull, and their name tag and health bar
    default: return (rend.shipRadius.get(e.id) ?? 30) + 60;
  }
}

export function createEntityGraphics(rend: Renderer, type: EntityType, id: number, data?: number[]): Container {
  const container = new Container();
  rend.typeOf.set(id, type);

  switch (type) {
    case EntityType.Player:
      rend.tags.set(id, buildPlayerParts(container));
      break;
    case EntityType.Asteroid:
      // data[0] = size, data[1] = resourceType
      {
        const { rock, seams } = drawAsteroid(container, id, data?.[0] || 30, rend.state.entities.get(id)?.composition, rend.sys.data?.visuals?.greyseam);
        const at = rend.state.entities.get(id);
        rend.rockObjs.set(id, rock);
        if (rend.trainingLooks.has(id)) container.addChild(drawTrainingLook(rend.trainingLooks.get(id)!, id, data?.[0] || 30));
        else rend.rocks.add(id, rock, at?.x ?? 0, at?.y ?? 0);
        if (seams) rend.asteroidSeams.set(id, seams);
      }
      break;
    case EntityType.Projectile:
      // Drawn by WeaponFx (tracers placed from the true spawn point)
      break;
    case EntityType.DroppedItem: {
      // data: [rarity index, kinds of item, item count]
      const pod = new LootPodView(data?.[0] ?? 0, data?.[2] ?? 1);
      rend.lootPods.set(id, pod);
      // (A chunk thrown out of a rock just struck: the strike kept ore, and it shows richer where it appears)
      const at = rend.state.entities.get(id);
      if (at) rend.miningStrikes.pod(at.x, at.y);
      container.addChild(pod.container);
      break;
    }
    case EntityType.Station: {
      // data: [stationId, orbit..., orbitTimeScale, radius, design, turrets, weapon]
      const view = new StationView(data?.[0] ?? id, data?.[8] ?? 200, rend.state.entities.get(id)?.name, rend.lighting, data?.[9] ?? 0, data?.[10] ?? 0, data?.[11] ?? 0);
      rend.stations.set(id, view);
      container.addChild(view.container);
      break;
    }
    case EntityType.Portal:
      // data: [targetSystem, kind (0 jump gate, 1 rift), hue]
      if (data?.[1] === 1) {
        const rift = new RiftShader(data[2] ?? 275);
        rend.rifts.set(id, rift);
        container.addChild(rift.container);
      } else {
        rend.gates.set(id, buildPortalParts(container, id));
      }
      break;
    case EntityType.Enemy: {
      // A single-body enemy: data[0] its kind's index in data/mobs.json
      const view = new MobView(data?.[0] ?? 0);
      rend.mobs.set(id, view);
      container.addChild(view.container);
      break;
    }
    case EntityType.ShipBody:
      // Dummies and debris are drawn by the ship renderer
      break;
    default:
      // Default circle
      const g = new Graphics();
      g.circle(0, 0, 10);
      g.fill({ color: 0xffffff });
      container.addChild(g);
  }

  return container;
}

export function animateRockHit(rend: Renderer, container: Container, id: number, size: number): void {
  const hit = rend.rockHits.get(id)!;
  const k = Math.max(0, 1 - (performance.now() - hit.at) / 170);
  let flash = container.getChildByLabel('rockFlash') as Graphics | null;
  if (!flash && k > 0) {
    // The rock's outline in white, made on its first hit and kept (hidden) after
    flash = new Graphics().poly(getAsteroidPolygon(id, 0, 0, size).flatMap((v) => [v.x, v.y])).fill({ color: 0xffffff });
    flash.label = 'rockFlash';
    flash.blendMode = 'add';
    container.addChild(flash);
  }
  if (flash) {
    flash.visible = k > 0;
    flash.alpha = 0.5 * hit.strength * k * k * k;
  }
  container.scale.set(1 + 0.03 * hit.strength * k * k);
  if (k <= 0) rend.rockHits.delete(id);
}
