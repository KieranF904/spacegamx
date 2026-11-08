/**
 * @contract protocol.snapshot-codec
 * owns:       snapshot rows: entity and projectile packing and unpacking, SNAP_FIELDS
 * needs:      packed/tables, fxKinds
 * invariants: pack then unpack returns the snapshot — common/src/network/protocol.test.ts
 * extend:     a new snapshot field is a packed key in PackedSnapshot plus pack and unpack lines (bump the protocol version)
 */
import { type EntityState, EntityType, type ServerSnapshotMessage } from './serverCore.js';

/**
 * Snapshot wire format: { type, t: tick, lp: lastProcessedInput, e: entity rows,
 * p: projectile rows, r: removed, k: keyframes, c: control rows, o: out of view }
 * (empty lists left out). A row is
 *   [id, type, x, y, angle, vx, vy, hp, maxHp, data, name, av]
 * with absent fields as null and trailing nulls dropped.
 */
export const SNAP_FIELDS = ['id', 'type', 'x', 'y', 'angle', 'vx', 'vy', 'hp', 'maxHp', 'data', 'name', 'av'] as const;


export interface PackedSnapshot { type: 'snapshot'; t: number; lp: number; e?: unknown[][]; p?: (number | null)[][]; r?: number[]; k?: number[][]; c?: number[][]; o?: number[]; f?: number[][]; n?: number[][]; d?: number[][]; x?: number[][]; w?: number[][]; h?: number; g?: number[][] }

/**
 * Projectiles have rows of their own (they're most of a fight's rows):
 *   [id, vx, vy, weaponType, ticks since fired, spawnX, spawnY, ownerId, gun?, tier?, sizeScale?, turret?, ticks to its end?, x?, y?]
 * gun (data[10]: the gun that fired it, packed as a fire event's part: hits.ts; -1 none) is for confirmed hits.
 * No gun, tier 1, size 1, no turret and no end go as null (trailing ones dropped); the
 * end (data[9], the tick a shell that ends at a chosen point lands or bursts:
 * mortars, aim bursts) goes as ticks after the snapshot's; x and y only when
 * it's off the straight line from the muzzle (missiles). The hue is the owner's,
 * worked out again on arrival.
 */
export function packProjectile(s: EntityState, tick: number): (number | null)[] | null {
  const d = s.data;
  if (!d || (d.length !== 10 && d.length !== 11) || s.angle !== undefined || s.hp !== undefined || s.name !== undefined) return null;
  const row: (number | null)[] = [s.id, s.vx ?? 0, s.vy ?? 0, d[0], tick - d[3], d[4], d[5], d[6], (d[10] ?? -1) >= 0 ? d[10] : null,
    d[1] === 1 ? null : d[1], d[7] === 1 ? null : d[7], d[8] === 0 ? null : d[8], d[9] ? d[9] - tick : null, s.x ?? null, s.y ?? null];
  while (row[row.length - 1] === null) row.pop();
  return row;
}

function unpackProjectile(r: (number | null)[], tick: number): EntityState {
  const owner = r[7] as number;
  const s: EntityState = {
    id: r[0] as number, type: EntityType.Projectile, vx: r[1] as number, vy: r[2] as number,
    data: [r[3] as number, r[9] ?? 1, (owner * 137) % 360, tick - (r[4] as number), r[5] as number, r[6] as number, owner, r[10] ?? 1, r[11] ?? 0,
      r[12] != null ? tick + r[12] : 0, r[8] ?? -1],
  } as EntityState;
  if (r[13] != null) { s.x = r[13]; s.y = r[14] as number; }
  return s;
}

/** A snapshot's entity rows and projectile rows */
export function packEntities(m: ServerSnapshotMessage): { e: unknown[][]; p: (number | null)[][] } {
  const p: (number | null)[][] = [];
  const e = m.entities.filter((s) => {
    const row = s.type === EntityType.Projectile ? packProjectile(s, m.tick) : null;
    if (row) p.push(row);
    return !row;
  }).map((s) => {
    const row: unknown[] = SNAP_FIELDS.map((k) => (s as unknown as Record<string, unknown>)[k] ?? null);
    while (row.length && row[row.length - 1] === null) row.pop();
    return row;
  });
  return { e, p };
}

