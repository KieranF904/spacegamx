/**
 * Client message dispatch (net/dispatch.ts): the handler table covers exactly the types the old handleMessage switch
 * handled, the drops and limits in front of it are unchanged, and nothing under net/ imports GameServer.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { readFileSync, readdirSync, statSync } from 'fs';
import * as bitecs from 'bitecs';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { dispatch, HandlerRegistry, PRE_JOIN, MAX_INPUTS_PER_TICK } from './dispatch.js';
import { MessageLimiter } from './MessageLimits.js';
import { makeEmptyServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

describe('message dispatch', () => {
  it('the handler table is the old switch: exactly the pinned types (golden/clientMessages.json)', () => {
    resetGlobals();
    const server = makeEmptyServer({ clock: () => 1_000_000 });
    const pinned: string[] = JSON.parse(readFileSync(join(__dirname, '../golden/clientMessages.json'), 'utf8'));
    expect(server.handledMessageTypes().sort()).toEqual(pinned);
    expect(server.handledMessageTypes().length).toBe(108); // (+5: the pickup panel and auto-pickup, docs/design/loot-pickup-2026-11.md)
  }, 120_000);

  it('drops non-messages, pre-join messages and limited ones; unknown types fall through silently', () => {
    const seen: string[] = [];
    const sent: unknown[] = [];
    const reg = new HandlerRegistry();
    reg.on('ping', () => seen.push('ping'));
    reg.on('chat', () => seen.push('chat'));
    const table = reg.freeze();
    const ctx = { limiter: new MessageLimiter(() => 0), send: (_ws: unknown, m: unknown) => sent.push(m) } as any;
    const conn = { joined: false, isAdmin: false, ws: {} } as any;
    for (const bad of [null, undefined, 3, 'ping', [], { type: 4 }]) dispatch(table, ctx, conn, bad as any);
    expect(seen).toEqual([]);
    dispatch(table, ctx, conn, { type: 'chat', text: 'hi' } as any);     // not joined: dropped
    dispatch(table, ctx, conn, { type: 'ping' } as any);                  // pre-join allowed
    expect(seen).toEqual(['ping']);
    conn.joined = true;
    dispatch(table, ctx, conn, { type: 'nonsense' } as any);
    dispatch(table, ctx, conn, { type: '__proto__' } as any);
    dispatch(table, ctx, conn, { type: 'constructor' } as any);
    expect(seen).toEqual(['ping']);
    // A chat flood: past the burst it's refused, with a 'Slow down' reply
    for (let i = 0; i < 50; i++) dispatch(table, ctx, conn, { type: 'chat', text: 'x' } as any);
    const chats = seen.filter((s) => s === 'chat').length;
    expect(chats).toBeGreaterThan(0);
    expect(chats).toBeLessThan(50);
    expect(sent.length).toBe(50 - chats);
    expect(sent[0]).toEqual({ type: 'systemMessage', text: 'Slow down: too many messages at once.', color: '#fca5a5' });
    // Admins aren't limited
    const admin = { joined: true, isAdmin: true, ws: {} } as any;
    const before = seen.length;
    for (let i = 0; i < 50; i++) dispatch(table, ctx, admin, { type: 'chat', text: 'x' } as any);
    expect(seen.length - before).toBe(50);
  });

  it('keeps the constants and refuses a second handler for a type', () => {
    expect([...PRE_JOIN].sort()).toEqual(['join', 'ping']);
    expect(MAX_INPUTS_PER_TICK).toBe(16);
    const reg = new HandlerRegistry();
    reg.on('ping', () => {});
    expect(() => reg.on('ping', () => {})).toThrow(/two handlers/);
  });

  it('nothing under net/ imports GameServer at runtime (type-only imports, as the transports use, are fine)', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(f) && !/\.test\.ts$/.test(f)) files.push(p);
      }
    };
    walk(__dirname);
    expect(files.length).toBeGreaterThan(3);
    const runtimeImport = /^\s*(import|export)\s+(?!type\b)[^;]*from\s+['"](\.\.\/)+GameServer(\.js)?['"]/m;
    const bad = files.filter((p) => runtimeImport.test(readFileSync(p, 'utf8')));
    expect(bad).toEqual([]);
    // (the check itself catches one)
    expect(runtimeImport.test("import { GameServer } from '../GameServer.js';")).toBe(true);
    expect(runtimeImport.test("import type { GameServer } from '../GameServer.js';")).toBe(false);
  });
});
