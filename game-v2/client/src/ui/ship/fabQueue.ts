/**
 * @contract client.ui.ship.fab-queue
 * owns:       the fabricator's queue as the Ship window shows it (Status and Fabricator tabs): every part it has work
 *             for (damaged: repair, missing or planned: build, queued: recycle), in the order it takes them (the pilot's
 *             priority list first, then repairs, recycles, builds; parts held off last), each with what it waits on;
 *             and the messages "Queue repairs" sends
 * needs:      nothing imported at run time (pure): the caller passes the parts, the field lists and the bills
 * invariants: the job under way is first; the priority list comes before the usual order and keeps its own order;
 *             held parts are last and say so; a part whose bill the hold can't pay says what it is short of —
 *             client/src/ui/ship/fabQueue.test.ts
 * extend:     a new kind of work is one QueueKind and its place in KIND_ORDER
 */

export type QueueKind = 'repair' | 'build' | 'recycle';
export type QueueState = 'working' | 'held' | 'short' | 'grade' | 'ready';

export interface QueuePart {
  uid: number;
  name: string;
  /** Standing (built and joined) */
  alive: boolean;
  /** HP share missing of a standing part, 0..1 */
  missing: number;
  /** Not standing, wanted (missing or planned) */
  wanted: boolean;
  /** Queued for recycling */
  recycle: boolean;
  /** The fabricator can make it (its grade) */
  makeable: boolean;
  /** Join distance from the core (-1: joined to nothing) */
  depth: number;
  /** What its job takes from the hold (a repair's bill, a build's inputs; {} for a recycle or a free core repair) */
  bill: Readonly<Record<string, number>>;
}

export interface QueueInput {
  parts: readonly QueuePart[];
  /** The pilot's priority list and held parts (uids: MachineView.first, paused) */
  first: readonly number[];
  paused: readonly number[];
  /** The job under way (its part's uid) */
  busy: number | undefined;
  have(id: string): number;
  itemName(id: string): string;
}

export interface QueueRow {
  uid: number;
  name: string;
  kind: QueueKind;
  state: QueueState;
  /** On the pilot's priority list (its place, 1-based; 0: not) */
  first: number;
  /** "Short: 2 alloy plate" / "Held" / "Needs a better fabricator" / "Under way" / "Ready" */
  waits: string;
  /** Damaged share (repairs) */
  missing: number;
}

const KIND_ORDER: Record<QueueKind, number> = { repair: 0, recycle: 1, build: 2 };

function kindOf(p: QueuePart): QueueKind | null {
  if (p.alive && p.recycle) return 'recycle';
  if (p.alive && p.missing > 1e-6) return 'repair';
  if (!p.alive && p.wanted) return 'build';
  return null;
}

/** What the hold is short of to pay `bill` ({} : nothing) */
export function shortOf(bill: Readonly<Record<string, number>>, have: (id: string) => number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, n] of Object.entries(bill)) { const s = n - have(id); if (s > 0) out[id] = s; }
  return out;
}

export function fabQueue(inp: QueueInput): QueueRow[] {
  const rows: (QueueRow & { depth: number; idx: number })[] = [];
  const firstAt = new Map(inp.first.map((u, k) => [u, k + 1]));
  const held = new Set(inp.paused);
  inp.parts.forEach((p, idx) => {
    const kind = kindOf(p);
    if (!kind) return;
    let state: QueueState = 'ready', waits = 'Ready';
    if (p.uid === inp.busy) { state = 'working'; waits = 'Under way'; }
    else if (held.has(p.uid)) { state = 'held'; waits = 'Held'; }
    else if (!p.makeable) { state = 'grade'; waits = 'Needs a better fabricator'; }
    else if (kind !== 'recycle') {
      const s = shortOf(p.bill, inp.have);
      const ids = Object.keys(s);
      if (ids.length) {
        state = 'short';
        waits = `Short: ${ids.slice(0, 2).map((id) => `${s[id]} ${inp.itemName(id).toLowerCase()}`).join(', ')}${ids.length > 2 ? ` +${ids.length - 2}` : ''}`;
      } else if (kind === 'build' && p.depth < 0) waits = 'Joined to nothing yet';
    }
    rows.push({ uid: p.uid, name: p.name, kind, state, first: firstAt.get(p.uid) ?? 0, waits, missing: p.missing, depth: p.depth < 0 ? 999 : p.depth, idx });
  });
  const rank = (r: QueueRow) => (r.state === 'working' ? 0 : r.state === 'held' ? 3 : r.first ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || (a.first && b.first ? a.first - b.first : 0) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || (a.kind === 'recycle' ? b.depth - a.depth : a.depth - b.depth) || a.idx - b.idx);
  return rows.map(({ depth: _d, idx: _i, ...r }) => r);
}

/**
 * "Queue repairs" in the field: the fabricator switched on, and the damaged and missing parts put first, repairs
 * nearest the core first then rebuilds (each `top` goes to the front, so they are sent last first). At most `max` parts
 */
export function repairMessages(rows: readonly QueueRow[], fabOn: boolean, max = 12): ({ type: 'machine'; kind: 'fabricator'; on: true } | { type: 'fieldOrder'; action: 'top' | 'resume'; uid: number })[] {
  const want = rows.filter((r) => r.kind !== 'recycle').slice(0, max);
  const out: ({ type: 'machine'; kind: 'fabricator'; on: true } | { type: 'fieldOrder'; action: 'top' | 'resume'; uid: number })[] = [];
  if (!fabOn) out.push({ type: 'machine', kind: 'fabricator', on: true });
  for (const r of want) if (r.state === 'held') out.push({ type: 'fieldOrder', action: 'resume', uid: r.uid });
  const order = [...want].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  for (let k = order.length - 1; k >= 0; k--) out.push({ type: 'fieldOrder', action: 'top', uid: order[k].uid });
  return out;
}
