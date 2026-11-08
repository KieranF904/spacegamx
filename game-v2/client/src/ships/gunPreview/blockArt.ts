/**
 * @contract client.ships.gun-preview.block-art
 * owns:       drawing the preview's block wall: each block as a hull or armour square in the game's own part art, darkening
 *             and cracking as its HP falls, fading in when the wall is rebuilt
 * needs:      BlockTarget, build/partArt drawPartArt (it takes the colours from hullPreview2d), render/gunLooks crackTexture and crackShow;
 *             common placeGeometry; npm: pixi.js
 * invariants: only a block whose HP changed is redrawn — none pinned
 * extend:     a new damage look is one change in drawBlock
 */

import { Container, Graphics } from 'pixi.js';
import { placeGeometry, type Catalog, type PlacedGeom, type PlacedPart } from '@space-game/common';
import { drawPartArt } from '../build/partArt';
import { crackShow, crackTexture } from '../render/gunLooks';
import { mix } from '../shipColors';
import type { Block, BlockTarget } from './blockTarget';

interface Cell { holder: Container; body: Graphics; crack: Graphics | null }

export class BlockArt {
  readonly root = new Container();
  private cells: Cell[] = [];
  private geoms = new Map<string, PlacedGeom>();
  private laidOut: Block[] | null = null;

  /** `catalog`: the game's parts (without it, plain squares in default hull colours) */
  constructor(private catalog: Catalog | null) {}

  /** Redraw what changed since last time (rebuilding the cells if the wall was laid out again) */
  sync(t: BlockTarget): void {
    if (this.laidOut !== t.blocks) this.build(t);
    for (let i = 0; i < t.blocks.length; i++) {
      const b = t.blocks[i], c = this.cells[i];
      c.holder.visible = b.alive;
      if (!b.dirty) continue;
      b.dirty = false;
      if (b.alive) this.drawBlock(b, c);
      c.holder.alpha = b.appear;
      c.holder.scale.set(0.88 + 0.12 * b.appear);
    }
  }

  destroy(): void {
    this.root.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.cells = [];
  }

  private build(t: BlockTarget): void {
    this.destroy();
    this.laidOut = t.blocks;
    for (const b of t.blocks) {
      const holder = new Container(), body = new Graphics();
      holder.position.set(b.x, b.y);
      holder.addChild(body);
      this.root.addChild(holder);
      this.cells.push({ holder, body, crack: null });
      b.dirty = true;
    }
  }

  private geom(fn: string): PlacedGeom | null {
    const cat = this.catalog;
    if (!cat || !cat.variants.has('sq') || !cat.functions.has(fn)) return null;
    let g = this.geoms.get(fn);
    if (!g) {
      g = placeGeometry(cat, { uid: 0, piece: 'sq', fn, material: 'alloy', x: 0, y: 0, rot: 0, flip: false } as PlacedPart);
      this.geoms.set(fn, g);
    }
    return g;
  }

  /** The block as the ship renderer would show a plate at that health: darker as it is hurt, cracked once it is */
  private drawBlock(b: Block, c: Cell): void {
    const f = b.hp / b.max, h = b.size / 2, g = c.body;
    g.clear();
    const fn = b.armour ? 'armor' : 'hull', geom = this.geom(fn);
    const dark = Math.min(0.55, (1 - f) * 0.6);
    if (geom && this.catalog) {
      drawPartArt(g, this.catalog, geom, (gx, gy) => [(gx - 0.5) * b.size, (gy - 0.5) * b.size], b.size, { alpha: 1, tint: 0x05070b, tintK: dark });
    } else {
      const fill = b.armour ? 0x6b7280 : 0x24324d;
      g.rect(-h, -h, b.size, b.size).fill(mix(fill, 0x05070b, dark)).stroke({ color: mix(fill, 0xc8d6ea, 0.3), width: Math.max(1, b.size * 0.04) });
    }
    const a = crackShow(f);
    if (a > 0) {
      if (!c.crack) {
        const cg = new Graphics();
        cg.rect(-h, -h, b.size, b.size).fill({ texture: crackTexture(), color: 0xffffff });
        c.holder.addChild(cg);
        c.crack = cg;
      }
      c.crack.alpha = a;
      c.crack.visible = true;
    } else if (c.crack) c.crack.visible = false;
  }
}
