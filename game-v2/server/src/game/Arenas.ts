/**
 * Arenas: a job's private battleground (a systems.json surface with `arena`,
 * instanced). A pilot who tells the job's person they're ready is sent down
 * to their party's own copy (anyone else in the party who says the same
 * joins them there), where the job's boss is waiting.
 *
 * Beat it and everyone down there is lifted back to orbit a few seconds
 * later (the kill is the job's credit, as for any boss). Shot down, or out
 * past the edge, and you can go back down to the same fight (talk to them
 * again) while the copy lasts; nobody down there for a while and it's
 * cleared, boss and all, for the next party.
 */

import type { StarSystemData } from '@space-game/common';
import type { PilotConn } from './Pilots.js';

export interface ArenaHost {
  tick(): number;
  systems(): StarSystemData[];
  /** Every copy of a system */
  instances(id: string): number[];
  /** The pilot's party (0: none) */
  partyId(conn: PilotConn): number;
  /** Pilots flying in a system (alive) */
  pilots(num: number): { conn: PilotConn; eid: number; x: number; y: number }[];
  travel(conn: PilotConn, num: number, x: number, y: number): void;
  toOrbit(conn: PilotConn, surface: StarSystemData, angle: number): void;
  toast(conn: PilotConn, text: string, kind?: 'info' | 'good' | 'warn' | 'bad'): void;
  /** The boss in this copy (Bosses.spawnAt): its entity, or -1 */
  spawnBoss(boss: string, num: number, x: number, y: number): number;
  bossAlive(eid: number): boolean;
  removeBoss(eid: number): void;
}

const SECOND = 60;
/** After the kill, this long before everyone's lifted out */
const LIFT = 8 * SECOND;
/** Nobody down there this long and the copy is cleared */
const EMPTY = 30 * SECOND;

interface Run {
  num: number;
  /** The party (or a solo pilot's own negative key) */
  key: number;
  sys: StarSystemData;
  boss: string;
  eid: number;
  /** When the boss fell (-1: still fighting) */
  won: number;
  /** When the copy was last seen empty (-1: someone's there) */
  empty: number;
}

export class Arenas {
  private runs = new Map<number, Run>();
  private solo = new Map<PilotConn, number>();
  private nextSolo = -1;

  constructor(private host: ArenaHost) {}

  /** Send a pilot down to their party's copy of an arena, with its boss: null, or why not */
  enter(conn: PilotConn, arenaId: string, boss: string): string | null {
    const sys = this.host.systems().find((s) => s.id === arenaId && s.surface?.arena);
    if (!sys) return 'The way down is sealed';
    const party = this.host.partyId(conn);
    if (!party && !this.solo.has(conn)) this.solo.set(conn, this.nextSolo--);
    const key = party || this.solo.get(conn)!;
    let run = [...this.runs.values()].find((r) => r.key === key && r.sys.id === sys.id && r.boss === boss);
    if (run && run.won >= 0) return 'The fight down there is over. Give it a moment';
    if (!run) {
      const free = this.host.instances(sys.id).find((n) => !this.runs.has(n));
      if (free === undefined) return `Every way into ${sys.name} is in use. Try again soon`;
      const b = sys.surface!.arena!.boss;
      const eid = this.host.spawnBoss(boss, free, b.x, b.y);
      if (eid < 0) return 'Nothing stirs down there';
      run = { num: free, key, sys, boss, eid, won: -1, empty: -1 };
      this.runs.set(free, run);
    }
    const e = sys.surface!.arena!.entry;
    this.host.travel(conn, run.num, e.x + (Math.random() - 0.5) * 800, e.y);
    this.host.toast(conn, `Down into ${sys.name}. Fly out past the edge to leave`, 'info');
    return null;
  }

  /** Is this system copy an arena someone's fighting in */
  isArena(num: number): boolean {
    return this.runs.has(num);
  }

  tick(): void {
    const now = this.host.tick();
    if (now % 10 !== 0) return;
    for (const run of [...this.runs.values()]) {
      const pilots = this.host.pilots(run.num);
      if (run.won < 0 && !this.host.bossAlive(run.eid)) {
        run.won = now;
        for (const p of pilots) this.host.toast(p.conn, 'The way back up opens in a few seconds', 'good');
      }
      if (run.won >= 0 && now - run.won >= LIFT) {
        for (const p of pilots) this.host.toOrbit(p.conn, run.sys, Math.atan2(p.y, p.x));
        this.clear(run);
        continue;
      }
      if (pilots.length) { run.empty = -1; continue; }
      if (run.empty < 0) run.empty = now;
      else if (now - run.empty >= EMPTY) this.clear(run);
    }
  }

  /** A pilot went for good (disconnected) */
  leave(conn: PilotConn): void {
    this.solo.delete(conn);
  }

  private clear(run: Run): void {
    if (this.host.bossAlive(run.eid)) this.host.removeBoss(run.eid);
    this.runs.delete(run.num);
  }
}
