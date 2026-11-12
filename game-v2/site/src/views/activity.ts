/** The admin Activity page: the live feed of what pilots do on each game server (routes/activity.ts) */

import { html, jsonAttr, raw, type SafeHtml } from '../html.js';
import type { ActivityEvent } from '../activity.js';
import { shell } from './admin.js';
import { csrfField, empty, type PageCtx } from './layout.js';

/** What each event type is called in the filter (an unknown one shows as it is) */
export const EVENT_TYPES: Record<string, string> = {
  join: 'Joined', leave: 'Left', chat: 'Chat', signin: 'Signed in', signout: 'Signed out', register: 'New account', account: 'Account change',
  death: 'Death', pvp: 'PvP kill', kills: 'PvE kills', boss_start: 'Boss fight', boss_kill: 'Boss killed', boss_fail: 'Boss fight lost',
  sale: 'Big sale', sales: 'Sales', trade: 'Trade', craft: 'Crafting', mined: 'Mining', salvage: 'Salvage', level: 'Level up',
  quest: 'Quest', dock: 'Docked', ship: 'Ship change', refit: 'Ship edits', build: 'Ship built', social: 'Messages & friends',
  admin: 'Admin action', kick: 'Kicked', refused: 'Refused', protocol: 'Old client', error: 'Server error', dropped: 'Not sent', server: 'Server',
};

/** Types shown as warnings (red), and as good news (green) */
const BAD = new Set(['death', 'pvp', 'boss_fail', 'kick', 'refused', 'protocol', 'error', 'dropped']);
const GOOD = new Set(['boss_kill', 'level', 'quest', 'build', 'sale', 'register']);

export interface SourceView {
  id: string;
  name: string;
  /** ok | signin (connect to read it) | forbidden | unavailable (no feed there yet) */
  state: 'ok' | 'signin' | 'forbidden' | 'unavailable';
  error?: string;
  /** Uses the site's own session (nothing to connect) */
  own: boolean;
  /** Connected with a session of its own (a disconnect button) */
  connected: boolean;
  live: string[];
}

export interface ActivityFilters { source: string; server: string; type: string; player: string; q: string }

export type Row = ActivityEvent & { source: string };

/** A stable colour for a server's badge (one of five) */
function hue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 5;
}

function filterHref(f: Partial<ActivityFilters>): string {
  const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString();
  return `/admin/activity${q ? `?${q}` : ''}`;
}

/** One event's row (also sent by the live feed, as HTML: the page script puts it at the top) */
export function activityRow(e: Row, sources: Map<string, string>, multi: boolean): SafeHtml {
  const iso = new Date(e.at).toISOString();
  const badge = e.server === 'Lobby' && multi ? `Lobby · ${sources.get(e.source) ?? e.source}` : e.server;
  const kind = BAD.has(e.type) ? ' act-bad' : GOOD.has(e.type) ? ' act-good' : '';
  const who = (name: string) => html`<a href="${filterHref({ player: name })}">${name}</a>`;
  return html`<tr class="act-row${kind}" data-at="${e.at}">
    <td class="mono small act-time"><time datetime="${iso}" data-clock title="${new Date(e.at).toUTCString()}">${iso.slice(11, 19)}</time></td>
    <td><span class="pill act-server act-h${hue(badge)}">${badge}</span></td>
    <td class="act-player">${e.player ? who(e.player) : html`<span class="dim">-</span>`}</td>
    <td><span class="act-type">${EVENT_TYPES[e.type] ?? e.type}</span></td>
    <td class="act-detail">${e.detail}${e.other && !e.detail.includes(e.other) ? html` <span class="dim">(${who(e.other)})</span>` : ''}</td>
  </tr>`;
}

