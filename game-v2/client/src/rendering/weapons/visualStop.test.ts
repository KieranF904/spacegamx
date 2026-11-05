/**
 * Every drawn shell stops at the first surface it is seen to touch (WeaponFx.castHit, ships/drawnHit.ts), in that
 * frame, with its impact there; nothing of it shows past that point afterwards. The server's hits only confirm: they
 * never move the impact, draw a second one, or bring an ended shell back (a later hit, an adopt, a later row).
 *
 * Real WeaponFx with a stand-in world: walls across the shells' path (y = -300 and y = -600) that castHit reports, a
 * stand-in game state, drawing stubbed out (the shots' state is what's checked).
 */
import { describe, expect, it, vi } from 'vitest';
import { Container } from 'pixi.js';
import { EntityType, WeaponType } from '@space-game/common';
import { WeaponFx, type DrawnHit, type PredictedShell } from './WeaponFx';
import type { GameState } from '../../state/GameState';

const ME = 7, OTHER = 9;

interface ShotView { id: number; predicted: boolean; fading: number | null; ended: boolean; hit: { x: number; y: number } | null; head: { x: number; y: number } | null; tail: { x: number; y: number } | null; pierceLeft: number }

/** Walls: (y, the entity id it stands for). A shell's line meets the first one it crosses going up (y falling) */
function walls(list: [number, number][]) {
  return (x0: number, y0: number, x1: number, y1: number, owner: number, skip: readonly number[] | null, out: DrawnHit): boolean => {
    let best = Infinity, id = -1;
    for (const [wy, wid] of list) {
      if (wid === owner || skip?.includes(wid)) continue;
      if (!(y0 > wy && y1 <= wy)) continue;
      const t = (y0 - wy) / (y0 - y1);
      if (t < best) { best = t; id = wid; }
    }
    if (id < 0) return false;
    out.t = best; out.x = x0 + (x1 - x0) * best; out.y = y0 + (y1 - y0) * best; out.target = id;
    return true;
  };
}

function rig(list: [number, number][] = [[-300, 50]]) {
  const entities = new Map<number, { id: number; type: number }>();
  const state = {
    entities: Object.assign(entities, { ofType: (t: number) => [...entities.values()].filter((e) => e.type === t) }),
    playerId: ME, serverTick: 100, predictionEnabled: true, triggerScreenShake() {},
  };
  const fx = new WeaponFx(new Container());
  // (no textures in node: nothing is painted; the shots' fading, keeping and letting go run as in a frame)
  const inner = fx as unknown as { draw: (f: number) => void; clock: number; ageShots: (f: number) => void };
  inner.draw = (frames: number) => { inner.clock += frames; inner.ageShots(frames); };
  fx.castHit = walls(list);
  const impacts: [number, number][] = [];
  const orig = (fx as unknown as { impactAt: (s: unknown, x: number, y: number) => void }).impactAt.bind(fx);
  vi.spyOn(fx as unknown as { impactAt: (s: unknown, x: number, y: number) => void }, 'impactAt').mockImplementation((s, x, y) => { impacts.push([x, y]); orig(s, x, y); });
  const shots = () => [...(fx as unknown as { shots: Map<number, ShotView> }).shots.values()];
  const frame = (tick: number, serverTick = tick - 1) => {
    state.serverTick = serverTick;
    fx.update(state as unknown as GameState, 1 / 60, tick, tick - 6);
  };
  const fire = (p: Partial<PredictedShell> & { spawnTick: number }) =>
    fx.predict({ pose: { x: 0, y: 0, angle: -Math.PI / 2 }, owner: ME, type: WeaponType.Cannon, life: 60, spawnX: 0, spawnY: 0, vx: 0, vy: -110, size: 1, ...p } as PredictedShell);
  /** Nothing of any shell drawn past the wall it ended at (heads and tails on the near side) */
  const past = (wallY: number) => shots().filter((s) => s.ended && ((s.head && s.head.y < wallY - 1e-6) || (s.tail && s.tail.y < wallY - 1e-6))).length;
  return { fx, state, shots, frame, fire, entities, impacts, past };
}

