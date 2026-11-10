/**
 * The Pulse Dynamo, retired: on the ports core it had no ports and did nothing, so the part is gone from the catalogue.
 * A save is cleaned as it loads (econ/profile.ts migrateProfile): every dynamo held (hold, storage, quick bar, a finished
 * or running craft job, a fabricator order) is paid back as credits at its craft value, and every dynamo placed on a
 * ship or saved design is taken off it (its field-plan marks with it) and paid back the same way.
 * Idempotent: a profile with no dynamos changes nothing. Junk never throws.
 */

import type { Blueprint } from '../ships/types.js';
import type { PlayerProfile, ShipRecord } from './profile.js';

export const PULSE_DYNAMO_ID = 'power_pulse_dynamo';
/** Credits per dynamo refunded: what it was worth (its recipe: 1 titanium plate 24, 2 coil windings 48, 1 capacitor cell 40) */
export const PULSE_DYNAMO_REFUND = 160;

type Held = Pick<PlayerProfile, 'cargo' | 'storage' | 'quickbar' | 'credits' | 'jobs' | 'fabOrders'>;

const isDynamo = (p: { fn?: unknown } | null | undefined): boolean => p?.fn === PULSE_DYNAMO_ID;

/** Take the dynamos off one ship record, in place (their hp, ghost, owed, recycling and mine marks go with them; so do planned ones waiting in the field record); returns how many */
function stripShip(rec: ShipRecord): number {
  let n = 0;
  const parts = rec?.blueprint?.parts;
  if (Array.isArray(parts) && parts.some(isDynamo)) {
    const gone = parts.filter(isDynamo).map((q) => q.uid);
    n += gone.length;
    rec.blueprint.parts = parts.filter((q) => !isDynamo(q));
    const drop = new Set(gone);
    if (rec.hp && typeof rec.hp === 'object') for (const u of gone) delete rec.hp[u];
    if (Array.isArray(rec.ghosts)) rec.ghosts = rec.ghosts.filter((u) => !drop.has(u));
    if (Array.isArray(rec.owed)) rec.owed = rec.owed.filter((u) => !drop.has(u));
    if (Array.isArray(rec.field?.recycle)) rec.field!.recycle = rec.field!.recycle!.filter((u) => !drop.has(u));
    if (rec.field?.mines && typeof rec.field.mines === 'object') for (const u of gone) delete rec.field.mines[u];
  }
  const w = rec?.field?.waiting;
  if (Array.isArray(w) && w.some(isDynamo)) {
    n += w.filter(isDynamo).length;
    rec.field!.waiting = w.filter((q) => !isDynamo(q));
  }
  return n;
}

function stripBlueprint(b: Blueprint | null | undefined): number {
  if (!b || !Array.isArray(b.parts) || !b.parts.some(isDynamo)) return 0;
  const n = b.parts.filter(isDynamo).length;
  b.parts = b.parts.filter((q) => !isDynamo(q));
  return n;
}

/** Take every dynamo out of a profile (held, crafted, or placed) and credit the refund; returns how many went */
export function retirePulseDynamos(p: Held & Partial<Pick<PlayerProfile, 'hangar' | 'ship' | 'designs'>>): number {
  let n = 0;
  for (const key of ['cargo', 'storage'] as const) {
    const list = p[key];
    if (!Array.isArray(list) || !list.some((s) => s.id === PULSE_DYNAMO_ID)) continue;
    for (const s of list) if (s.id === PULSE_DYNAMO_ID) n += Math.max(0, Math.floor(s.n) || 0);
    p[key] = list.filter((s) => s.id !== PULSE_DYNAMO_ID);
  }
  if (Array.isArray(p.quickbar)) p.quickbar = p.quickbar.map((id) => (id === PULSE_DYNAMO_ID ? null : id));
  for (const j of p.jobs ?? []) {
    const k = j.out?.[PULSE_DYNAMO_ID];
    if (typeof k === 'number' && k > 0) { n += Math.floor(k); delete j.out[PULSE_DYNAMO_ID]; }
  }
  if (p.fabOrders?.some((o) => o.item === PULSE_DYNAMO_ID)) {
    for (const o of p.fabOrders) if (o.item === PULSE_DYNAMO_ID) n += Math.max(0, o.n - o.made);
    p.fabOrders = p.fabOrders.filter((o) => o.item !== PULSE_DYNAMO_ID);
  }
  // Placed: every ship record (the flown ship is the active hangar slot's record; counted once if it is not in the hangar) and every saved design
  const seen = new Set<ShipRecord>();
  for (const rec of [...(p.hangar ?? []), p.ship]) if (rec && !seen.has(rec)) { seen.add(rec); n += stripShip(rec); }
  for (const b of p.designs ?? []) n += stripBlueprint(b);
  if (n > 0) p.credits += n * PULSE_DYNAMO_REFUND;
  return n;
}
