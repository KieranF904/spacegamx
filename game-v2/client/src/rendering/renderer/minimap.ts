/**
 * @contract client.render.minimap
 * owns:       the corner radar: its disc, the throttled redraw and one dot style per entity kind
 * needs:      GameState (entities, populations, player), MinimapHost (view roll, system data, way-ins), ships/ShipRenderer FACTION_COLORS, NestViews nestColor; npm: @space-game/common, pixi.js
 * invariants: it is turned against the view's roll so it reads like the screen — none pinned
 *             it redraws at most every 1000/minimapHz milliseconds (quality tier) — none pinned
 * extend:     a new entity kind on the radar is one more case in the entity switch of draw()
 */

import { Container, Graphics } from 'pixi.js';
import { EntityType, nestPosition } from '@space-game/common';
import type { NestData, StarSystemData } from '@space-game/common';
import type { GameState } from '../../state/GameState';
import type { PopGhost } from '../../state/Populations';
import { FACTION_COLORS } from '../../ships/ShipRenderer';
import { nestColor } from '../NestViews';

/** What the minimap reads from the renderer */
export interface MinimapHost {
  cameraAngle(): number;
  sysData(): StarSystemData | undefined;
  wayIns(): NestData[];
}

export class Minimap {
  private container: Container;
  private graphics: Graphics;
  private readonly MINIMAP_SIZE = 180;
  private readonly MINIMAP_RANGE = 8000; // World units to display
  /** The minimap redraws at 20 Hz (its dots move a fraction of a pixel a frame) */
  private at = 0;
  private ms = 50;
  /** The minimap's nests and way-ins together (reused) */
  private nestScratch: NestData[] = [];
  /** The populations' ghosts (packs nobody's near: state/Populations.ts), reused */
  private ghostScratch: PopGhost[] = [];

  constructor(private screenWidth: () => number, parent: Container, private state: GameState, private host: MinimapHost) {
    this.container = new Container();
    this.container.x = screenWidth() - this.MINIMAP_SIZE - 15;
    this.container.y = 15;
    parent.addChild(this.container);

    // Background circle
    const bg = new Graphics();
    bg.circle(this.MINIMAP_SIZE / 2, this.MINIMAP_SIZE / 2, this.MINIMAP_SIZE / 2);
    bg.fill({ color: 0x000000, alpha: 0.6 });
    bg.circle(this.MINIMAP_SIZE / 2, this.MINIMAP_SIZE / 2, this.MINIMAP_SIZE / 2);
    bg.stroke({ color: 0x44ffff, width: 2, alpha: 0.8 });
    this.container.addChild(bg);

    // Graphics layer for entities
    this.graphics = new Graphics();
    this.container.addChild(this.graphics);

    // Mask to keep dots inside circle
    const mask = new Graphics();
    mask.circle(this.MINIMAP_SIZE / 2, this.MINIMAP_SIZE / 2, this.MINIMAP_SIZE / 2 - 2);
    mask.fill({ color: 0xffffff });
    this.container.addChild(mask);
    this.graphics.mask = mask;
  }

  setVisible(on: boolean): void {
    this.container.visible = on;
  }

  /** Redraws per second (the quality tier) */
  setHz(hz: number): void {
    this.ms = 1000 / hz;
  }

  /** Keeps its corner on a resize */
  onResize(): void {
    this.container.x = this.screenWidth() - this.MINIMAP_SIZE - 15;
  }

  /** Once a frame: redraws when its interval is up */
  tick(): void {
    if (performance.now() - this.at >= this.ms) {
      this.at = performance.now();
      this.draw();
    }
  }