describe('a drawn shell stops at the first surface it touches', () => {
  it('your own predicted bolt: stops at the wall in the frame it gets there, one impact there, nothing past it', () => {
    const { shots, frame, fire, impacts, past } = rig();
    fire({ spawnTick: 100 });
    frame(101);
    frame(102);
    expect(shots()[0].ended).toBe(false);
    // Tick 103 takes it from -220 to -330: it stops at -300 that frame
    frame(103);
    const s = shots()[0];
    expect(s.ended).toBe(true);
    expect(s.head).toEqual({ x: 0, y: -300 });
    expect(impacts).toEqual([[0, -300]]);
    for (let t = 104; t < 130; t++) { frame(t); expect(past(-300)).toBe(0); }
  });

  it("the server's hit after it only confirms: no second impact, the impact not moved, not drawn again", () => {
    const { fx, shots, frame, fire, impacts, entities, past } = rig();
    fire({ spawnTick: 100 });
    for (let t = 101; t <= 104; t++) frame(t);
    // Its hit, for a shell this client never had a row for (the adopt path), a little off where it was drawn to strike
    fx.onHit(900, 2, -308);
    frame(105, 104);
    expect(impacts).toEqual([[0, -300]]);
    expect(shots().find((x) => x.id === 900)?.hit).toEqual({ x: 0, y: -300 });
    // ...and a row for it now (late): taken over ended, never flying again
    entities.set(900, { id: 900, type: EntityType.Projectile, data: [WeaponType.Cannon, 1, 0, 100, 0, 0, ME, 1, 0, 0, 3], spawnTick: 100, spawnX: 0, spawnY: 0, x: 0, y: -440, vx: 0, vy: -110 } as never);
    for (let t = 106; t < 300; t++) { frame(t, t - 1); expect(past(-300)).toBe(0); }
    expect(impacts).toHaveLength(1);
    // Let go long since, and a hit or a row for it still changes nothing
    fx.onHit(900, 0, -300);
    frame(301, 300);
    expect(impacts).toHaveLength(1);
    expect(shots().filter((x) => !x.ended)).toEqual([]);
  });

  it("another ship's shell on the interpolated timeline: the server's hit comes first, the shell stops where it's drawn to touch", () => {
    const { fx, shots, frame, entities, impacts } = rig();
    entities.set(901, { id: 901, type: EntityType.Projectile, data: [WeaponType.Cannon, 1, 0, 100, 0, 0, OTHER, 1, 0, 0, 3], spawnTick: 100, spawnX: 0, spawnY: 0, x: 0, y: -110, vx: 0, vy: -110 } as never);
    // (drawn 6 ticks behind: at tick 105 its head is at -0; the server's hit, 4 units into the wall, comes now)
    frame(105, 104);
    fx.onHit(901, 0, -304);
    for (let t = 106; t < 112; t++) frame(t, t - 1);
    const s = shots().find((x) => x.id === 901)!;
    expect(s.ended).toBe(true);
    expect(s.hit).toEqual({ x: 0, y: -300 });
    expect(impacts).toEqual([[0, -300]]);
  });

  it('a piercing shell marks each surface it passes and stops at the last', () => {
    const { shots, frame, fire, impacts } = rig([[-300, 50], [-600, 51]]);
    fire({ spawnTick: 100, pierce: 1 });
    for (let t = 101; t < 110; t++) frame(t);
    expect(impacts).toEqual([[0, -300], [0, -600]]);
    const s = shots()[0];
    expect(s.ended).toBe(true);
    expect(s.head).toEqual({ x: 0, y: -600 });
  });

  it("a shell passes through its own shooter's ship", () => {
    const { shots, frame, fire, impacts } = rig([[-300, ME]]);
    fire({ spawnTick: 100 });
    for (let t = 101; t < 106; t++) frame(t);
    expect(impacts).toEqual([]);
    expect(shots()[0].ended).toBe(false);
  });
});
