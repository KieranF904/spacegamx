/**
 * A socket that never joins costs nothing (SEC-01/PR-01, gameServer/session.ts): no player entity, no ship, no
 * snapshots, not one of the server's clients; it is hung up on after JOIN_DEADLINE_MS, and past MAX_UNJOINED waiting
 * the oldest goes. Its ship and welcome come with the join.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Player, type ClientSocket } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { JOIN_DEADLINE_MS, MAX_UNJOINED, JOIN_TIMEOUT_CLOSE } from '../gameServer/session.js';

const dataDir = join(__dirname, '../../../data');
const files = readGameDataFiles(dataDir);
const shipConfig = loadShipConfigCached(dataDir);

function server() {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  return new GameServer({
    gameData: new GameData(files), userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false, ships: createShipBridge(shipConfig),
  });
}

/** A socket that keeps what it's sent, and closes as a real one does (the link told) */
function socket(gs: GameServer) {
  let open = true;
  const frames: (string | Uint8Array)[] = [];
  const closed: number[] = [];
  const ws: ClientSocket = {
    isOpen: () => open,
    send: (d) => { frames.push(d as string | Uint8Array); },
    close: (code) => { if (!open) return; open = false; closed.push(code ?? 0); link.close(); },
  };
  const link = gs.connect(ws);
  return { ws, link, frames, closed, open: () => open };
}

afterEach(() => { vi.useRealTimers(); });

describe('a socket that never joins', () => {
  it('has no entity, no welcome and no snapshots; joining gives it its ship and the welcome', () => {
    const gs = server();
    const players = () => [...(bitecs as any).getAllEntities((gs as any).world)].filter((e: number) => bitecs.hasComponent((gs as any).world, Player, e)).length;
    const before = players();
    const s = socket(gs);
    for (let i = 0; i < 30; i++) gs.step();
    expect(players()).toBe(before);
    expect((gs as any).clients.size).toBe(0);
    expect(gs.getPlayerId(s.ws)).toBe(0);
    expect(s.frames.length).toBe(0);
    // (pings are answered meanwhile)
    s.link.receive({ type: 'ping', clientTime: 1 } as never);
    expect(s.frames.length).toBe(1);

    s.link.receive({ type: 'join', username: 'Alice' } as never);
    expect(players()).toBe(before + 1);
    const pid = gs.getPlayerId(s.ws);
    expect(bitecs.hasComponent((gs as any).world, Player, pid)).toBe(true);
    const n = s.frames.length;
    for (let i = 0; i < 30; i++) gs.step();
    expect(s.frames.length).toBeGreaterThan(n);
  });

  it('a join from another protocol version gets no entity either', () => {
    const gs = server();
    const s = socket(gs);
    s.link.receive({ type: 'join', username: 'Old', protocol: -1 } as never);
    expect(s.open()).toBe(false);
    expect((gs as any).clients.size).toBe(0);
  });

  it('is hung up on at the join deadline; a joined one is not', () => {
    const gs = server();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const idle = socket(gs);
    const joined = socket(gs);
    joined.link.receive({ type: 'join', username: 'Bob' } as never);
    vi.advanceTimersByTime(JOIN_DEADLINE_MS - 1);
    expect(idle.open()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(idle.closed).toEqual([JOIN_TIMEOUT_CLOSE]);
    expect(joined.open()).toBe(true);
    expect((gs as any).clients.size).toBe(1);
  });

  it('past MAX_UNJOINED waiting, the oldest is hung up on (so a flood cannot lock real pilots out)', () => {
    const gs = server();
    const all = Array.from({ length: MAX_UNJOINED + 2 }, () => socket(gs));
    expect(all.filter((s) => !s.open()).map((s) => all.indexOf(s))).toEqual([0, 1]);
    expect(all[0].closed).toEqual([JOIN_TIMEOUT_CLOSE]);
    // (The newest still joins)
    all.at(-1)!.link.receive({ type: 'join', username: 'Real' } as never);
    expect((gs as any).clients.size).toBe(1);
    // (Joined sockets don't count against it)
    for (let i = 0; i < 4; i++) socket(gs);
    expect(all.at(-1)!.open()).toBe(true);
  });
});
