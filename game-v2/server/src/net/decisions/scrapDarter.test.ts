/**
 * The Scrap Darter (the Scrap Mother's den; common bodies/custom/scrapDarter.ts, its moves common bodies/moves/custom.ts) on the tick
 * layer: its darts onto a flank and away, and its flight after a fin or its fuel pod is shot off, are the server's ship
 * bit for bit at every snapshot on a capable client (customEnemies.test.ts for the rest of the roster).
 */
import { describe, it, expect } from 'vitest';
import { customGroups } from '@space-game/common';
import { fight } from '../../testkits/decisionFight.testkit.js';

describe('the Scrap Darter on the tick layer (CAPS.PILOTS)', () => {
  it('darts onto your flank and away; with a fin or its pod gone it flies the same on both sides', () => {
    const r = fight({
      ticks: 1500, prey: true, loseAt: 800,
      packs: [{ ships: ['scrap_darter', 'scrap_darter', 'scrap_crawler'], dx: 1300, dy: 500, faction: 'scrapborn' }],
      lose: (ship, uid) => {
        const part = ship.blueprint.parts.find((p) => p.uid === uid);
        return ship.blueprint.name === 'Scrap Darter' && part?.group !== undefined && ['fin_l', 'pod'].includes(customGroups('scrap_darter')[part.group]);
      },
    });
    const moves = r.server.enemies.custom.stats.moves;
    expect(moves['scrap_darter.dart'] ?? 0).toBeGreaterThan(1);
    expect(r.server.enemies.custom.stats.lost).toBeGreaterThanOrEqual(2);
    // (checked at each snapshot's tick: the Crawler's magnet no longer sends one a round while it pulls, its pulls worked
    // out on the pilot's tick layer: pull fields. About 140 snapshots, 230 before)
    expect(r.got.A.checked).toBeGreaterThan(250);
    expect(r.got.A.off).toBe(0);
    expect(r.got.A.ctlRows).toBe(0);
    expect(r.stats.off).toBe(0);
  }, 300_000);
});
