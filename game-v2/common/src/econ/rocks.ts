/**
 * Rock types and belts from data/mining.json: a type with a `name` and a
 * `size` band joins the asteroid registry (copying the `like` type's motion
 * and spawn rules), and `fields` set each belt's mix of types by weight (a
 * new belt is made from its mix).
 * Server and client both call this before any asteroid is generated, so
 * they place the same rocks.
 */

import { asteroidRegistry } from '../data/registries/AsteroidRegistry.js';
import type { AsteroidDefinition } from '../data/definitions/AsteroidDefinition.js';
import type { MiningTable } from './mining.js';
import { setAsteroidOutliers } from '../asteroid/generation.js';

export function registerRockTypes(table: MiningTable): void {
  setAsteroidOutliers(table.outliers);
  for (const [id, t] of Object.entries(table.types)) {
    if (!t.name || !t.size) continue;
    const base = asteroidRegistry.get(t.like ?? id) ?? asteroidRegistry.get('asteroid_metal');
    if (!base) continue;
    const def: AsteroidDefinition = { ...base, id, name: t.name, size: { ...base.size, min: t.size[0], max: t.size[1] } };
    asteroidRegistry.register(id, def);
  }
  for (const [fieldId, mix] of Object.entries(table.fields ?? {})) {
    const asteroidTypes = Object.entries(mix).filter(([k]) => !k.startsWith('_')).map(([typeId, weight]) => ({ id: typeId, weight }));
    const field = asteroidRegistry.getField(fieldId);
    if (field) field.asteroidTypes = asteroidTypes;
    else asteroidRegistry.registerField({ id: fieldId, name: fieldId, center: { x: 0, y: 0 }, radius: 0, density: 0, asteroidTypes });
  }
}

/** A rock type's display name */
export function rockName(table: MiningTable, type: string): string {
  return table.types[type]?.name ?? asteroidRegistry.get(type)?.name ?? 'Asteroid';
}
