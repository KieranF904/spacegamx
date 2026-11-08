/**
 * @contract server.gameserver.spatialgrid
 * owns:       the per-system broadphase grid
 * needs:      bitecs-free; plain data
 * invariants: query results and their order keep the frame hash — server/src/golden/frameHash.test.ts
 * extend:      n/a
 */

import { addEntity } from 'bitecs';
import { WORLD_SIZE } from '@space-game/common';

export const SPATIAL_CHUNK_SIZE = 500;

export interface SpatialEntity {
  id: number;
  x: number;
  y: number;
  radius: number;
  type: 'player' | 'projectile' | 'item';
  /** The system copy it's in (instanced copies share coordinates) */
  system: number;
}

/**
 * The broadphase: a uniform grid per system (instanced copies are systems of
 * their own here, so shots never see another copy). Everything is recorded
 * where it stood when the tick began; a system's cells are only filled the
 * first time something looks there that tick, so systems nobody's shooting in
 * cost nothing beyond the record.
 */
export class SpatialGrid {
  // Integer key = ((system * GRID_STRIDE) + cx + GRID_OFFSET) * GRID_STRIDE + (cy + GRID_OFFSET).
  // Avoids per-add template-string allocation (~100k strings/sec at 60Hz).
  private static readonly GRID_OFFSET = 1024;   // WORLD_SIZE 260000 / chunk 500 = 520 cells max
  private static readonly GRID_STRIDE = 2048;
  private grid: Map<number, SpatialEntity[]> = new Map();
  // Pool of arrays reused across ticks to avoid per-tick array churn
  private arrayPool: SpatialEntity[][] = [];
  // Pool of SpatialEntity objects reused across ticks (~1300 objects/tick otherwise)
  private entityPool: SpatialEntity[] = [];
  private poolIndex = 0;
  /** What's in each system this tick, in the order it was added (cells are filled from it on demand) */
  private pending = new Map<number, SpatialEntity[]>();
  private built = new Set<number>();
  /** Query dedupe without a Set: an entity's last query number, by id */
  private stamp = new Int32Array(1 << 14);
  private queryNo = 0;

  clear(): void {
    // Return arrays to the pool instead of dropping them for GC
    for (const arr of this.grid.values()) this.recycle(arr);
    for (const arr of this.pending.values()) this.recycle(arr);
    this.grid.clear();
    this.pending.clear();
    this.built.clear();
    // Reset the entity pool cursor — objects stay pooled for next tick
    this.poolIndex = 0;
  }

  private recycle(arr: SpatialEntity[]): void {
    if (this.arrayPool.length < 4096) {
      arr.length = 0;
      this.arrayPool.push(arr);
    }
  }

  /** Reuse a pooled SpatialEntity instead of allocating a fresh object */
  private obtainEntity(
    id: number, x: number, y: number, radius: number,
    type: SpatialEntity['type'], system: number,
  ): SpatialEntity {
    let e: SpatialEntity;
    if (this.poolIndex < this.entityPool.length) {
      e = this.entityPool[this.poolIndex];
      e.id = id; e.x = x; e.y = y; e.radius = radius; e.type = type; e.system = system;
    } else {
      e = { id, x, y, radius, type, system };
      this.entityPool.push(e);
    }
    this.poolIndex++;
    return e;
  }

  private obtainArray(): SpatialEntity[] {
    return this.arrayPool.pop() ?? [];
  }

  private static key(system: number, cx: number, cy: number): number {
    return ((system * SpatialGrid.GRID_STRIDE) + cx + SpatialGrid.GRID_OFFSET) * SpatialGrid.GRID_STRIDE + (cy + SpatialGrid.GRID_OFFSET);
  }

