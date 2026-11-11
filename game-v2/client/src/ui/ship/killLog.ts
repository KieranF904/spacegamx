/**
 * @contract client.ui.ship.kill-log
 * owns:       the Ship window's Kills log: significant events only (your kills and assists with what each paid, bosses
 *             beaten, your ship lost), consecutive kills of the same enemy collapsed into one row with their loot totalled
 * needs:      nothing (pure); fed from app/serverMessages.ts (gained kill:/assist:, bossDefeated, death)
 * invariants: a kill or assist of the same name and kind as the newest row adds to it (count, loot, credits, XP); any
 *             other event starts a new row; the log keeps at most KILL_LOG_MAX rows, oldest dropped —
 *             client/src/ui/ship/killLog.test.ts
 * extend:     a new kind of event is one KillKind and its words in killTitle()
 */

export type KillKind = 'kill' | 'assist' | 'boss' | 'death';

export interface KillEvent {
  kind: KillKind;
  name: string;
  items?: Readonly<Record<string, number>>;
  credits?: number;
  xp?: number;
  /** Wall clock, ms */
  at: number;
}

export interface KillRow {
  kind: KillKind;
  name: string;
  count: number;
  items: Record<string, number>;
  credits: number;
  xp: number;
  first: number;
  last: number;
}

export const KILL_LOG_MAX = 60;

const stacks = (k: KillKind) => k === 'kill' || k === 'assist';

export class KillLog {
  /** Oldest first */
  readonly rows: KillRow[] = [];
  /** Bumps on every change (the tab redraws when it moves) */
  version = 0;

  add(e: KillEvent): void {
    const last = this.rows[this.rows.length - 1];
    let row: KillRow;
    if (last && stacks(e.kind) && last.kind === e.kind && last.name === e.name) {
      row = last;
      row.count++;
      row.last = e.at;
    } else {
      row = { kind: e.kind, name: e.name, count: 1, items: {}, credits: 0, xp: 0, first: e.at, last: e.at };
      this.rows.push(row);
      if (this.rows.length > KILL_LOG_MAX) this.rows.splice(0, this.rows.length - KILL_LOG_MAX);
    }
    for (const [id, n] of Object.entries(e.items ?? {})) if (n > 0) row.items[id] = (row.items[id] ?? 0) + n;
    row.credits += Math.max(0, e.credits ?? 0);
    row.xp += Math.max(0, e.xp ?? 0);
    this.version++;
  }

  clear(): void { this.rows.length = 0; this.version++; }
}

/** A row's title: "5× Scrap Mother", "Assist: Raider", "Boss beaten: Pyreclast", "Ship lost" */
export function killTitle(r: KillRow): string {
  const n = r.count > 1 ? `${r.count}× ` : '';
  switch (r.kind) {
    case 'kill': return `${n}${r.name}`;
    case 'assist': return `${n}${r.name} (assist)`;
    case 'boss': return `Boss beaten: ${r.name}`;
    case 'death': return r.name ? `Ship lost to ${r.name}` : 'Ship lost';
  }
}

/** The loot under a row: "+12 Iron Ore · +40 cr · +120 XP" ('' for none) */
export function killLoot(r: KillRow, itemName: (id: string) => string): string {
  const out = Object.entries(r.items).sort((a, b) => b[1] - a[1]).map(([id, n]) => `+${n} ${itemName(id)}`);
  if (r.credits) out.push(`+${r.credits.toLocaleString('en-GB')} cr`);
  if (r.xp) out.push(`+${r.xp.toLocaleString('en-GB')} XP`);
  return out.join(' · ');
}

/** The one log for the session (the Kills tab draws it; serverMessages feeds it) */
export const killLog = new KillLog();
