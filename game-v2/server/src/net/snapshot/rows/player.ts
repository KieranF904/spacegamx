/**
 * @contract server.snapshot.rows.player
 * owns:       a pilot's snapshot rows: its own full row (motion, charge, the part features' values, gun state) and the
 *             status-only row every other pilot gets
 * needs:      RowHost (world, clients, lingering, ships, features, gunNet), RowKeys, common energy/guns packers; npm: bitecs
 * invariants: the own row's layout is PILOT_ROW / packCharge / gunStateAt — server/src/golden/parity.test.ts
 *             status row's data order matches features.wire.json status — none pinned
 * extend:     a new value on another pilot's status row is one entry at the end of `status.data` below
 */
import { defineQuery } from 'bitecs';
import {
  Position, Velocity, Rotation, InSystem, Player, Health, Boost, Input, EntityType, packCursorWeaponState, quantizeShipValue, packCharge,
  gunStateAt, packGunState, warmthPercent, type EntityState,
} from '@space-game/common';
import { pushRow, type RowHost, type RowKeys, type SnapRow } from './keys.js';

/** Pilots (GameServer reads the same query) */
export const playerQuery = defineQuery([Player, Position, Velocity, Rotation, Input, Health, Boost]);

/** Scratch for the part features' pilot-row values (spread at once) */
const fxRow: number[] = [];

/** The part features' values for the pilot's own row (fills the scratch array; spread it at once) */
function fxWire(h: RowHost, eid: number): number[] {
  const out = fxRow;
  out.length = 0;
  h.features.wire(eid, out, 0);
  return out;
}

/**
 * Another pilot's cursor distance in hundreds, for its status row (the drawing fallback of a client not stepping its
 * gun lane: ShipClient.placeReplica). An armed pilot's goes by GunNet's idle rule (`rough`: the turn it makes to a
 * gun's line, at most every IDLE_MIN_GAP ticks), firing or not, so its row isn't sent again to every holder each
 * time the cursor crosses a hundred; an unarmed one's (no lane, no turrets to draw) is the cursor's
 */
function roughCursor(h: RowHost, eid: number): number {
  const l = h.gunNet?.lanes.get(eid);
  return Math.round((l && l.kind === 'pilot' ? l.rough : Input.cursorDist[eid]) / 100);
}

export function playerRows(h: RowHost, keys: RowKeys, num: number, rows: SnapRow[]): void {
  const names = new Map<number, string>();
  for (const c of h.clients.values()) names.set(c.playerId, c.username);
  for (const l of h.lingering.values()) names.set(l.conn.playerId, l.conn.username);

  for (const eid of playerQuery(h.world)) {
    if (InSystem.systemId[eid] !== num) continue;
    const beam = h.ships.beamState(eid);
    const ship = h.ships.get(eid);
    // (The charge, packed: the whole gauge, the layout's sig, and the parts' triples, energy.ts packCharge)
    const charge = packCharge(ship?.derived, h.ships.chargeOf(eid));
    const field = h.ships.jumpFieldState(eid);
    const row = pushRow(rows, keys, {
      id: eid,
      type: EntityType.Player,
      // Ship bodies are already rounded to SHIP_PRECISION each tick; these
      // must match it exactly so client prediction replays from server state
      x: quantizeShipValue('pos', Position.x[eid]),
      y: quantizeShipValue('pos', Position.y[eid]),
      angle: quantizeShipValue('angle', Rotation.angle[eid]),
      vx: quantizeShipValue('vel', Velocity.x[eid]),
      vy: quantizeShipValue('vel', Velocity.y[eid]),
      av: quantizeShipValue('angVel', ship?.angVel ?? 0),
      hp: Math.round(Health.current[eid]),
      maxHp: Math.round(Health.max[eid]),
      // data[0]: cursor/weapon state (see CURSOR_STATE.md); data[1]: the whole charge (the gauge); [8] the ports layout's sig, [9]
      // -(the parts' triples' count), [13...] the triples (reconciliation: energy.ts PILOT_ROW, packCharge / unpackCharge)
      data: [
        packCursorWeaponState(Input.targetAngle[eid], beam.hit, h.ships.weaponBeamState(eid).on, beam.on),
        charge.total,
        Math.round(Input.cursorDist[eid]),     // turret convergence (cursor distance)
        ship?.jump ?? 0,                       // jump drive counter (reconciliation + effects)
        Math.round(h.ships.shieldFraction(eid) * 100), // shield charge %
        h.ships.empTicksLeft(eid),          // knocked out by an EMP: ticks left (prediction drifts that long)
        Math.round((ship?.jumpScale ?? 1) * 1000), // this jump's speed scale (prediction)
        field.flags,                           // in a charging field: 1 a star's ring, 2 a lodestone's (bits)
        charge.g,                              // [8] the ports layout's sig (100 for a ship with no state yet)
        charge.count,                          // [9] -(its parts' triples) that follow from [13] (1 for a ship with no state yet)
        field.prime,                           // a lodestone's priming left, ticks (prediction)
        warmthPercent(h.ships.warmthOf(eid)), // warmth % (common/src/ships/warmth.ts: the frost vignette, and the stage prediction flies and fires with)
        ship?.cargo ?? 0,                      // [12] the hold's cargo mass (common/src/ships/load.ts: prediction flies it)
        ...charge.groups,                      // [13...] the parts' triples (CHARGE_GROUPS_AT)
        // After the groups, the part features' values in features.wire.json pilotExtra order (features/strafer/strafer.ts
        // pilotExtras reads them): the Burst Strafer's dodge counter and way (ships/features/strafer), what the Tow Beam tows (+1: ships/features/tow)
        ...fxWire(h, eid),
      ],
    }, 'player', names.get(eid));
    // Last, the gun-state correction (own ship only: guns.ts packGunState), after exactly the pilotExtra values
    { const d = row.state.data!, end = gunStateAt(d);
      while (d.length < end) d.push(0);
      d.length = end;
      if (ship) packGunState(ship, d); else d.push(0); }
    // Everyone else: status only (motion is replicated). data: [shield %, EMP'd, mining beam hit (tenths), weapon beam on,
    // mining beam on, cursor distance (hundreds), what its Tow Beam tows, its statuses (bits: marked 1, slowed 2)]
    const status: EntityState = {
      id: eid, type: EntityType.Player, x: row.state.x, y: row.state.y, hp: row.state.hp, maxHp: row.state.maxHp,
      data: [Math.round(h.ships.shieldFraction(eid) * 20) * 5, h.ships.isEmped(eid) ? 1 : 0,
        Math.round(beam.hit * 10), h.ships.weaponBeamState(eid).on ? 1 : 0, beam.on ? 1 : 0, roughCursor(h, eid),
        // [6] what its Tow Beam tows (entity id + 1, 0 none: ships/features/tow, features.wire.json status)
        h.features.status('tow', eid),
        // [7] marked and slowed (bits: ships/features/weaponry, features.wire.json status)
        h.features.status('weaponry', eid),
        // [8] how full each shaped shield is (a nibble each: ships/features/zoneshield, features.wire.json status)
        h.features.status('zoneshield', eid)],
    };
    row.other = { state: status, key: keys.internKey(-1 - eid, `${status.hp},${status.maxHp},${status.data!.join(',')}`) };
  }
}
