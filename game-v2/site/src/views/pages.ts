/** Public pages: home, updates, a post, suggestions, pilots, sign-in, account */

import { html, raw, SafeHtml } from '../html.js';
import { firstImage, firstParagraph, renderMarkdown, safeUrl } from '../markdown.js';
import { decoratePostImages, type ImageStat } from '../postImages.js';
import type { LobbyAccount } from '../lobby.js';
import { BOARDS, type PilotCard, type Rankings } from '../pilots.js';
import { SHOUT_MAX, publicShout } from '../shoutbox.js';
import type { RenderData } from '../catalog/types.js';
import type { Comment, Post, SharedShip, Shout, Suggestion, SuggestionStatus } from '../store/types.js';
import { SUGGESTION_STATUSES } from '../store/types.js';
import { pilotShips } from './ships.js';
import type { Guide } from '../guides.js';
import {
  csrfField, empty, fmtDate, fmtNum, layout, livePill, sectionHead, signInPrompt, STATUS_LABEL, statusBadge, tagChip, when,
  type PageCtx,
} from './layout.js';

export const coverOf = (p: Post): string | null => p.cover || firstImage(p.body);
export const summaryOf = (p: Post, max = 220): string => p.summary || firstParagraph(p.body, max);

// ---------------------------------------------------------------- shared blocks

export function shoutbox(ctx: PageCtx, shouts: Shout[]): SafeHtml {
  return html`<section class="shoutbox panel" data-shoutbox data-me="${ctx.user?.username ?? ''}" data-admin="${ctx.user?.isAdmin ? '1' : ''}" aria-labelledby="shout-h">
  <div class="panel-head"><h2 id="shout-h">Shoutbox</h2><span class="sb-state" data-sb-state>live</span></div>
  <ol class="shouts" data-shouts aria-live="polite" aria-relevant="additions">
    ${shouts.length ? shouts.map((s) => shoutLine(publicShout(s))) : ''}
  </ol>
  <p class="shouts-empty" data-shouts-empty${shouts.length ? raw(' hidden') : ''}>No messages yet.</p>
  ${ctx.user
    ? html`<form class="shout-form" method="post" action="/shoutbox" data-shout-form>
        ${csrfField(ctx)}
        <label class="sr-only" for="shout-text">Message</label>
        <input id="shout-text" name="text" maxlength="${SHOUT_MAX}" autocomplete="off" placeholder="Message" required>
        <span class="count" data-count aria-hidden="true">${SHOUT_MAX}</span>
        <button class="btn btn-primary" type="submit">Send</button>
        <p class="form-error" data-shout-error role="alert" hidden></p>
      </form>`
    : signInPrompt(ctx, 'to join in.')}
</section>`;
}

function shoutLine(s: ReturnType<typeof publicShout>): SafeHtml {
  return html`<li data-id="${s.id}"><span class="sh-name${s.admin ? ' admin' : ''}">${s.name}</span><span class="sh-text">${s.text}</span>${when(s.at)}</li>`;
}

function postRow(p: Post, comments: number, lead = false): SafeHtml {
  const cover = coverOf(p);
  const url = `/updates/${encodeURIComponent(p.slug)}`;
  return html`<article class="post-row${lead ? ' lead' : ''}${cover ? '' : ' no-cover'}">
  ${cover ? html`<a class="post-cover" href="${url}" tabindex="-1" aria-hidden="true"><img src="${cover}" alt="" loading="lazy"></a>` : ''}
  <div class="post-row-body">
    <p class="meta">${when(p.publishedAt ?? p.updatedAt, false)}${p.tags.length ? html` <span class="sep">/</span> ${p.tags.slice(0, 3).join(', ')}` : ''}</p>
    <h3><a href="${url}">${p.title}</a></h3>
    <p class="summary">${summaryOf(p, lead ? 300 : 200)}</p>
    <p class="meta"><a class="more" href="${url}">Read more</a>${comments ? html` <span class="sep">/</span> ${comments} ${comments === 1 ? 'comment' : 'comments'}` : ''}</p>
  </div>
</article>`;
}

function miniBoard(r: Rankings | null): SafeHtml {
  const rows = r?.weekly.kills?.length ? { label: 'Hostiles destroyed this week', rows: r.weekly.kills } : r?.allTime.kills?.length ? { label: 'Hostiles destroyed, all time', rows: r.allTime.kills } : null;
  return html`<section class="panel mini-board" aria-labelledby="mb-h">
  <div class="panel-head"><h2 id="mb-h">Top pilots</h2><a class="link-quiet" href="/pilots">All boards</a></div>
  ${rows
    ? html`<p class="dim small">${rows.label}</p><ol class="rank-list">${rows.rows.slice(0, 5).map((x, i) => html`<li><span class="rk">${i + 1}</span><a href="/pilots/${encodeURIComponent(x.name)}">${x.name}</a><span class="val">${fmtNum(x.value)}</span></li>`)}</ol>`
    : html`<p class="dim">No scores yet.</p>`}
</section>`;
}

