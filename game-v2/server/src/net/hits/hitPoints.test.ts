/**
 * Where a confirmed hit is drawn (docs/design/confirmed-hits.md part C, "the record's point of impact"): the client
 * works the point out itself (ConfirmedHits.hitPoint), and it must be where the server's shell struck. A fight with
 * pirates: the client's shells on ships that fly (pilotless: they move after the server's collision step, so the
 * pose that counts is the tick before the hit), and theirs on the client's own ship (no replica of it: its predicted
 * pose, GameState.selfPoseAt; the fake's is the server's, as a prediction that held). Before this was worked out
 * with the target's pose on the hit's own tick and no pose at all for the client's ship, NPC fights drew hits up to
 * ~35 units off (six of 18 here more than 20 off: every hit on the client's own ship).
 *
 * A real GameServer and the fake client (fakeHitsClient.testkit.ts) taking confirmed hits for everything (CAPS.HITS);
 * each impact it was shown is compared with the server's projectileHit for that shell.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Input, InSystem, CAPS, ReplicaMode, replicaAngle, quantizeReplicaAngle, type ReplicaEnv,
} from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { FakeHitsClient } from './fakeHitsClient.testkit.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

describe('confirmed hits: the impact is drawn where the server\'s shell struck', () => {
  it('in a fight with pirates: on ships that fly, and on the client\'s own ship', () => {
    resetGlobals();
    // (the pirates' choices are random: seeded, so the fight is the same every run)
    const random = Math.random;
    let seed = 0x2545f491;
    Math.random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    try {
      const clock = { t: 1_000_000 };
      const server = new GameServer({
        gameData: new GameData(files),
        userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
        scene: 'sectors', autoStart: false,
        ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
        clock: () => clock.t,
        netCaps: CAPS.HITS,
      });
      const ships = server.getShips();
      const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
      const A = new FakeHitsClient(server, { name: 'hit_points', caps: CAPS.HITS, env });
      // The server's point for each shell's hits on ships
      const truth = new Map<number, { x: number; y: number; target: number }[]>();
      const ledger = server.hits as unknown as { shellHit(p: number, x: number, y: number, h?: { target: number }): void };
      const shellHit = ledger.shellHit.bind(ledger);
      ledger.shellHit = (p, x, y, h) => {
        if (h) { const l = truth.get(p) ?? []; l.push({ x, y, target: h.target }); truth.set(p, l); }
        shellHit(p, x, y, h);
      };
      const step = () => { server.step(); clock.t += 1000 / 60; A.flushUp(); };
      for (let i = 0; i < 20; i++) step();
      const c = server.pilots.connOf(A.pid)!;
      c.isAdmin = true;
      server.admin.run(c, 'god', { on: 'on' });
      ships.respawnInPlace(A.pid, ships.library.get('corsair')!);
      const num = InSystem.systemId[A.pid];
      const x0 = Position.x[A.pid] + 30000, y0 = Position.y[A.pid] + 30000;
      Position.x[A.pid] = x0; Position.y[A.pid] = y0; Velocity.x[A.pid] = 0; Velocity.y[A.pid] = 0;
      for (let i = 0; i < 3; i++) step();
      server.enemies.spawnPack(num, { faction: 'pirates', ships: ['pirate_raider', 'pirate_skiff', 'pirate_skiff'] } as never, x0 + 1300, y0 + 700);
      server.enemies.spawnPack(num, { faction: 'pirates', ships: ['pirate_raider', 'pirate_skiff'] } as never, x0 - 1300, y0 + 700);
      const hostiles = new Set<number>();
      for (let t = 0; t < 1500; t++) {
        for (const k of ['forward', 'backward', 'left', 'right', 'fireLeft', 'fireRight', 'boost'] as const) Input[k][A.pid] = 0;
        let best = -1, bd = Infinity;
        for (const [eid] of ships.bodies) {
          if (!server.enemies.factionOf(eid) || InSystem.systemId[eid] !== num) continue;
          hostiles.add(eid);
          const d = Math.hypot(Position.x[eid] - Position.x[A.pid], Position.y[eid] - Position.y[A.pid]);
          if (d < bd) { bd = d; best = eid; }
        }
        if (best >= 0) {
          const dx = Position.x[best] - Position.x[A.pid], dy = Position.y[best] - Position.y[A.pid];
          Input.targetAngle[A.pid] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(Math.atan2(dy, dx)));
          Input.cursorDist[A.pid] = bd;
          if (bd < 1800) { Input.fireLeft[A.pid] = 1; Input.fireRight[A.pid] = 1; }
        }
        step();
      }
      // Each impact the client was shown against the server's point for that shell (the nearest, for a pierce)
      let onSelf = 0, onOthers = 0, close = 0;
      const off: string[] = [];
      for (const m of A.impacts) {
        const l = truth.get(m.id);
        if (!l) continue;
        let e = Infinity, tgt = -1;
        for (const s of l) { const d = Math.hypot(s.x - m.x, s.y - m.y); if (d < e) { e = d; tgt = s.target; } }
        if (tgt === A.pid) onSelf++; else if (hostiles.has(tgt)) onOthers++;
        if (e <= 0.5) close++;
        if (e > 5) off.push(`shell ${m.id} on ${tgt === A.pid ? 'self' : tgt}: ${e.toFixed(1)} off`);
      }
      if (process.env.HITS_DEBUG) console.log('HP', { onSelf, onOthers, close, impacts: A.impacts.length }, off.slice(0, 5));
      expect(onSelf, "hits on the client's own ship").toBeGreaterThan(10);
      expect(onOthers, 'hits on pirates').toBeGreaterThan(3);
      // Every one where the server's struck, to the tenth it's sent at; a hit on a ship keyframed in its snapshot may be a
      // little off (its path before the keyframe is the client's guess), never more than a few units
      expect(off).toEqual([]);
      expect(close / (onSelf + onOthers)).toBeGreaterThan(0.95);
    } finally {
      Math.random = random;
    }
  }, 120_000);
});
