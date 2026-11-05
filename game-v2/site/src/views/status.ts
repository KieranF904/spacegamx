/** /status: the game server's state. Each section shows only what the server has reported. */

import type { Catalog } from '../catalog/book.js';
import { duration, num } from '../catalog/text.js';
import { html, SafeHtml } from '../html.js';
import type { ServerStatus } from '../status.js';
import { layout, timeAgo, when, type PageCtx } from './layout.js';

const NOT_REPORTED = 'Not reported by the server yet.';

const BOSS_STATE: Record<string, string> = { up: 'Up', fighting: 'In a fight', down: 'Down' };

function section(title: string, inner: SafeHtml | null): SafeHtml {
  return html`<section class="panel status-sec"><div class="panel-head"><h2>${title}</h2></div>${inner ?? html`<p class="dim">${NOT_REPORTED}</p>`}</section>`;
}

export function statusPage(ctx: PageCtx, d: { status: ServerStatus | null; catalog: Catalog | null; now?: number }): SafeHtml {
  const s = d.status;
  const now = d.now ?? Date.now();
  const sysName = (id: string) => d.catalog?.system.get(id)?.name ?? id;
  const bossName = (id: string) => d.catalog?.boss.get(id)?.name ?? id;

  const overview = !s
    ? html`<p>The server is offline. Nothing has been reported.</p>`
    : s.online
      ? html`<dl class="facts"><div><dt>State</dt><dd><span class="live live-on"><i aria-hidden="true"></i>Online</span></dd></div>
          <div><dt>Pilots online</dt><dd>${s.players}</dd></div><div><dt>Ships in space</dt><dd>${s.ships}</dd></div>
          <div><dt>Last report</dt><dd>${timeAgo(new Date(s.at).toISOString(), now)}</dd></div></dl>`
      : html`<dl class="facts"><div><dt>State</dt><dd><span class="live live-offline"><i aria-hidden="true"></i>Offline</span></dd></div>
          <div><dt>Last report</dt><dd>${s.at ? html`${when(new Date(s.at).toISOString())}` : 'never'}</dd></div></dl>`;

  const live = !!s?.online;
  const build = !live || (!s.version && s.protocol === undefined && !s.startedAt) ? null : html`<dl class="facts">
    ${s.version ? html`<div><dt>Version</dt><dd>${s.version}</dd></div>` : ''}
    ${s.protocol !== undefined ? html`<div><dt>Protocol</dt><dd>${s.protocol}</dd></div>` : ''}
    ${s.startedAt ? html`<div><dt>Up for</dt><dd>${duration(Math.max(0, (now - s.startedAt) / 1000))}</dd></div>` : ''}</dl>`;

  const tick = !live || !s.tick ? null : html`<dl class="facts">
    <div><dt>Typical tick</dt><dd>${num(s.tick.ms50, 1)} ms</dd></div><div><dt>Slowest 1%</dt><dd>${num(s.tick.ms99, 1)} ms</dd></div></dl>`;

  const systems = !live || !s.systems ? null : s.systems.length
    ? html`<div class="table-scroll"><table class="db-table"><thead><tr><th>System</th><th class="num">Pilots</th></tr></thead>
      <tbody>${s.systems.slice().sort((a, b) => b.players - a.players || sysName(a.id).localeCompare(sysName(b.id))).map((x) => html`<tr><td>${sysName(x.id)}</td><td class="num">${x.players}</td></tr>`)}</tbody></table></div>`
    : html`<p class="dim">No pilots in any system.</p>`;

  const bosses = !live || !s.bosses ? null : s.bosses.length
    ? html`<div class="table-scroll"><table class="db-table"><thead><tr><th>Boss</th><th>System</th><th>State</th><th>Back in</th></tr></thead>
      <tbody>${s.bosses.map((b) => html`<tr><td>${d.catalog?.boss.has(b.id) ? html`<a href="/database/bosses/${encodeURIComponent(b.id)}">${bossName(b.id)}</a>` : bossName(b.id)}</td><td>${sysName(b.system)}</td><td>${BOSS_STATE[b.state]}</td>
        <td>${b.state === 'down' && b.respawnAt ? duration(Math.max(0, (b.respawnAt - now) / 1000)) : ''}</td></tr>`)}</tbody></table></div>`
    : html`<p class="dim">No bosses listed.</p>`;

  const body = html`
<section class="page-head wrap">
  <p class="eyebrow">Server</p>
  <h1>Status</h1>
  <p class="lede">Whether the game server is up, who is on it, and which bosses are up.</p>
</section>
<section class="wrap block-tight status-grid">
  ${section('Server', overview)}
  ${live ? section('Version', build) : ''}
  ${live ? section('Tick time', tick) : ''}
  ${live ? section('Pilots by system', systems) : ''}
  ${live ? section('Bosses', bosses) : ''}
</section>`;
  return layout(ctx, { title: 'Status', body, description: 'Whether the game server is up, who is on it, and which bosses are up.' });
}
