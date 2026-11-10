/**
 * The WebSocket front end under hostile clients (docs/audits/server-robustness.md):
 * an in-process server on a free port, real sockets.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';
import { SocketTransport, clientAddress, MAX_CLIENT_MESSAGE_BYTES, MAX_SOCKETS_PER_IP } from './SocketTransport.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

resetGlobals();
const log = vi.spyOn(console, 'log').mockImplementation(() => {});
const server = makeServer({ profileStore: new MemoryProfileStore() });
const transport = new SocketTransport(server, 0);
const sockets: WebSocket[] = [];

async function open(): Promise<WebSocket> {
  while (!transport.port()) await new Promise((r) => setTimeout(r, 5));
  const ws = new WebSocket(`ws://127.0.0.1:${transport.port()}`);
  sockets.push(ws);
  ws.on('error', () => {});
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('close', () => res()); ws.once('error', rej); });
  return ws;
}
const closed = (ws: WebSocket) => new Promise<number>((r) => { if (ws.readyState === WebSocket.CLOSED) r(-1); else ws.once('close', (code) => r(code)); });

afterAll(() => {
  for (const ws of sockets) ws.terminate();
  transport.stopAccepting();
  log.mockRestore();
});

describe('socket transport', () => {
  it('drops a client that sends a message over the size limit, and carries on', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const big = await open();
    const fine = await open();
    big.send(JSON.stringify({ type: 'chat', text: 'x'.repeat(MAX_CLIENT_MESSAGE_BYTES + 10) }));
    expect(await closed(big)).toBe(1009);
    // The other one's still served
    const pong = new Promise((r) => fine.once('message', r));
    fine.send(JSON.stringify({ type: 'ping', clientTime: 1 }));
    expect(await pong).toBeTruthy();
    err.mockRestore();
  });

  it("survives garbage: empty, truncated and random binary frames, and text that isn't JSON", async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ws = await open();
    ws.send(Buffer.alloc(0));
    for (let i = 0; i < 200; i++) ws.send(Buffer.from(Array.from({ length: i % 40 }, () => Math.floor(Math.random() * 256))));
    ws.send('{not json');
    ws.send('null');
    ws.send('"a string"');
    const pong = new Promise((r) => ws.once('message', r));
    ws.send(JSON.stringify({ type: 'ping', clientTime: 2 }));
    expect(await pong).toBeTruthy();
    // (Logged a line now and then, not 200)
    expect(err.mock.calls.length).toBeLessThan(5);
    err.mockRestore();
  });

  it(`takes at most ${MAX_SOCKETS_PER_IP} sockets from one address at once`, async () => {
    const before = sockets.filter((w) => w.readyState === WebSocket.OPEN).length;
    const extra: WebSocket[] = [];
    for (let i = 0; i < MAX_SOCKETS_PER_IP - before + 1; i++) extra.push(await open());
    const last = extra[extra.length - 1];
    expect([WebSocket.CLOSING, WebSocket.CLOSED]).toContain(last.readyState);
    // Closing one frees a place
    extra[0].close();
    await closed(extra[0]);
    await new Promise((r) => setTimeout(r, 20));
    const again = await open();
    expect(again.readyState).toBe(WebSocket.OPEN);
  });

  it("believes X-Real-IP only from this machine (nginx)", () => {
    const req = (remoteAddress: string, real?: string) => ({ socket: { remoteAddress }, headers: real ? { 'x-real-ip': real } : {} }) as unknown as IncomingMessage;
    expect(clientAddress(req('127.0.0.1', '203.0.113.5'))).toBe('203.0.113.5');
    expect(clientAddress(req('198.51.100.1', '203.0.113.5'))).toBe('198.51.100.1');
    expect(clientAddress(req('::1'))).toBe('::1');
  });
});
