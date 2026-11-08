import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../../server/src/proto/createProtoServer';
import { BLOCK_ID, BlockTarget, blockSpec, type HitDamage } from './blockTarget';
import { WALL_COLS, WALL_ROWS } from './framing';

const SPEC = { hullHp: 100, armourHp: 250 };
const wall = () => { const t = new BlockTarget(SPEC); t.layout(300, 30); return t; };
const shell = (damage: number, over: Partial<HitDamage> = {}): HitDamage => ({ damage, splashDamage: 0, splashRadius: 0, splashFalloff: 1.5, chain: null, ...over });
const hpOf = (t: BlockTarget) => t.blocks.map((b) => b.hp);

describe('block target', () => {
  it('takes its HP from the catalogue: an armour square holds more than a hull one', () => {
    const { catalog } = createShipBridge(loadShipConfigCached(join(__dirname, '../../../../data')));
    const s = blockSpec(catalog);
    expect(s.hullHp).toBeGreaterThan(0);
    expect(s.armourHp).toBeGreaterThan(s.hullHp);
  });
  it('lays out a wall with its front face at the distance, armour in front, centred on the line of fire', () => {
    const t = wall();
    expect(t.blocks.length).toBe(WALL_COLS * WALL_ROWS);
    expect(Math.min(...t.blocks.map((b) => b.x - b.size / 2))).toBeCloseTo(300, 6);
    expect(t.blocks.filter((b) => b.armour).every((b) => b.col === 0)).toBe(true);
    expect(t.blocks.reduce((s, b) => s + b.y, 0)).toBeCloseTo(0, 6);
  });
  it('a line from the muzzle meets the front block on its face; one that passes wide misses', () => {
    const t = wall();
    const c = t.cast(0, 0, 500, 0)!;
    expect(c.t * 500).toBeCloseTo(300, 6);
    expect(t.cast(0, 0, 250, 0)).toBeNull();
    expect(t.cast(0, 400, 500, 400)).toBeNull();
  });
  it('the struck face\'s normal turns back toward the shell', () => {
    const t = wall();
    const n = t.normalAt(300, 0, 1, 0, { nx: 0, ny: 0 })!;
    expect(n.nx).toBeLessThan(-0.9);
  });
  it('a shell hurts only the block it hits', () => {
    const t = wall();
    const c = t.cast(0, 0, 500, 0)!;
    const before = hpOf(t);
    const hurt = t.strike(300, 0, c.id, shell(40));
    expect(hurt.length).toBe(1);
    const after = hpOf(t);
    const changed = after.map((h, i) => (h !== before[i] ? i : -1)).filter((i) => i >= 0);
    expect(changed).toEqual([c.id - BLOCK_ID]);
    expect(t.blocks[c.id - BLOCK_ID].hp).toBe(before[c.id - BLOCK_ID] - 40);
  });
  it('a burst falls off with distance from where it lands and stops at its radius', () => {
    const t = wall();
    const mid = t.blocks.find((b) => b.col === 0 && b.row === 2)!;
    t.strike(mid.x - mid.size / 2, mid.y, -1, shell(0, { splashDamage: 100, splashRadius: 40 }));
    const lost = (col: number, row: number) => { const b = t.blocks.find((q) => q.col === col && q.row === row)!; return b.max - b.hp; };
    expect(lost(0, 2)).toBeCloseTo(100, 6);
    expect(lost(0, 3)).toBeGreaterThan(0);
    expect(lost(0, 3)).toBeLessThan(lost(0, 2));
    expect(lost(1, 2)).toBeGreaterThan(0);
    expect(lost(0, 4)).toBe(0);
    expect(lost(2, 2)).toBe(0);
  });
  it('a chain jumps to the nearest other blocks at a falling share', () => {
    const t = wall();
    const c = t.cast(0, 0, 500, 0)!;
    const before = hpOf(t);
    t.strike(300, 0, c.id, shell(20, { chain: { count: 2, radius: 100, falloff: 0.5 } }));
    const lost = t.blocks.map((b, i) => before[i] - b.hp).filter((l) => l > 0).sort((a, b) => b - a);
    expect(lost).toEqual([20, 10, 5]);
  });
  it('a block breaks at 0 HP once, and rounds then pass its place', () => {
    const t = wall();
    const c = t.cast(0, 0, 500, 0)!;
    const b = t.blocks[c.id - BLOCK_ID];
    t.strike(300, 0, c.id, shell(b.max - 1));
    expect(b.alive).toBe(true);
    expect(t.takeBroken()).toEqual([]);
    t.strike(300, 0, c.id, shell(5));
    expect(b.alive).toBe(false);
    expect(b.hp).toBe(0);
    expect(t.takeBroken()).toEqual([b]);
    expect(t.takeBroken()).toEqual([]);
    const next = t.cast(0, 0, 500, 0)!;
    expect(next.id).not.toBe(c.id);
    expect(next.t * 500).toBeCloseTo(330, 6);
  });
  it('a beam burns the first block on its line and moves on when it breaks', () => {
    const t = wall();
    const first = t.beam(10, 600)!;
    expect(first.x).toBeCloseTo(300, 6);
    const b = t.blocks[first.id - BLOCK_ID];
    expect(b.hp).toBe(b.max - 10);
    t.beam(1e6, 600);
    expect(b.alive).toBe(false);
    expect(t.beam(0, 600)!.x).toBeCloseTo(330, 6);
  });
  it('a negative beam mends up to the block\'s maximum', () => {
    const t = new BlockTarget(SPEC);
    t.layout(300, 30, 0.4);
    const b = t.blocks.find((q) => q.col === 0 && q.row === 2)!;
    expect(b.hp).toBeCloseTo(b.max * 0.4, 6);
    t.beam(-1e6, 600);
    expect(b.hp).toBe(b.max);
  });
  it('is rebuilt when mostly gone, every block at full HP and growing back in', () => {
    const t = wall();
    for (const b of t.blocks.slice(0, 13)) t.hurtBlock(b, 1e6);
    expect(t.aliveCount).toBe(2);
    const before = t.rebuilds;
    t.step(0.1);
    expect(t.rebuilds).toBe(before);
    t.step(2);
    t.step(0.01);
    expect(t.rebuilds).toBe(before + 1);
    expect(t.aliveCount).toBe(t.blocks.length);
    expect(t.blocks.every((b) => b.hp === b.max && b.appear < 1)).toBe(true);
    t.step(1);
    expect(t.blocks.every((b) => b.appear === 1)).toBe(true);
    expect(t.takeBroken()).toEqual([]);
  });
  it('is rebuilt after a long time even if barely scratched', () => {
    const t = wall();
    t.hurtBlock(t.blocks[0], 5);
    const n = t.rebuilds;
    for (let i = 0; i < 40; i++) t.step(1);
    expect(t.rebuilds).toBeGreaterThan(n);
    expect(t.blocks[0].hp).toBe(t.blocks[0].max);
  });
});
