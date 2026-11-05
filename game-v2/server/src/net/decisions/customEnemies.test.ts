/**
 * Custom enemies on the tick layer (docs/enemies/custom-roster.md; common bodies/custom, server game/custom): each design
 * flies on the enemy AI's pilot body with its own order (its move under way, its pieces lost), and a capable client's
 * replica of every one it runs is the server's ship bit for bit at every snapshot's tick, through their moves (a
 * Censer holding its lance's line, a Hookboat swinging onto its harpoon's, a Sower running ahead to sow, a Ray's arcs)
 * and after pieces are shot off (a lost vane or wing turning it slowly, a lost drive leaving it adrift, crabbing on one
 * of two drives). No control rows of them; every body check agrees.
 */
import { describe, it, expect } from 'vitest';
import { CAPS, Position, customGroups } from '@space-game/common';
import type { GameServer } from '../../GameServer.js';
import { fight, ALL } from '../../testkits/decisionFight.testkit.js';

/** What each design loses mid-fight: the pieces that change how it flies */
const LOSE: Record<string, string[]> = {
  Censer: ['vane_l', 'drive'], 'Maw Lurker': ['root_r', 'eye'], Hookboat: ['outrigger', 'drive_l'], 'Rime Bell': ['frill', 'tendril_c'],
  'Scrap Crawler': ['drive', 'claw_l'], 'Rivet Sower': ['sensors'], 'Slag Ray': ['wing_l'], Clinker: ['chimney_l', 'plate_front'], 'Helios Drone': ['drive'],
};
const DESIGN: Record<string, string> = {
  Censer: 'censer', 'Maw Lurker': 'maw_lurker', Hookboat: 'hookboat', 'Rime Bell': 'rime_bell', 'Scrap Crawler': 'scrap_crawler',
  'Rivet Sower': 'rivet_sower', 'Slag Ray': 'slag_ray', Clinker: 'clinker', 'Helios Drone': 'helios_drone',
};

/**
 * The Helios Drones keep well off and weld only what comes within their torch's reach: now and then each is brought in
 * beside the pilot (moved there on the server: a keyframe of it), so their torch is lit too
 */
function closeIn(t: number, server: GameServer, foes: number[]) {
  if (t % 400 !== 300) return;
  for (const id of foes) {
    const pid = server.enemies.targetOf(id);
    if (server.enemies.factionOf(id) === 'helios' && pid >= 0) { Position.x[id] = Position.x[pid] + 260; Position.y[id] = Position.y[pid] + 40; }
  }
}

function run(packs: { ships: string[]; dx: number; dy: number; faction: string }[], lose: boolean, ticks = 1500, caps?: number) {
  return fight({
    ticks, packs, caps, loseAt: lose ? 700 : undefined, prey: true, each: closeIn,
    lose: (ship, uid) => {
      const name = ship.blueprint.name, part = ship.blueprint.parts.find((p) => p.uid === uid);
      if (!part || part.group === undefined || !LOSE[name]) return false;
      return LOSE[name].includes(customGroups(DESIGN[name])[part.group]);
    },
  });
}

describe('custom enemies: their moves and lost pieces on the tick layer (CAPS.PILOTS)', () => {
  it('the replacements (Censer, Maw Lurker, Hookboat, Rime Bell, Helios Drone): every one run is the server\'s ship at every snapshot, through their moves', () => {
    const r = run([
      { ships: ['pirate_raider', 'pirate_raider'], dx: 1300, dy: 700, faction: 'pirates' },
      { ships: ['cinder_zealot'], dx: -1500, dy: 400, faction: 'cinder' },
      { ships: ['maw_lurker'], dx: 400, dy: -2200, faction: 'maw' },
      { ships: ['frost_shard', 'frost_shard', 'frost_shard'], dx: -900, dy: -1200, faction: 'frost' },
      { ships: ['helios_drone', 'helios_drone'], dx: 500, dy: 500, faction: 'helios' },
    ], false);
    const moves = r.server.enemies.custom.stats.moves;
    if (process.env.BODY_DEBUG) console.log('CUSTOM', JSON.stringify({ moves, got: { ...r.got.A, ran: r.got.A.ran.size }, stats: r.stats }));
    for (const m of ['censer.lance', 'maw_lurker.aim', 'hookboat.harpoon', 'rime_bell.pulse', 'helios_drone.torch']) expect(moves[m] ?? 0, m).toBeGreaterThan(0);
    expect(r.got.A.ran.size).toBeGreaterThanOrEqual(6);
    expect(r.got.A.checked).toBeGreaterThan(800);
    expect(r.got.A.off).toBe(0);
    expect(r.got.A.ctlRows).toBe(0);
    expect(r.stats.off).toBe(0);
  }, 300_000);

  it('the dens\' (Scrap Crawler, Rivet Sower, Slag Ray, Clinker): the same, and the Sower\'s mines as LAUNCH rows, every one exact', () => {
    const r = run([
      { ships: ['scrap_crawler', 'rivet_sower'], dx: 1100, dy: 600, faction: 'scrapborn' },
      { ships: ['slag_ray', 'clinker'], dx: -1400, dy: -500, faction: 'cinder' },
    ], false, 1500, ALL | CAPS.WAYPOINTS | CAPS.LAUNCHES);
    const moves = r.server.enemies.custom.stats.moves;
    if (process.env.BODY_DEBUG) console.log('DENS', JSON.stringify({ moves, got: { ...r.got.A, ran: r.got.A.ran.size }, stats: r.stats }));
    for (const m of ['scrap_crawler.pull', 'rivet_sower.lay', 'slag_ray.pass', 'clinker.volley']) expect(moves[m] ?? 0, m).toBeGreaterThan(0);
    expect(r.got.A.ran.size).toBeGreaterThanOrEqual(4);
    expect(r.got.A.off).toBe(0);
    // (laid in the tick, each mine run from its volley's row: exact on every tick it's stepped)
    expect(r.server.guides.stats.launched).toBeGreaterThanOrEqual(6);
    expect(r.mobs.checked).toBeGreaterThan(500);
    expect(r.mobs.off, r.mobs.firstOff).toBe(0);
    expect(r.got.A.ctlRows).toBe(0);
    expect(r.stats.off).toBe(0);
  }, 300_000);

  it('pieces shot off mid-fight (vanes, roots, wings, drives, the outrigger): their flight changes the same on both sides', () => {
    const r = run([
      { ships: ['pirate_raider', 'cinder_zealot'], dx: 1300, dy: 700, faction: 'pirates' },
      { ships: ['maw_lurker', 'scrap_crawler'], dx: -1500, dy: 400, faction: 'maw' },
      { ships: ['slag_ray', 'helios_drone', 'rivet_sower'], dx: 600, dy: -1500, faction: 'cinder' },
    ], true);
    if (process.env.BODY_DEBUG) console.log('LOST', JSON.stringify({ moves: r.server.enemies.custom.stats, got: { ...r.got.A, ran: r.got.A.ran.size }, stats: r.stats }));
    expect(r.server.enemies.custom.stats.lost).toBeGreaterThanOrEqual(6);
    expect(r.got.A.checked).toBeGreaterThan(600);
    expect(r.got.A.off).toBe(0);
    expect(r.got.A.ctlRows).toBe(0);
    expect(r.stats.off).toBe(0);
  }, 300_000);
});
