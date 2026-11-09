/**
 * @contract lobby.regions.defs
 * owns:       the game servers the lobby DEFINES (one per region/host), loaded from data/servers.json or LOBBY_SERVERS_JSON
 * needs:      node fs/path
 * invariants: a bad entry is skipped with a message, never fatal; none given means the old behaviour (only heartbeats list) — server-browser/src/regions/regions.test.ts
 * extend:     a new field a server has is one line in ServerDef and one in parseDefs
 */

import fs from 'fs';
import path from 'path';

/** always-on: a VPS process that is up all the time. on-demand: a Fly machine that is suspended when empty and woken by a connection */
export type ServerKind = 'always-on' | 'on-demand';

/** One game server as defined centrally (a sleeping one can't heartbeat, so the lobby has to know it exists) */
export interface ServerDef {
  /** Stable id: the server sends it as SERVER_ID in its heartbeat so the lobby can match them */
  id: string;
  name: string;
  region: string;
  /** Public address clients connect to */
  host: string;
  port: number;
  secure: boolean;
  kind: ServerKind;
  maxPlayers: number;
  /** The protocol / build this server is expected to run (shown while it sleeps; a heartbeat says the real one) */
  protocol?: number;
  build?: string;
}

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const HOST = /^[A-Za-z0-9._:[\]-]{1,253}$/;

/** The definitions in a parsed JSON value (an array, or { servers: [...] }), and what was wrong with the rest */
export function parseDefs(raw: unknown): { defs: ServerDef[]; errors: string[] } {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.servers) ? (raw as any).servers : null;
  if (!list) return { defs: [], errors: ['expected an array or { "servers": [...] }'] };
  const defs: ServerDef[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  list.forEach((e: any, i: number) => {
    const where = `servers[${i}]`;
    const port = Number(e?.port ?? 443);
    if (typeof e?.id !== 'string' || !ID.test(e.id)) return void errors.push(`${where}: bad id`);
    if (seen.has(e.id)) return void errors.push(`${where}: duplicate id "${e.id}"`);
    if (typeof e.host !== 'string' || !HOST.test(e.host)) return void errors.push(`${where}: bad host`);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return void errors.push(`${where}: bad port`);
    if (e.kind !== undefined && e.kind !== 'always-on' && e.kind !== 'on-demand') return void errors.push(`${where}: kind must be always-on or on-demand`);
    const kind: ServerKind = e.kind === 'on-demand' ? 'on-demand' : 'always-on';
    seen.add(e.id);
    const protocol = Number(e.protocol);
    defs.push({
      id: e.id,
      name: String(e.name ?? e.id).slice(0, 64),
      region: String(e.region ?? 'unknown').slice(0, 32),
      host: e.host,
      port,
      secure: e.secure === undefined ? true : Boolean(e.secure),
      kind,
      maxPlayers: Math.min(100_000, Math.max(1, Math.floor(Number(e.maxPlayers) || 32))),
      ...(Number.isInteger(protocol) && protocol > 0 ? { protocol } : {}),
      ...(typeof e.build === 'string' && e.build ? { build: e.build.slice(0, 40) } : {}),
    });
  });
  return { defs, errors };
}

/** LOBBY_SERVERS_JSON (the JSON itself), else <dataDir>/servers.json, else none */
export function loadDefs(dataDir: string, env: NodeJS.ProcessEnv = process.env, log: (m: string) => void = console.log): ServerDef[] {
  let text = env.LOBBY_SERVERS_JSON;
  if (!text) {
    try { text = fs.readFileSync(path.join(dataDir, 'servers.json'), 'utf8'); } catch { return []; }
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { log(`servers.json is not valid JSON: ${String(e)}`); return []; }
  const { defs, errors } = parseDefs(raw);
  for (const m of errors) log(`servers.json: ${m}`);
  return defs;
}