// ---------------------------------------------------------------- home

/** The guides the home page points to first (by file slug) */
const HOME_GUIDES = ['getting-started', 'controls-and-flight-modes', 'building-a-ship', 'mining-and-refining'];

export function homePage(ctx: PageCtx, d: { posts: Post[]; comments: Map<number, number>; shouts: Shout[]; rankings: Rankings | null; guides?: Guide[] }): SafeHtml {
  const [lead, ...rest] = d.posts;
  const featured = HOME_GUIDES.map((s) => d.guides?.find((g) => g.slug === s)).filter((g): g is Guide => !!g);
  const body = html`
<section class="hero">
  <div class="hero-art" aria-hidden="true"><img src="/static/img/hero-corsair.webp" alt="" width="1600" height="900"></div>
  <div class="wrap hero-in">
    <p class="eyebrow eyebrow-hero">Space game <span class="sep">/</span> in development</p>
    <h1>Build it part by part.<br><span class="accent">Fly it into the dark.</span></h1>
    <p class="lede">A space game about building ships. Mine, trade and take jobs at stations. You build your ship one part at a time and fly it yourself. Still in development.</p>
    <div class="hero-cta">
      <a class="btn-play btn-play-lg" href="/play"><span>Play now</span><small>in the browser</small></a>
      ${lead ? html`<a class="btn btn-ghost" href="/updates/${encodeURIComponent(lead.slug)}">Latest update <span aria-hidden="true">&rarr;</span></a>` : ''}
    </div>
    <div class="hero-meta">
      ${livePill(ctx.live, true)}
      <span class="dim">${ctx.user ? html`Signed in as <b>${ctx.user.username}</b>.` : 'One account for the site and the game.'}</span>
    </div>
  </div>
  <div class="hero-scroll" aria-hidden="true"></div>
</section>

<section class="wrap block">
  ${sectionHead('Updates', 'Latest', html`<a class="link-quiet" href="/updates">All updates <span aria-hidden="true">&rarr;</span></a>`)}
  ${lead
    ? html`<div class="post-list home-posts">${postRow(lead, d.comments.get(lead.id) ?? 0, true)}${rest.slice(0, 2).map((p) => postRow(p, d.comments.get(p.id) ?? 0))}</div>`
    : empty('No updates yet', 'Nothing here yet.')}
</section>
${featured.length ? html`<section class="wrap block-tight" aria-labelledby="home-guides-h">
  ${sectionHead('Guides', raw('<span id="home-guides-h">How it works</span>'), html`<a class="link-quiet" href="/guides">All guides <span aria-hidden="true">&rarr;</span></a>`)}
  <div class="guide-grid guide-grid-4">${featured.map((x) => html`<a class="guide-card" href="/guides/${x.slug}">
    <span class="guide-n">${String(x.order).padStart(2, '0')}</span>
    <span class="guide-t">${x.title}</span>
    <span class="guide-s">${x.summary}</span>
  </a>`)}</div>
</section>` : ''}

<section class="features" aria-labelledby="feat-h">
  <div class="wrap">
    ${sectionHead('The game', raw('<span id="feat-h">Features</span>'))}
    <div class="feature">
      <figure class="feature-art art-parts"><img src="/static/img/parts.webp" alt="Eight ship parts rendered in the game, each with its name: Bastion, Lance, Cutter, Fusion Torch, Cell Reactor, Battery, Deflector and Ion Drive" loading="lazy"></figure>
      <div class="feature-text">
        <p class="feature-n">01 <span>Build</span></p>
        <h3>Ships are built from parts</h3>
        <p>Hull plates, generators, batteries, engines, guns and shields go onto a grid in the hangar. Guns have mounting rules, and every part adds mass.</p>
        <p class="feature-links"><a href="/guides/building-a-ship">Guide: Building a ship</a><a href="/database/parts">Database: every part</a></p>
      </div>
    </div>
    <div class="feature flip">
      <figure class="feature-art art-ship"><img src="/static/img/lancer.webp" alt="A player ship rendered in the game, engines lit" loading="lazy"></figure>
      <div class="feature-text">
        <p class="feature-n">02 <span>Fly</span></p>
        <h3>Mouse or helm controls</h3>
        <p>Steer with the mouse, or switch to helm controls (V): A and D turn, Q and E strafe. Shift boosts, and the jump drive (J) crosses the gaps between systems.</p>
        <p class="feature-links"><a href="/guides/controls-and-flight-modes">Guide: Controls and flight modes</a><a href="/guides/travel">Guide: Travel</a></p>
      </div>
    </div>
    <div class="feature">
      <figure class="feature-art art-boss"><img src="/static/img/scrap-mother.webp" alt="The Scrap Mother, a boss ship with crane claws and green vents" loading="lazy"></figure>
      <div class="feature-text">
        <p class="feature-n">03 <span>Fight</span></p>
        <h3>Bosses</h3>
        <p>Bosses fight in stages. Attacks are telegraphed, and shooting a part off stops the move it powers. Everyone who damages a boss gets a share of the reward.</p>
        <p class="feature-links"><a href="/guides/bosses-the-basics">Guide: Bosses, the basics</a><a href="/database/bosses">Database: every boss</a></p>

      </div>
    </div>
  </div>
</section>

<section class="wrap block community">
  ${sectionHead('Community', 'Community', html`<a class="link-quiet" href="/suggestions">Suggestions <span aria-hidden="true">&rarr;</span></a>`)}
  <div class="community-grid">
    ${shoutbox(ctx, d.shouts)}
    <div class="side-stack">
      ${miniBoard(d.rankings)}
      <section class="panel cta-panel">
        <h2>Suggestions</h2>
        <p>Post ideas and vote on them.</p>
        <a class="btn" href="/suggestions">Open the board</a>
      </section>
    </div>
  </div>
</section>`;
  return layout(ctx, { title: '', body, image: '/static/img/hero-corsair.webp', bodyClass: 'home' });
}

