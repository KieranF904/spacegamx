/**
 * @contract protocol.weapon-groups
 * owns:       the weapon-groups message: set which group each weapon on the live ship is in (a decision; the
 *             selection rides inputs)
 * needs:      nothing imported
 * invariants: every client-sent type here is one the server dispatches, and the set of dispatched types is pinned by
 *             name — server/src/golden/structure.test.ts
 *             the group mask changes only on weapons, free, and the design hash follows —
 *             server/src/net/handlers/weaponGroups.test.ts
 * extend:     a new message is an interface plus a member of this area's client / server union below; then its
 *             handler (server/src/net/handlers) or its entry in client/src/app/serverMessages.ts, and the golden pins
 *             (UPDATE_GOLDEN=1 on structure.test.ts)
 */

/**
 * Weapon groups on the wire (docs/design/groups-mines-docking.md, "Weapon groups"). Which group each weapon is in is
 * part of the design (blueprint part `wg`): the hangar saves it with the design; this message changes it on the live
 * ship from the field build overlay without a plan save (a decision: the ship's blueprint changes, its design hash with
 * it, and other clients get the new design the usual way). The pilot's selection is not here: it rides inputs
 * (ClientInputMessage.weaponGroups).
 */

// ============================================ client -> server

/** Set weapons' groups on the live ship: blueprint uid to a 4-bit mask (ships/weaponGroups.ts). Weapons only; others ignored */
export interface ClientWeaponGroupsMessage { type: 'weaponGroups'; groups: Record<number, number> }

export type WeaponGroupsClientMessage = ClientWeaponGroupsMessage;
