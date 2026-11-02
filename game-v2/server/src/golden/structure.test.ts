/**
 * Stage 0 structure pins. They fail if a refactor drops or reorders what the server and client are built around.
 *
 *  (a) tickOrder.json        the guard names GameServer runs per tick, in order (a refactor must keep this order)
 *  (b) clientMessages.json   every ClientMessage type the server dispatches
 *  (c) shipBridgeApi.json    ShipBridge's public method/accessor/field names (the facade must keep them)
 *  (d) serverMessages.json   every ServerMessage type client Game.ts handles itself
 *
 * Rewrite deliberately with:  UPDATE_GOLDEN=1 npx vitest run server/src/golden/structure.test.ts
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import * as bitecs from 'bitecs';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { createShipBridge } from '../proto/createProtoServer.js';

const dataDir = join(__dirname, '../../../data');
const srcRoot = join(__dirname, '../../..');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const UPDATE = !!process.env.UPDATE_GOLDEN;

function pin(file: string, actual: unknown) {
  const path = join(__dirname, file);
  if (UPDATE || !existsSync(path)) {
    writeFileSync(path, JSON.stringify(actual, null, 2) + '\n');
    return;
  }
  expect(actual).toEqual(JSON.parse(readFileSync(path, 'utf8')));
}

/** Names of `case 'x':` labels at the switch's own indent, inside the body of the method/function starting at `startRe` */
function caseLabels(src: string, startRe: RegExp, caseIndent: number): string[] {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) => startRe.test(l));
  expect(start, `start of ${startRe}`).toBeGreaterThanOrEqual(0);
  const indent = lines[start].match(/^\s*/)![0].length;
  const out = new Set<string>();
  const re = new RegExp(`^ {${caseIndent}}case '([^']+)':`);
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.length && l.match(/^\s*/)![0].length <= indent && /^\s*\}/.test(l)) break;
    let rest = l;
    const m = re.exec(rest);
    if (m) {
      // several labels may share a line: case 'a': case 'b':
      for (const mm of rest.matchAll(/case '([^']+)':/g)) out.add(mm[1]);
    }
  }
  return [...out].sort();
}

describe('structure pins', () => {
  it('server tick order (guard names)', () => {
    resetGlobals();
    const server = new GameServer({
      gameData: new GameData(readGameDataFiles(dataDir)),
      userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
      scene: 'sectors',
      autoStart: false,
      ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
      clock: () => 1_000_000,
    });
    // One pilot, so the per-client periodic steps run too
    const t = new LocalTransport(server);
    t.connect();
    t.send({ type: 'join', username: 'golden' } as any);
    let seq: string[] = [];
    const real = server.guard.bind(server);
    (server as any).guard = (where: string, fn: () => void) => { seq.push(where); real(where, fn); };
    const ticks: string[][] = [];
    for (let i = 0; i < 61; i++) { seq = []; server.step(); if (seq[seq.length - 1] === 'snapshots') seq.pop(); ticks.push(seq); } // ('snapshots' runs last, only when one is due)
    // An ordinary tick, and the tick that is a multiple of 60 (the periodic steps run there)
    const ordinary = ticks[0];
    const periodic = ticks[59];
    expect(periodic.length).toBeGreaterThan(ordinary.length);
    // every other tick is the ordinary shape or the periodic one; nothing else
    for (const t of ticks.slice(0, 59)) expect(t).toEqual(ordinary);
    pin('tickOrder.json', {
      _note: 'Order GameServer.step()/tick() runs its guarded systems. A refactor must keep this order. "periodic" is the tick where currentTick % 60 === 0.',
      ordinary, periodic,
    });
  }, 120_000);

  it('client messages the server handles', () => {
    // Stage 1 Cut 1 turned handleMessage's switch into a handler table (net/dispatch.ts), so the types come from the
    // table. (The Stage 0 pin, read from case labels at one indent, missed 'join' and 'respawn'; Stage 2 added them.)
    resetGlobals();
    const server = new GameServer({
      gameData: new GameData(readGameDataFiles(dataDir)),
      userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
      scene: 'sectors',
      autoStart: false,
      ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
      clock: () => 1_000_000,
    });
    const types = server.handledMessageTypes().sort();
    expect(types.length).toBe(82);
    pin('clientMessages.json', types);
  }, 120_000);

  it('ShipBridge public API', () => {
    const src = readFileSync(join(srcRoot, 'server/src/ships/ShipBridge.ts'), 'utf8');
    const priv = new Set([...src.matchAll(/^\s*private\s+(?:readonly\s+|static\s+)*([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
    const bridge = createShipBridge(loadShipConfigFromDisk(dataDir)) as any;
    const names = new Set<string>();
    for (let p = Object.getPrototypeOf(bridge); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const n of Object.getOwnPropertyNames(p)) names.add(n);
    }
    for (const n of Object.keys(bridge)) names.add(n);
    names.delete('constructor');
    const pub = [...names].filter((n) => !priv.has(n) && !n.startsWith('_') && !n.startsWith('#')).sort();
    expect(pub.length).toBeGreaterThan(50);
    const path = join(__dirname, 'shipBridgeApi.json');
    if (UPDATE || !existsSync(path)) { writeFileSync(path, JSON.stringify(pub, null, 2) + '\n'); return; }
    // The facade may grow, never lose: every pinned name must still be there
    const pinned: string[] = JSON.parse(readFileSync(path, 'utf8'));
    expect(pinned.filter((n) => !names.has(n))).toEqual([]);
    // ...and a new public name should be pinned on purpose
    expect(pub.filter((n) => !pinned.includes(n))).toEqual([]);
  });

  it('server messages client Game.ts handles', () => {
    // (the handler table moved to client/src/app/serverMessages.ts: one entry per line at two-space indent)
    const src = readFileSync(join(srcRoot, 'client/src/app/serverMessages.ts'), 'utf8').replace(/\r\n/g, '\n');
    const body = src.slice(src.indexOf('const TABLE: Handlers = {'));
    const types = [...new Set([...body.slice(0, body.indexOf('\n};')).matchAll(/^ {2}([A-Za-z]+)[:,]/gm)].map((m) => m[1]))].sort();
    expect(types.length).toBeGreaterThan(20);
    pin('serverMessages.json', types);
  });
});
