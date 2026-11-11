/**
 * @contract protocol.loot
 * owns:       the pickup messages: what loot is in reach (sent when it changes), taking it (one decision), the hold's ghosts and their templates, mining mode and the ore blacklist
 * needs:      type-only imports of econ/stacks (Bag) and econ/holdGhosts
 * invariants: every client-sent type here is one the server dispatches, and the set of dispatched types is pinned by
 *             name — server/src/golden/structure.test.ts
 *             the server types the client handles itself are exactly the pinned set — client/src/app/serverMessages.test.ts
 * extend:     a new message is an interface plus a member of this area's client / server union below; then its handler
 *             (server/src/net/handlers/modules.ts) or its entry in client/src/app/serverMessages.ts, and the golden pins
 */

import type { Bag } from '../econ/stacks.js';

// ============================================ server -> client

/** A pod in pickup reach, with what is in it (docs/design/loot-pickup-2026-11.md C) */
export interface LootNearPod {
  id: number;
  items: Bag;
  /** Your own wreck */
  mine?: boolean;
  /** Someone else's wreck: seconds until anyone may take from it */
  lock?: number;
}

/** The pods in your pickup reach and their contents; sent only when that changes (an empty list: none any more) */
export interface ServerLootNearMessage { type: 'lootNear'; pods: LootNearPod[] }

export type LootServerMessage = ServerLootNearMessage;

// ============================================ client -> server

/** Take loot in reach into the hold: one item (all of it that fits), or everything (no `item`). The server checks reach, wreck keeping and room */
export interface ClientLootTakeMessage { type: 'lootTake'; item?: string }

/** Set or clear a ghost in the hold of the ship you fly: `n` a target (absent: unlimited), `remove` to drop it */
export interface ClientGhostMessage { type: 'ghost'; item: string; n?: number; remove?: boolean }

/** Ghost templates (profile.pickup.templates): save the hold's ghosts under a name, load one into the hold (replacing its ghosts), or delete one */
export interface ClientGhostTemplateMessage { type: 'ghostTemplate'; save?: string; load?: string; remove?: string }

/** Mining mode on or off (on: every ore but the blacklisted comes in by itself) */
export interface ClientPickupPrefsMessage { type: 'pickupPrefs'; mining: boolean }

/** Put an ore on the blacklist (mining mode leaves it) or take it off; `jettison`: and throw out what the hold has of it ("Blacklist & jettison") */
export interface ClientOreBlacklistMessage { type: 'oreBlacklist'; item: string; on: boolean; jettison?: boolean }

export type LootClientMessage = ClientLootTakeMessage | ClientGhostMessage | ClientGhostTemplateMessage | ClientPickupPrefsMessage | ClientOreBlacklistMessage;