// ---------------------------------------------------------------- updates

export function updatesPage(ctx: PageCtx, d: { posts: Post[]; total: number; page: number; perPage: number; tag: string | null; tags: { tag: string; count: number }[]; comments: Map<number, number> }): SafeHtml {
  const pages = Math.max(1, Math.ceil(d.total / d.perPage));
  const q = (page: number) => `/updates?${new URLSearchParams({ ...(d.tag ? { tag: d.tag } : {}), ...(page > 1 ? { page: String(page) } : {}) })}`;
  const body = html`
<section class="page-head wrap">
  <p class="eyebrow">Updates</p>
  <h1>Updates</h1>
  <p class="lede">Changes to the game. <a href="/rss.xml" class="rss">RSS feed</a></p>
  ${d.tags.length ? html`<div class="tags" aria-label="Filter by tag"><a class="tag${d.tag ? '' : ' on'}" href="/updates">all</a>${d.tags.map((t) => tagChip(t.tag, t.tag === d.tag))}</div>` : ''}
</section>
<section class="wrap block-tight">
  ${d.posts.length
    ? html`<div class="post-list">${d.posts.map((p, i) => postRow(p, d.comments.get(p.id) ?? 0, i === 0 && d.page === 1 && !d.tag))}</div>`
    : empty(d.tag ? `Nothing tagged “${d.tag}”` : 'No updates yet', d.tag ? html`<a href="/updates">All updates</a>` : 'Nothing here yet.')}
  ${pages > 1 ? html`<nav class="pager" aria-label="Pages">
    ${d.page > 1 ? html`<a class="btn" href="${q(d.page - 1)}" rel="prev">Newer</a>` : html`<span></span>`}
    <span class="dim">Page ${d.page} of ${pages}</span>
    ${d.page < pages ? html`<a class="btn" href="${q(d.page + 1)}" rel="next">Older</a>` : html`<span></span>`}
  </nav>` : ''}
</section>`;
  return layout(ctx, { title: d.tag ? `Updates: ${d.tag}` : 'Updates', body, feed: true });
}

/** One comment in a post's list (also what the page's script adds after a comment is posted) */
export function commentItem(ctx: PageCtx, post: Post, c: Comment, imageAlt = ''): SafeHtml {
  const thumb = c.image && safeUrl(c.image, 'image');
  return html`<li class="comment" id="c${c.id}"${c.image ? html` data-image="${c.image}"` : ''}>
    <div class="comment-meta"><span class="c-name">${c.authorId ? html`<a href="/pilots/${encodeURIComponent(c.authorName)}">${c.authorName}</a>` : c.authorName}</span>${when(c.createdAt)}
    ${ctx.user?.isAdmin ? html`<form method="post" action="/admin/comments/${c.id}/hide" class="inline-mod">${csrfField(ctx)}<input type="hidden" name="back" value="/updates/${post.slug}#comments"><button class="link-btn" type="submit">Hide</button></form>` : ''}</div>
    ${thumb ? html`<a class="c-thumb" href="${c.image}" data-open-image title="${imageAlt ? `On the image: ${imageAlt}` : 'On an image in this post'}" aria-label="${imageAlt ? `View the image this comment is on: ${imageAlt}` : 'View the image this comment is on'}"><img src="${c.image}" alt="" loading="lazy"></a>` : ''}
    <div class="comment-body prose-sm">${raw(renderMarkdown(c.body, 'comment'))}</div>
  </li>`;
}

