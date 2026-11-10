/** The per-frame draw pass (state/interpolation.ts) over a stand-in game state: bracketing, clamping and the angle's short way round. */
import { describe, expect, it } from 'vitest';
import { EntityType, INTERP_MIN_DELAY_MS } from '@space-game/common';
import { interpolateFrame, fallbackInterpolate } from './interpolation';

interface E { id: number; x: number; angle: number; renderX: number; renderAngle: number }
const ent = (id: number, x: number, angle = 0, extra: object = {}): E =>
  ({ id, type: EntityType.Player, x, y: 0, vx: 0, vy: 0, angle, renderX: x, renderY: 0, renderAngle: angle, ...extra }) as E;
const snap = (tick: number, rows: Array<[number, number, number]>) =>
  ({ tick, entities: new Map(rows.map(([id, x, angle]) => [id, { x, y: 0, vx: 0, vy: 0, angle }])) });


function gs(renderTick: number, buffer: ReturnType<typeof snap>[], entities: E[]): any {
  return {
    playerId: 1, predictionEnabled: false, predictedTick: 0, selfPrev: null, orbitFocus: null, tickMs: 1000 / 60,
    targetInterpDelayMs: 0, interpDelayMs: 0, snapshotBuffer: buffer, renderTickNow: 0,
    entities: new Map(entities.map((e) => [e.id, e])),
    frameDrawn() {}, getEstimatedServerTick: () => renderTick + INTERP_MIN_DELAY_MS / (1000 / 60), getRawServerTick: () => renderTick,
  } as never;
}

describe('interpolateFrame', () => {
  it('places another ship between the bracketing snapshots', () => {
    const other = ent(2, 0);
    interpolateFrame(gs(105, [snap(100, [[2, 0, 0]]), snap(110, [[2, 100, 0]])], [other]), 0.016);
    expect(other.x).toBeCloseTo(50, 6);
  });

  it('never extrapolates past 1.2 of the gap', () => {
    const other = ent(2, 0);
    interpolateFrame(gs(500, [snap(100, [[2, 0, 0]]), snap(110, [[2, 100, 0]])], [other]), 0.016);
    expect(other.x).toBeCloseTo(120, 6);
  });

  it('before the buffer starts it holds at the first snapshot (t clamped at 0)', () => {
    const other = ent(2, 0);
    interpolateFrame(gs(10, [snap(100, [[2, 30, 0]]), snap(110, [[2, 100, 0]])], [other]), 0.016);
    expect(other.x).toBeCloseTo(30, 6);
  });

  it('turns the short way round the circle', () => {
    const other = ent(2, 0, 3.0);
    interpolateFrame(gs(105, [snap(100, [[2, 0, 3.0]]), snap(110, [[2, 0, -3.0]])], [other]), 0.016);
    // halfway between 3.0 and -3.0 the short way is about pi, not 0
    expect(Math.abs(Math.abs(other.angle) - Math.PI)).toBeLessThan(0.15);
  });

  it('the own ship without prediction is drawn exactly where it is (no smoothing lag)', () => {
    const me = ent(1, 80, 1.5, { renderX: 0, renderAngle: 0 });
    interpolateFrame(gs(105, [snap(100, []), snap(110, [])], [me]), 0.016);
    expect(me.renderX).toBe(80);
    expect(me.renderAngle).toBe(1.5);
  });

  it('the interpolation delay slews toward its target within its limits', () => {
    const g = gs(105, [snap(100, []), snap(110, [])], []);
    g.targetInterpDelayMs = 1e9;
    interpolateFrame(g, 0.016);
    const one = g.interpDelayMs;
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThan(1e9);
    for (let i = 0; i < 2000; i++) interpolateFrame(g, 0.1);
    const top = g.interpDelayMs;
    expect(top).toBeLessThan(1e9);
    interpolateFrame(g, 0.1);
    expect(g.interpDelayMs).toBe(top);
    g.targetInterpDelayMs = -1e9;
    for (let i = 0; i < 2000; i++) interpolateFrame(g, 0.1);
    expect(g.interpDelayMs).toBeGreaterThanOrEqual(0);
    expect(g.interpDelayMs).toBeLessThan(top);
  });

  it('with fewer than two snapshots it eases toward the entity position', () => {
    const other = ent(2, 100, 0, { renderX: 0 });
    interpolateFrame(gs(105, [snap(100, [[2, 100, 0]])], [other]), 0.016);
    expect(other.renderX).toBeCloseTo(25, 6);
  });
});

describe('fallbackInterpolate', () => {
  it('eases others a quarter of the way a frame and snaps the own ship', () => {
    const me = ent(1, 10, 0, { renderX: 0 });
    const o = ent(2, 40, 0, { renderX: 0 });
    fallbackInterpolate(gs(0, [], [me, o]));
    expect(me.renderX).toBe(10);
    expect(o.renderX).toBe(10);
  });
});
