/**
 * @contract server.net.handlers.ship-edit
 * owns:       ship editing and the hangar docking messages: dock, undock, shipEdit, slot saves, designSave,
 *             shareDesign, pilotInfo
 * needs:      HandlerRegistry (net/dispatch.ts), ServerCtx, ClientConnection, the game modules reached through ctx;
 *             @space-game/common, bitecs
 * invariants: the types it registers are part of the pinned dispatched set — server/src/golden/structure.test.ts
 * extend:     a new hangar message is a t.on line; the docking itself is game/Docking.ts
 */

/**
 * Ship editing and the hangar's docking messages: dock / undock, shipEdit, slotSave, slotFly, slotClear, designSave,
 * shareDesign and pilotInfo. Moved verbatim from GameServer (the receiver `this` became `ctx`; the helpers take ctx
 * first). The docking itself (berths, who is inside a station) lives in game/Docking.ts.
 */
import { hasComponent } from 'bitecs';
import { Player, Dead, repRank, fixModelMaterials, parseBlueprint, usesDevParts, type Blueprint } from '@space-game/common';
import type { ClientConnection } from '../ClientConnection.js';
import type { HandlerRegistry } from '../dispatch.js';
import type { ServerCtx } from '../ServerCtx.js';

export function registerShipEditHandlers(t: HandlerRegistry): void {
  t.on('pilotInfo', (ctx, conn, msg) => {
    handlePilotInfo(ctx, conn, Number(msg.id));
  });
  t.on('shareDesign', (ctx, conn, msg) => {
    handleShareDesign(ctx, conn, msg.blueprint);
  });
  t.on('shipEdit', (ctx, conn, msg) => {
    handleShipEdit(ctx, conn, msg.blueprint);
  });
  t.on('slotSave', (ctx, conn, msg) => {
    handleSlotSave(ctx, conn, msg);
  });
  t.on('slotFly', (ctx, conn, msg) => {
    const was = ctx.pilots.get(conn)?.ship;
    ctx.hangar.fly(conn, Math.floor(Number(msg.slot)));
    // Another ship: its own loadout aboard
    if (ctx.pilots.get(conn)?.ship !== was) { ctx.ammo.restock(conn, { report: true, quiet: true }); ctx.pilots.sendProfile(conn); }
  });
  t.on('slotClear', (ctx, conn, msg) => {
    ctx.hangar.scrap(conn, Math.floor(Number(msg.slot)));
  });
  t.on('designSave', (ctx, conn, msg) => {
    let bp: Blueprint;
    try { bp = clientBlueprint(ctx, msg.blueprint); } catch { return; }
    if (!ctx.ships.validate(bp, { devParts: conn.isAdmin }).ok) { ctx.pilots.toast(conn, 'Fix the design first: it has problems', 'warn'); return; }
    ctx.hangar.saveDesign(conn, Math.floor(Number(msg.slot)), bp);
  });
  t.on('dock', (ctx, conn, msg) => {
    ctx.docking.handleDock(conn);
  });
  t.on('undock', (ctx, conn, msg) => {
    ctx.docking.undock(conn);
  });
}

/** When each connection last shared a design (shares are throttled) */
const lastShare = new WeakMap<ClientConnection, number>();

/** Another pilot's info card */
export function handlePilotInfo(ctx: ServerCtx, conn: ClientConnection, eid: number): void {
  const other = ctx.liveConn(eid);
  const p = other && ctx.pilots.get(other);
  if (!other || !p) return;
  const ship = ctx.ships.get(eid);
  let best = { v: -1, name: '', rank: '' };
  // (A tie goes to the faction whose id sorts first, so it doesn't hang on how the save stored the keys)
  for (const [f, v] of Object.entries(p.reputation).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (v > best.v) best = { v, name: ctx.quests.file.reputations[f]?.name ?? f, rank: repRank(v).name };
  }
  const size = ctx.party.size(other);
  ctx.send(conn.ws, {
    type: 'pilotInfo', id: eid, name: other.username, level: p.level, guest: other.userId === null,
    ship: ship?.blueprint.name ?? 'No ship', parts: ship ? ship.derived.alive.filter(Boolean).length : 0,
    hull: Math.round(ctx.ships.integrity(eid) * 100),
    title: best.v >= 5 ? `${best.rank} · ${best.name}` : 'Independent pilot',
    party: size > 1 ? { leader: ctx.party.leaderName(other) ?? '', size, mine: ctx.party.same(conn, other) } : undefined,
    kills: p.stats.kills ?? 0,
    ribbons: ctx.achievements.summary(other).count,
    topRibbon: ctx.achievements.summary(other).top,
  });
}

