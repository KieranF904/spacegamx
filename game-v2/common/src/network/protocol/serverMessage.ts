/**
 * @contract protocol.server-union
 * owns:       the ServerMessage union over every family
 * needs:      every server message family file
 * invariants: union membership decides what the compact and binary codecs may carry — serverMessages.json
 * extend:     a new server message type is one line in ServerMessage
 */
import type { EconServerMessage } from '../econProtocol.js';
import type { SocialServerMessage } from '../socialProtocol.js';
import type { ContribServerMessage } from '../contributorProtocol.js';
import type { BossServerMessage } from '../bossProtocol.js';
import type { FieldServerMessage } from '../fieldProtocol.js';
import type { GuestServerMessage } from '../guestProtocol.js';
import type { MinesServerMessage } from '../minesProtocol.js';
import type { ClampServerMessage } from '../clampProtocol.js';
import type { TutorialServerMessage } from '../tutorialProtocol.js';
import type { GunRangeServerMessage } from '../gunRangeProtocol.js';
import type { CombatServerMessage } from '../combatProtocol.js';
import type { UpdateServerMessage } from '../updateProtocol.js';
import type { ServerOwnSyncMessage } from '../../sim/ownStep.js';
import type { ServerGunSyncMessage } from '../../sim/otherGuns.js';
import type { ServerPullsMessage } from '../../sim/pullFields.js';
import type { ServerWelcomeMessage, ServerPongMessage, ServerSnapshotMessage, ServerPlayerStateMessage, ServerInventoryMessage, ServerBankMessage, ServerChatMessage,ServerSystemMessage, ServerSystemInfoMessage, ServerDialogueMessage, ServerShopMessage, ServerDamageMessage, ServerDeathMessage, ServerLevelUpMessage, ServerLootMessage, ServerEffectMessage, ServerAuthResultMessage, ServerAdminStatsMessage, ServerAdminResultMessage, ServerAdminAccountsMessage, ServerAdminInfoMessage, ServerErrorMessage, ServerWarpMessage, ServerAsteroidSpawnMessage, ServerAsteroidSeedMessage, ServerAsteroidDebugMessage } from './serverCore.js';
import type { ServerMapDotsMessage, ServerPopsMessage } from './mapProtocol.js';
import type { ServerStationFireMessage, ServerBossIntroMessage, ServerBossChargeMessage, ServerBossTelegraphMessage, ServerBossBeamMessage, ServerBossBlowMessage, ServerBossPhaseMessage, ServerWorldEventMessage, ServerWorldEventEndMessage, ServerObjectiveMessage, ServerSiegeStateMessage, ServerObjectiveEndMessage, ServerBossDefeatedMessage, ServerIgniteMessage, ServerInterceptMessage, ServerDetonationMessage, ServerPartDestroyedMessage, ServerContactMessage } from './worldProtocol.js';
import type { ServerDockResultMessage, ServerHitsMessage, ServerHpCheckMessage, ServerHitFixMessage, ServerNetCapsMessage, ServerProjectileHitMessage, ServerShipSyncMessage, ServerShipHpMessage, ServerShipHpBatchMessage, ServerDebrisSplitMessage, ServerCellsMessage, ServerCrowdMessage, ServerShipEditResultMessage } from './shipProtocol.js';
export type ServerMessage =
  | ServerWelcomeMessage
  | ServerPongMessage
  | ServerSnapshotMessage
  | ServerPlayerStateMessage
  | ServerSystemInfoMessage
  | ServerInventoryMessage
  | ServerBankMessage
  | ServerChatMessage
  | ServerSystemMessage
  | ServerDialogueMessage
  | ServerShopMessage
  | ServerDamageMessage
  | ServerDeathMessage
  | ServerLevelUpMessage
  | ServerLootMessage
  | ServerEffectMessage
  | ServerErrorMessage
  | ServerWarpMessage
  | ServerAsteroidSpawnMessage
  | ServerAsteroidSeedMessage
  | ServerAsteroidDebugMessage
  | ServerAuthResultMessage
  | ServerAdminStatsMessage
  | ServerAdminResultMessage
  | ServerAdminInfoMessage
  | ServerAdminAccountsMessage
  | ServerShipSyncMessage
  | ServerShipHpMessage
  | ServerShipHpBatchMessage
  | ServerDebrisSplitMessage
  | ServerCellsMessage
  | ServerCrowdMessage
  | ServerShipEditResultMessage
  | ServerProjectileHitMessage
  | ServerHitsMessage
  | ServerHpCheckMessage
  | ServerHitFixMessage
  | ServerNetCapsMessage
  | ServerOwnSyncMessage
  | ServerGunSyncMessage
  | ServerPullsMessage
  | ServerDockResultMessage
  | ServerPartDestroyedMessage
  | ServerContactMessage
  | ServerDetonationMessage
  | ServerInterceptMessage
  | ServerStationFireMessage
  | ServerMapDotsMessage
  | ServerPopsMessage
  | ServerIgniteMessage
  | ServerBossIntroMessage
  | ServerBossChargeMessage
  | ServerBossTelegraphMessage
  | ServerBossBeamMessage
  | ServerBossBlowMessage
  | ServerBossPhaseMessage
  | ServerBossDefeatedMessage
  | ServerWorldEventMessage
  | ServerWorldEventEndMessage
  | ServerObjectiveMessage
  | ServerObjectiveEndMessage
  | ServerSiegeStateMessage
  | EconServerMessage
  | SocialServerMessage
  | ContribServerMessage
  | BossServerMessage
  | FieldServerMessage
  | MinesServerMessage
  | ClampServerMessage
  | TutorialServerMessage
  | GunRangeServerMessage
  | CombatServerMessage
  | UpdateServerMessage
  | GuestServerMessage;

