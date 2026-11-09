/**
 * @contract lobby.rankings.board
 * owns:       the ranking rules: what a ranked stat is, how a game server's report and an old rankings document merge
 *             into a pilot's row, and how rows become the boards clients see (pure: no I/O, the clock is given)
 * needs:      nothing (the lobby has no common dependency, so BOARDS repeats common/econ/ribbons RANKED)
 * invariants: a stat only ever goes up in a row (all time: max of what's there and what's reported) — server-browser/src/rankings/rankings.test.ts
 *             weekly reports are added, so any number of servers sum — server-browser/src/rankings/rankings.test.ts
 *             a row from an earlier week shows no weekly numbers — server-browser/src/rankings/rankings.test.ts
 *             BOARDS matches common RANKED — server/src/game/rankings/rankings.test.ts
 * extend:     a new ranked stat is one entry in BOARDS (and in common RANKED)
 */

/** What is ranked (the same list and order as common/econ/ribbons RANKED) */
export const BOARDS: { key: string; label: string }[] = [
  { key: 'earned', label: 'Credits earned' },
  { key: 'kills', label: 'Hostiles destroyed' },
  { key: 'bosses', label: 'Boss kills' },
  { key: 'quests', label: 'Jobs done' },
  { key: 'mined', label: 'Ore mined' },
];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Weeks start on Monday 00:00 UTC (1970-01-05 was a Monday): the same as common weekOf */
const EPOCH_MONDAY = 4 * 24 * 60 * 60 * 1000;
export const weekOf = (nowMs: number): number => Math.floor((nowMs - EPOCH_MONDAY) / WEEK_MS);
export const weekEndsIn = (nowMs: number): number => WEEK_MS - ((nowMs - EPOCH_MONDAY) % WEEK_MS);

/** Most rows shown on each board, and the biggest number taken as a stat */
export const TOP = 10;
export const VALUE_MAX = 1e12;

export type Stats = Record<string, number>;

/** One account's numbers: `weekly` counts this `week` only */
export interface RankRecord {
  userId: number;
  name: string;
  week: number;
  weekly: Stats;
  allTime: Stats;
}

export interface BoardRow { name: string; value: number }
export interface BoardView {
  weekEndsIn: number;
  boards: { key: string; label: string; weekly: BoardRow[]; allTime: BoardRow[]; you?: { weekly: number; allTime: number; weeklyRank: number; allTimeRank: number } }[];
}

const KEYS = new Set(BOARDS.map((b) => b.key));

/** A stats object cut down to ranked keys and sane numbers (anything else dropped, never trusted) */
export function cleanStats(raw: unknown): Stats {
  const out: Stats = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!KEYS.has(k) || typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
    out[k] = Math.min(VALUE_MAX, v);
  }
  return out;
}

export function emptyRecord(userId: number, name: string, week: number): RankRecord {
  return { userId, name, week, weekly: {}, allTime: {} };
}

/** The row as of this week (an earlier week's weekly numbers are gone) */
export function rolled(r: RankRecord, week: number): RankRecord {
  return r.week === week ? r : { ...r, week, weekly: {} };
}

/** A game server's report for one pilot: `weekly` numbers are added, `allTime` ones raise the total (never lower it) */
export function applyReport(r: RankRecord, week: number, weekly: Stats, allTime: Stats): RankRecord {
  const row = rolled(r, week);
  const w = { ...row.weekly }, a = { ...row.allTime };
  for (const [k, v] of Object.entries(weekly)) w[k] = Math.min(VALUE_MAX, (w[k] ?? 0) + v);
  for (const [k, v] of Object.entries(allTime)) if (v > (a[k] ?? 0)) a[k] = v;
  return { ...row, weekly: w, allTime: a };
}

/** An old per-server rankings document's numbers merged in: both boards raised to the larger (so twice is once) */
export function applyImport(r: RankRecord, week: number, weekly: Stats | null, allTime: Stats): RankRecord {
  const row = rolled(r, week);
  const w = { ...row.weekly }, a = { ...row.allTime };
  for (const [k, v] of Object.entries(weekly ?? {})) if (v > (w[k] ?? 0)) w[k] = v;
  for (const [k, v] of Object.entries(allTime)) if (v > (a[k] ?? 0)) a[k] = v;
  return { ...row, weekly: w, allTime: a };
}

export function sameRecord(a: RankRecord, b: RankRecord): boolean {
  return a.name === b.name && a.week === b.week && JSON.stringify(a.weekly) === JSON.stringify(b.weekly) && JSON.stringify(a.allTime) === JSON.stringify(b.allTime);
}

/** The boards (top TOP of each, weekly and all time) and, for `you` (an account id), where they stand */
export function buildView(rows: RankRecord[], week: number, now: number, you: number | null): BoardView {
  const top = (get: (r: RankRecord) => Stats, key: string) => {
    const all = rows.filter((r) => (get(r)[key] ?? 0) > 0).sort((x, y) => (get(y)[key] ?? 0) - (get(x)[key] ?? 0) || x.userId - y.userId);
    const i = you === null ? -1 : all.findIndex((r) => r.userId === you);
    return { rows: all.slice(0, TOP).map((r) => ({ name: r.name, value: Math.round(get(r)[key] ?? 0) })), you: i >= 0 ? get(all[i])[key] ?? 0 : 0, rank: i + 1 };
  };
  const weekly = (r: RankRecord): Stats => (r.week === week ? r.weekly : {});
  return {
    weekEndsIn: weekEndsIn(now),
    boards: BOARDS.map((b) => {
      const w = top(weekly, b.key), a = top((r) => r.allTime, b.key);
      return {
        key: b.key, label: b.label, weekly: w.rows, allTime: a.rows,
        you: you === null ? undefined : { weekly: Math.round(w.you), allTime: Math.round(a.you), weeklyRank: w.rank, allTimeRank: a.rank },
      };
    }),
  };
}
