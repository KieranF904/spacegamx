/**
 * Custom enemies' shared support (docs/enemies/custom-roster.md): a blueprint part's `group` sheds with its group, the
 * `under` rule off a boss (the Clinker's magma takes nothing while a plate covers it), each design's pieces' HP and
 * grades from factions.json custom, and the replaced types spawning as their custom designs.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import {
  createShipState, rebuildShip, groupsGone, customGroups, partHit, newPartHit, loadCatalog, blueprintGeometry, type ShipState, type Catalog, type ShipTuning,
} from '@space-game/common';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';

const dataDir = join(__dirname, '../../../../data');
const cfg = loadShipConfigCached(dataDir);
const catalog: Catalog = loadCatalog(cfg.catalog as never);
const tuning = cfg.tuning as unknown as ShipTuning;
const factions = readGameDataFiles(dataDir).factions as { custom: { types: Record<string, string>; designs: Record<string, { hp: Record<string, number> }> } };

const ship = (id: string): ShipState => createShipState(catalog, tuning, 1, cfg.enemies[id], 0);
const group = (s: ShipState, design: string, g: string) => s.blueprint.parts.flatMap((p, i) => (p.group === customGroups(design).indexOf(g) ? [i] : []));
const geometry = (s: ShipState) => blueprintGeometry(catalog, s.blueprint);

describe('custom enemies: groups, the under rule, their tables', () => {
  it('every design\'s parts are in its roster groups, core first, and every group has HP in the table', () => {
    for (const [type, design] of Object.entries(factions.custom.types)) {
      const bp = cfg.enemies[design];
      expect(bp, design).toBeDefined();
      expect(bp.rigid).toBe(true);
      const groups = customGroups(design);
      expect(groups[0]).toBe('core');
      for (const p of bp.parts) expect(p.group, `${design} ${p.piece}`).toBeLessThan(groups.length);
      expect(Object.keys(factions.custom.designs[design].hp).sort(), type).toEqual([...groups].sort());
    }
    // (the five replacements and the Helios drone, live; the dens' four, and the Scrap Mother's den's Darter)
    expect(Object.keys(factions.custom.types).sort()).toEqual(['cinder_zealot', 'clinker', 'frost_shard', 'helios_drone', 'maw_lurker', 'pirate_raider', 'rivet_sower', 'scrap_crawler', 'scrap_darter', 'slag_ray']);
  });

  it('every design holds together as built: each part reaches the core (a loose one would fall off at its first rebuild)', () => {
    for (const design of new Set(Object.values(factions.custom.types))) {
      const s = ship(design);
      expect(s.blueprint.parts.filter((_, i) => !s.derived.alive[i]).map((p) => p.piece), design).toEqual([]);
    }
  });

  it('a part of a group shot off takes the rest of its group with it, and the structure loses the whole piece', () => {
    const s = ship('scrap_crawler');
    const claw = group(s, 'scrap_crawler', 'claw_l');
    expect(claw.length).toBeGreaterThan(1);
    const r = partHit({ catalog, tuning, geometry: () => geometry(s) } as never, s, claw[0], 1e6, undefined, { tick: 1 }, newPartHit());
    expect(r.part).toBe(claw[0]);
    for (const i of claw) expect(s.hp[i], `part ${i}`).toBe(0);
    rebuildShip(s, catalog, tuning);
    for (const i of claw) expect(s.derived.alive[i]).toBe(false);
    expect(groupsGone(s.blueprint, s.hp, s.detached)).toBe(1 << customGroups('scrap_crawler').indexOf('claw_l'));
    // (the rest stands)
    expect(s.derived.alive[group(s, 'scrap_crawler', 'magnet')[0]]).toBe(true);
  });

  it('the under rule: a hit on the Clinker\'s magma under a plate goes to the plate; with the plate off, the magma takes it', () => {
    const s = ship('clinker');
    const core = group(s, 'clinker', 'core').find((i) => catalog.pieces.get(s.blueprint.parts[i].piece)?.under)!;
    const plate = group(s, 'clinker', 'plate_front')[0];
    const ctx = { catalog, tuning, geometry: () => geometry(s) } as never;
    // A spot inside the front plate (its middle): what it covers of the magma is the plate's to take
    const at = geometry(s)[plate].centroid;
    const r = partHit(ctx, s, core, 10, { at }, { tick: 1 }, newPartHit());
    expect(r.part).toBe(plate);
    // The plate shot off: the same spot hits the magma
    for (const i of group(s, 'clinker', 'plate_front')) s.hp[i] = 0;
    rebuildShip(s, catalog, tuning);
    const r2 = partHit(ctx, s, core, 10, { at }, { tick: 2 }, newPartHit());
    expect(r2.part).toBe(core);
  });
});
