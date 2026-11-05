import { describe, it, expect } from 'vitest';
import { EntityType } from '@space-game/common';
import { canHurt, SIDE_WARD, SIDE_OUT } from './sides';

/** A state with just entities and a system (all canHurt reads) */
function state(systemId: string, ents: { id: number; type: EntityType; x?: number; y?: number; data?: number[] }[]) {
  return { systemId, entities: new Map(ents.map((e) => [e.id, { renderX: e.x ?? 0, renderY: e.y ?? 0, ...e }])) } as never;
}

describe("who a beam may hurt (as GameServer.canDamage)", () => {
  it('passes through wards for pilots, people\'s craft for anyone, and other pilots outside PvP space', () => {
    const s = state('sol', [
      { id: 1, type: EntityType.Player }, { id: 2, type: EntityType.Player, x: 500 },
      { id: 3, type: EntityType.ShipBody, data: [2, 0, 0, -1, 0, 0, 0, 0, 0, 0, SIDE_WARD] },
      { id: 4, type: EntityType.ShipBody, data: [2, 0, 0, -1, 0, 0, 0, 0, 0, 0, SIDE_OUT] },
      { id: 5, type: EntityType.ShipBody, data: [3, 0, 0, 1, 0, 0, 0, 0, 12, 0, 0] },
    ]);
    expect(canHurt(s, 1, 5)).toBe(true);
    expect(canHurt(s, 5, 1)).toBe(true);
    expect(canHurt(s, 5, 3)).toBe(true);
    expect(canHurt(s, 1, 3)).toBe(false);
    expect(canHurt(s, 3, 1)).toBe(false);
    expect(canHurt(s, 1, 4)).toBe(false);
    expect(canHurt(s, 5, 4)).toBe(false);
    // (Sol isn't a PvP sector)
    expect(canHurt(s, 1, 2)).toBe(false);
  });
});
