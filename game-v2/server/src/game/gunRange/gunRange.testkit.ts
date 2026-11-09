/** The gun range tests' rig: a server with a profile store, a signed-in pilot berthed at a station, and the range's numbers. */

import { join as joinPath } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, Input, Health, Station, rangeDoor, type ClientSocket, type GunRangeDef } from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { MemoryProfileStore } from '../../profile/ProfileStore.js';
import { stationQuery } from '../Docking.js';

const dataDir = joinPath(__dirname, '../../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
export const S = (server: GameServer) => server as any;

export function boot(): { server: GameServer; store: MemoryProfileStore; def: GunRangeDef; num: number } {
  resetGlobals();
  const store = new MemoryProfileStore();
  const server = new GameServer({
    gameData: new GameData(readGameDataFiles(dataDir)),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigCached(dataDir)), profileStore: store, clock: () => 1_000_000,
  });
  const real = S(server).send.bind(server);
  S(server).send = (ws: any, msg: any) => { (ws.said ??= []).push(msg); real(ws, msg); };
  const sys = server.gameData.getSystem('gun_range')!;
  return { server, store, def: sys.gunRange!, num: server.gameData.getSystemNum('gun_range') };
}

export interface Pilot { link: ReturnType<GameServer['connect']>; conn: any; said: any[]; socket: { isOpen(): boolean } }

export function join(server: GameServer, name: string): Pilot {
  let open = true;
  const socket = { isOpen: () => open, send: () => {}, close: () => { open = false; }, said: [] as any[] } as unknown as ClientSocket & { said: any[] };
  const link = server.connect(socket);
  link.receive({ type: 'join', username: name } as any);
  const conn = [...S(server).clients.values()].find((c: any) => c.ws === socket);
  return { link, conn, said: socket.said, socket };
}

/** Signed in as account `id` (the join as a guest, then the account's login) */
export async function signIn(server: GameServer, name: string, id: number): Promise<Pilot> {
  const p = join(server, name);
  p.conn.userId = id;
  await server.loginPilot(p.conn, id);
  return p;
}

export const run = (server: GameServer, n: number) => { for (let i = 0; i < n; i++) server.step(); };
/** Let the profile store's writes land */
export const settle = () => new Promise((r) => setTimeout(r, 0));

/** Berth the pilot at the first station of the system they're in */
export function dock(server: GameServer, p: Pilot): number {
  const eid = p.conn.playerId, num = InSystem.systemId[eid];
  const st = [...stationQuery(S(server).world)].find((s) => InSystem.systemId[s] === num && server.gameData.getStationByNum(Station.stationId[s]))!;
  Position.x[eid] = Position.x[st] + 20; Position.y[eid] = Position.y[st]; Velocity.x[eid] = 0; Velocity.y[eid] = 0;
  p.link.receive({ type: 'dock' } as any);
  return st;
}

export const states = (p: Pilot) => p.said.filter((m) => m?.type === 'gunRangeState');
export const lastState = (p: Pilot) => states(p).at(-1);

/** Hold the trigger, aimed at (x, y) */
export function fireAt(p: Pilot, x: number, y: number, on = true): void {
  const eid = p.conn.playerId;
  Input.fireLeft[eid] = on ? 1 : 0;
  Input.targetAngle[eid] = Math.atan2(y - Position.y[eid], x - Position.x[eid]);
  Input.cursorDist[eid] = Math.hypot(x - Position.x[eid], y - Position.y[eid]);
}

/** Fly the pilot to the door's zone (a teleport inside the system) */
export function toDoor(def: GunRangeDef, p: Pilot): void {
  const d = rangeDoor(def), eid = p.conn.playerId;
  Position.x[eid] = d.x + d.nx * 200; Position.y[eid] = d.y + d.ny * 200; Velocity.x[eid] = 0; Velocity.y[eid] = 0;
}

/** Destroy the pilot's ship (its core out) */
export function kill(p: Pilot): void {
  Health.current[p.conn.playerId] = 0;
}

/** The range's heavy target (the Redtooth Mammoth), the far one */
export const heavyOf = (def: GunRangeDef) => def.targets.find((t) => t.ship === 'giant_mammoth')!;