export function postPage(ctx: PageCtx, d: { post: Post; comments: Comment[]; preview?: boolean; error?: string; draft?: string; newer: Post | null; older: Post | null }): SafeHtml {
  const p = d.post;
  const cover = coverOf(p);
  const onImage = new Map<string, ImageStat>();
  for (const c of d.comments) if (c.image) { const s = onImage.get(c.image); if (s) s.count++; else onImage.set(c.image, { count: 1, firstId: c.id }); }
  const pictured = decoratePostImages(renderMarkdown(p.body, 'post'), onImage);
  const bodyHtml = raw(pictured.html);
  const altOf = new Map(pictured.images.map((i) => [i.src, i.alt]));
  // (The cover is shown in the header; if it's the body's own first image, the body keeps it too)
  const body = html`
<article class="post">
  <header class="post-head wrap-narrow">
    ${p.status === 'draft' ? html`<p class="draft-flag">Draft: only admins can see this</p>` : ''}
    <p class="meta"><a href="/updates">Updates</a> <span class="sep">/</span> ${when(p.publishedAt ?? p.updatedAt, false)} <span class="sep">/</span> ${ctx.authors?.[p.authorName.toLowerCase()] ?? p.authorName}</p>
    <h1>${p.title}</h1>
    ${p.summary ? html`<p class="lede">${p.summary}</p>` : ''}
    ${p.tags.length ? html`<div class="tags">${p.tags.map((t) => tagChip(t))}</div>` : ''}
    ${p.status === 'published' ? html`<p class="meta"><a href="#comments">${d.comments.length ? `${d.comments.length} ${d.comments.length === 1 ? 'comment' : 'comments'}` : 'Leave a comment'}</a></p>` : ''}
    ${ctx.user?.isAdmin ? html`<p class="admin-inline"><a href="/admin/posts/${p.id}">Edit this post</a></p>` : ''}
  </header>
  ${p.cover ? html`<figure class="post-cover-lg wrap"><span class="pic"><img src="${cover}" alt="${p.title}" data-cover></span></figure>` : ''}
  <div class="prose wrap-narrow">${bodyHtml}</div>
  <nav class="post-nav wrap-narrow" aria-label="More updates">
    ${d.older ? html`<a href="/updates/${encodeURIComponent(d.older.slug)}"><small>Previous</small>${d.older.title}</a>` : html`<span></span>`}
    ${d.newer ? html`<a class="next" href="/updates/${encodeURIComponent(d.newer.slug)}"><small>Next</small>${d.newer.title}</a>` : html`<span></span>`}
  </nav>
</article>
<section class="comments wrap-narrow" id="comments" aria-labelledby="comments-h">
  <h2 id="comments-h">Comments <span class="dim" data-comment-total>${d.comments.length || ''}</span></h2>
  <ol class="comment-list" data-comment-list>${d.comments.map((c) => commentItem(ctx, p, c, c.image ? altOf.get(c.image) : ''))}</ol>
  <p class="dim" data-comments-empty${d.comments.length ? raw(' hidden') : ''}>No comments yet.</p>
  ${p.status !== 'published' ? '' : ctx.user
    ? html`<form class="comment-form" method="post" action="/updates/${encodeURIComponent(p.slug)}/comments">
        ${csrfField(ctx)}
        <label for="comment-body">Add a comment <span class="dim">as ${ctx.user.username}</span></label>
        <textarea id="comment-body" name="body" rows="4" maxlength="2000" required placeholder="Markdown is supported">${d.draft ?? ''}</textarea>
        ${d.error ? html`<p class="form-error" role="alert">${d.error}</p>` : ''}
        <div class="form-row"><span class="dim small">Moderators can hide comments.</span><button class="btn btn-primary" type="submit">Post comment</button></div>
      </form>`
    : signInPrompt(ctx, 'to comment.')}
  ${!pictured.images.length || p.status !== 'published' ? '' : html`<template data-image-form>${ctx.user
    ? html`<form class="comment-form" method="post" action="/updates/${encodeURIComponent(p.slug)}/comments">
        ${csrfField(ctx)}
        <input type="hidden" name="image" value="">
        <label for="image-comment-body">Add a comment</label>
        <textarea id="image-comment-body" name="body" rows="3" maxlength="2000" required></textarea>
        <p class="form-error" data-form-error role="alert" hidden></p>
        <div class="form-row"><span class="dim small">as ${ctx.user.username}</span><button class="btn btn-primary" type="submit">Post comment</button></div>
      </form>`
    : signInPrompt(ctx, 'to comment.')}</template>`}
</section>`;
  return layout(ctx, { title: p.title, body, description: summaryOf(p, 200), image: cover, bodyClass: 'post-page' });
}

// ---------------------------------------------------------------- suggestions

