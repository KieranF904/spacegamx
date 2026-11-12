/** The admin panel's Donations tab (the owner only): what the lobby has recorded, newest first, and a total per account */

import { html, type SafeHtml } from '../html.js';
import { shell } from './admin.js';
import { empty, when, type PageCtx } from './layout.js';

export interface DonationRow { id: number; username: string | null; userId: number | null; amount: number; currency: string; status: string; orderId: string; captureId: string | null; createdAt: number; completedAt: number | null }
export interface DonationAccount { userId: number | null; username: string | null; total: number; count: number }
export interface DonationReport { enabled: boolean; currency: string; total: number; count: number; recent: DonationRow[]; accounts: DonationAccount[] }

/** Minor units as money: "$7.50" (other currencies: "7.50 EUR") */
export function money(minor: number, currency: string): string {
  const text = (Math.round(minor) / 100).toFixed(2);
  return currency === 'USD' ? `$${text}` : `${text} ${currency}`;
}

const who = (name: string | null, id: number | null): SafeHtml | string =>
  name ? html`<a href="/pilots/${encodeURIComponent(name)}">${name}</a>` : id !== null ? `account ${id}` : 'Guest (no account)';

export function donationsPage(ctx: PageCtx, report: DonationReport | null, error?: string): SafeHtml {
  if (!report) {
    return shell(ctx, 'donations', 'Donations', html`<h1>Donations</h1><p>${error ?? "The lobby isn't answering. Try again in a moment."}</p>`);
  }
  return shell(ctx, 'donations', 'Donations', html`
  <h1>Donations</h1>
  <p>${report.enabled ? 'Donations are on.' : 'Donations are off on this lobby (no PayPal keys for it).'}
    Total received: <strong>${money(report.total, report.currency)}</strong> from ${report.count} ${report.count === 1 ? 'donation' : 'donations'}.</p>
  <h2>By account</h2>
  ${report.accounts.length ? html`<div class="table-wrap"><table class="table">
    <thead><tr><th>Account</th><th>Total</th><th>Donations</th></tr></thead>
    <tbody>${report.accounts.map((a) => html`<tr><td>${who(a.username, a.userId)}</td><td>${money(a.total, report.currency)}</td><td>${a.count}</td></tr>`)}</tbody>
  </table></div>` : empty('No donations yet', 'Completed donations show here with a total per account.')}
  <h2>Recent</h2>
  ${report.recent.length ? html`<div class="table-wrap"><table class="table">
    <thead><tr><th>When</th><th>Account</th><th>Amount</th><th>Status</th><th>PayPal capture</th></tr></thead>
    <tbody>${report.recent.map((d) => html`<tr><td>${when(new Date(d.completedAt ?? d.createdAt).toISOString())}</td><td>${who(d.username, d.userId)}</td><td>${money(d.amount, d.currency)}</td><td>${d.status}</td><td><code>${d.captureId ?? d.orderId}</code></td></tr>`)}</tbody>
  </table></div>` : html`<p class="dim">Nothing yet.</p>`}`);
}