export function clientBlueprint(ctx: ServerCtx, raw: unknown): Blueprint {
  const r = raw as { parts?: unknown } | null;
  if (!r || typeof r !== 'object' || !Array.isArray(r.parts) || r.parts.length > 256) throw new Error('not a blueprint');
  const bp = fixModelMaterials(ctx.ships.catalog, parseBlueprint(JSON.stringify(raw)));
  bp.name = bp.name.slice(0, 64);
  for (const p of bp.parts) {
    if (p.facing !== undefined && (typeof p.facing !== 'string' || p.facing.length > 16)) delete p.facing;
    if (p.gems) p.gems = p.gems.map((g) => g.slice(0, 40));
  }
  return bp;
}

/** Send a ship design to your party (they can load it into their hangar) */
export function handleShareDesign(ctx: ServerCtx, conn: ClientConnection, raw: unknown): void {
  const now = ctx.clock();
  if (now - (lastShare.get(conn) ?? 0) < 3000) return;
  lastShare.set(conn, now);
  let bp: Blueprint;
  try {
    bp = clientBlueprint(ctx, raw);
  } catch {
    return ctx.pilots.toast(conn, "That isn't a ship design", 'warn');
  }
  if (!ctx.ships.validate(bp, { devParts: conn.isAdmin }).ok) return ctx.pilots.toast(conn, 'Fix the design first: it has problems', 'warn');
  const others = ctx.party.members(conn).filter((m) => m !== conn) as ClientConnection[];
  if (!others.length) return ctx.pilots.toast(conn, 'Share designs with your party: invite someone first (P)', 'warn');
  for (const m of others) ctx.send(m.ws, { type: 'sharedDesign', from: conn.username, blueprint: bp });
  ctx.pilots.toast(conn, `Sent the ${bp.name} to your party`, 'good');
}

/** Hangar: validate the new blueprint and respawn the player's ship in place. */
export function handleShipEdit(ctx: ServerCtx, conn: ClientConnection, raw: unknown): void {
  const reply = (ok: boolean, errors: string[]) => ctx.send(conn.ws, { type: 'shipEditResult', ok, errors });
  const eid = conn.playerId;
  if (!hasComponent(ctx.world, Player, eid) || hasComponent(ctx.world, Dead, eid)) return reply(false, ['no ship to refit']);
  // Berthed (hangar opened in range) counts even if the station has moved since; otherwise be in range now
  if (!ctx.shipEditAnywhere && !conn.docked && !ctx.isDocked(eid)) return reply(false, ['dock at a station to refit your ship']);
  let bp: Blueprint;
  try {
    bp = clientBlueprint(ctx, raw);
  } catch {
    return reply(false, ['not a blueprint']);
  }
  const result = ctx.ships.validate(bp, { devParts: conn.isAdmin });
  if (!result.ok) return reply(false, result.errors.map((e) => e.message));
  // Parts the pilot has are built in; the rest become ghosts (proto mode hands out everything)
  const profile = ctx.pilots.get(conn);
  const errors = ctx.hangar.save(conn, profile?.activeSlot ?? 0, bp, { grantAll: ctx.freeBuild(conn) || (conn.isAdmin && usesDevParts(ctx.ships.catalog, bp)) });
  if (errors.length) return reply(false, errors);
  conn.blueprint = bp;
  reply(true, []);
}

/** Save a design to a hangar slot */
export function handleSlotSave(ctx: ServerCtx, conn: ClientConnection, msg: { slot: number; blueprint: unknown; plan?: string }): void {
  const reply = (ok: boolean, errors: string[]) => ctx.send(conn.ws, { type: 'shipEditResult', ok, errors });
  const eid = conn.playerId;
  if (!hasComponent(ctx.world, Player, eid) || hasComponent(ctx.world, Dead, eid)) return reply(false, ['no ship']);
  if (!ctx.shipEditAnywhere && !conn.docked && !ctx.isDocked(eid)) return reply(false, ['dock at a station to use the hangar']);
  let bp: Blueprint;
  try {
    bp = clientBlueprint(ctx, msg.blueprint);
  } catch {
    return reply(false, ['not a blueprint']);
  }
  const result = ctx.ships.validate(bp, { devParts: conn.isAdmin });
  if (!result.ok) return reply(false, result.errors.map((e) => e.message));
  const plan = typeof msg.plan === 'string' && ctx.ships.library.has(msg.plan) && ctx.pilots.knowsPlan(conn, msg.plan) ? msg.plan : undefined;
  const errors = ctx.hangar.save(conn, Math.floor(Number(msg.slot)), bp, { plan, grantAll: ctx.freeBuild(conn) || (conn.isAdmin && usesDevParts(ctx.ships.catalog, bp)) });
  reply(errors.length === 0, errors);
}
