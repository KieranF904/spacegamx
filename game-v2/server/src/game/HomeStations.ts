/**
 * Pilots' own stations, in their own pocket of space (the private `homestead`
 * system's instanced copies). Each site's jump point leads there: a pilot who
 * chartered their station at that site goes to their copy, loaded on the
 * spot: the dock (every service, run on their tracks), a gate back out, and a
 * structure for each track they've built, bigger and better plated a tier at
 * a time (econ/outpost.ts trackStructure). A copy nobody's in for a while is
 * unloaded for the next pilot.
 */

import { stationTable, trackStructure, type Blueprint } from '@space-game/common';
import type { Pilots, PilotConn } from './Pilots.js';

export interface HomeHost {
  tick(): number;
  instances(id: string): number[];
  /** Pilots in a system copy (alive) */
  pilots(num: number): PilotConn[];
  travel(conn: PilotConn, num: number, x: number, y: number): void;
  systemNum(id: string): number;
  stationSystem(stationId: string): string | undefined;
  spawnDock(num: number): number;
  spawnGate(num: number, x: number, y: number, to: string): number;
  spawnStructure(bp: Blueprint, num: number, x: number, y: number, name: string): number;
  /** Take any of those out of the world */
  remove(eid: number): void;
  toast(conn: PilotConn, text: string, kind?: 'info' | 'good' | 'warn' | 'bad'): void;
}

const SYSTEM = 'homestead';
const SECOND = 60;
/** Nobody in it this long, and a copy is unloaded */
const EMPTY = 30 * SECOND;
/** The dock at the middle, the gate out below it, the tracks' structures in a ring */
const GATE: [number, number] = [0, 2800];
const RING = 2300;

interface Home {
  num: number;
  /** Whose: their account (or, a guest's, their connection) */
  owner: string;
  /** Where its gate leads back to */
  back: { num: number; x: number; y: number };
  dock: number;
  gate: number;
  /** Each track's structure and the tier it shows */
  built: Map<string, { eid: number; tier: number }>;
  empty: number;
}

export class HomeStations {
  private homes = new Map<number, Home>();

  constructor(private host: HomeHost, private pilots: Pilots) {}

  private ownerOf(conn: PilotConn): string {
    return conn.userId !== null ? `u${conn.userId}` : `c${conn.playerId}`;
  }

  /** Is this system copy someone's station? */
  isHome(num: number): boolean {
    return this.homes.has(num) || this.host.instances(SYSTEM).includes(num);
  }

  /** A pilot took a site's jump point (from `system`, at x, y): to their station, if it's chartered here */
  jump(conn: PilotConn, system: string, x: number, y: number): void {
    const p = this.pilots.get(conn);
    const file = stationTable();
    if (!p || !file) return;
    const here = file.sites.find((s) => this.host.stationSystem(s.station) === system);
    if (!p.outpost) return this.host.toast(conn, `This jump point leads to pilots' own stations. Charter one${here ? ` here (${here.name})` : ''} from a station window: Your station`, 'info');
    if (!here || here.id !== p.outpost.site) {
      const mine = file.sites.find((s) => s.id === p.outpost!.site);
      return this.host.toast(conn, `Your station is reached from ${mine?.name ?? 'its own site'}'s jump point`, 'warn');
    }
    const owner = this.ownerOf(conn);
    let home = [...this.homes.values()].find((h) => h.owner === owner);
    if (!home) {
      const free = this.host.instances(SYSTEM).find((n) => !this.homes.has(n));
      if (free === undefined) return this.host.toast(conn, 'The jump point is busy: try again in a moment', 'warn');
      home = { num: free, owner, back: { num: this.host.systemNum(system), x, y }, dock: this.host.spawnDock(free), gate: this.host.spawnGate(free, GATE[0], GATE[1], system), built: new Map(), empty: -1 };
      this.homes.set(free, home);
    }
    home.back = { num: this.host.systemNum(system), x, y };
    this.build(home, p.outpost.tracks);
    this.host.travel(conn, home.num, GATE[0] + 400, GATE[1] - 600);
  }

  /** Out through the gate: back beside the jump point they came in by */
  leave(conn: PilotConn, num: number): boolean {
    const home = this.homes.get(num);
    if (!home) return false;
    this.host.travel(conn, home.back.num, home.back.x + 500, home.back.y);
    return true;
  }

  /** Where a pilot who was in a station should come back out (logging in there, say): null if they weren't */
  exitFor(num: number): { num: number; x: number; y: number } | null {
    return this.homes.get(num)?.back ?? null;
  }

  /** Each track's structure, as built (and only what changed) */
  private build(home: Home, tracks: Record<string, number>): void {
    const file = stationTable();
    if (!file) return;
    const ids = Object.keys(file.tracks);
    ids.forEach((id, i) => {
      const tier = tracks[id] ?? 0;
      const had = home.built.get(id);
      if ((had?.tier ?? 0) === tier) return;
      if (had) this.host.remove(had.eid);
      home.built.delete(id);
      if (tier <= 0) return;
      const a = -Math.PI / 2 + ((i + 0.5) / ids.length) * Math.PI * 2;
      const eid = this.host.spawnStructure(trackStructure(id, tier), home.num, Math.cos(a) * RING, Math.sin(a) * RING, `${file.tracks[id].name} ${tier}`);
      if (eid >= 0) home.built.set(id, { eid, tier });
    });
  }

  tick(): void {
    const now = this.host.tick();
    if (now % SECOND) return;
    for (const home of [...this.homes.values()]) {
      const inside = this.host.pilots(home.num);
      if (inside.length) {
        home.empty = -1;
        // Its owner's builds finished while they're here: up they go
        const owner = inside.find((c) => this.ownerOf(c) === home.owner);
        const p = owner && this.pilots.get(owner);
        if (p?.outpost) this.build(home, p.outpost.tracks);
        continue;
      }
      if (home.empty < 0) { home.empty = now; continue; }
      if (now - home.empty < EMPTY) continue;
      for (const b of home.built.values()) this.host.remove(b.eid);
      this.host.remove(home.dock);
      this.host.remove(home.gate);
      this.homes.delete(home.num);
    }
  }
}
