/**
 * Time-to-kill bench for the cave enemies at Mk I on a STATIONARY starter (Sparrow T), if every shot lands (data/factions.json
 * custom stats; their moves in common/src/bodies/moves/custom.ts). Kieran's target: about 10 s. In play maybe 1 in 3 shots lands,
 * so a moving pilot lasts a minute or more. Computed from the data by formula (the full sim isn't needed: a shell's damage is
 * its nominal number; splash falloff and armour are ignored, as they are in the old "17 s" figure):
 *   Clinker: 4 shells (CLINKER_SHELLS) lobbed CLINKER_GAP=12 ticks apart each volley, a volley every `every` (230), each down
 *            CLINKER_WARN=60 ticks after its lob, `damage` HP each.
 *   Slag Ray: a cone of 3 shells every `cone` (30) ticks for the RAY_RUN=80 ticks of each pass (k = 0, 30, 60), a pass every
 *            `every` (220); each shell is the cannon's 14 HP x `damage`. (Its tail pools are left out: a pass lays them 260 off
 *            its target's side, so they miss one that sits still; their burn is unchanged.)
 * Times are from the first lob / first volley, in ticks (60 per second).
 *
 * Before (the split branch): Clinker 60 HP/shell (16.5 s), Slag Ray 0.9 scale = 12.6 HP/shell (about 33 s: 28 volleys).
 * After: Clinker 90 HP/shell, Slag Ray 3.0 scale = 42 HP/shell.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { createShipState, loadCatalog, type ShipTuning, type Catalog } from '@space-game/common';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';

const dataDir = join(__dirname, '../../../../data');
const cfg = loadShipConfigCached(dataDir);
const catalog: Catalog = loadCatalog(cfg.catalog as never);
const tuning = cfg.tuning as unknown as ShipTuning;
type Stats = Record<string, { moves: Record<string, Record<string, number>> }>;
const stats = findStats();

function findStats(): Stats {
  const f = readGameDataFiles(dataDir).factions as Record<string, any>;
  const walk = (o: any): Stats | null => {
    if (!o || typeof o !== 'object') return null;
    if (o.clinker?.moves && o.slag_ray?.moves) return o;
    for (const v of Object.values(o)) { const r = walk(v); if (r) return r; }
    return null;
  };
  return walk(f)!;
}

const CANNON = 14, TICK = 60;
const sparrowHp = () => {
  const bp = JSON.parse(require('fs').readFileSync(join(dataDir, 'ships/blueprints/sparrow-t.json'), 'utf-8'));
  const s = createShipState(catalog, tuning, 1, bp, 0);
  return s.hp.reduce((a: number, b: number) => a + b, 0);
};

/** Tick the cumulative damage first reaches `hp`, given hits as [tick, damage] in time order */
const killAt = (hits: [number, number][], hp: number) => { let t = 0; for (const [at, d] of hits.sort((a, b) => a[0] - b[0])) { t += d; if (t >= hp) return at; } return Infinity; };

function clinker(damage: number) {
  const hits: [number, number][] = [];
  for (let n = 0; n < 8; n++) for (let i = 0; i < 4; i++) hits.push([n * 230 + i * 12 + 60, damage]);
  return hits;
}
function ray(scale: number) {
  const hits: [number, number][] = [];
  for (let n = 0; n < 30; n++) for (const k of [0, 30, 60]) for (let s = 0; s < 3; s++) hits.push([n * 220 + k, CANNON * scale]);
  return hits;
}

describe('cave enemies: time to kill a stationary Sparrow T at Mk I', () => {
  const hp = sparrowHp();
  const cl = stats.clinker.moves.volley.damage, sr = stats.slag_ray.moves.pass.damage;
  const row = (name: string, before: [number, number][], after: [number, number][]) =>
    // eslint-disable-next-line no-console
    console.log(`${name}: before ${(killAt(before, hp) / TICK).toFixed(1)} s, after ${(killAt(after, hp) / TICK).toFixed(1)} s (Sparrow T ${hp.toFixed(0)} HP)`);

  it('the starter is about 1058 HP', () => { expect(hp).toBeGreaterThan(1000); expect(hp).toBeLessThan(1120); });
  it('Clinker kills it in about 10 s', () => {
    row('Clinker', clinker(60), clinker(cl));
    const s = killAt(clinker(cl), hp) / TICK;
    expect(s).toBeGreaterThan(8.5); expect(s).toBeLessThan(11);
  });
  it('Slag Ray kills it in about 10 s', () => {
    row('Slag Ray', ray(0.9), ray(sr));
    const s = killAt(ray(sr), hp) / TICK;
    expect(s).toBeGreaterThan(7.5); expect(s).toBeLessThan(11);
  });
});
