/**
 * The asset viewer's pure parts: its URL params (parsed, bounded, written back), the CLI's flags, the asset list and
 * search, asset ids and sheets, and the synthetic blueprints (models on a stub, material blocks, pieces).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { loadCatalog, parseBlueprint, type ShipTuning } from '@space-game/common';
import { DEFAULTS, flagsToParams, lightWith, parseParams, toQuery } from './params';
import { expandAsset, listAssets, parseAssetId, searchAssets, shipGroup, type AssetSources } from './assets';
import { defaultFacing, materialBlueprint, modelBlueprint, pieceBlueprint, usesBespoke, viewerShip } from './builders';

const DATA = join(__dirname, '../../../data/ships');
const json = (f: string) => JSON.parse(readFileSync(join(DATA, f), 'utf8'));
const tuning = json('tuning.json') as ShipTuning;
const catalog = loadCatalog({
  pieces: json('pieces.json'), functions: json('functions.json'), materials: json('materials.json'), models: json('models.json'),
  bespoke: readdirSync(join(DATA, 'bespoke')).map((f) => json(`bespoke/${f}`)),
} as never, { overlapShrink: tuning.overlapShrink });

describe('viewer params', () => {
  it('defaults when empty', () => {
    expect(parseParams('')).toEqual(DEFAULTS);
  });

  it('reads the example URL', () => {
    const p = parseParams('?asset=ship:sparrow-t&zoom=2&light=sun&bg=transparent&flames=0.8');
    expect(p).toMatchObject({ asset: 'ship:sparrow-t', zoom: 2, light: 'sun', bg: 'transparent', flames: 0.8 });
  });

  it('bounds and rejects bad values', () => {
    const p = parseParams('zoom=999&flames=7&damage=-1&light=disco&bg=plaid&angle=-90&lightDir=400&scale=100&w=3&tint=red&facing=e&cols=2.6');
    expect(p.zoom).toBe(64);
    expect(p.flames).toBe(1);
    expect(p.damage).toBe(0);
    expect(p.light).toBe('sun');
    expect(p.bg).toBe('starfield');
    expect(p.angle).toBe(270);
    expect(p.lightDir).toBe(40);
    expect(p.scale).toBe(8);
    expect(p.w).toBe(16);
    expect(p.tint).toBeNull();
    expect(p.facing).toBe('E');
    expect(p.cols).toBe(3);
    expect(parseParams('zoom=fit&aim=rest&tint=faction:pirates').zoom).toBe('fit');
    expect(parseParams('aim=rest').aim).toBeNull();
    expect(parseParams('aim=-45').aim).toBe(-45);
    expect(parseParams('tint=FF8800').tint).toBe('#ff8800');
    expect(parseParams('tint=faction:pirates').tint).toBe('faction:pirates');
  });

  it('booleans: 1/0, true/false, on/off', () => {
    expect(parseParams('grid=1&boost=true&exhaust=off&bloom=0&stub=no&ui=0')).toMatchObject({ grid: true, boost: true, exhaust: false, bloom: false, stub: false, ui: false });
  });

  it('writes only what differs, and reads back the same', () => {
    expect(toQuery(DEFAULTS)).toBe('');
    const p = parseParams('asset=model:laser_glint@E,ship:enemy/scrap_mother&zoom=1.5&angle=90&bg=dark&grid=1&aim=30&tint=%23aabbcc&w=800&h=600&scale=2');
    const q = toQuery(p);
    expect(q).toContain('asset=model:laser_glint@E,ship:enemy/scrap_mother');
    expect(q).not.toContain('light=');
    expect(parseParams(q)).toEqual(p);
  });

  it('light colour overrides: the sun colour, and the ambient tint at the ambient level', () => {
    const p = parseParams('lightColor=%23B8CCFF&ambientColor=4d385c&ambient=0.5');
    expect(p.lightColor).toBe('#b8ccff');
    expect(p.ambientColor).toBe('#4d385c');
    expect(parseParams('lightColor=blue').lightColor).toBeNull();
    expect(parseParams(toQuery(p))).toMatchObject({ lightColor: '#b8ccff', ambientColor: '#4d385c' });
    const preset = { ambient: [0.25, 0.25, 0.27], color: [0.95, 0.88, 0.74] };
    // Nothing set: the preset's own
    expect(lightWith(preset, DEFAULTS)).toEqual({ ambient: preset.ambient.map((v) => v * 1), color: preset.color });
    // A tint keeps the preset's ambient level; the level override moves it; the sun takes its colour whole
    const mean = (a: number[]) => (a[0] + a[1] + a[2]) / 3;
    const tinted = lightWith(preset, { ...DEFAULTS, ambientColor: '#ff0000' });
    expect(mean(tinted.ambient)).toBeCloseTo(mean(preset.ambient), 6);
    expect(tinted.ambient[0]).toBeGreaterThan(tinted.ambient[1]);
    expect(mean(lightWith(preset, { ...DEFAULTS, ambient: 0.6 }).ambient)).toBeCloseTo(0.6, 6);
    expect(lightWith(preset, { ...DEFAULTS, lightColor: '#ffffff' }).color).toEqual([1, 1, 1]);
  });

  it('CLI flags', () => {
    const { params, rest } = flagsToParams(['ship:corsair', '--zoom', '2', '--grid', '--no-bloom', '--flames=0.5', '--out', 'x.png', '--light', 'dark']);
    expect(params).toEqual({ asset: 'ship:corsair', zoom: '2', grid: '1', bloom: '0', flames: '0.5', light: 'dark' });
    expect(rest).toEqual({ out: 'x.png' });
    // (a boolean doesn't swallow the asset after it)
    expect(flagsToParams(['--grid', 'ship:arrow']).params).toEqual({ grid: '1', asset: 'ship:arrow' });
    expect(flagsToParams(['--grid', '0', 'ship:arrow']).params).toEqual({ grid: '0', asset: 'ship:arrow' });
  });
});

const sources: AssetSources = {
  blueprints: [
    { path: 'sparrow-t', name: 'Sparrow T' }, { path: 'enemy/pirate_raider', name: 'Pirate Raider' },
    { path: 'enemy/scrap_mother', name: 'Scrap Mother', bespoke: true, rigid: true }, { path: 'enemy/giant_mammoth', name: 'Redtooth Mammoth' },
    { path: 'dev/annihilator', name: 'Dev Annihilator' },
  ],
  models: [{ id: 'laser_glint', name: 'Glint', family: 'laser', mount: 'turret' }, { id: 'cannon_pip', name: 'Pip', family: 'cannon', mount: 'fixed' }],
  materials: [{ id: 'alloy', name: 'Alloy', grade: 1 }, { id: 'scrap_rust', name: 'Scrapborn Rust', grade: 3 }],
  pieces: [{ id: 'sq' }, { id: 'round2' }],
};

describe('viewer assets', () => {
  const list = listAssets(sources);

  it('groups ships', () => {
    expect(shipGroup(sources.blueprints[0])).toBe('Library ships');
    expect(shipGroup(sources.blueprints[1])).toBe('Enemy ships');
    expect(shipGroup(sources.blueprints[2])).toBe('Bosses & giants');
    expect(shipGroup(sources.blueprints[3])).toBe('Bosses & giants');
    expect(shipGroup(sources.blueprints[4])).toBe('Dev blueprints');
  });

  it('lists everything once, sheets first, models by family', () => {
    const ids = list.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('sheet:models');
    expect(ids).toContain('ship:enemy/scrap_mother');
    expect(ids.indexOf('model:cannon_pip')).toBeLessThan(ids.indexOf('model:laser_glint'));
    expect(ids).toEqual(expect.arrayContaining(['material:scrap_rust', 'piece:round2', 'ship:dev/annihilator']));
  });

  it('searches by every word', () => {
    expect(searchAssets(list, 'glint').map((e) => e.id)).toEqual(['model:laser_glint']);
    expect(searchAssets(list, 'turret').map((e) => e.id)).toEqual(['model:laser_glint']);
    expect(searchAssets(list, 'scrap').map((e) => e.id)).toEqual(['ship:enemy/scrap_mother', 'material:scrap_rust']);
    expect(searchAssets(list, 'bespoke mother').map((e) => e.id)).toEqual(['ship:enemy/scrap_mother']);
    expect(searchAssets(list, '').length).toBe(list.length);
  });

  it('parses ids', () => {
    expect(parseAssetId('ship:enemy/pirate_raider')).toEqual({ kind: 'ship', key: 'enemy/pirate_raider' });
    expect(parseAssetId('boss:scrap_mother')).toEqual({ kind: 'ship', key: 'enemy/scrap_mother' });
    expect(parseAssetId('model:laser_glint@W')).toEqual({ kind: 'model', key: 'laser_glint', facing: 'W' });
    expect(parseAssetId('ship:sparrow-t@N')).toBeNull();
    expect(parseAssetId('ship:../secrets')).toBeNull();
    expect(parseAssetId('nonsense')).toBeNull();
  });

  it('expands sheets and lists', () => {
    expect(expandAsset('sheet:models', list).map((r) => r.key)).toEqual(['cannon_pip', 'laser_glint']);
    expect(expandAsset('sheet:bosses', list).map((r) => r.key)).toEqual(['enemy/giant_mammoth', 'enemy/scrap_mother']);
    expect(expandAsset('sheet:facings:cannon_pip', list).map((r) => r.facing)).toEqual(['N', 'E', 'S', 'W']);
    expect(expandAsset('ship:sparrow-t, material:alloy ,bogus', list)).toEqual([{ kind: 'ship', key: 'sparrow-t' }, { kind: 'material', key: 'alloy' }]);
    expect(expandAsset('sheet:nope', list)).toEqual([]);
  });
});

describe('viewer blueprints', () => {
  const alive = (bp: ReturnType<typeof pieceBlueprint>) => viewerShip(catalog, tuning, 1, bp);

  it('faces weapons forward and engines back', () => {
    expect(defaultFacing(catalog, 'cannon_pip')).toBe('N');
    expect(defaultFacing(catalog, 'engine_ion_drive')).toBe('S');
    expect(defaultFacing(catalog, 'power_battery')).toBeNull();
  });

  it('puts every model on a stub along its attach edge', () => {
    for (const f of [...catalog.functions.values()].filter((x) => x.model)) {
      const bp = modelBlueprint(catalog, f.id);
      expect(bp.parts[0].fn).toBe(f.id);
      expect(bp.parts.length).toBeGreaterThan(1);
      expect(bp.parts.slice(1).every((p) => p.fn === 'hull')).toBe(true);
    }
    // A forward gun's stub is behind it (below); an engine's is in front of it (above)
    expect(modelBlueprint(catalog, 'cannon_pip').parts[1]).toMatchObject({ x: 0, y: 1 });
    expect(modelBlueprint(catalog, 'engine_ion_drive').parts[1]).toMatchObject({ x: 0, y: -1 });
    expect(modelBlueprint(catalog, 'cannon_pip', { facing: 'E' }).parts[1]).toMatchObject({ x: -1, y: 0 });
    expect(modelBlueprint(catalog, 'cannon_pip', { stub: false }).parts).toHaveLength(1);
    // (a model that fires its own way keeps no facing it can't use)
    expect(modelBlueprint(catalog, 'power_battery', { facing: 'E' }).parts[0].facing).toBeUndefined();
  });

  it('builds a test block in every material, and every piece', () => {
    for (const m of catalog.materials.values()) {
      const bp = materialBlueprint(catalog, m.id);
      expect(bp.parts.every((p) => p.material === m.id)).toBe(true);
      expect(alive(bp).derived.radius).toBeGreaterThan(0);
    }
    for (const id of catalog.pieceIds) {
      expect(pieceBlueprint(catalog, id).parts[0].piece).toBe(id);
      expect(alive(pieceBlueprint(catalog, id)).derived.alive).toEqual([true]);
    }
    expect(() => materialBlueprint(catalog, 'cheese')).toThrow();
  });

  it('knows a bespoke design', () => {
    const bp = parseBlueprint(readFileSync(join(DATA, 'blueprints/enemy/scrap_mother.json'), 'utf8'));
    expect(usesBespoke(catalog, bp)).toBe(true);
    expect(usesBespoke(catalog, parseBlueprint(readFileSync(join(DATA, 'blueprints/sparrow-t.json'), 'utf8')))).toBe(false);
  });
});
