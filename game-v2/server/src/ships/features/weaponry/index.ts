/**
 * @contract feature.weaponry.server
 * owns:       the shared shot behaviours world half: mark and slow beams and the statuses on the wire
 * needs:      ServerFeature, ServerWeaponHooks, common ROLE_MARK / ROLE_SLOW / statusBits, bridge/core WeaponBridge
 * invariants: its hooks run in feature id order and its message names never clash with another feature or the game —
 *             server/src/ships/features/host.test.ts
 * extend:     a new beam status is a role hook in the weapon hooks below plus its wire bit in features.wire.json
 */

/**
 * The shared shot behaviours' world half (the shared half, with the weapon roles: common/src/ships/features/weaponry).
 *   - mark and slow: a beam playing the role burns as the damaging beam does, then marks (MARK_TAKEN × every hit,
 *     bridge/damage.ts hurt) or slows (flight.ts SLOW_CONTROL, bridge/flight.ts and pilotless.ts) what it burned, while
 *     lit and its `ticks` after
 *   - the statuses on the wire: ticks left marked and slowed in the pilot's own row (features.wire.json pilotExtra), the
 *     bits in the status row others get (status "statuses"); replicas fly a slowed ship by CTL.slowed (bridge flight)
 *   - endAtAim, walk and guided are shot options the projectile code reads (game/Weapons.ts, bridge/weapons.ts): no hooks
 */
import type { FeatureInstance, ServerFeature, ServerWeaponHooks, ShipsOf } from '../types.js';
import { ROLE_MARK, ROLE_SLOW, statusBits, type ShipState, type WeaponInfo, type WeaponTuning } from '@space-game/common';
import type { WeaponBridge } from '../../bridge/core.js';

/** A marking beam: it burns, then what it burned is marked (+20% damage taken) for `mark.ticks` */
function markBeam(b: WeaponBridge, eid: number, ship: ShipState, w: WeaponInfo, def: WeaponTuning): number {
  const t = b.fireBeam(eid, ship, w, def);
  if (b.beamStruck >= 0 && def.mark) b.mark(b.beamStruck, def.mark.ticks);
  return t;
}

/** A slowing beam: it burns, then what it burned is slowed (thrust and turning × SLOW_CONTROL) for `slow.ticks` */
function slowBeam(b: WeaponBridge, eid: number, ship: ShipState, w: WeaponInfo, def: WeaponTuning): number {
  const t = b.fireBeam(eid, ship, w, def);
  if (b.beamStruck >= 0 && def.slow) b.slow(b.beamStruck, def.slow.ticks);
  return t;
}

/** What the statuses ask of the game: the ticks left marked and slowed */
type WeaponryHost = ShipsOf<'markedTicksLeft' | 'slowedTicksLeft'>;

class Weaponry implements FeatureInstance {
  constructor(private host: WeaponryHost) {}

  /** The pilot row's values (features.wire.json pilotExtra order): ticks left marked, then slowed */
  wire(eid: number, out: number[]): number {
    out[0] = this.host.ships.markedTicksLeft(eid);
    out[1] = this.host.ships.slowedTicksLeft(eid);
    return 2;
  }

  /** The status row's bits (weaponry.ts STATUS_MARKED, STATUS_SLOWED) */
  status(eid: number): number {
    return statusBits(this.host.ships.markedTicksLeft(eid) > 0, this.host.ships.slowedTicksLeft(eid) > 0);
  }
}

const hooks: Readonly<Record<string, ServerWeaponHooks>> = {
  [ROLE_MARK]: { onFire: markBeam },
  [ROLE_SLOW]: { onFire: slowBeam },
};

export const serverFeature: ServerFeature = {
  id: 'weaponry',
  create: (host) => new Weaponry(host),
  weapon: hooks,
};
