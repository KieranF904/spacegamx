/**
 * The lobby: the server list and the accounts (one account for every server).
 * Its address comes from VITE_BROWSER_URL at build time (dev: localhost:8787).
 */

export const LOBBY_URL: string = (import.meta as any).env?.VITE_BROWSER_URL || 'http://localhost:8787';

export interface LobbyAuthResult { success: boolean; username?: string; token?: string; isAdmin?: boolean; error?: string }

/** POST to the lobby's accounts (/auth/login, register, validate, logout) */
export async function lobbyAuth(action: 'login' | 'register' | 'validate' | 'logout', body: Record<string, string>): Promise<LobbyAuthResult> {
  try {
    const r = await fetch(`${LOBBY_URL}/auth/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return await r.json();
  } catch {
    return { success: false, error: "Can't reach the accounts server. Check your connection and try again." };
  }
}
