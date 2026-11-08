/**
 * @contract server.gameserver.options
 * owns:       the GameServer constructor options
 * needs:      types only; npm: @space-game/common
 * invariants: behaviour is unchanged from the class it was split from — none pinned
 * extend:      a new option is a field here
 */

import { GameData } from '../data/GameData.js';
import type { UserStore } from '../auth/types.js';
import type { ShipBridge } from '../ships/ShipBridge.js';
import { Blueprint } from '@space-game/common';
import { type RangeConfig } from '../game/WeaponsRange.js';
import { type TelemetryWriter } from '../game/Telemetry.js';
import { type ContribStore } from '../game/ContributorNotes.js';
import type { FriendsBackend } from '../game/social/FriendsBackend.js';
import { type WorldStore } from '../game/SystemMemory.js';
import { type ProfileStore } from '../profile/ProfileStore.js';
import type { AdminServer } from '../AdminServer.js';

export interface GameServerOptions {
  gameData: GameData;
  userDB: UserStore;
  adminServer?: AdminServer | null;
  /** 'sectors' loads every star system (normal play). 'empty' spawns nothing but players. */
  scene?: 'sectors' | 'empty';
  /** Start the real-time loop immediately (default true). Tests and replays drive step() instead. */
  autoStart?: boolean;
  /** Treat every connection as admin (proto mode: no login). */
  everyoneAdmin?: boolean;
  /** Guests (not signed in) are admins: the dev server only. Refused outright under NODE_ENV=production. */
  guestAdmin?: boolean;
  /** Crowd fallbacks (net/crowd/CrowdControl.ts, measured from tick cost): on in the real server (index.ts); tests and benches opt in */
  crowd?: boolean;
  /** Designs every guest finds in their hangar: the dev server only, like guestAdmin */
  guestShips?: Blueprint[];
  /** Modular ships: every player flies one. */
  ships: ShipBridge;
  /** Allow hangar edits anywhere (proto's empty scene has no stations). Default: docked only. */
  shipEditAnywhere?: boolean;
  /** Keeps logged-in players' progress between sessions (default: in memory only) */
  profileStore?: ProfileStore;
  /** Where friends and status are kept, per account (index.ts: the lobby, LobbyFriends; default: in memory, MemoryFriends) */
  friends?: FriendsBackend;
  /** Wall clock (ms) for autosave and fabricator jobs; tests pass a fake one */
  clock?: () => number;
  /** Allow the map's click-to-warp for everyone (dev servers, proto). Admins can always use it. */
  devTeleport?: boolean;
  /** The weapons range (data/dev/range.json): the dev server only (needs devTeleport), refused outright under NODE_ENV=production */
  devRange?: RangeConfig;
  /** Admins may switch on free build (any part in the hangar, nothing taken): the dev server only. Refused outright under NODE_ENV=production. */
  freeBuild?: boolean;
  /** Every pilot joins and respawns in this system (the dev Rockery, `dev_rockery`), whatever their profile says: the dev server only. Refused outright under NODE_ENV=production. */
  devStart?: string;
  /** Where pilots' deaths and milestones are written (Telemetry.ts); none: not recorded */
  telemetry?: TelemetryWriter;
  /** Where contributor notes and ranks are kept (contribFileStore: data/contributor); none: in memory */
  contributorStore?: ContribStore;
  /** Where the world's memory is kept between restarts (worldFileStore: data/world/memory.json); none: in memory only */
  worldStore?: WorldStore;
  /**
   * The payout dice's secret (game/payoutDice.ts): fixed, the same rolls every run (tests, benches). None: the
   * PAYOUT_SECRET environment variable if set, else a random one each boot (the real server). Never sent anywhere
   */
  payoutSecret?: string;
}
