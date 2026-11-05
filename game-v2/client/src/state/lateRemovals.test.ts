import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import { EntityType, type ServerSnapshotMessage } from '@space-game/common';
import { GameState } from './GameState';
import { WeaponFx } from '../rendering/weapons/WeaponFx';

const snap = (tick: number, entities: ServerSnapshotMessage['entities'], removed: number[]): ServerSnapshotMessage =>
  ({ type: 'snapshot', tick, lastProcessedInput: 0, entities, removed } as unknown as ServerSnapshotMessage);

/** Another ship's shell (owner 9), fired on `spawnTick` from (0, 0), as a snapshot brings it */
const shellOf = (id: number, spawnTick: number) =>
  ({ id, type: EntityType.Projectile, x: 0, y: 0, vx: 30, vy: 0, data: [1, 1, 0, spawnTick, 0, 0, 9, 1, 0] });

describe('a shell fired and gone between two snapshots', () => {
  it('is made, drawn once, then removed with the next snapshot (not left flying as a ghost)', () => {
    const s = new GameState();
    s.predictionEnabled = false;
    const shell = { id: 77, type: EntityType.Projectile, x: 0, y: 0, vx: 110, vy: 0, data: [19, 1, 0, 99, 0, 0, 5, 1, 1] };
    s.applySnapshot(snap(100, [shell], [77]));
    expect(s.entities.has(77)).toBe(true);
    s.interpolate(1 / 60);
    s.applySnapshot(snap(103, [], []));
    expect(s.entities.has(77)).toBe(false);
  });

  it('a removal of something it never had is not held over', () => {
    const s = new GameState();
    s.predictionEnabled = false;
    s.applySnapshot(snap(100, [], [5]));
    const shell = { id: 5, type: EntityType.Projectile, x: 0, y: 0, vx: 50, vy: 0, data: [1, 1, 0, 101, 0, 0, 9, 1, 0] };
    s.applySnapshot(snap(103, [shell], []));
    s.interpolate(1 / 60);
    s.applySnapshot(snap(106, [], []));
    expect(s.entities.has(5)).toBe(true);
  });
});

/**
 * Coalesced frames (CAPS.COALESCE, docs/design/packed-frames.md): several snapshots come in one WebSocket message and
 * are applied in one go, with no frame drawn between them. A shell made by the first and removed by a later one (or
 * spent by a confirmed hit in it) was never seen by the renderers: another ship's shot showed no tracer at all, only
 * a mark where it hit. It now stays until a frame has drawn it.
 */
describe('a shell made and removed inside one coalesced message', () => {
  const rig = () => {
    const s = new GameState();
    s.predictionEnabled = false;
    const fx = new WeaponFx(new Container());
    (fx as unknown as { draw: () => void }).draw = () => {};
    const shots = () => (fx as unknown as { shots: Map<number, unknown> }).shots;
    /** One frame drawn: the game state's, then the shots' (Renderer's order) */
    const frame = () => { s.interpolate(1 / 60); fx.update(s, 1 / 60, s.serverTick, s.serverTick - 6); };
    return { s, fx, shots, frame };
  };

  it('is drawn: its tracer is made, then it goes with the next snapshot', () => {
    const { s, shots, frame } = rig();
    // (one message: the snapshot that brings it, then the one that removes it)
    s.applySnapshot(snap(100, [shellOf(40, 99)], []));
    s.applySnapshot(snap(103, [], [40]));
    expect(s.entities.has(40), 'kept for a frame').toBe(true);
    frame();
    expect(shots().has(40), 'its tracer was made').toBe(true);
    s.applySnapshot(snap(106, [], []));
    expect(s.entities.has(40)).toBe(false);
  });

  it('the same for a shell a confirmed hit spends (removeShell) in a later sub-frame', () => {
    const { s, shots, frame } = rig();
    s.applySnapshot(snap(100, [shellOf(41, 99)], []));
    s.applySnapshot(snap(103, [], []));
    s.removeShell(41);
    expect(s.entities.has(41)).toBe(true);
    frame();
    expect(shots().has(41)).toBe(true);
    s.applySnapshot(snap(106, [], []));
    expect(s.entities.has(41)).toBe(false);
  });

  it('a shell drawn before its removal goes at once, as ever', () => {
    const { s, frame } = rig();
    s.applySnapshot(snap(100, [shellOf(42, 99)], []));
    frame();
    s.applySnapshot(snap(103, [], [42]));
    expect(s.entities.has(42)).toBe(false);
  });

  it('an id used again by the next snapshot is the new entity', () => {
    const { s } = rig();
    s.applySnapshot(snap(100, [shellOf(43, 99)], []));
    s.applySnapshot(snap(103, [], [43]));
    s.applySnapshot(snap(106, [shellOf(43, 105)], []));
    expect(s.entities.get(43)?.spawnTick).toBe(105);
  });

  it('with no frames drawn at all (a hidden tab) nothing waits for long', () => {
    const { s } = rig();
    s.applySnapshot(snap(100, [shellOf(44, 99)], []));
    s.applySnapshot(snap(103, [], [44]));
    for (let t = 106; t <= 160; t += 3) s.applySnapshot(snap(t, [], []));
    expect(s.entities.has(44)).toBe(false);
  });
});
