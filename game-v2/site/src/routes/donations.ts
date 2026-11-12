/**
 * The admin Donations page (the owner only).
 *   GET /admin/donations   what the lobby has recorded (server-browser/src/donations): the newest and a total per account
 * Read from the lobby's /admin/donations with LOBBY_ADMIN_SECRET, here on the server: the browser never sees the secret.
 */

import { ownerOnly } from '../views/admin.js';
import { donationsPage, type DonationReport } from '../views/donations.js';
import type { RouteEnv } from './env.js';

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<any> }>;

/** The lobby's report, or null when it can't be read */
export async function readDonations(lobbyUrl: string, adminSecret: string, f: Fetch = fetch as unknown as Fetch): Promise<DonationReport | null> {
  if (!adminSecret) return null;
  try {
    const r = await f(`${lobbyUrl}/admin/donations`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminSecret}` }, body: '{}', signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (r.status !== 200 || j?.success !== true || !Array.isArray(j.recent) || !Array.isArray(j.accounts)) return null;
    return { enabled: j.enabled === true, currency: String(j.currency || 'USD'), total: Number(j.total) || 0, count: Number(j.count) || 0, recent: j.recent, accounts: j.accounts };
  } catch {
    return null;
  }
}

export function registerDonations(env: RouteEnv): void {
  env.router.get('/admin/donations', async (ctx) => {
    const user = env.requireAdmin(ctx);
    if (!user) return;
    if (!user.isOwner) { env.page(ctx, 403, ownerOnly(ctx.page)); return; }
    const report = await readDonations(env.cfg.lobbyUrl, env.cfg.lobbyAdminSecret);
    env.page(ctx, report ? 200 : 503, donationsPage(ctx.page, report));
  });
}
