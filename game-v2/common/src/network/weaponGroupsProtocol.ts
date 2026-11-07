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
