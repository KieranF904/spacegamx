/**
 * @contract server.gun-range.gate
 * owns:       which client messages a pilot in the gun range may send: flying, shooting, talking and leaving pass; every
 *             build, hangar, trade, item, market, quest, travel and dev message is refused before its handler runs
 * needs:      @space-game/common ClientMessage (type only)
 * invariants: the table names every client message type (a new one fails to compile until it says pass or refuse), and an
 *             unknown type is refused — server/src/game/gunRange/gunRange.test.ts
 * extend:     a new client message type is one line in RANGE_GATE
 */

import type { ClientMessage } from '@space-game/common';

type Verdict = 'pass' | 'refuse';

/** Each client message type, in the gun range: let through, or refused (dispatch drops it: net/dispatch.ts) */
export const RANGE_GATE = {
  // Flying, shooting and the netcode under them
  input: 'pass', ping: 'pass', stateHash: 'pass', hpResync: 'pass', packedResync: 'pass', shipNeed: 'pass', mapView: 'pass',
  respawn: 'pass', target: 'pass', weaponGroups: 'pass', feedSwitch: 'pass',
  // X: at the door it takes you out (game/gunRange); nothing else in the range answers it
  interact: 'pass',
  // The range's own
  gunRangeEnter: 'pass', gunRangeWeapon: 'pass',
  // Talking and company (none of it touches a profile's items)
  chat: 'pass', whisper: 'pass', setStatus: 'pass', friendRequest: 'pass', friendRespond: 'pass', friendRemove: 'pass',
  partyInvite: 'pass', partyRespond: 'pass', partyLeave: 'pass', partyKick: 'pass', partyPromote: 'pass', mapPing: 'pass',
  pilotInfo: 'pass', rankings: 'pass', ribbons: 'pass',
  // Joining swaps the profile under the range: leave first
  join: 'refuse',
  // Building, the hangar and the station (there is none in the range, and nothing built here may last)
  shipEdit: 'refuse', dock: 'refuse', undock: 'refuse', stationOpen: 'refuse', slotBuild: 'refuse', slotClear: 'refuse', slotFly: 'refuse',
  slotLoadout: 'refuse', slotOrder: 'refuse', slotSave: 'refuse', designSave: 'refuse', designDelete: 'refuse', shareDesign: 'refuse',
  fieldPlan: 'refuse', fieldPlanClear: 'refuse', fieldCancel: 'refuse', fieldRecycle: 'refuse', machine: 'refuse',
  clampDock: 'refuse', clampSwap: 'refuse', clampUndock: 'refuse', tow: 'refuse', mineDrop: 'refuse',
  // Items, money and trade
  itemMove: 'refuse', itemStore: 'refuse', itemJettison: 'refuse', itemUse: 'refuse', scrapItem: 'refuse', quickbarSet: 'refuse',
  restockLoadout: 'refuse', ammoPrefer: 'refuse', bankDeposit: 'refuse', craft: 'refuse', refine: 'refuse', fabOrder: 'refuse',
  fabOrderCancel: 'refuse', gemCut: 'refuse', gemSocket: 'refuse', gemUnsocket: 'refuse', marketBuy: 'refuse', marketSell: 'refuse',
  marketSellAll: 'refuse', marketScan: 'refuse', vendorBuy: 'refuse', vendorOpen: 'refuse', tradeRequest: 'refuse', tradeRespond: 'refuse',
  tradeOffer: 'refuse', tradeAccept: 'refuse', tradeCancel: 'refuse', outpostCharter: 'refuse', outpostUpgrade: 'refuse', skillUp: 'refuse',
  // Jobs, people, the codex, sieges and the training yard
  job: 'refuse', questAccept: 'refuse', questAbandon: 'refuse', questBoard: 'refuse', questSeen: 'refuse', talk: 'refuse', codexRead: 'refuse',
  siege: 'refuse', tutorialLeave: 'refuse', tutorialReport: 'refuse', contrib: 'refuse',
  // Admin and dev tools (they move ships and hand out things: leave the range first)
  admin: 'refuse', devTeleport: 'refuse', devSpawn: 'refuse', devShip: 'refuse', devBoss: 'refuse', devStation: 'refuse', devBank: 'refuse',
  bossDevTool: 'refuse',
  // (Old types no handler answers today: refused all the same)
  dropItem: 'refuse', pickup: 'refuse', buy: 'refuse', sell: 'refuse', repair: 'refuse', refuel: 'refuse', warp: 'refuse',
} as const satisfies Record<ClientMessage['type'], Verdict>;

/** May a pilot in the gun range send this message type (unknown types are refused) */
export function passesInRange(type: string): boolean {
  return (RANGE_GATE as Record<string, Verdict | undefined>)[type] === 'pass';
}
