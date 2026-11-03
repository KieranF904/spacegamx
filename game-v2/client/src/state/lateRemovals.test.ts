import { describe, expect, it } from 'vitest';
import { EntityType, type ServerSnapshotMessage } from '@space-game/common';
import { GameState } from './GameState';

const snap = (tick: number, entities: ServerSnapshotMessage['entities'], removed: number[]): ServerSnapshotMessage =>
  ({ type: 'snapshot', tick, lastProcessedInput: 0, entities, removed } as unknown as ServerSnapshotMessage);

describe('a shell fired and gone between two snapshots', () => {
  it('is made, seen for a snapshot, then removed with the next one (not left flying as a ghost)', () => {
    const s = new GameState();
    s.predictionEnabled = false;
    const shell = { id: 77, type: EntityType.Projectile, x: 0, y: 0, vx: 110, vy: 0, data: [19, 1, 0, 99, 0, 0, 5, 1, 1] };
    s.applySnapshot(snap(100, [shell], [77]));
    expect(s.entities.has(77)).toBe(true);
    s.applySnapshot(snap(103, [], []));
    expect(s.entities.has(77)).toBe(false);
  });

  it('a removal of something it never had is not held over', () => {
    const s = new GameState();
    s.predictionEnabled = false;
    s.applySnapshot(snap(100, [], [5]));
    const shell = { id: 5, type: EntityType.Projectile, x: 0, y: 0, vx: 50, vy: 0, data: [1, 1, 0, 101, 0, 0, 9, 1, 0] };
    s.applySnapshot(snap(103, [shell], []));
    s.applySnapshot(snap(106, [], []));
    expect(s.entities.has(5)).toBe(true);
  });
});