export function suggestionsPage(ctx: PageCtx, d: { list: Suggestion[]; sort: 'top' | 'new'; status: SuggestionStatus | null; voted: Set<number>; counts: Record<SuggestionStatus, number>; error?: string; draft?: { title: string; body: string } }): SafeHtml {
  const link = (o: { sort?: string; status?: string | null }) => {
    const sort = o.sort ?? d.sort;
    const status = o.status === undefined ? d.status : o.status;
    const q = new URLSearchParams({ ...(sort !== 'top' ? { sort } : {}), ...(status ? { status } : {}) }).toString();
    return `/suggestions${q ? `?${q}` : ''}`;
  };
  const total = Object.values(d.counts).reduce((a, b) => a + b, 0);
  const body = html`
<section class="page-head wrap">
  <p class="eyebrow">Community</p>
  <h1>Suggestions</h1>
  <p class="lede">Ideas for the game. One vote per account.</p>
</section>
<section class="wrap block-tight sugg-layout">
  <div class="sugg-main">
    <div class="toolbar">
      <div class="seg" role="group" aria-label="Sort">
        <a href="${link({ sort: 'top' })}"${d.sort === 'top' ? raw(' aria-current="true"') : ''}>Top</a>
        <a href="${link({ sort: 'new' })}"${d.sort === 'new' ? raw(' aria-current="true"') : ''}>New</a>
      </div>
      <div class="filters" aria-label="Filter by status">
        <a class="tag${d.status ? '' : ' on'}" href="${link({ status: null })}">all <span class="n">${total}</span></a>
        ${SUGGESTION_STATUSES.map((s) => html`<a class="tag tag-${s}${d.status === s ? ' on' : ''}" href="${link({ status: s })}">${STATUS_LABEL[s].toLowerCase()} <span class="n">${d.counts[s]}</span></a>`)}
      </div>
    </div>
    ${d.list.length
      ? html`<ol class="sugg-list">${d.list.map((s) => suggestionRow(ctx, s, d.voted.has(s.id)))}</ol>`
      : total === 0
        ? empty('No suggestions yet.', '', ctx.user ? html`<a class="btn btn-primary" href="#suggest">Suggest something</a>` : html`<a class="btn btn-primary" href="/register?next=/suggestions">Create an account</a>`)
        : empty('Nothing here yet.', html`<a href="/suggestions">All suggestions</a>`)}
  </div>
  <aside class="sugg-side">
    <section class="panel" id="suggest" aria-labelledby="sg-h">
      <div class="panel-head"><h2 id="sg-h">Suggest something</h2></div>
      ${ctx.user
        ? html`<form method="post" action="/suggestions" class="stack">
            ${csrfField(ctx)}
            <label for="sg-title">Idea</label>
            <input id="sg-title" name="title" maxlength="120" required value="${d.draft?.title ?? ''}" placeholder="e.g. Name your ships">
            <label for="sg-body">Details <span class="dim">(optional)</span></label>
            <textarea id="sg-body" name="body" rows="5" maxlength="2000">${d.draft?.body ?? ''}</textarea>
            ${d.error ? html`<p class="form-error" role="alert">${d.error}</p>` : ''}
            <button class="btn btn-primary" type="submit">Post suggestion</button>
            <p class="dim small">Check the list for duplicates first.</p>
          </form>`
        : signInPrompt(ctx, 'to post ideas and vote.')}
    </section>
  </aside>
</section>`;
  return layout(ctx, { title: 'Suggestions', body });
}

function suggestionRow(ctx: PageCtx, s: Suggestion, voted: boolean): SafeHtml {
  const canVote = !!ctx.user && s.status !== 'done' && s.status !== 'declined';
  return html`<li class="sugg status-row-${s.status}" id="s${s.id}">
  <form class="vote" method="post" action="/suggestions/${s.id}/vote" data-vote>
    ${csrfField(ctx)}<input type="hidden" name="on" value="${voted ? '0' : '1'}">
    <button type="submit" class="vote-btn${voted ? ' voted' : ''}" aria-pressed="${voted ? 'true' : 'false'}" ${canVote ? '' : raw('disabled')} aria-label="${voted ? 'Remove your vote' : 'Vote for this'} (${s.votes} ${s.votes === 1 ? 'vote' : 'votes'})" title="${ctx.user ? (canVote ? (voted ? 'Remove your vote' : 'Vote for this') : 'Voting is closed') : 'Sign in to vote'}">
      <svg viewBox="0 0 16 10" aria-hidden="true"><path d="M1 9 8 2l7 7" fill="none" stroke="currentColor" stroke-width="2"/></svg>
      <span class="vote-n" data-votes>${s.votes}</span>
    </button>
  </form>
  <div class="sugg-body">
    <div class="sugg-top"><h3>${s.title}</h3>${statusBadge(s.status)}</div>
    ${s.body ? html`<div class="prose-sm">${raw(renderMarkdown(s.body, 'comment'))}</div>` : ''}
    <p class="meta">${s.authorName} <span class="sep">/</span> ${when(s.createdAt)}${ctx.user?.isAdmin ? html` <span class="sep">/</span> <a href="/admin/suggestions#s${s.id}">Moderate</a>` : ''}</p>
    ${s.reply ? html`<div class="reply"><p class="reply-by">${s.replyBy ?? 'The team'} replied</p><div class="prose-sm">${raw(renderMarkdown(s.reply, 'comment'))}</div></div>` : ''}
  </div>
</li>`;
}

