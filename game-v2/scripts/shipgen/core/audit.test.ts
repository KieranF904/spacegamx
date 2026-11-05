// Fixes from the 2026-11-01 audit: grid reading, roles and their examples, the band, selectors, the outline.
import { describe, expect, it } from 'vitest';
import { loadContext } from './context';
import { blueprintToGrid, gridToBlueprint } from './grid';
import { briefCheck, loadRoles, matches, outOfBand } from './roles';
import { exposedCorners, outlineShapes, silhouetteScore, squareCornerWords } from './silhouette';
import { check } from './check';
import { ship } from './testShips';
import { buildLegend, legendFor } from './legend';
import { systemPrompt } from './prompt';
import { partsToBlueprint } from './partlist';
import type { Blueprint } from '../../../common/src/ships/index';

const ctx = loadContext();
const roles = loadRoles(ctx).roles;
const legend = buildLegend(ctx);

describe('shipgen grid reading', () => {
  it('keeps reading rows after a blank line, with a warning', () => {
    const d = gridToBlueprint(ctx, 'grid:\n -1 0 1\n0 HA CA HA\n\n1 HA HA HA\n2 HA HA HA\nend');
    expect(d.errors).toEqual([]);
    expect(d.bp!.parts.length).toBe(9);
    expect(d.warnings.join(' ')).toMatch(/blank line/);
  });
  it('still ends the grid at chatter after a blank line', () => {
    const d = gridToBlueprint(ctx, 'grid:\n -1 0 1\n0 HA CA HA\n\nHope this helps!\nend');
    expect(d.errors).toEqual([]);
    expect(d.bp!.parts.length).toBe(3);
  });
  it('reads and writes a one-column ship and an empty one', () => {
    const d = gridToBlueprint(ctx, 'grid:\n   0\n0  CA\n1  HA\nend');
    expect(d.errors).toEqual([]);
    expect(d.bp!.parts.length).toBe(2);
    const back = gridToBlueprint(ctx, blueprintToGrid(ctx, d.bp!).text);
    expect(back.bp!.parts.length).toBe(2);
    expect(() => blueprintToGrid(ctx, { name: 'none', catalogVersion: ctx.catalog.version, parts: [] })).not.toThrow();
    expect(gridToBlueprint(ctx, blueprintToGrid(ctx, { name: 'none', catalogVersion: ctx.catalog.version, parts: [] }).text).bp!.parts).toEqual([]);
  });
});

describe('shipgen part list hull under a part', () => {
  it('drops a hull piece only when the part covers all of it', () => {
    const hull = legend.find('hull', 'alloy')!.code;
    const d = partsToBlueprint(ctx, `name: t\nparts:\nCA 0,0\n${hull} -2,0 2x1\nPI^ -2,0\nPI^ -1,0\nend\n`);
    expect(d.errors).toEqual([]);
    expect(d.bp!.parts.filter((p) => p.fn === 'hull').length).toBe(0);
  });
});

describe('shipgen roles', () => {
  for (const r of roles.filter((x) => x.example)) {
    it(`${r.id}: the worked example meets its own brief and stays in the band`, () => {
      const bp = ship(r.example!);
      expect(briefCheck(ctx, bp, { ...r, example: undefined }).unmet, r.id).toEqual([]);
      expect(outOfBand(ctx, bp, r.band), r.id).toEqual([]);
      expect(systemPrompt(ctx, { role: r.id })).toContain('## Example');
    });
  }

  it('enforces the pilot level band with the game licensing', () => {
    const starter = roles.find((r) => r.id === 'starter')!;
    const wren = ship('dev/review-wren');
    const fusion = legend.entries.find((e) => e.fn === 'power_fusion_plant')!;
    const bad: Blueprint = { ...wren, parts: wren.parts.map((p, i) => (i === wren.parts.findIndex((q) => q.fn === 'power_cell_reactor') ? { ...p, fn: fusion.fn, material: fusion.material } : p)) };
    expect(briefCheck(ctx, bad, { ...starter, example: undefined }).unmet.join(' ')).toMatch(/above the pilot level band[^]*Fusion Plant/);
    expect(briefCheck(ctx, wren, { ...starter, example: undefined }).unmet.join(' ')).not.toMatch(/band/);
    // (the legend and the check agree on what the band is)
    for (const e of legendFor(legend, starter.band)) expect(outOfBand(ctx, { name: 'x', catalogVersion: 1, parts: [{ uid: 0, piece: 'sq', fn: e.fn, material: e.material, x: 0, y: 0, rot: 0, flip: false }] }, starter.band)).toEqual([]);
  });

  it('counts engines by thrust, not gyros or strafers, and shields by family', () => {
    const part = (fn: string) => ({ fn, piece: 'sq', material: legend.entries.find((e) => e.fn === fn)!.material });
    expect(matches(ctx, { role: 'engine' }, part('engine_ion_drive'))).toBe(true);
    expect(matches(ctx, { role: 'engine' }, part('utility_gyro'))).toBe(false);
    expect(matches(ctx, { role: 'engine' }, part('engine_burst_strafer'))).toBe(false);
    expect(matches(ctx, { role: 'thruster' }, part('utility_gyro'))).toBe(true);
    expect(matches(ctx, { family: 'shield' }, part('shield_deflector'))).toBe(true);
    expect(matches(ctx, { family: 'shield' }, part('utility_mining_laser'))).toBe(false);
    for (const r of roles) for (const s of [...(r.require ?? []), ...(r.encourage ?? [])]) expect(s.role, r.id).not.toBe('tool');
  });
});

describe('shipgen outline', () => {
  it('finds the exposed corners of a box ship and scores shaped ones', () => {
    const box: Blueprint = gridToBlueprint(ctx, 'grid:\n  0 HA HA HA\n  1 HA CA HA\n  2 HA HA HA\nend').bp!;
    expect(exposedCorners(ctx, box).length).toBe(4);
    expect(silhouetteScore(ctx, box)).toBe(0);
    const tri = outlineShapes(ctx).find((s) => s.marks.startsWith('t')) ?? outlineShapes(ctx)[0];
    const shaped = gridToBlueprint(ctx, `grid:\n  0 HA${tri.letter}1 HA HA\n  1 HA CA HA\n  2 HA HA HA\nend`).bp!;
    expect(silhouetteScore(ctx, shaped)).toBeGreaterThan(0);
    expect(squareCornerWords(ctx, shaped).length).toBe(3);
    expect(check(ctx, shaped).scores.silhouette).toBeGreaterThan(check(ctx, box).scores.silhouette!);
  });
  it('derives the useful shapes from the pieces', () => {
    const o = outlineShapes(ctx);
    expect(o.length).toBeGreaterThanOrEqual(2);
    expect(o.every((s) => /^[a-z]1-[a-z]\d$/.test(s.marks))).toBe(true);
    expect(systemPrompt(ctx, { role: 'starter' })).toContain('Shape the outline');
  });
});