export function packSnapshot(m: ServerSnapshotMessage): PackedSnapshot {
  const { e, p } = packEntities(m);
  const out: PackedSnapshot = { type: 'snapshot', t: m.tick, lp: m.lastProcessedInput };
  if (e.length) out.e = e;
  if (p.length) out.p = p;
  if (m.removed.length) out.r = m.removed;
  if (m.ships?.length) out.k = m.ships;
  if (m.ctl?.length) out.c = packCtlIds(m.ctl);
  if (m.out?.length) out.o = m.out;
  if (m.fire?.length) out.f = packFire(m.fire);
  if (m.own?.length) out.n = m.own;
  if (m.decisions?.length) out.d = m.decisions;
  if (m.causes?.length) out.x = m.causes;
  if (m.guides?.length) out.w = m.guides;
  if (m.hh !== undefined) out.h = m.hh;
  if (m.gun?.length) out.g = m.gun;
  return out;
}

/**
 * Control rows on the wire go in id order, each id as the step from the one
 * before (doubled, plus 1 for a run row: see packControlRow), so most take a
 * byte instead of three.
 */
function packCtlIds(rows: number[][]): number[][] {
  const ided = rows.map((r) => (r[0] < 0 ? { id: -1 - r[0], run: 1, r } : { id: r[0], run: 0, r })).sort((a, b) => a.id - b.id);
  let prev = 0;
  return ided.map(({ id, run, r }) => { const row = [(id - prev) * 2 + run, ...r.slice(1)]; prev = id; return row; });
}

/**
 * Fire events on the wire: in owner order, the owner as the step from the one
 * before, and each shell id as the step from the last id (they're mostly
 * consecutive): [ownerStep, ticksAgo, part, aimQ, idStep, idStep, ...]
 */
export function packFire(rows: number[][]): number[][] {
  const sorted = [...rows].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let owner = 0, id = 0;
  return sorted.map((r) => {
    const row = [r[0] - owner, r[1], r[2], r[3]];
    owner = r[0];
    for (let i = 4; i < r.length; i++) { row.push(r[i] - id); id = r[i]; }
    return row;
  });
}

function unpackFire(rows: number[][]): number[][] {
  let owner = 0, id = 0;
  return rows.map((r) => {
    owner += r[0];
    const row = [owner, r[1], r[2], r[3]];
    for (let i = 4; i < r.length; i++) { id += r[i]; row.push(id); }
    return row;
  });
}

function unpackCtlIds(rows: number[][]): number[][] {
  let id = 0;
  return rows.map((r) => {
    id += Math.floor(r[0] / 2);
    return [r[0] % 2 ? -1 - id : id, ...r.slice(1)];
  });
}

export function unpackSnapshot(p: PackedSnapshot): ServerSnapshotMessage {
  const entities = (p.e ?? []).map((row) => {
    const s: Record<string, unknown> = {};
    for (let i = 0; i < row.length; i++) if (row[i] !== null) s[SNAP_FIELDS[i]] = row[i];
    return s as unknown as EntityState;
  });
  for (const r of p.p ?? []) entities.push(unpackProjectile(r, p.t));
  return { type: 'snapshot', tick: p.t, lastProcessedInput: p.lp, entities, removed: p.r ?? [], ships: p.k, ctl: p.c && unpackCtlIds(p.c), out: p.o, fire: p.f && unpackFire(p.f), ...(p.n ? { own: p.n } : {}), ...(p.d ? { decisions: p.d } : {}), ...(p.x ? { causes: p.x } : {}), ...(p.w ? { guides: p.w } : {}), ...(p.h !== undefined ? { hh: p.h } : {}), ...(p.g ? { gun: p.g } : {}) };
}
