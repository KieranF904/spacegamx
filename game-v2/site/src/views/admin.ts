/** The admin panel (isAdmin from the lobby; the owner's own tools, isOwner, only shown to the owner: app.ts says which) */

import { html, raw, SafeHtml } from '../html.js';
import { renderMarkdown, safeUrl } from '../markdown.js';
import { postImages } from '../postImages.js';
import type { AdminUser } from '../lobby.js';
import type { ApiToken, Comment, Post, SharedShip, Shout, Suggestion, SuggestionStatus } from '../store/types.js';
import { SUGGESTION_STATUSES } from '../store/types.js';
import { csrfField, empty, fmtDate, layout, STATUS_LABEL, statusBadge, when, type PageCtx } from './layout.js';

type Tab = 'overview' | 'posts' | 'comments' | 'suggestions' | 'shoutbox' | 'ships' | 'pilots' | 'tokens';
const TABS: [Tab, string, string][] = [
  ['overview', 'Overview', '/admin'], ['posts', 'Posts', '/admin/posts'], ['comments', 'Comments', '/admin/comments'],
  ['suggestions', 'Suggestions', '/admin/suggestions'], ['shoutbox', 'Shoutbox', '/admin/shoutbox'], ['ships', 'Shared ships', '/admin/ships'],
  ['pilots', 'Pilots & bans', '/admin/pilots'], ['tokens', 'API tokens', '/admin/tokens'],
];
/** The owner's tabs (app.ts requireOwner) */
const OWNER_TABS: Tab[] = ['tokens'];

const isOwner = (ctx: PageCtx) => !!ctx.user?.isOwner;

/** A rank's badge: owner, admin, or nothing */
export function rankPill(u: { isAdmin: boolean; isOwner?: boolean }): SafeHtml | '' {
  return u.isOwner ? html` <span class="pill pill-admin">owner</span>` : u.isAdmin ? html` <span class="pill pill-admin">admin</span>` : '';
}

function shell(ctx: PageCtx, tab: Tab, title: string, content: SafeHtml, notice?: { kind: 'ok' | 'error'; text: string } | null): SafeHtml {
  const body = html`
<section class="admin wrap">
  <nav class="admin-nav" aria-label="Admin">
    <p class="eyebrow">Admin</p>
    ${TABS.filter(([t]) => isOwner(ctx) || !OWNER_TABS.includes(t)).map(([t, label, href]) => html`<a href="${href}"${t === tab ? raw(' aria-current="page"') : ''}>${label}</a>`)}
  </nav>
  <div class="admin-main">${content}</div>
</section>`;
  return layout(ctx, { title: `Admin: ${title}`, body, bodyClass: 'admin-page', notice });
}

/** An owner-only page, asked for by an admin */
export function ownerOnly(ctx: PageCtx): SafeHtml {
  return shell(ctx, 'overview', 'Owner only', html`
  <h1>Owner only</h1>
  <p>Only the owner can do this: publishing and unpublishing posts, API tokens, admin rank and deleting accounts.</p>
  <p><a href="/admin">Back to the admin overview</a></p>`);
}

function back(path: string): SafeHtml { return html`<input type="hidden" name="back" value="${path}">`; }

