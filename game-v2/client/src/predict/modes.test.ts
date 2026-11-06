import { describe, expect, it } from 'vitest';
import { AHEAD_BACK } from '@space-game/common';
import { DEFAULT_MODE, PREDICT_MODES, modeById, ptDrawTick, type ModeCtx } from './modes';
import type { InterpolatedEntity } from '../state/GameState';
import type { PtStLayer } from './ptst';

const ctx = (over: Partial<ModeCtx> = {}): ModeCtx => ({
  self: () => 1, renderTick: () => 90, confirmedTick: () => 100, predictedTick: () => 112, ownDraw: () => 111.5,
  ai: (id) => id === 7, drawBack: (id) => (id === 3 ? AHEAD_BACK - 1 : AHEAD_BACK), layer: { has: () => false } as unknown as PtStLayer, ...over,
});
const ent = (id: number) => ({ id }) as InterpolatedEntity;

describe('prediction modes', () => {
  it('registry: A B C1 C2 C3, C3 the default, A installs nothing', () => {
    expect(PREDICT_MODES.map((m) => m.id)).toEqual(['A', 'B', 'C1', 'C2', 'C3']);
    expect(DEFAULT_MODE).toBe('C3');
    expect(modeById('a')!.hook(ctx())).toBeNull();
    expect(modeById('c3')!.ptst).toEqual({ touch: true });
    expect(modeById('C2')!.ptst).toEqual({ touch: false });
  });

  it('B: your ship drawn at the render tick, never past the confirmed one', () => {
    const h = modeById('B')!.hook(ctx())!;
    expect(h.own!(111.5)).toBe(90);
    expect(modeById('B')!.hook(ctx({ renderTick: () => 104 }))!.own!(111.5)).toBe(100);
  });

  it('C1: AI ships and their shells ahead, pilots and theirs at the render tick, yours at present', () => {
    const h = modeById('C1')!.hook(ctx())!;
    h.frame!(0);
    expect(h.ship!(ent(7), 90)).toBe(111.5 - AHEAD_BACK);
    expect(h.ship!(ent(3), 90)).toBe(90);
    expect(h.shot!(7, 111.5, 90)).toBe(111.5 - AHEAD_BACK);
    expect(h.shot!(3, 111.5, 90)).toBe(90);
    expect(h.shot!(1, 111.5, 90)).toBe(111.5);
  });

  it('C2/C3 draw tick: a pilot half a tick behind your shells, anyone else AHEAD_BACK', () => {
    expect(ptDrawTick(ctx(), 3, 111.5)).toBe(111);
    expect(ptDrawTick(ctx(), 7, 111.5)).toBe(110);
  });
});
