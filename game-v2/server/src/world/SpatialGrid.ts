/**
 * Spatial Grid - Efficient spatial partitioning for collision detection
 */

export interface SpatialEntity {
  id: number;
  x: number;
  y: number;
  radius: number;
}

export interface CollisionPair {
  entityA: number;
  entityB: number;
  distance: number;
  overlapX: number;
  overlapY: number;
}

/**
 * Grid-based spatial partitioning
 * Divides world into cells for efficient broad-phase collision detection
 */
export class SpatialGrid {
  private cellSize: number;
  private cells = new Map<string, Set<number>>();
  private entityCells = new Map<number, Set<string>>();
  private entities = new Map<number, SpatialEntity>();

  constructor(cellSize: number = 500) {
    this.cellSize = cellSize;
  }

  /**
   * Get cell key for position
   */
  private getCellKey(x: number, y: number): string {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    return `${cx},${cy}`;
  }

  /**
   * Get all cell keys that an entity overlaps
   */
  private getEntityCells(entity: SpatialEntity): string[] {
    const keys: string[] = [];
    const minX = Math.floor((entity.x - entity.radius) / this.cellSize);
    const maxX = Math.floor((entity.x + entity.radius) / this.cellSize);
    const minY = Math.floor((entity.y - entity.radius) / this.cellSize);
    const maxY = Math.floor((entity.y + entity.radius) / this.cellSize);

    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        keys.push(`${cx},${cy}`);
      }
    }
    return keys;
  }

  /**
   * Insert or update an entity
   */
  insert(entity: SpatialEntity): void {
    // Remove from old cells if exists
    this.remove(entity.id);

    // Store entity
    this.entities.set(entity.id, entity);

    // Get cells this entity overlaps
    const cellKeys = this.getEntityCells(entity);
    this.entityCells.set(entity.id, new Set(cellKeys));

    // Add to each cell
    for (const key of cellKeys) {
      let cell = this.cells.get(key);
      if (!cell) {
        cell = new Set();
        this.cells.set(key, cell);
      }
      cell.add(entity.id);
    }
  }

  /**
   * Remove an entity
   */
  remove(id: number): void {
    const cellKeys = this.entityCells.get(id);
    if (cellKeys) {
      for (const key of cellKeys) {
        const cell = this.cells.get(key);
        if (cell) {
          cell.delete(id);
          if (cell.size === 0) {
            this.cells.delete(key);
          }
        }
      }
      this.entityCells.delete(id);
    }
    this.entities.delete(id);
  }

  /**
   * Update entity position
   */
  update(id: number, x: number, y: number, radius?: number): void {
    const entity = this.entities.get(id);
    if (entity) {
      entity.x = x;
      entity.y = y;
      if (radius !== undefined) {
        entity.radius = radius;
      }
      this.insert(entity);
    }
  }

  /**
   * Query entities in range
   */
  queryRange(x: number, y: number, radius: number): number[] {
    const results: number[] = [];
    const seen = new Set<number>();

    const minX = Math.floor((x - radius) / this.cellSize);
    const maxX = Math.floor((x + radius) / this.cellSize);
    const minY = Math.floor((y - radius) / this.cellSize);
    const maxY = Math.floor((y + radius) / this.cellSize);

    const radiusSq = radius * radius;

    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        const cell = this.cells.get(`${cx},${cy}`);
        if (!cell) continue;

        for (const id of cell) {
          if (seen.has(id)) continue;
          seen.add(id);

          const entity = this.entities.get(id);
          if (!entity) continue;

          const dx = entity.x - x;
          const dy = entity.y - y;
          const distSq = dx * dx + dy * dy;
          const combinedRadius = radius + entity.radius;

          if (distSq <= combinedRadius * combinedRadius) {
            results.push(id);
          }
        }
      }
    }

    return results;
  }

  /**
   * Query entities at a point
   */
  queryPoint(x: number, y: number): number[] {
    const results: number[] = [];
    const key = this.getCellKey(x, y);
    const cell = this.cells.get(key);

    if (cell) {
      for (const id of cell) {
        const entity = this.entities.get(id);
        if (!entity) continue;

        const dx = entity.x - x;
        const dy = entity.y - y;
        const distSq = dx * dx + dy * dy;

        if (distSq <= entity.radius * entity.radius) {
          results.push(id);
        }
      }
    }

    return results;
  }

  /**
   * Get all collision pairs (broad phase)
   */
  getCollisionPairs(): CollisionPair[] {
    const pairs: CollisionPair[] = [];
    const checked = new Set<string>();

    for (const [key, cell] of this.cells) {
      const ids = Array.from(cell);

      // Check pairs within this cell
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const idA = ids[i];
          const idB = ids[j];
          const pairKey = idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;

          if (checked.has(pairKey)) continue;
          checked.add(pairKey);

          const entityA = this.entities.get(idA);
          const entityB = this.entities.get(idB);
          if (!entityA || !entityB) continue;

          // Narrow phase: actual circle collision
          const dx = entityB.x - entityA.x;
          const dy = entityB.y - entityA.y;
          const distSq = dx * dx + dy * dy;
          const combinedRadius = entityA.radius + entityB.radius;

          if (distSq < combinedRadius * combinedRadius) {
            const distance = Math.sqrt(distSq);
            const overlap = combinedRadius - distance;
            const nx = distance > 0 ? dx / distance : 1;
            const ny = distance > 0 ? dy / distance : 0;

            pairs.push({
              entityA: idA,
              entityB: idB,
              distance,
              overlapX: nx * overlap,
              overlapY: ny * overlap,
            });
          }
        }
      }
    }

    return pairs;
  }

  /**
   * Clear all entities
   */
  clear(): void {
    this.cells.clear();
    this.entityCells.clear();
    this.entities.clear();
  }

  /**
   * Get entity count
   */
  get size(): number {
    return this.entities.size;
  }

  /**
   * Debug: get grid stats
   */
  getStats(): { entities: number; cells: number; maxCellSize: number } {
    let maxCellSize = 0;
    for (const cell of this.cells.values()) {
      maxCellSize = Math.max(maxCellSize, cell.size);
    }
    return {
      entities: this.entities.size,
      cells: this.cells.size,
      maxCellSize,
    };
  }
}