  private draw(): void {
        const g = this.graphics;
    g.clear();
    // Turned with the view, so it reads the same way as the screen
    g.pivot.set(this.MINIMAP_SIZE / 2, this.MINIMAP_SIZE / 2);
    g.position.set(this.MINIMAP_SIZE / 2, this.MINIMAP_SIZE / 2);
    g.rotation = -this.host.cameraAngle();
    
    const playerPos = this.state.getPlayerPosition();
    const center = this.MINIMAP_SIZE / 2;
    const scale = (this.MINIMAP_SIZE / 2) / this.MINIMAP_RANGE;
    
    // Draw star/sun at center if close enough
    const sunDist = Math.sqrt(playerPos.x ** 2 + playerPos.y ** 2);
    if (sunDist < this.MINIMAP_RANGE * 2) {
      const sunX = center + (-playerPos.x) * scale;
      const sunY = center + (-playerPos.y) * scale;
      g.circle(sunX, sunY, 8);
      g.fill({ color: 0xffaa00, alpha: 0.9 });
      g.circle(sunX, sunY, 5);
      g.fill({ color: 0xffff88, alpha: 1.0 });
    }

    // Hostile nests: a triangle in their faction's colour
    const nestList = this.nestScratch;
    nestList.length = 0;
    for (const n of this.host.sysData()?.nests ?? []) if (!n.hidden) nestList.push(n);
    for (const n of this.host.wayIns()) nestList.push(n);
    for (const n of nestList) {
      const at = nestPosition(n, this.host.sysData()?.planets, this.state.getRawServerTick());
      const dx = at.x - playerPos.x, dy = at.y - playerPos.y;
      if (dx * dx + dy * dy > this.MINIMAP_RANGE * this.MINIMAP_RANGE) continue;
      const mx = center + dx * scale, my = center + dy * scale;
      g.poly([mx, my - 6, mx + 5.5, my + 4, mx - 5.5, my + 4]);
      g.fill({ color: nestColor(n.faction), alpha: 0.35 });
      g.stroke({ color: nestColor(n.faction), width: 1.5, alpha: 0.95 });
    }

    // Ghosts: packs nobody's near, as faint rings in their faction's colour (real ships once a pilot comes near)
    for (const gh of this.state.populations.ghosts(this.state.systemId, this.host.sysData(), this.state.getRawServerTick(), this.ghostScratch)) {
      const dx = gh.x - playerPos.x, dy = gh.y - playerPos.y;
      if (dx * dx + dy * dy > this.MINIMAP_RANGE * this.MINIMAP_RANGE) continue;
      g.circle(center + dx * scale, center + dy * scale, 3);
      g.stroke({ color: gh.calm ? 0x9ca3af : FACTION_COLORS[gh.faction] ?? 0xff4444, width: 1, alpha: 0.5 });
    }

    // Draw entities
    for (const [id, entity] of this.state.entities) {
      const dx = entity.renderX - playerPos.x;
      const dy = entity.renderY - playerPos.y;
      const dist = Math.sqrt(dx ** 2 + dy ** 2);
      
      if (dist > this.MINIMAP_RANGE) continue;
      
      const mx = center + dx * scale;
      const my = center + dy * scale;
      
      // Color based on entity type
      switch (entity.type) {
        case EntityType.Player:
          if (id === this.state.playerId) continue; // Skip self
          g.circle(mx, my, 4);
          g.fill({ color: 0x44ff44, alpha: 0.9 }); // Green for other players
          break;
          
        case EntityType.Asteroid:
          g.circle(mx, my, 2 + (entity.data?.[0] || 50) / 50);
          g.fill({ color: 0x888888, alpha: 0.6 }); // Gray for asteroids
          break;
          
        case EntityType.DroppedItem:
          g.circle(mx, my, 3);
          g.fill({ color: 0xffff00, alpha: 0.9 }); // Yellow for items
          break;
          
        case EntityType.Enemy:
          g.circle(mx, my, 4);
          g.fill({ color: 0xff4444, alpha: 0.9 }); // Red for enemies
          break;

        case EntityType.ShipBody: {
          // data[0]: 3 hostile (in its faction's colour; bigger for elites and bosses), 2 traffic, 1 wreck/derelict
          const kind = entity.data?.[0] ?? 0;
          if (kind === 3) {
            const rank = entity.data?.[4] ?? 0;
            g.circle(mx, my, rank === 2 ? 6 : rank === 1 ? 4.5 : 3.5);
            // (Grey while it's a passive pack nobody's provoked)
            g.fill({ color: entity.data?.[9] === 1 ? 0x9ca3af : FACTION_COLORS[entity.data?.[3] ?? -1] ?? 0xff4444, alpha: entity.data?.[9] === 1 ? 0.7 : 0.95 });
          } else if (kind === 2) {
            g.circle(mx, my, 2.5);
            g.fill({ color: 0x9fd8ff, alpha: 0.75 }); // Pale blue for traffic
          } else if (kind === 1) {
            g.circle(mx, my, 2.5);
            g.fill({ color: 0x8a8a8a, alpha: 0.7 }); // Grey for wrecks and derelicts
          }
          break;
        }
          
        case EntityType.Station:
          g.rect(mx - 5, my - 5, 10, 10);
          g.fill({ color: 0x4488ff, alpha: 0.9 }); // Blue for stations
          break;
          
        case EntityType.NPC:
          g.circle(mx, my, 4);
          g.fill({ color: 0x44ffff, alpha: 0.9 }); // Cyan for NPCs
          break;
      }
    }
    
    // Draw player at center
    g.circle(center, center, 5);
    g.fill({ color: 0x00ff00, alpha: 1.0 });
    
    // Draw player direction indicator
    const player = this.state.entities.get(this.state.playerId);
    if (player) {
      const angle = player.angle || 0;
      const dirLen = 12;
      g.moveTo(center, center);
      g.lineTo(center + Math.cos(angle) * dirLen, center + Math.sin(angle) * dirLen);
      g.stroke({ color: 0x00ff00, width: 2, alpha: 0.8 });
    }
  }
}
