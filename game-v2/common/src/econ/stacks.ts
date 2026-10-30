/**
 * Item stacks: a player's cargo and storage are lists of { id, n }, one entry
 * per item id. These helpers never mutate their inputs' entries in place
 * without returning the result, and keep lists free of empty stacks.
 */

export interface Stack {
  id: string;
  n: number;
}

/** Item id → count */
export type Bag = Record<string, number>;

export function countOf(list: Stack[], id: string): number {
  return list.find((s) => s.id === id)?.n ?? 0;
}

export function addTo(list: Stack[], id: string, n: number): void {
  if (!(n > 0)) return; // (NaN too: a count from a client that isn't one)
  const s = list.find((x) => x.id === id);
  if (s) s.n += n;
  else list.push({ id, n });
}

/** Remove up to n; returns how many were removed */
export function removeFrom(list: Stack[], id: string, n: number): number {
  const i = list.findIndex((x) => x.id === id);
  if (i < 0 || !(n > 0)) return 0;
  const take = Math.min(n, list[i].n);
  list[i].n -= take;
  if (list[i].n <= 0) list.splice(i, 1);
  return take;
}

export function hasAll(list: Stack[], need: Bag): boolean {
  return Object.entries(need).every(([id, n]) => countOf(list, id) >= n);
}

/** Remove a whole bill, or nothing if it can't be paid */
export function removeAll(list: Stack[], need: Bag): boolean {
  if (!hasAll(list, need)) return false;
  for (const [id, n] of Object.entries(need)) removeFrom(list, id, n);
  return true;
}

/** What's still missing to pay a bill */
export function shortfall(list: Stack[], need: Bag): Bag {
  const out: Bag = {};
  for (const [id, n] of Object.entries(need)) {
    const have = countOf(list, id);
    if (have < n) out[id] = n - have;
  }
  return out;
}

export function addBag(a: Bag, b: Bag, k = 1): Bag {
  const out: Bag = { ...a };
  for (const [id, n] of Object.entries(b)) out[id] = (out[id] ?? 0) + n * k;
  return out;
}

export function bagTotal(b: Bag): number {
  return Object.values(b).reduce((s, n) => s + n, 0);
}

export function cleanStacks(list: Stack[]): Stack[] {
  const merged: Bag = {};
  for (const s of list) if (s && typeof s.id === 'string' && Number.isFinite(s.n) && s.n > 0) merged[s.id] = (merged[s.id] ?? 0) + Math.floor(s.n);
  return Object.entries(merged).map(([id, n]) => ({ id, n }));
}

/** The secure hold: what of the hold survives a death outside safe space (server Pilots DEFAULT_DEATH_RULES) */
export const SECURE_HOLD = { stacks: 3, units: 25 } as const;

/**
 * The hold's secure stacks: the `stacks` worth most, each counted only up to
 * `units` (value × min(n, units); ties keep hold order). Each one's count kept,
 * by stack. Server and client both rank them here, so the locks shown are the
 * stacks a death really keeps.
 */
export function secureHold(cargo: Stack[], value: (id: string) => number, stacks: number = SECURE_HOLD.stacks, units: number = SECURE_HOLD.units): Map<Stack, number> {
  const worth = (st: Stack) => value(st.id) * Math.min(st.n, units);
  const out = new Map<Stack, number>();
  for (const st of [...cargo].sort((a, b) => worth(b) - worth(a)).slice(0, Math.max(0, stacks))) {
    const k = Math.min(st.n, units);
    if (k > 0) out.set(st, k);
  }
  return out;
}