export function activityPage(ctx: PageCtx, d: {
  sources: SourceView[]; rows: Row[]; filters: ActivityFilters; servers: string[]; types: string[];
  cursors: Record<string, number>; error?: string;
}): SafeHtml {
  const f = d.filters;
  const names = new Map(d.sources.map((s) => [s.id, s.name]));
  const multi = d.sources.length > 1;
  const types = [...new Set([...d.types, ...(f.type ? [f.type] : [])])].sort((a, b) => (EVENT_TYPES[a] ?? a).localeCompare(EVENT_TYPES[b] ?? b));
  const servers = [...new Set([...d.servers, ...(f.server ? [f.server] : [])])].sort();
  const opt = (value: string, label: string, on: boolean) => html`<option value="${value}"${on ? raw(' selected') : ''}>${label}</option>`;
  const feedQuery = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString();
  return shell(ctx, 'activity', f.player ? `Activity: ${f.player}` : 'Activity', html`
  <div class="admin-head">
    <h1>${f.player ? html`Activity: ${f.player}` : 'Activity'}</h1>
    <p><a class="btn" href="/admin/chat">Chat with pilots who are on</a></p>
    <div class="act-controls">
      <span class="act-state small" data-activity-state aria-live="polite">Live</span>
      <button class="btn btn-sm" type="button" data-activity-pause>Pause</button>
    </div>
  </div>
  ${f.player ? html`<p class="small"><a href="${filterHref({ ...f, player: '' })}">Back to everyone</a></p>` : ''}

  <div class="act-sources">
    ${d.sources.map((s) => html`<div class="act-source act-source-${s.state}">
      <b>${s.name}</b>
      ${s.state === 'ok' ? html`<span class="small dim">${s.live.length ? `Live: ${s.live.join(', ')}` : 'No game server reporting right now'}</span>`
        : s.state === 'unavailable' ? html`<span class="small dim">${s.name} feed not available yet</span>`
        : s.state === 'forbidden' ? html`<span class="small form-error">${s.error ?? 'Not an admin there'}</span>`
        : html`<span class="small dim">Sign in to ${s.name} to read it</span>`}
      ${s.state === 'signin' && !s.own ? html`<form method="post" action="/admin/activity/connect" class="inline-form act-connect">
        ${csrfField(ctx)}<input type="hidden" name="source" value="${s.id}">
        <input name="username" autocomplete="username" placeholder="Username" required maxlength="40" aria-label="${s.name} username">
        <input name="password" type="password" autocomplete="current-password" placeholder="Password" required maxlength="200" aria-label="${s.name} password">
        <button class="btn btn-sm" type="submit">Sign in</button>
      </form>` : ''}
      ${s.connected ? html`<form method="post" action="/admin/activity/disconnect">${csrfField(ctx)}<input type="hidden" name="source" value="${s.id}"><button class="link-btn" type="submit">Sign out of ${s.name}</button></form>` : ''}
    </div>`)}
  </div>
  ${d.error ? html`<p class="form-error" role="alert">${d.error}</p>` : ''}

  <form method="get" action="/admin/activity" class="act-filters" role="search">
    ${multi ? html`<label class="field"><span>Source</span><select name="source">${opt('', 'All', !f.source)}${d.sources.map((s) => opt(s.id, s.name, f.source === s.id))}</select></label>` : ''}
    <label class="field"><span>Server</span><select name="server">${opt('', 'All', !f.server)}${servers.map((s) => opt(s, s, f.server === s))}</select></label>
    <label class="field"><span>Event</span><select name="type">${opt('', 'All', !f.type)}${types.map((t) => opt(t, EVENT_TYPES[t] ?? t, f.type === t))}</select></label>
    <label class="field"><span>Pilot</span><input name="player" value="${f.player}" maxlength="40" placeholder="Exact name"></label>
    <label class="field grow"><span>Search</span><input name="q" value="${f.q}" maxlength="100" placeholder="Words in the line"></label>
    <div class="act-filter-buttons"><button class="btn btn-primary btn-sm" type="submit">Filter</button><a class="link-btn" href="/admin/activity">Clear</a></div>
  </form>

  <div class="table-wrap" data-activity data-feed="/admin/activity/feed${feedQuery ? `?${feedQuery}` : ''}" data-cursors="${raw(jsonAttr(d.cursors))}">
    <table class="table act-table">
      <thead><tr><th>Time</th><th>Server</th><th>Pilot</th><th>Event</th><th>Detail</th></tr></thead>
      <tbody data-activity-rows>${d.rows.map((e) => activityRow(e, names, multi))}</tbody>
    </table>
    ${d.rows.length ? '' : html`<div data-activity-empty>${empty('Nothing yet', 'Events show up here as pilots play. They arrive every few seconds.')}</div>`}
  </div>
  <p class="dim small">Newest first, the latest 100. Lobbies keep 5,000 events per server. Public chat lines are kept; private messages never are.</p>`);
}