  /** File an entity in the cells it covers */
  private insert(entity: SpatialEntity): void {
    const minCx = Math.floor((entity.x - entity.radius + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const maxCx = Math.floor((entity.x + entity.radius + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const minCy = Math.floor((entity.y - entity.radius + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const maxCy = Math.floor((entity.y + entity.radius + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const key = SpatialGrid.key(entity.system, cx, cy);
        let chunk = this.grid.get(key);
        if (!chunk) {
          chunk = this.obtainArray();
          this.grid.set(key, chunk);
        }
        chunk.push(entity);
      }
    }
  }

  /** Add an entity by fields, reusing pooled objects (allocation-free); its cells are filled when its system is first queried */
  addEntity(
    id: number, x: number, y: number, radius: number,
    type: SpatialEntity['type'], system: number,
  ): void {
    let list = this.pending.get(system);
    if (!list) {
      list = this.obtainArray();
      this.pending.set(system, list);
    }
    list.push(this.obtainEntity(id, x, y, radius, type, system));
  }

  /** Everything in a system whose cells meet a box (each once, in the order it was added within each cell) */
  query(system: number, x1: number, y1: number, x2: number, y2: number, padding: number = 0): SpatialEntity[] {
    if (!this.built.has(system)) {
      this.built.add(system);
      for (const e of this.pending.get(system) ?? []) this.insert(e);
    }
    const minX = Math.min(x1, x2) - padding;
    const maxX = Math.max(x1, x2) + padding;
    const minY = Math.min(y1, y2) - padding;
    const maxY = Math.max(y1, y2) + padding;

    const minCx = Math.floor((minX + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const maxCx = Math.floor((maxX + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const minCy = Math.floor((minY + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const maxCy = Math.floor((maxY + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);

    if (++this.queryNo === 0x7fffffff) { this.stamp.fill(0); this.queryNo = 1; }
    const result: SpatialEntity[] = [];

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const chunk = this.grid.get(SpatialGrid.key(system, cx, cy));
        if (!chunk) continue;
        for (const entity of chunk) {
          const id = entity.id;
          if (id >= this.stamp.length) {
            const grown = new Int32Array(Math.max(id + 1, this.stamp.length * 2));
            grown.set(this.stamp);
            this.stamp = grown;
          }
          if (this.stamp[id] === this.queryNo) continue;
          this.stamp[id] = this.queryNo;
          result.push(entity);
        }
      }
    }

    return result;
  }

  /**
   * Everything whose cells lie along a segment, `padding` either side of it:
   * the cells of its bounding box that the padded segment can reach (a long
   * diagonal beam's box is mostly cells nowhere near it)
   */
  queryRay(system: number, x1: number, y1: number, x2: number, y2: number, padding: number = 0): SpatialEntity[] {
    const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
    // (Short ones, a shell's step: the box is a cell or four anyway)
    if (l2 < SPATIAL_CHUNK_SIZE * SPATIAL_CHUNK_SIZE * 4) return this.query(system, x1, y1, x2, y2, padding);
    if (!this.built.has(system)) {
      this.built.add(system);
      for (const e of this.pending.get(system) ?? []) this.insert(e);
    }
    const h = SPATIAL_CHUNK_SIZE / 2, reach = padding + h * Math.SQRT2, reach2 = reach * reach;
    const minCx = Math.floor((Math.min(x1, x2) - padding + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const maxCx = Math.floor((Math.max(x1, x2) + padding + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const minCy = Math.floor((Math.min(y1, y2) - padding + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    const maxCy = Math.floor((Math.max(y1, y2) + padding + WORLD_SIZE) / SPATIAL_CHUNK_SIZE);
    if (++this.queryNo === 0x7fffffff) { this.stamp.fill(0); this.queryNo = 1; }
    const result: SpatialEntity[] = [];
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        // The cell's middle within half its diagonal (plus the padding) of the segment, or nothing in it is near enough
        const mx = cx * SPATIAL_CHUNK_SIZE - WORLD_SIZE + h, my = cy * SPATIAL_CHUNK_SIZE - WORLD_SIZE + h;
        const t = Math.max(0, Math.min(1, ((mx - x1) * dx + (my - y1) * dy) / l2));
        const ex = mx - (x1 + dx * t), ey = my - (y1 + dy * t);
        if (ex * ex + ey * ey > reach2) continue;
        const chunk = this.grid.get(SpatialGrid.key(system, cx, cy));
        if (!chunk) continue;
        for (const entity of chunk) {
          const id = entity.id;
          if (id >= this.stamp.length) {
            const grown = new Int32Array(Math.max(id + 1, this.stamp.length * 2));
            grown.set(this.stamp);
            this.stamp = grown;
          }
          if (this.stamp[id] === this.queryNo) continue;
          this.stamp[id] = this.queryNo;
          result.push(entity);
        }
      }
    }
    return result;
  }
}