export function adminOverview(ctx: PageCtx, d: { posts: { published: number; drafts: number }; comments: number; suggestions: Record<SuggestionStatus, number>; shouts: number; streams: number; live: { players: number; fresh: boolean } | null; lobbyAdmin: boolean }): SafeHtml {
  const open = d.suggestions.open;
  const stat = (label: string, value: string | number, href: string) => html`<a class="stat" href="${href}"><span class="stat-v">${value}</span><span class="stat-k">${label}</span></a>`;
  return shell(ctx, 'overview', 'Overview', html`
  <h1>Overview</h1>
  <div class="stats">
    ${stat('posts live', d.posts.published, '/admin/posts')}
    ${stat('drafts', d.posts.drafts, '/admin/posts')}
    ${stat('recent comments', d.comments, '/admin/comments')}
    ${stat('open suggestions', open, '/admin/suggestions')}
    ${stat('shouts kept', d.shouts, '/admin/shoutbox')}
    ${stat('pilots online', d.live?.fresh ? d.live.players : 'off', '/pilots')}
  </div>
  <div class="admin-quick">
    <a class="btn btn-primary" href="/admin/posts/new">Write an update</a>
    ${isOwner(ctx) ? html`<a class="btn" href="/admin/tokens">API tokens for the CLI</a>` : ''}
  </div>
  ${isOwner(ctx) ? html`<section class="panel">
    <div class="panel-head"><h2>Posting from the terminal</h2></div>
    <p class="small">Make a token under <a href="/admin/tokens">API tokens</a>, then:</p>
    <pre class="code"><code>cd game-v2/site
SITE_TOKEN=sgs_… npm run post-update -- path/to/post.md --publish</code></pre>
    <p class="dim small">Front matter sets the title, tags and draft or published; local images are uploaded. See DEVELOPMENT.md, "Website".</p>
  </section>` : html`<p class="dim small">You can write drafts; the owner publishes them.</p>`}
  ${d.lobbyAdmin ? '' : html`<p class="form-error">LOBBY_ADMIN_SECRET isn't set: the Pilots &amp; bans tools are off.</p>`}
  <p class="dim small">${d.streams} open shoutbox ${d.streams === 1 ? 'stream' : 'streams'}.</p>`);
}

export function adminPosts(ctx: PageCtx, posts: Post[], notice?: { kind: 'ok' | 'error'; text: string } | null): SafeHtml {
  return shell(ctx, 'posts', 'Posts', html`
  <div class="admin-head"><h1>Posts</h1><a class="btn btn-primary" href="/admin/posts/new">New post</a></div>
  ${posts.length ? html`<div class="table-wrap"><table class="table">
    <thead><tr><th>Title</th><th>Status</th><th>Tags</th><th>Updated</th><th><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${posts.map((p) => html`<tr>
      <td><a href="/admin/posts/${p.id}"><b>${p.title}</b></a><br><span class="dim small mono">/updates/${p.slug}</span></td>
      <td><span class="pill pill-${p.status}">${p.status}</span></td>
      <td class="small">${p.tags.join(', ')}</td>
      <td class="small">${when(p.updatedAt)}</td>
      <td class="actions">
        <a class="link-btn" href="/updates/${encodeURIComponent(p.slug)}">View</a>
        ${isOwner(ctx) ? html`<form method="post" action="/admin/posts/${p.id}/${p.status === 'published' ? 'unpublish' : 'publish'}">${csrfField(ctx)}<button class="link-btn" type="submit">${p.status === 'published' ? 'Unpublish' : 'Publish'}</button></form>` : ''}
      </td>
    </tr>`)}</tbody></table></div>`
    : empty('No posts yet', 'Write the first update, or post one from the terminal.', html`<a class="btn btn-primary" href="/admin/posts/new">Write an update</a>`)}`, notice);
}

export function adminEditor(ctx: PageCtx, d: { post: Partial<Post> & { id?: number }; error?: string; notice?: { kind: 'ok' | 'error'; text: string } | null }): SafeHtml {
  const p = d.post;
  const isNew = !p.id;
  return shell(ctx, 'posts', isNew ? 'New post' : 'Edit post', html`
  <div class="admin-head"><h1>${isNew ? 'New post' : 'Edit post'}</h1>${p.id && p.slug ? html`<a class="link-quiet" href="/updates/${encodeURIComponent(p.slug)}">View on the site</a>` : ''}</div>
  <form method="post" action="${isNew ? '/admin/posts' : `/admin/posts/${p.id}`}" class="editor" data-editor>
    ${csrfField(ctx)}
    <div class="editor-meta">
      <div class="field grow"><label for="ed-title">Title</label><input id="ed-title" name="title" required maxlength="140" value="${p.title ?? ''}"></div>
      <div class="field"><label for="ed-slug">Slug <span class="dim">(blank: from the title)</span></label><input id="ed-slug" name="slug" maxlength="80" pattern="[a-z0-9-]*" value="${p.slug ?? ''}" class="mono"></div>
      <div class="field grow"><label for="ed-tags">Tags <span class="dim">(comma separated)</span></label><input id="ed-tags" name="tags" maxlength="200" value="${(p.tags ?? []).join(', ')}"></div>
      <div class="field grow"><label for="ed-summary">Summary <span class="dim">(blank: the first paragraph)</span></label><input id="ed-summary" name="summary" maxlength="300" value="${p.summary ?? ''}"></div>
      <div class="field grow"><label for="ed-cover">Cover image URL <span class="dim">(blank: the first image)</span></label><input id="ed-cover" name="cover" maxlength="300" value="${p.cover ?? ''}" class="mono"></div>
    </div>
    <div class="editor-panes">
      <div class="pane">
        <div class="pane-head"><label for="ed-body">Markdown</label>
          <label class="btn btn-sm upload-btn">Upload image<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-upload hidden></label></div>
        <textarea id="ed-body" name="body" rows="24" required data-md-source class="mono">${p.body ?? ''}</textarea>
        <p class="hint" data-upload-status aria-live="polite">Images: upload, and the Markdown for it goes in where your cursor is.</p>
      </div>
      <div class="pane">
        <div class="pane-head"><span>Preview</span><span class="dim small">sanitised, as published</span></div>
        <div class="prose preview" data-md-preview>${raw(renderMarkdown(p.body ?? '', 'post'))}</div>
      </div>
    </div>
    ${d.error ? html`<p class="form-error" role="alert">${d.error}</p>` : ''}
    <div class="editor-actions">
      <span class="dim small">${p.status ? html`Now: <span class="pill pill-${p.status}">${p.status}</span>` : ''}${p.publishedAt ? html` · first published ${fmtDate(p.publishedAt)}` : ''}</span>
      ${isOwner(ctx) ? html`<button class="btn" type="submit" name="status" value="draft">${p.status === 'published' ? 'Save and unpublish' : 'Save draft'}</button>
      <button class="btn btn-primary" type="submit" name="status" value="published">${p.status === 'published' ? 'Save' : 'Publish'}</button>`
      : p.status === 'published' ? html`<span class="dim small">Published: only the owner can change it.</span>`
      : html`<button class="btn btn-primary" type="submit" name="status" value="draft">Save draft</button><span class="dim small">The owner publishes it.</span>`}
    </div>
  </form>
  ${p.id && (isOwner(ctx) || p.status !== 'published') ? html`<form method="post" action="/admin/posts/${p.id}/delete" class="danger-line" data-confirm="Delete this post and its comments for good?">
    ${csrfField(ctx)}<button class="btn btn-danger btn-sm" type="submit">Delete post</button></form>` : ''}`, d.notice);
}

export function adminComments(ctx: PageCtx, d: { comments: Comment[]; posts: Map<number, Post> }, notice?: { kind: 'ok' | 'error'; text: string } | null): SafeHtml {
  return shell(ctx, 'comments', 'Comments', html`
  <h1>Comments</h1>
  ${d.comments.length ? html`<ol class="mod-list">${d.comments.map((c) => {
    const post = d.posts.get(c.postId);
    const alt = c.image && post ? postImages(post.body).find((i) => i.src === c.image)?.alt : '';
    return html`<li class="${c.hidden ? 'is-hidden' : ''}">
      <div class="mod-meta"><b>${c.authorName}</b> on ${post ? html`<a href="/updates/${encodeURIComponent(post.slug)}#c${c.id}">${post.title}</a>` : 'a deleted post'} · ${when(c.createdAt)}${c.hidden ? html` · <span class="pill pill-draft">hidden</span>` : ''}</div>
      ${c.image && safeUrl(c.image, 'image') ? html`<p class="mod-image"><a class="c-thumb" href="${c.image}" target="_blank" rel="noopener"><img src="${c.image}" alt="" loading="lazy"></a> <span class="dim small">On an image${alt ? html`: ${alt}` : ''}</span></p>` : ''}
      <div class="prose-sm">${raw(renderMarkdown(c.body, 'comment'))}</div>
      <div class="mod-actions">
        <form method="post" action="/admin/comments/${c.id}/${c.hidden ? 'show' : 'hide'}">${csrfField(ctx)}${back('/admin/comments')}<button class="btn btn-sm" type="submit">${c.hidden ? 'Show' : 'Hide'}</button></form>
        <form method="post" action="/admin/comments/${c.id}/delete" data-confirm="Delete this comment for good?">${csrfField(ctx)}<button class="btn btn-sm btn-danger" type="submit">Delete</button></form>
      </div></li>`;
  })}</ol>` : empty('No comments yet', 'Comments on updates show up here to moderate.')}`, notice);
}

export function adminSuggestions(ctx: PageCtx, list: Suggestion[], notice?: { kind: 'ok' | 'error'; text: string } | null): SafeHtml {
  return shell(ctx, 'suggestions', 'Suggestions', html`
  <h1>Suggestions</h1>
  <p class="dim">Set a status and reply; the reply shows under the suggestion on the board. Voting closes once it's done or declined.</p>
  ${list.length ? html`<ol class="mod-list">${list.map((s) => html`<li id="s${s.id}" class="${s.hidden ? 'is-hidden' : ''}">
    <div class="mod-meta"><b>${s.title}</b> · ${s.votes} ${s.votes === 1 ? 'vote' : 'votes'} · ${s.authorName} · ${when(s.createdAt)} ${statusBadge(s.status)}${s.hidden ? html` <span class="pill pill-draft">hidden</span>` : ''}</div>
    ${s.body ? html`<div class="prose-sm">${raw(renderMarkdown(s.body, 'comment'))}</div>` : ''}
    <form method="post" action="/admin/suggestions/${s.id}" class="mod-form">
      ${csrfField(ctx)}
      <label class="sr-only" for="st-${s.id}">Status</label>
      <select id="st-${s.id}" name="status">${SUGGESTION_STATUSES.map((st) => html`<option value="${st}"${st === s.status ? raw(' selected') : ''}>${STATUS_LABEL[st]}</option>`)}</select>
      <label class="sr-only" for="rp-${s.id}">Reply</label>
      <textarea id="rp-${s.id}" name="reply" rows="2" maxlength="2000" placeholder="Reply (optional, shown publicly)">${s.reply ?? ''}</textarea>
      <button class="btn btn-sm btn-primary" type="submit">Save</button>
    </form>
    <div class="mod-actions">
      <form method="post" action="/admin/suggestions/${s.id}/${s.hidden ? 'show' : 'hide'}">${csrfField(ctx)}<button class="btn btn-sm" type="submit">${s.hidden ? 'Show' : 'Hide'}</button></form>
      <form method="post" action="/admin/suggestions/${s.id}/delete" data-confirm="Delete this suggestion and its votes for good?">${csrfField(ctx)}<button class="btn btn-sm btn-danger" type="submit">Delete</button></form>
    </div></li>`)}</ol>` : empty('No suggestions yet', 'When pilots post ideas they show up here.')}`, notice);
}

export function adminShoutbox(ctx: PageCtx, shouts: Shout[], notice?: { kind: 'ok' | 'error'; text: string } | null): SafeHtml {
  return shell(ctx, 'shoutbox', 'Shoutbox', html`
  <h1>Shoutbox</h1>
  <p class="dim">The latest lines, newest first. Deleting one removes it from every open page at once. (Admins can also delete from the shoutbox itself.)</p>
  ${shouts.length ? html`<ol class="mod-list compact">${[...shouts].reverse().map((s) => html`<li>
    <div class="mod-meta"><b>${s.authorName}</b> · ${when(s.createdAt)}</div><div>${s.text}</div>
    <div class="mod-actions"><form method="post" action="/admin/shoutbox/${s.id}/delete">${csrfField(ctx)}<button class="btn btn-sm btn-danger" type="submit">Delete</button></form></div>
  </li>`)}</ol>` : empty('Nothing said yet', 'Shouts show up here.')}`, notice);
}

export function adminShips(ctx: PageCtx, ships: SharedShip[], notice?: { kind: 'ok' | 'error'; text: string } | null): SafeHtml {
  return shell(ctx, 'ships', 'Shared ships', html`
  <h1>Shared ships</h1>
  <p class="dim">Ships pilots have shared from the game, newest first. A hidden ship stays in this list but not in the gallery.</p>
  ${ships.length ? html`<ol class="mod-list compact">${ships.map((s) => html`<li>
    <div class="mod-meta"><b>${s.name}</b> · ${s.ownerName} · ${s.stats.parts} parts · ${when(s.updatedAt)}${s.hidden ? ' · hidden' : ''}</div>
    <div class="mod-actions">
      <a class="btn btn-sm" href="/ships/${s.id}">View</a>
      <form method="post" action="/admin/ships/${s.id}/${s.hidden ? 'show' : 'hide'}">${csrfField(ctx)}<button class="btn btn-sm" type="submit">${s.hidden ? 'Show' : 'Hide'}</button></form>
      <form method="post" action="/admin/ships/${s.id}/delete">${csrfField(ctx)}<button class="btn btn-sm btn-danger" type="submit">Delete</button></form>
    </div>
  </li>`)}</ol>` : empty('No shared ships', 'Nothing has been shared yet.')}`, notice);
}

export function adminTokens(ctx: PageCtx, d: { tokens: ApiToken[]; created?: { name: string; token: string } }, notice?: { kind: 'ok' | 'error'; text: string } | null): SafeHtml {
  return shell(ctx, 'tokens', 'API tokens', html`
  <h1>API tokens</h1>
  <p class="dim">For posting updates from the terminal (<span class="mono">npm run post-update</span>) or any script. A token acts as an admin for the posts API only. Only a hash is kept: the token is shown once.</p>
  ${d.created ? html`<section class="panel token-new" role="status">
    <div class="panel-head"><h2>Token "${d.created.name}" created</h2></div>
    <p class="small">Copy it now; it won't be shown again.</p>
    <div class="copy-row"><input class="mono" readonly value="${d.created.token}" data-copy-src aria-label="New token"><button class="btn" type="button" data-copy>Copy</button></div>
    <pre class="code"><code>SITE_TOKEN=${d.created.token} npm run post-update -- post.md</code></pre>
    <p class="dim small">Or save it for this machine: <span class="mono">npm run post-update -- --save-token ${d.created.token}</span></p>
  </section>` : ''}
  <form method="post" action="/admin/tokens" class="inline-form">
    ${csrfField(ctx)}
    <label for="tk-name">Name</label>
    <input id="tk-name" name="name" required maxlength="60" placeholder="e.g. laptop, assistant">
    <button class="btn btn-primary" type="submit">Create token</button>
  </form>
  ${d.tokens.length ? html`<div class="table-wrap"><table class="table">
    <thead><tr><th>Name</th><th>Token</th><th>Made by</th><th>Created</th><th>Last used</th><th><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${d.tokens.map((t) => html`<tr><td><b>${t.name}</b></td><td class="mono small">${t.prefix}…</td><td>${t.createdByName}</td><td class="small">${fmtDate(t.createdAt)}</td><td class="small">${t.lastUsedAt ? when(t.lastUsedAt) : 'never'}</td>
      <td class="actions"><form method="post" action="/admin/tokens/${t.id}/revoke" data-confirm="Revoke this token? Anything using it stops working.">${csrfField(ctx)}<button class="link-btn danger-text" type="submit">Revoke</button></form></td></tr>`)}</tbody></table></div>`
    : html`<p class="dim">No tokens yet.</p>`}`, notice);
}

export function adminPilots(ctx: PageCtx, d: { users: AdminUser[]; total: number; search: string; enabled: boolean; error?: string }, notice?: { kind: 'ok' | 'error'; text: string } | null): SafeHtml {
  const banText = (u: AdminUser) => u.ban ? (u.ban.until === null ? 'for good' : `until ${new Date(u.ban.until).toISOString().slice(0, 16).replace('T', ' ')} UTC`) : '';
  return shell(ctx, 'pilots', 'Pilots & bans', html`
  <h1>Pilots &amp; bans</h1>
  <p class="dim">Accounts are the lobby's; these use its admin routes (the same ones the in-game admin tools use). A ban stops sign-in on the site and in the game, and ends live sessions.
    Admins ban pilots; the owner can also ban admins, grant and revoke admin, and delete accounts. Nobody bans the owner here.</p>
  ${!d.enabled ? html`<p class="form-error">LOBBY_ADMIN_SECRET isn't set, so these tools are off.</p>` : html`
  <form method="get" action="/admin/pilots" class="inline-form" role="search">
    <label for="ps">Name starts with</label><input id="ps" name="q" value="${d.search}" maxlength="20">
    <button class="btn" type="submit">Search</button>
  </form>
  ${d.error ? html`<p class="form-error">${d.error}</p>` : ''}
  <div class="table-wrap"><table class="table">
    <thead><tr><th>Pilot</th><th>Joined</th><th>Status</th><th>Ban</th>${isOwner(ctx) ? html`<th>Owner tools</th>` : ''}</tr></thead>
    <tbody>${d.users.map((u) => {
      const me = u.username === ctx.user?.username;
      // (Admins can't act on admins or the owner; nobody acts on the owner here)
      const locked = u.isOwner || (u.isAdmin && !isOwner(ctx));
      const user = html`<input type="hidden" name="username" value="${u.username}">`;
      return html`<tr>
      <td><a href="/pilots/${encodeURIComponent(u.username)}"><b>${u.username}</b></a>${rankPill(u)}<br><span class="dim small">#${u.id}</span></td>
      <td class="small">${fmtDate(u.createdAt)}</td>
      <td class="small">${u.ban ? html`<span class="pill pill-banned">banned ${banText(u)}</span><br><span class="dim">${u.ban.reason}${u.ban.by ? ` (by ${u.ban.by})` : ''}</span>` : 'active'}</td>
      <td>${me ? html`<span class="dim small">you</span>` : locked ? html`<span class="dim small">${u.isOwner ? 'the owner' : 'the owner\'s to change'}</span>` : u.ban
        ? html`<form method="post" action="/admin/pilots/unban">${csrfField(ctx)}${user}<button class="btn btn-sm" type="submit">Lift ban</button></form>`
        : html`<form method="post" action="/admin/pilots/ban" class="ban-form">${csrfField(ctx)}${user}
            <select name="days" aria-label="Ban length"><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option><option value="forever">For good</option></select>
            <input name="reason" maxlength="200" placeholder="Reason" aria-label="Reason" required>
            <button class="btn btn-sm btn-danger" type="submit">Ban</button></form>`}</td>
      ${isOwner(ctx) ? html`<td class="actions">${me || u.isOwner ? '' : html`
        <form method="post" action="/admin/pilots/admin">${csrfField(ctx)}${user}<input type="hidden" name="on" value="${u.isAdmin ? '0' : '1'}"><button class="btn btn-sm" type="submit">${u.isAdmin ? 'Remove admin' : 'Make admin'}</button></form>
        <form method="post" action="/admin/pilots/delete" data-confirm="Delete ${u.username}'s account and pilot for good?">${csrfField(ctx)}${user}<button class="btn btn-sm btn-danger" type="submit">Delete account</button></form>`}</td>` : ''}
    </tr>`;
    })}</tbody></table></div>
  <p class="dim small">${d.total} ${d.total === 1 ? 'account' : 'accounts'}${d.search ? ` matching "${d.search}"` : ''}${d.users.length < d.total ? `, first ${d.users.length} shown` : ''}.</p>`}`, notice);
}
