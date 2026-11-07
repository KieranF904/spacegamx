/**
 * The field build overlay's weapon groups (docs/design/groups-mines-docking.md, "Weapon groups"): `weaponGroups` sets
 * which of the four groups each weapon on the live ship is in. Weapons only (anything else in the message is ignored),
 * free, no plan save. It is a decision: the live blueprint and the saved record change together (as a field refit does,
 * game/field/FieldShips.ts), so the design hash changes and every client that holds the ship gets the new design the
 * usual way and steps its guns on the new groups. The selection (which group a button fires) is not here: it rides inputs.
 */
import { hasComponent } from 'bitecs';
import { Player, Dead, cleanWeaponGroups, partWeaponGroups, type Blueprint, type PlacedPart } from '@space-game/common';
import type { HandlerRegistry } from '../dispatch.js';
import type { ServerCtx } from '../ServerCtx.js';
import type { ClientConnection } from '../ClientConnection.js';

export function registerWeaponGroupsHandlers(t: HandlerRegistry): void {
  t.on('weaponGroups', (ctx, conn, msg) => {
    handleWeaponGroups(ctx, conn, msg?.groups);
  });
}

const MAX_GROUPS_ENTRIES = 256;

export function handleWeaponGroups(ctx: ServerCtx, conn: ClientConnection, raw: unknown): boolean {
  const eid = conn.playerId;
  if (!hasComponent(ctx.world, Player, eid) || hasComponent(ctx.world, Dead, eid) || conn.docked) return false;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const ship = ctx.ships.get(eid);
  if (!ship || ship.kind !== 'ship') return false;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_GROUPS_ENTRIES) return false;
  const want = new Map<number, number>();
  for (const [k, v] of entries) {
    const uid = Number(k), mask = Number(v);
    if (Number.isInteger(uid) && Number.isInteger(mask) && mask >= 0 && mask <= 15) want.set(uid, mask);
  }
  // (A weapon is never in no group: 0 means the default, group 1)
  const weapons = new Set(ship.derived.weapons.map((w) => ship.blueprint.parts[w.part]?.uid));
  const bp = withGroups(ship.blueprint, (p) => {
    if (!weapons.has(p.uid) || !want.has(p.uid)) return p;
    const m = want.get(p.uid)! || 1;
    if (partWeaponGroups(p) === m) return p;
    const out: PlacedPart = { ...p };
    const wg = cleanWeaponGroups(m);
    if (wg === undefined) delete out.wg; else out.wg = wg;
    return out;
  });
  if (!bp) return false;
  const ghosts = ship.blueprint.parts.filter((_, i) => ship.ghost[i]).map((p) => p.uid);
  if (!ctx.ships.refitInFlight(eid, bp, ghosts)) return false;
  // (The saved record follows, when it is this ship's: a borrowed dev ship is never saved)
  const rec = ctx.pilots.get(conn)?.ship;
  if (rec && rec.blueprint.parts.length === bp.parts.length && rec.blueprint.parts.every((p, i) => p.uid === bp.parts[i].uid)) {
    rec.blueprint = bp;
    ctx.pilots.markDirty(conn);
  }
  return true;
}

/** The blueprint with `edit` applied to each part; null when no part changed */
function withGroups(bp: Blueprint, edit: (p: PlacedPart) => PlacedPart): Blueprint | null {
  let changed = false;
  const parts = bp.parts.map((p) => { const q = edit(p); if (q !== p) changed = true; return q; });
  return changed ? { ...bp, parts } : null;
}
