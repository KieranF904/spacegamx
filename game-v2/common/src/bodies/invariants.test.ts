/**
 * Pins for header invariants that had none: bodies/custom (roster order) and bodies/moves (same output on both sides).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import roster from './custom/roster.json' with { type: 'json' };
import { CUSTOM_DESIGNS, customIndex, customGroups } from './custom/index.js';
import { customMoves, type CustomAct, type CustomStats } from './moves/custom.js';

describe('bodies/custom: listed in roster order', () => {
  it('each design sits at its roster.json index, with its groups core first', () => {
    expect(CUSTOM_DESIGNS.map((d) => d.id)).toEqual(roster.designs.map((d) => d.id));
    roster.designs.forEach((r, i) => {
      expect(customIndex(r.id)).toBe(i);
      expect(customGroups(r.id)).toEqual(r.groups);
      expect(r.groups[0]).toBe('core');
    });
    expect(customIndex('no_such_design')).toBe(-1);
    expect(new Set(roster.designs.map((d) => d.id)).size).toBe(roster.designs.length);
  });
});

describe('bodies/moves: the same on both sides', () => {
  it('no move module draws on anything outside its inputs (no Math.random, Date, performance)', () => {
    const dir = join(__dirname, 'moves');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      const src = readFileSync(join(dir, f), 'utf-8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(src, f).not.toMatch(/Math\.random|Date\.now|performance\.now|new Date\b/);
    }
  });

  it('a design step gives the same calls from the same inputs, and never touches Math.random', () => {
    const run = (design: string, k: number): string => {
      const log: unknown[] = [];
      const stats: CustomStats = { range: 800, reach: 900, firepower: 1, hp: {}, moves: {} };
      const pose = { x: 100, y: 50, vx: 1, vy: 0, angle: 0.3 } as any;
      const act: CustomAct = {
        eid: 7, now: 1000, target: 3, d: 400, design, stats, dmg: 1, st: {},
        has: () => true,
        at: (g) => ({ x: 120 + g.length, y: 60, dir: 0.2 }),
        me: () => pose, tpose: () => ({ ...pose, x: 500, y: 100 }), ahead: () => ({ x: 510, y: 100 }),
        fx: (m) => log.push(['fx', m]), shoot: (s) => log.push(['shoot', s]),
        rng: () => 0.5, mobs: false,
      };
      customMoves(() => 0)[design].step?.(act, { move: 0, arg: 100, seed: 12345 } as any, k);
      return JSON.stringify(log);
    };
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Math.random in a move'); });
    try {
      for (const d of CUSTOM_DESIGNS) {
        for (const k of [0, 1, 5, 20, 40]) expect(run(d.id, k), `${d.id} k=${k}`).toBe(run(d.id, k));
      }
    } finally { spy.mockRestore(); }
  });
});
