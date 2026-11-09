/**
 * @contract lobby.regions.merge
 * owns:       the server list a client sees: defined servers merged with live heartbeats, filtered by protocol, and the newest version known
 * needs:      regions/defs, servers (ServerEntry, listing)
 * invariants: a defined server with no heartbeat is listed asleep (on-demand) or offline (always-on) — server-browser/src/regions/regions.test.ts
 *             only servers whose protocol matches the asker's are offered; no protocol asked means no filtering — server-browser/src/regions/regions.test.ts
 *             with no definitions the list is the heartbeats alone, as before — server-browser/src/regions/regions.test.ts
 * extend:     a new status is a member of ServerStatus and a branch in mergeServers
 */

import { listing, type ServerEntry } from '../servers.js';
import type { ServerDef } from './defs.js';

export type ServerStatus = 'online' | 'asleep' | 'offline';

/** What GET /list shows of one server */
export type ListedServer = Omit<ServerEntry, 'lastSeen'> & {
  /** Its definition id (absent for a server that only heartbeats) */
  id?: string;
  kind?: 'always-on' | 'on-demand';
  status: ServerStatus;
  /** For a sleeping or offline one: what to tell the player */
  note?: string;
};

export const ASLEEP_NOTE = 'Asleep: joins in a few seconds';
export const OFFLINE_NOTE = 'Offline';

/** Live heartbeats and definitions, as one list: defined servers first (in their order), then any other live server */
export function mergeServers(defs: ServerDef[], live: ServerEntry[], production: boolean): ListedServer[] {
  const out: ListedServer[] = [];
  const used = new Set<ServerEntry>();
  for (const d of defs) {
    const beat = live.find((s) => !used.has(s) && (s.id === d.id || (s.host === d.host && s.port === d.port)));
    if (beat) {
      used.add(beat);
      // (The address is the defined, public one; the rest is what the server says about itself)
      out.push({ ...listing(beat, production), id: d.id, kind: d.kind, host: d.host, port: d.port, secure: d.secure, name: d.name, region: d.region, status: 'online' });
    } else {
      out.push({
        id: d.id, kind: d.kind, host: d.host, port: d.port, secure: d.secure, name: d.name, region: d.region,
        maxPlayers: d.maxPlayers, players: 0, version: d.build ?? '',
        ...(d.protocol !== undefined ? { protocol: d.protocol } : {}),
        ...(d.build ? { build: d.build } : {}),
        status: d.kind === 'on-demand' ? 'asleep' : 'offline',
        note: d.kind === 'on-demand' ? ASLEEP_NOTE : OFFLINE_NOTE,
      });
    }
  }
  for (const s of live) if (!used.has(s)) out.push({ ...listing(s, production), status: 'online' });
  return out;
}

/** Only the servers a client on `protocol` can talk to (no protocol asked, or a server that doesn't say: kept) */
export function filterByProtocol(list: ListedServer[], protocol: number | undefined): { servers: ListedServer[]; hidden: number } {
  if (protocol === undefined) return { servers: list, hidden: 0 };
  const servers = list.filter((s) => s.protocol === undefined || s.protocol === protocol);
  return { servers, hidden: list.length - servers.length };
}

/** The newest protocol (and its build) any server runs or is defined to run: a client older than it should reload */
export function latestVersion(list: ListedServer[]): { protocol: number; build: string } | null {
  let best: ListedServer | null = null;
  for (const s of list) if (s.protocol !== undefined && (!best || s.protocol > best.protocol!)) best = s;
  return best ? { protocol: best.protocol!, build: best.build ?? '' } : null;
}

/** The protocol a /list query asks for (?protocol=66): a whole number, or none */
export function askedProtocol(query: string): number | undefined {
  const v = new URLSearchParams(query).get('protocol');
  if (v === null || !/^\d{1,6}$/.test(v)) return undefined;
  return Number(v);
}