// ---------------------------------------------------------------- pilots

export interface CardNames { bosses: Record<string, string>; ribbons: Record<string, string> }

/** An id the catalog doesn't know, as words ("boss_scrap_mother" -> "Scrap mother") */
const plainId = (id: string) => { const t = id.replace(/^boss_/, '').replace(/_/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

export function pilotCard(card: PilotCard | null, name: string, opts: { own: boolean; names?: CardNames; heading?: 'h1' | 'h2' }): SafeHtml {
  if (!card) {
    return html`<section class="pilot-card panel no-data">
      <div class="pc-id"><span class="pc-badge">?</span><div><p class="eyebrow">Pilot</p>${opts.heading === 'h1' ? html`<h1>${name}</h1>` : html`<h2>${name}</h2>`}</div></div>
      ${empty('No record yet', opts.own ? 'The card fills in after you play.' : `No record for ${name}.`, opts.own ? html`<a class="btn-play" href="/play">Play now</a>` : undefined)}
    </section>`;
  }
  const s = card.stats;
  const tally: [string, number][] = [['Hostiles destroyed', s.kills], ['Boss kills', s.bosses], ['Jobs done', s.quests], ['Ore mined', s.mined], ['Credits earned', s.earned], ['Systems visited', card.systemsVisited]];
  const bosses = Object.entries(card.bossKills).filter(([, n]) => n > 0).map(([id, n]) => ({ name: opts.names?.bosses[id] ?? plainId(id), n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const ribbonNames = opts.names ? (card.ribbonIds ?? []).map((id) => opts.names!.ribbons[id] ?? plainId(id)).sort((a, b) => a.localeCompare(b)) : [];
  return html`<section class="pilot-card panel">
  <div class="pc-id">
    <span class="pc-badge" aria-label="Level ${card.level}"><small>LVL</small>${card.level}</span>
    <div><p class="eyebrow">Pilot</p>${opts.heading === 'h1' ? html`<h1>${name}</h1>` : html`<h2>${name}</h2>`}
      <p class="dim">${card.shipName ? html`Flying the <b class="ship">${card.shipName}</b>` : 'No ship on record'}${card.ships > 1 ? ` · ${card.ships} ships in the hangar` : ''}</p></div>
  </div>
  <dl class="pc-stats">${tally.map(([k, v]) => html`<div><dt>${k}</dt><dd>${fmtNum(v)}</dd></div>`)}</dl>
  ${bosses.length ? html`<div class="pc-list"><h3>Bosses beaten</h3><ul class="chips">${bosses.map((b) => html`<li>${b.name}${b.n > 1 ? html` <span class="n">&times;${b.n}</span>` : ''}</li>`)}</ul></div>` : ''}
  ${ribbonNames.length ? html`<div class="pc-list"><h3>Ribbons <span class="dim">${ribbonNames.length}</span></h3><ul class="chips">${ribbonNames.map((n) => html`<li>${n}</li>`)}</ul></div>` : ''}
  <p class="pc-foot dim small">${card.ribbons && !ribbonNames.length ? html`${card.ribbons} ${card.ribbons === 1 ? 'ribbon' : 'ribbons'} · ` : ''}${card.since ? html`Pilot since ${fmtDate(card.since)}` : ''}${card.lastFlown ? html` · last flew ${when(card.lastFlown)}` : ''}${opts.own ? html` · ${fmtNum(card.credits)} credits` : ''}</p>
</section>`;
}

export function pilotsPage(ctx: PageCtx, d: { rankings: Rankings | null; period: 'weekly' | 'allTime' }): SafeHtml {
  const boards = d.rankings?.[d.period];
  const any = boards && Object.values(boards).some((b) => b.length);
  const body = html`
<section class="page-head wrap">
  <p class="eyebrow">Leaderboards</p>
  <h1>Pilots</h1>
  <p class="lede">Leaderboards from the game. Weekly boards reset each week.</p>
  <div class="toolbar">
    <div class="seg" role="group" aria-label="Period">
      <a href="/pilots"${d.period === 'allTime' ? raw(' aria-current="true"') : ''}>All time</a>
      <a href="/pilots?period=weekly"${d.period === 'weekly' ? raw(' aria-current="true"') : ''}>This week</a>
    </div>
    <form class="pilot-search" method="get" action="/pilots/find" role="search">
      <label class="sr-only" for="pf">Find a pilot</label>
      <input id="pf" name="name" placeholder="Find a pilot by name" maxlength="20" required>
      <button class="btn" type="submit">Find</button>
    </form>
  </div>
</section>
<section class="wrap block-tight">
  ${any
    ? html`<div class="boards">${BOARDS.filter((b) => (boards![b.key] ?? []).length).map((b) => {
        const rows = boards![b.key];
        return html`<section class="board panel" aria-label="${b.label}">
          <div class="panel-head"><h2>${b.label}</h2></div>
          <ol class="rank-list">${rows.map((r, i) => html`<li class="${i < 3 ? `top top-${i + 1}` : ''}"><span class="rk">${i + 1}</span><a href="/pilots/${encodeURIComponent(r.name)}">${r.name}</a><span class="val">${fmtNum(r.value)}${b.unit ? html` <small>${b.unit}</small>` : ''}</span></li>`)}</ol>
        </section>`;
      })}</div>
      ${BOARDS.some((b) => !(boards![b.key] ?? []).length) ? html`<p class="dim small boards-none">No scores yet: ${BOARDS.filter((b) => !(boards![b.key] ?? []).length).map((b) => b.label.toLowerCase()).join(', ')}.</p>` : ''}`
    : empty(d.period === 'weekly' ? 'No scores this week.' : 'No scores yet.', '', html`<a class="btn-play" href="/play">Play now</a>`)}
</section>`;
  return layout(ctx, { title: 'Pilots', body });
}

export function pilotPage(ctx: PageCtx, d: { name: string; card: PilotCard | null; ranks: { label: string; rank: number; value: number }[]; ships: SharedShip[]; render: RenderData | null; names?: CardNames }): SafeHtml {
  const body = html`
<section class="wrap block-tight narrow-col">
  <p class="meta crumb"><a href="/pilots">Pilots</a> <span class="sep">/</span> ${d.name}</p>
  ${pilotCard(d.card, d.name, { own: ctx.user?.username.toLowerCase() === d.name.toLowerCase(), names: d.names, heading: 'h1' })}
  ${d.ranks.length ? html`<section class="panel"><div class="panel-head"><h2>On the boards</h2></div><ul class="rank-places">${d.ranks.map((r) => html`<li><span class="rk">#${r.rank}</span> ${r.label} <span class="val">${fmtNum(r.value)}</span></li>`)}</ul></section>` : ''}
  ${pilotShips(d.ships, d.render)}
</section>`;
  return layout(ctx, { title: d.name, body });
}

export function notFoundPage(ctx: PageCtx, what = 'page'): SafeHtml {
  const body = html`<section class="wrap block narrow-col not-found">
  <p class="eyebrow">404</p>
  <h1>${what === 'page' ? 'Page not found' : `No such ${what}`}</h1>
  <p class="lede">The address may be wrong, or the page has been removed.</p>
  <p class="nf-links"><a class="btn" href="/">Home</a><a class="btn btn-ghost" href="/updates">Updates</a><a class="btn btn-ghost" href="/guides">Guides</a><a class="btn btn-ghost" href="/database">Database</a></p>
</section>`;
  return layout(ctx, { title: 'Not found', body });
}

export function errorPage(ctx: PageCtx, title: string, text: string): SafeHtml {
  return layout(ctx, { title, body: html`<section class="wrap block narrow-col">${empty(title, text, html`<a class="btn" href="/">Home</a>`)}</section>` });
}

// ---------------------------------------------------------------- sign in, register

export function signInPage(ctx: PageCtx, d: { mode: 'signin' | 'register'; next: string; error?: string; username?: string; email?: string }): SafeHtml {
  const reg = d.mode === 'register';
  const nextQ = d.next !== '/' ? `?next=${encodeURIComponent(d.next)}` : '';
  const body = html`
<section class="auth wrap">
  <div class="auth-art" aria-hidden="true"><img src="/static/img/sparrow.webp" alt=""></div>
  <div class="auth-panel panel">
    <p class="eyebrow">${reg ? 'New account' : 'Account'}</p>
    <h1>${reg ? 'Create an account' : 'Sign in'}</h1>
    <p class="dim">${reg ? 'One account for the site and the game.' : 'The same account as the game.'}</p>
    <form method="post" action="/${reg ? 'register' : 'signin'}" class="stack">
      ${csrfField(ctx)}
      <input type="hidden" name="next" value="${d.next}">
      <label for="u">${reg ? 'Pilot name' : 'Pilot name or email'}</label>
      <input id="u" name="username" required autocomplete="username" maxlength="${reg ? 20 : 254}" value="${d.username ?? ''}" ${reg ? raw('pattern="[A-Za-z0-9_\\-]{2,20}" title="2 to 20 letters, numbers, _ or -"') : ''} autofocus>
      ${reg ? html`<p class="hint">2 to 20 letters, numbers, _ or -. Shown to other players.</p>
      <label for="e">Email</label>
      <input id="e" name="email" type="email" required autocomplete="email" maxlength="254" value="${d.email ?? ''}">
      <p class="hint">Not shown to anyone.</p>` : ''}
      <label for="p">Password</label>
      <input id="p" name="password" type="password" required autocomplete="${reg ? 'new-password' : 'current-password'}" maxlength="200">
      ${d.error ? html`<p class="form-error" role="alert">${d.error}</p>` : ''}
      <button class="btn btn-primary btn-wide" type="submit">${reg ? 'Create account' : 'Sign in'}</button>
    </form>
    <p class="auth-switch">${reg ? html`Have an account? <a href="/signin${nextQ}">Sign in</a>` : html`No account? <a href="/register${nextQ}">Create an account</a>`}</p>
  </div>
</section>`;
  return layout(ctx, { title: reg ? 'Create an account' : 'Sign in', body, bodyClass: 'auth-page' });
}

// ---------------------------------------------------------------- account

export type AccountForm = 'email' | 'password' | 'everywhere' | 'delete';

export function accountPage(ctx: PageCtx, d: { account: LobbyAccount; card: PilotCard | null; errors: Partial<Record<AccountForm, string>> }): SafeHtml {
  const a = d.account;
  const err = (f: AccountForm) => (d.errors[f] ? html`<p class="form-error" role="alert">${d.errors[f]}</p>` : '');
  const body = html`
<section class="page-head wrap">
  <p class="eyebrow">Account</p>
  <h1>${a.username}</h1>
  <p class="lede">Pilot since ${fmtDate(a.createdAt)}${a.isOwner ? html` · <span class="gold">owner</span>` : a.isAdmin ? html` · <span class="gold">admin</span>` : ''}. <a href="/pilots/${encodeURIComponent(a.username)}">Public profile</a></p>
</section>
<section class="wrap block-tight account-grid">
  <div class="account-main">
    ${pilotCard(d.card, a.username, { own: true })}
    <div class="panel-row">
      <a class="btn-play" href="/play">Play now</a>
      <span class="dim small">The game uses this sign-in.</span>
    </div>
  </div>
  <div class="account-forms">
    <section class="panel" aria-labelledby="em-h">
      <div class="panel-head"><h2 id="em-h">Email</h2></div>
      <p class="dim small">Current: <b class="mono">${a.email}</b></p>
      <form method="post" action="/account/email" class="stack">
        ${csrfField(ctx)}
        <label for="em">New email</label><input id="em" name="email" type="email" required maxlength="254" autocomplete="email">
        <label for="em-p">Password</label><input id="em-p" name="password" type="password" required autocomplete="current-password">
        ${err('email')}
        <button class="btn" type="submit">Change email</button>
      </form>
    </section>
    <section class="panel" aria-labelledby="pw-h">
      <div class="panel-head"><h2 id="pw-h">Password</h2></div>
      <form method="post" action="/account/password" class="stack">
        ${csrfField(ctx)}
        <label for="pw-c">Current password</label><input id="pw-c" name="password" type="password" required autocomplete="current-password">
        <label for="pw-n">New password</label><input id="pw-n" name="newPassword" type="password" required minlength="1" maxlength="200" autocomplete="new-password">
        <label for="pw-r">New password again</label><input id="pw-r" name="repeat" type="password" required maxlength="200" autocomplete="new-password">
        ${err('password')}
        <button class="btn" type="submit">Change password</button>
        <p class="hint">Signs out all other sessions, including the game.</p>
      </form>
    </section>
    <section class="panel" aria-labelledby="ev-h">
      <div class="panel-head"><h2 id="ev-h">Sessions</h2></div>
      <form method="post" action="/account/signout-all" class="stack">
        ${csrfField(ctx)}
        <p class="dim small">Ends every session, on the site and in the game.</p>
        ${err('everywhere')}
        <button class="btn" type="submit">Sign out everywhere</button>
      </form>
      <form method="post" action="/signout" class="stack top-gap">${csrfField(ctx)}<button class="btn btn-ghost" type="submit">Sign out of this browser</button></form>
    </section>
    <section class="panel danger" aria-labelledby="del-h">
      <div class="panel-head"><h2 id="del-h">Delete account</h2></div>
      <details${d.errors.delete ? raw(' open') : ''}>
        <summary>Delete this account</summary>
        <form method="post" action="/account/delete" class="stack" data-confirm-delete="${a.username}">
          ${csrfField(ctx)}
          <p class="small">This deletes the account, the pilot and everything the pilot owns. It can't be undone. Comments and suggestions stay, shown as "a former pilot". Shouts and votes are deleted.</p>
          <label for="del-n">Type <b class="mono">${a.username}</b> to confirm</label>
          <input id="del-n" name="confirm" required autocomplete="off" data-confirm-input>
          <label for="del-p">Password</label><input id="del-p" name="password" type="password" required autocomplete="current-password">
          ${err('delete')}
          <button class="btn btn-danger" type="submit" data-confirm-button>Delete my account</button>
        </form>
      </details>
    </section>
  </div>
</section>`;
  return layout(ctx, { title: 'Account', body });
}
