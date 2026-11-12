/**
 * The lobby: the server list and the accounts (one account for every server).
 * Its address comes from VITE_BROWSER_URL at build time (dev: localhost:8787).
 */

export const LOBBY_URL: string = (import.meta as any).env?.VITE_BROWSER_URL || 'http://localhost:8787';

export interface LobbyAuthResult { success: boolean; username?: string; token?: string; isAdmin?: boolean; error?: string }

/** POST to the lobby's accounts (/auth/login, register, validate, logout) */
export async function lobbyAuth(action: 'login' | 'register' | 'validate' | 'logout', body: Record<string, string | boolean>): Promise<LobbyAuthResult> {
  try {
    const r = await fetch(`${LOBBY_URL}/auth/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return await r.json();
  } catch {
    return { success: false, error: "Can't reach the accounts server. Check your connection and try again." };
  }
}

/**
 * A new account. `newsletter` is the player's own yes or no to the email newsletter (ui/join/newsletterChoice.ts): every
 * sign-up form asks, and the lobby records exactly this (server-browser/src/newsletter).
 */
export function lobbyRegister(username: string, email: string, password: string, newsletter: boolean): Promise<LobbyAuthResult> {
  return lobbyAuth('register', { username, email, password, newsletter });
}
