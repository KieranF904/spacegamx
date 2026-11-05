/**
 * Accounts are kept by the lobby (server-browser); the game server asks it.
 * With the lobby's admin secret it can manage them too (ranks and bans).
 */

import { LobbyAccounts } from './LobbyAccounts.js';
import type { UserStore } from './types.js';

export function createUserStore(lobbyUrl: string, adminSecret = ''): UserStore {
  return new LobbyAccounts(lobbyUrl, adminSecret);
}
