/**
 * @contract server.snapshot.rows.bodies
 * owns:       the snapshot rows of what isn't a pilot: pilotless ship bodies (status), single-body mobs, projectiles
 *             (keyed without their place while on their line) and loot pods (their drift anchor)
 * needs:      RowHost (world, ships, enemies, mobs, pods, namedBody, personCraft, wards, ticks), RowKeys; npm: bitecs
 * invariants: a straight shell's row goes once and again only when its course changes — server/src/net/snapshot/shotIds.test.ts
 *             row bytes per client unchanged — server/src/golden/frameHash.test.ts
 * extend:     a new row kind is one function here (or its own file) added to ROW_KINDS in rows/index.ts
 */
import { hasComponent, defineQuery } from 'bitecs';
import {
  Position, Velocity, Rotation, InSystem, Player, Projectile, Lifetime, DroppedItem, EntityType, quantizeShipValue,
} from '@space-game/common';
import { pushRow, type RowHost, type RowKeys, type SnapRow } from './keys.js';

/** Projectiles and loot pods (GameServer reads the same queries) */
export const projectileQuery = defineQuery([Projectile, Position, Velocity, Lifetime]);
export const droppedItemQuery = defineQuery([DroppedItem, Position, Velocity, Lifetime]);

/** Ship bodies without a pilot (dummies, hostiles, freighters, wrecks, debris) */
export function shipRows(h: RowHost, keys: RowKeys, num: number, rows: SnapRow[]): void {
  for (const [eid] of h.ships.bodies) {
    if (hasComponent(h.world, Player, eid) || InSystem.systemId[eid] !== num) continue;
    const named = h.namedBody(eid);
    const foe = h.enemies.info(eid);
    // Status only: motion is replicated (where it is goes only for creating it on the client)
    // data: [kind (1 derelict, 2 traffic, 3 hostile, 0 other), shield %, EMP'd, faction index, 1 elite / 2 boss, core %, weapon beam on, hull %, rating, 1 calm (a passive pack, unprovoked),
    //        side (1 a ward, on the pilots' side; 2 a person's craft, out of every fight: canDamage, so clients' beams pass through as the server's do)]
    // Core and hull % go as 0: clients work them out from the part HP they have (ShipClient.fillHull)
    const side = h.personCraft.has(eid) ? 2 : h.wards.has(eid) ? 1 : 0;
    const data = [named?.kind ?? 0, Math.round(h.ships.shieldFraction(eid) * 100), h.ships.isEmped(eid) ? 1 : 0,
      foe?.factionIndex ?? -1, foe?.boss ? 2 : foe?.elite ? 1 : 0, 0, h.ships.weaponBeamState(eid).on ? 1 : 0, 0, Math.round(foe?.rating ?? 0), foe && h.enemies.isCalm(eid) ? 1 : 0, side];
    pushRow(rows, keys, {
      id: eid,
      type: EntityType.ShipBody,
      x: quantizeShipValue('pos', Position.x[eid]),
      y: quantizeShipValue('pos', Position.y[eid]),
      angle: quantizeShipValue('angle', Rotation.angle[eid]),
      data,
    }, 'ship', named?.name, keys.rowKey(eid, data));
  }
}

/** Single-body enemies: where they are and their HP (data: [their kind's index in data/mobs.json]) */
export function mobRows(h: RowHost, keys: RowKeys, num: number, rows: SnapRow[]): void {
  for (const eid of h.mobs.inSystem(num)) {
    const m = h.mobs.info(eid)!;
    const r1 = (v: number) => Math.round(v * 10) / 10;
    pushRow(rows, keys, { id: eid, type: EntityType.Enemy, x: r1(Position.x[eid]), y: r1(Position.y[eid]), angle: Math.round(Rotation.angle[eid] * 1000) / 1000,
      vx: r1(Velocity.x[eid]), vy: r1(Velocity.y[eid]), hp: m.hp, maxHp: m.maxHp, data: [m.index] }, 'mob');
  }
}

export function projectileRows(h: RowHost, keys: RowKeys, num: number, rows: SnapRow[]): void {
  for (const eid of projectileQuery(h.world)) {
    if (InSystem.systemId[eid] !== num) continue;
    const ownerId = Projectile.ownerId[eid];
    const vx = Math.round(Velocity.x[eid] * 100) / 100, vy = Math.round(Velocity.y[eid] * 100) / 100;
    // data: [weaponType, tier, hue (golden-angle hash of the owner), spawnTick, spawnX, spawnY, ownerId, sizeScale, turret,
    // endTick (a shell that ends at a chosen point: the tick it lands or bursts, 0 none: Weapons.spawn)]
    // (data[10]: the gun that fired it, packed as a fire event's part, -1 none: a client works its hits out from it, HitLedger)
    const data = [
      Projectile.weaponType[eid], Projectile.tier[eid], (ownerId * 137) % 360, Projectile.spawnTick[eid],
      Math.round(Projectile.spawnX[eid] * 10) / 10, Math.round(Projectile.spawnY[eid] * 10) / 10,
      ownerId, Math.round((Projectile.sizeScale[eid] || 1) * 100) / 100, Projectile.turret[eid], Projectile.endTick[eid], Projectile.gun[eid],
    ];
    // Where it is goes only if the client can't work it out (spawn + velocity × age: see GameState)
    const x = Math.round(Position.x[eid] * 100) / 100, y = Math.round(Position.y[eid] * 100) / 100;
    const off = (from: number) => Math.max(Math.abs(data[4] + vx * (h.ticks.currentTick - from) - x), Math.abs(data[5] + vy * (h.ticks.currentTick - from) - y));
    // (A pilot's shells move on the tick they're fired: they count from the tick before. The two are a
    // whole tick's flight apart, so the nearer is always the right one, and the row's key never flips.)
    if (off(data[3] - 1) < off(data[3])) data[3]--;
    // The rounded velocity drifts from the real one by up to 0.005 a tick
    const onLine = off(data[3]) < 0.5 + 0.006 * (h.ticks.currentTick - data[3]);
    const row = pushRow(rows, keys, { id: eid, type: EntityType.Projectile, x: onLine ? undefined! : x, y: onLine ? undefined! : y, vx, vy, data },
      'projectile', undefined, keys.rowKey(eid, [vx, vy, ...data]));
    row.x = x; row.y = y;
  }
}

export function podRows(h: RowHost, keys: RowKeys, num: number, rows: SnapRow[]): void {
  for (const eid of droppedItemQuery(h.world)) {
    if (InSystem.systemId[eid] !== num) continue;
    // A drifting pod goes once, as its drift anchor (data[3] its tick): clients work out the rest (podDrift)
    const a = h.pods.anchor(eid);
    const row = a
      ? pushRow(rows, keys, { id: eid, type: EntityType.DroppedItem, x: Math.round(a.x * 10) / 10, y: Math.round(a.y * 10) / 10,
        vx: Math.round(a.vx * 1000) / 1000, vy: Math.round(a.vy * 1000) / 1000, data: [...h.pods.snapshotData(eid), a.t] }, 'pod')
      : pushRow(rows, keys, { id: eid, type: EntityType.DroppedItem, x: Math.round(Position.x[eid]), y: Math.round(Position.y[eid]), data: h.pods.snapshotData(eid) }, 'pod');
    row.x = Position.x[eid]; row.y = Position.y[eid];
  }
}
