import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { Position, ServerMessage } from '@space-game/common';
import { createProtoServer } from './createProtoServer.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';

const files = readGameDataFiles(join(__dirname, '../../../data'));
const ships = loadShipConfigFromDisk(join(__dirname, '../../../data'));

describe('proto mode (M0)', () => {
  it('runs 300 ticks in-process with a LocalTransport client', () => {
    const server = createProtoServer({ files, ships, autoStart: false });
    const transport = new LocalTransport(server);
    const received: ServerMessage[] = [];
    transport.onMessage = (msg) => received.push(msg);
    transport.connect();
    transport.send({ type: 'join', username: 'smoke' } as any);

    const playerId = transport.getPlayerId();
    expect(playerId).toBeGreaterThanOrEqual(0);
    expect(received.some((m) => m.type === 'welcome')).toBe(true);

    const startY = Position.y[playerId];
    transport.send({
      type: 'input', seq: 1, tick: 0, forward: true, backward: false, left: false, right: false,
      boost: false, fireLeft: false, fireRight: false, targetAngle: -Math.PI / 2,
    });

    for (let i = 0; i < 300; i++) server.step();

    expect(server.getTick()).toBe(300);
    // Forward (W) is world -y
    expect(Position.y[playerId]).toBeLessThan(startY - 100);
    // Snapshots only go when there's something to send (the client predicts its own ship)
    expect(received.filter((m) => m.type === 'snapshot').length).toBeGreaterThan(0);
  });
});