/**
 * The ships of a client's system it doesn't have in view (further than the
 * snapshot's ship view: pilotless ones, distant or live, and other pilots),
 * for the system map: once a second while its map is open (mapView), only
 * what's changed. Each ship's way is a leg in closed form (common
 * ships/farRoute.ts) the client carries it on along exactly as the server
 * reckons it, so a distant ship's dot is sent again only when its route turns,
 * a live one's when it's strayed MAP_DOT_SLACK from where the client has it.
 *   dots   MAP_DOT_STRIDE numbers a ship: [id, x / 10, y / 10, vx × 100, vy × 100,
 *          wx × 100, wy × 100, thrust] (its leg as from `tick`: velocity, the
 *          top speed it's thrusting towards, for `thrust` more ticks, -1 for good)
 *   routes MAP_ROUTE_STRIDE numbers a ship on patrol round a home that stays
 *          put: [id, age, x, y, vx, vy, tx, ty, hx, hy, roam, speed, seed], the
 *          leg it's on (from where it was `age` ticks before `tick`, for (tx, ty))
 *          and its patrol (common ships/farRoute.ts Patrol, with its dice), all
 *          as the server has them: the map works out every leg after as the
 *          server does, so it's told a patrol once
 *   info   MAP_INFO_STRIDE numbers a ship that's new or looks different:
 *          [id, flags, rating]; flags = kind (1 derelict, 2 traffic, 3 hostile,
 *          4 pilot) | rank (1 elite, 2 boss) << 3 | calm << 5 | (faction index + 1) << 6
 *   gone   ships no longer on it
 *   names  [id, name, ...] for the ones it hasn't been told the name of
 *   full   a fresh list (just opened, or another system): anything not in it is gone
 *   pts    MAP_PT_STRIDE numbers a hostile: [id, x / 10, y / 10], where it is at `tick`. Hostiles go as places, not
 *          legs (they're loaded and active, not predictable from here: a ghost nobody's near isn't a ship at all,
 *          the client works it out, ServerPopsMessage), at the rate their distance earns (common FEED_TIERS): in
 *          the client's ring every message, in the system's first band (inner Sol) every 2 s, past it every 5 s
 */
