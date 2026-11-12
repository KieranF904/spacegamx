/** A pilot's own pages under /account: their donations and their inbox (routes/mine.ts) */

import { html, raw, type SafeHtml } from '../html.js';
import type { Inbox, InboxMessage, MyDonations } from '../playerLobby.js';
import { money } from './donations.js';
import { csrfField, empty, layout, when, type PageCtx } from './layout.js';

/** The links between the account's pages */
function accountNav(here: 'donations' | 'inbox', unread = 0): SafeHtml {
  const cur = (k: string) => (k === here ? raw(' aria-current="page"') : '');
  return html`<p class="lede"><a href="/account">Account</a> · <a href="/account/inbox"${cur('inbox')}>Inbox${unread > 0 ? ` (${unread})` : ''}</a> · <a href="/account/donations"${cur('donations')}>Donations</a></p>`;
}

const UNAVAILABLE = "This can't be read right now. Try again in a moment.";

const STATUS: Record<string, string> = { COMPLETED: 'Completed', PENDING: 'Pending', FAILED: 'Failed' };
const iso = (ms: number) => new Date(ms).toISOString();

export function myDonationsPage(ctx: PageCtx, d: MyDonations | null): SafeHtml {
  const body = html`
<section class="page-head wrap">
  <p class="eyebrow">Account</p>
  <h1>Your donations</h1>
  ${accountNav('donations')}
</section>
<section class="wrap block-tight">
  ${!d ? html`<p>${UNAVAILABLE}</p>` : html`
  <p>${d.total > 0 ? html`You've donated <strong>${money(d.total, d.currency)}</strong> in total. Thank you!` : "You haven't donated yet."} <a href="/support.html">Support the game</a></p>
  ${d.contributorAt > 0 ? html`<p data-rank>${d.total >= d.contributorAt ? 'You have the contributor rank.' : 'Anybody who donates $10 USD or more in total receives the contributor rank.'}</p>` : ''}
  ${d.donations.length ? html`<div class="table-wrap"><table class="table">
    <thead><tr><th>Date</th><th>Amount</th><th>Status</th><th>PayPal reference</th></tr></thead>
    <tbody>${d.donations.map((x) => html`<tr><td>${when(iso(x.at), false)}</td><td>${money(x.amount, x.currency)}</td><td>${STATUS[x.status] ?? x.status}</td><td>${x.reference ? html`<code>${x.reference}</code>` : ''}</td></tr>`)}</tbody>
  </table></div>
  <p class="dim small">Pending payments count once PayPal completes them. Only you can see this page.</p>` : empty('No donations yet', 'Donations you make while signed in show here.')}`}
</section>`;
  return layout(ctx, { title: 'Your donations', body });
}

const fromName = (m: InboxMessage) => (m.from === 'system' ? 'The game' : m.from);

export function inboxPage(ctx: PageCtx, box: Inbox | null): SafeHtml {
  const body = html`
<section class="page-head wrap">
  <p class="eyebrow">Account</p>
  <h1>Inbox</h1>
  ${accountNav('inbox', box?.unread ?? 0)}
</section>
<section class="wrap block-tight">
  ${!box ? html`<p>${UNAVAILABLE}</p>` : box.messages.length ? html`
  <p class="dim small">The same inbox as in the game. ${box.unread > 0 ? `${box.unread} unread.` : 'Nothing unread.'}</p>
  <div class="table-wrap"><table class="table">
    <thead><tr><th>Subject</th><th>From</th><th>Sent</th></tr></thead>
    <tbody>${box.messages.map((m) => html`<tr${m.readAt === null ? raw(' data-unread') : ''}>
      <td><a href="/account/inbox/${m.id}">${m.readAt === null ? html`<strong>${m.subject}</strong>` : m.subject}</a>${m.readAt === null ? html` <span class="pill pill-admin">new</span>` : ''}</td>
      <td>${fromName(m)}</td><td>${when(iso(m.createdAt))}</td></tr>`)}</tbody>
  </table></div>
  ${box.unread > 0 ? html`<form method="post" action="/account/inbox/read-all" class="stack top-gap">${csrfField(ctx)}<button class="btn btn-ghost" type="submit">Mark all as read</button></form>` : ''}`
    : empty('No messages', 'Messages from the game and its admins show here and in the game.')}
</section>`;
  return layout(ctx, { title: 'Inbox', body });
}

/** One message, as plain text: its line breaks kept, nothing in it treated as HTML */
export function messagePage(ctx: PageCtx, m: InboxMessage): SafeHtml {
  const paragraphs = m.body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const body = html`
<section class="page-head wrap">
  <p class="eyebrow">Inbox</p>
  <h1>${m.subject}</h1>
  <p class="lede">From ${fromName(m)} · ${when(iso(m.createdAt))}</p>
</section>
<section class="wrap block-tight">
  <div class="panel">${paragraphs.map((p) => html`<p class="pre-line">${p}</p>`)}</div>
  <form method="post" action="/account/inbox/${m.id}/delete" class="stack top-gap">${csrfField(ctx)}<button class="btn btn-ghost" type="submit">Delete</button></form>
  <p><a href="/account/inbox">Back to the inbox</a></p>
</section>`;
  return layout(ctx, { title: m.subject || 'Message', body });
}
