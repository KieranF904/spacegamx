/** Public pages: home, updates, a post, suggestions, pilots, sign-in, account */

import { html, raw, SafeHtml } from '../html.js';
import { firstImage, firstParagraph, renderMarkdown } from '../markdown.js';
import type { LobbyAccount } from '../lobby.js';
import { BOARDS, type PilotCard, type Rankings } from '../pilots.js';
import { SHOUT_MAX, publicShout } from '../shoutbox.js';
import type { Comment, Post, Shout, Suggestion, SuggestionStatus } from '../store/types.js';
import { SUGGESTION_STATUSES } from '../store/types.js';
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
  <p class="shouts-empty" data-shouts-empty${shouts.length ? raw(' hidden') : ''}>Quiet out here. Say hello.</p>
  ${ctx.user
    ? html`<form class="shout-form" method="post" action="/shoutbox" data-shout-form>
        ${csrfField(ctx)}
        <label class="sr-only" for="shout-text">Message</label>
        <input id="shout-text" name="text" maxlength="${SHOUT_MAX}" autocomplete="off" placeholder="Say something to the other pilots" required>
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
    <p class="meta"><a class="more" href="${url}">Read the update</a>${comments ? html` <span class="sep">/</span> ${comments} ${comments === 1 ? 'comment' : 'comments'}` : ''}</p>
  </div>
</article>`;
}

function miniBoard(r: Rankings | null): SafeHtml {
  const rows = r?.weekly.kills?.length ? { label: 'Hostiles destroyed this week', rows: r.weekly.kills } : r?.allTime.kills?.length ? { label: 'Hostiles destroyed, all time', rows: r.allTime.kills } : null;
  return html`<section class="panel mini-board" aria-labelledby="mb-h">
  <div class="panel-head"><h2 id="mb-h">Top pilots</h2><a class="link-quiet" href="/pilots">All boards</a></div>
  ${rows
    ? html`<p class="dim small">${rows.label}</p><ol class="rank-list">${rows.rows.slice(0, 5).map((x, i) => html`<li><span class="rk">${i + 1}</span><a href="/pilots/${encodeURIComponent(x.name)}">${x.name}</a><span class="val">${fmtNum(x.value)}</span></li>`)}</ol>`
    : html`<p class="dim">No one on the boards yet. The first pilot to clear a few hostiles takes the top spot.</p>`}
</section>`;
}

// ---------------------------------------------------------------- home

export function homePage(ctx: PageCtx, d: { posts: Post[]; comments: Map<number, number>; shouts: Shout[]; rankings: Rankings | null }): SafeHtml {
  const [lead, ...rest] = d.posts;
  const body = html`
<section class="hero">
  <div class="hero-art" aria-hidden="true"><img src="/static/img/hero-corsair.webp" alt="" width="1600" height="900"></div>
  <div class="wrap hero-in">
    <p class="eyebrow eyebrow-hero">Multiplayer space game <span class="sep">/</span> in development</p>
    <h1>Build it part by part.<br><span class="accent">Fly it into the dark.</span></h1>
    <p class="lede">Mine, trade and take jobs at the stations. Design your ship one component at a time, wire up its power, and take it out against what nests in the Drift.</p>
    <div class="hero-cta">
      <a class="btn-play btn-play-lg" href="/play"><span>Play now</span><small>in your browser</small></a>
      ${lead ? html`<a class="btn btn-ghost" href="/updates/${encodeURIComponent(lead.slug)}">Latest update <span aria-hidden="true">&rarr;</span></a>` : ''}
    </div>
    <div class="hero-meta">
      ${livePill(ctx.live, true)}
      <span class="dim">${ctx.user ? html`Signed in as <b>${ctx.user.username}</b>: Play takes you straight in.` : 'One account for the site and the game.'}</span>
    </div>
  </div>
  <div class="hero-scroll" aria-hidden="true"></div>
</section>

<section class="wrap block">
  ${sectionHead('Patch notes', 'Latest updates', html`<a class="link-quiet" href="/updates">All updates <span aria-hidden="true">&rarr;</span></a>`)}
  ${lead
    ? html`<div class="post-list home-posts">${postRow(lead, d.comments.get(lead.id) ?? 0, true)}${rest.slice(0, 2).map((p) => postRow(p, d.comments.get(p.id) ?? 0))}</div>`
    : empty('No updates yet', 'The first patch notes will land here.')}
</section>

<section class="features" aria-labelledby="feat-h">
  <div class="wrap">
    ${sectionHead('The game', raw('<span id="feat-h">What you do out there</span>'))}
    <div class="feature">
      <figure class="feature-art art-parts"><img src="/static/img/parts.webp" alt="A sheet of the game's ship components: guns, engines, reactors, batteries and shields, each with its name" loading="lazy"></figure>
      <div class="feature-text">
        <p class="feature-n">01 <span>Build</span></p>
        <h3>Every ship is a grid of parts you place</h3>
        <p>Hull plates, reactors, batteries, engines, guns and shields, each a named component with its own size, numbers and trade-off. Power runs along wires you draw across the hull; shoot out the block under a wire and everything past the break goes dark.</p>
        <p class="dim">Guns follow mounting rules: what they bolt onto, which way they face, the lane they need clear. The Component Guide (C) lists them all by the level they open at.</p>
      </div>
    </div>
    <div class="feature flip">
      <figure class="feature-art art-ship"><img src="/static/img/lancer.webp" alt="A player ship rendered in the game, engines lit" loading="lazy"></figure>
      <div class="feature-text">
        <p class="feature-n">02 <span>Fly</span></p>
        <h3>Steer with the mouse, or take the helm</h3>
        <p>Point and thrust with the mouse, or switch to helm controls (V): turn with A and D, strafe with Q and E, and the camera swings round so your nose always points up the screen.</p>
        <p class="dim">Engines have a rated speed: an Ion Drive is efficient but slow at the top end, an Afterburner trades cruise for a huge boost.</p>
      </div>
    </div>
    <div class="feature">
      <figure class="feature-art art-boss"><img src="/static/img/scrap-mother.webp" alt="The Scrap Mother, a huge patched-together boss with crane claws and glowing green vents" loading="lazy"></figure>
      <div class="feature-text">
        <p class="feature-n">03 <span>Fight</span></p>
        <h3>Bosses in three stages, each its own fight</h3>
        <p>Every attack that hurts is telegraphed first, moves come in a fixed order you can learn, and shooting a part off stops the move it powers. The Scrap Mother waits in her nest out in the Drift.</p>
        <blockquote class="ingame"><p>&ldquo;Something huge and patched together stirs in the hollow at the heart of the junk, grey veins glinting in the rock around it.&rdquo;</p><cite>The game, as you reach her</cite></blockquote>
      </div>
    </div>
  </div>
</section>

<section class="wrap block community">
  ${sectionHead('Community', 'Talk to the other pilots', html`<a class="link-quiet" href="/suggestions">Suggest something <span aria-hidden="true">&rarr;</span></a>`)}
  <div class="community-grid">
    ${shoutbox(ctx, d.shouts)}
    <div class="side-stack">
      ${miniBoard(d.rankings)}
      <section class="panel cta-panel">
        <h2>Got an idea?</h2>
        <p>The suggestions board is read. Post an idea, vote for the ones you want, and see what's planned.</p>
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
  <p class="eyebrow">Patch notes</p>
  <h1>Updates</h1>
  <p class="lede">What changed in the game, written up as it ships. <a href="/rss.xml" class="rss">RSS feed</a></p>
  ${d.tags.length ? html`<div class="tags" aria-label="Filter by tag"><a class="tag${d.tag ? '' : ' on'}" href="/updates">all</a>${d.tags.map((t) => tagChip(t.tag, t.tag === d.tag))}</div>` : ''}
</section>
<section class="wrap block-tight">
  ${d.posts.length
    ? html`<div class="post-list">${d.posts.map((p, i) => postRow(p, d.comments.get(p.id) ?? 0, i === 0 && d.page === 1 && !d.tag))}</div>`
    : empty(d.tag ? `Nothing tagged “${d.tag}”` : 'No updates yet', d.tag ? html`<a href="/updates">See every update</a>` : 'The first patch notes will land here.')}
  ${pages > 1 ? html`<nav class="pager" aria-label="Pages">
    ${d.page > 1 ? html`<a class="btn" href="${q(d.page - 1)}" rel="prev">Newer</a>` : html`<span></span>`}
    <span class="dim">Page ${d.page} of ${pages}</span>
    ${d.page < pages ? html`<a class="btn" href="${q(d.page + 1)}" rel="next">Older</a>` : html`<span></span>`}
  </nav>` : ''}
</section>`;
  return layout(ctx, { title: d.tag ? `Updates: ${d.tag}` : 'Updates', body, feed: true });
}

export function postPage(ctx: PageCtx, d: { post: Post; comments: Comment[]; preview?: boolean; error?: string; draft?: string; newer: Post | null; older: Post | null }): SafeHtml {
  const p = d.post;
  const cover = coverOf(p);
  const bodyHtml = raw(renderMarkdown(p.body, 'post'));
  // (The cover is shown in the header; if it's the body's own first image, the body keeps it too)
  const body = html`
<article class="post">
  <header class="post-head wrap-narrow">
    ${p.status === 'draft' ? html`<p class="draft-flag">Draft: only admins can see this</p>` : ''}
    <p class="meta"><a href="/updates">Updates</a> <span class="sep">/</span> ${when(p.publishedAt ?? p.updatedAt, false)} <span class="sep">/</span> ${p.authorName}</p>
    <h1>${p.title}</h1>
    ${p.summary ? html`<p class="lede">${p.summary}</p>` : ''}
    ${p.tags.length ? html`<div class="tags">${p.tags.map((t) => tagChip(t))}</div>` : ''}
    ${ctx.user?.isAdmin ? html`<p class="admin-inline"><a href="/admin/posts/${p.id}">Edit this post</a></p>` : ''}
  </header>
  ${p.cover ? html`<figure class="post-cover-lg wrap"><img src="${cover}" alt=""></figure>` : ''}
  <div class="prose wrap-narrow">${bodyHtml}</div>
  <nav class="post-nav wrap-narrow" aria-label="More updates">
    ${d.older ? html`<a href="/updates/${encodeURIComponent(d.older.slug)}"><small>Previous</small>${d.older.title}</a>` : html`<span></span>`}
    ${d.newer ? html`<a class="next" href="/updates/${encodeURIComponent(d.newer.slug)}"><small>Next</small>${d.newer.title}</a>` : html`<span></span>`}
  </nav>
</article>
<section class="comments wrap-narrow" id="comments" aria-labelledby="comments-h">
  <h2 id="comments-h">Comments <span class="dim">${d.comments.length || ''}</span></h2>
  ${d.comments.length
    ? html`<ol class="comment-list">${d.comments.map((c) => html`<li class="comment" id="c${c.id}">
        <div class="comment-meta"><span class="c-name">${c.authorId ? html`<a href="/pilots/${encodeURIComponent(c.authorName)}">${c.authorName}</a>` : c.authorName}</span>${when(c.createdAt)}
        ${ctx.user?.isAdmin ? html`<form method="post" action="/admin/comments/${c.id}/hide" class="inline-mod">${csrfField(ctx)}<input type="hidden" name="back" value="/updates/${p.slug}#comments"><button class="link-btn" type="submit">Hide</button></form>` : ''}</div>
        <div class="comment-body prose-sm">${raw(renderMarkdown(c.body, 'comment'))}</div>
      </li>`)}</ol>`
    : html`<p class="dim">No comments yet.${ctx.user ? ' Start the conversation.' : ''}</p>`}
  ${p.status !== 'published' ? '' : ctx.user
    ? html`<form class="comment-form" method="post" action="/updates/${encodeURIComponent(p.slug)}/comments">
        ${csrfField(ctx)}
        <label for="comment-body">Add a comment <span class="dim">as ${ctx.user.username}</span></label>
        <textarea id="comment-body" name="body" rows="4" maxlength="2000" required placeholder="Plain text, with **bold**, *italics*, \`code\` and links">${d.draft ?? ''}</textarea>
        ${d.error ? html`<p class="form-error" role="alert">${d.error}</p>` : ''}
        <div class="form-row"><span class="dim small">Be decent. Moderators can hide comments.</span><button class="btn btn-primary" type="submit">Post comment</button></div>
      </form>`
    : signInPrompt(ctx, 'to comment.')}
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
  <p class="lede">Ideas for the game, voted up by pilots. One vote per account; the team marks what's planned, under way, done or not happening, and says why.</p>
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
        ? empty('The board is empty', 'No one has suggested anything yet. Yours could be the first idea on it.', ctx.user ? html`<a class="btn btn-primary" href="#suggest">Make the first suggestion</a>` : html`<a class="btn btn-primary" href="/register?next=/suggestions">Create an account to post</a>`)
        : empty('Nothing here', html`No suggestions are ${d.status ? STATUS_LABEL[d.status].toLowerCase() : 'listed'} right now. <a href="/suggestions">See them all</a>.`)}
  </div>
  <aside class="sugg-side">
    <section class="panel" id="suggest" aria-labelledby="sg-h">
      <div class="panel-head"><h2 id="sg-h">Suggest something</h2></div>
      ${ctx.user
        ? html`<form method="post" action="/suggestions" class="stack">
            ${csrfField(ctx)}
            <label for="sg-title">Idea, in a line</label>
            <input id="sg-title" name="title" maxlength="120" required value="${d.draft?.title ?? ''}" placeholder="e.g. Let me name my ships">
            <label for="sg-body">Why, and how it might work <span class="dim">(optional)</span></label>
            <textarea id="sg-body" name="body" rows="5" maxlength="2000">${d.draft?.body ?? ''}</textarea>
            ${d.error ? html`<p class="form-error" role="alert">${d.error}</p>` : ''}
            <button class="btn btn-primary" type="submit">Post suggestion</button>
            <p class="dim small">Check the list first: a vote on an existing idea counts for more than a duplicate.</p>
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

export function pilotCard(card: PilotCard | null, name: string, opts: { own: boolean }): SafeHtml {
  if (!card) {
    return html`<section class="pilot-card panel no-data">
      <div class="pc-id"><span class="pc-badge">?</span><div><p class="eyebrow">Pilot</p><h2>${name}</h2></div></div>
      ${empty('No flight record yet', opts.own ? 'Your pilot card fills in once you have flown. Your level, ship and tallies show up here.' : `${name} hasn't flown yet, or the record isn't on this server.`, opts.own ? html`<a class="btn-play" href="/play">Play now</a>` : undefined)}
    </section>`;
  }
  const s = card.stats;
  const tally: [string, number][] = [['Hostiles destroyed', s.kills], ['Boss kills', s.bosses], ['Jobs done', s.quests], ['Ore mined', s.mined], ['Credits earned', s.earned], ['Systems visited', card.systemsVisited]];
  return html`<section class="pilot-card panel">
  <div class="pc-id">
    <span class="pc-badge" aria-label="Level ${card.level}"><small>LVL</small>${card.level}</span>
    <div><p class="eyebrow">Pilot</p><h2>${name}</h2>
      <p class="dim">${card.shipName ? html`Flying the <b class="ship">${card.shipName}</b>` : 'No ship on record'}${card.ships > 1 ? ` · ${card.ships} ships in the hangar` : ''}</p></div>
  </div>
  <dl class="pc-stats">${tally.map(([k, v]) => html`<div><dt>${k}</dt><dd>${fmtNum(v)}</dd></div>`)}</dl>
  <p class="pc-foot dim small">${card.ribbons ? html`${card.ribbons} ${card.ribbons === 1 ? 'ribbon' : 'ribbons'} · ` : ''}${card.codexFound ? html`${card.codexFound} codex records · ` : ''}${card.since ? html`Pilot since ${fmtDate(card.since)}` : ''}${card.lastFlown ? html` · last flew ${when(card.lastFlown)}` : ''}${opts.own ? html` · ${fmtNum(card.credits)} credits` : ''}</p>
</section>`;
}

export function pilotsPage(ctx: PageCtx, d: { rankings: Rankings | null; period: 'weekly' | 'allTime' }): SafeHtml {
  const boards = d.rankings?.[d.period];
  const any = boards && Object.values(boards).some((b) => b.length);
  const body = html`
<section class="page-head wrap">
  <p class="eyebrow">Leaderboards</p>
  <h1>Pilots</h1>
  <p class="lede">The game's own boards, refreshed as pilots fly. Weekly boards start again each week.</p>
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
    ? html`<div class="boards">${BOARDS.map((b) => {
        const rows = boards![b.key] ?? [];
        return html`<section class="board panel" aria-label="${b.label}">
          <div class="panel-head"><h2>${b.label}</h2></div>
          ${rows.length
            ? html`<ol class="rank-list">${rows.map((r, i) => html`<li class="${i < 3 ? `top top-${i + 1}` : ''}"><span class="rk">${i + 1}</span><a href="/pilots/${encodeURIComponent(r.name)}">${r.name}</a><span class="val">${fmtNum(r.value)}${b.unit ? html` <small>${b.unit}</small>` : ''}</span></li>`)}</ol>`
            : html`<p class="dim small">No one yet.</p>`}
        </section>`;
      })}</div>`
    : empty('The boards are empty', d.period === 'weekly' ? 'No one has scored this week yet.' : 'No pilot has made the boards yet. Fly a little and yours could be the first name here.', html`<a class="btn-play" href="/play">Play now</a>`)}
</section>`;
  return layout(ctx, { title: 'Pilots', body });
}

export function pilotPage(ctx: PageCtx, d: { name: string; card: PilotCard | null; ranks: { label: string; rank: number; value: number }[] }): SafeHtml {
  const body = html`
<section class="wrap block-tight narrow-col">
  <p class="meta"><a href="/pilots">Pilots</a> <span class="sep">/</span> ${d.name}</p>
  ${pilotCard(d.card, d.name, { own: ctx.user?.username.toLowerCase() === d.name.toLowerCase() })}
  ${d.ranks.length ? html`<section class="panel"><div class="panel-head"><h2>On the boards</h2></div><ul class="rank-places">${d.ranks.map((r) => html`<li><span class="rk">#${r.rank}</span> ${r.label} <span class="val">${fmtNum(r.value)}</span></li>`)}</ul></section>` : ''}
</section>`;
  return layout(ctx, { title: d.name, body });
}

export function notFoundPage(ctx: PageCtx, what = 'page'): SafeHtml {
  const body = html`<section class="wrap block narrow-col">${empty(`No such ${what}`, html`It may have moved, or never existed. <a href="/">Back to the start</a>.`)}</section>`;
  return layout(ctx, { title: 'Not found', body });
}

export function errorPage(ctx: PageCtx, title: string, text: string): SafeHtml {
  return layout(ctx, { title, body: html`<section class="wrap block narrow-col">${empty(title, text, html`<a class="btn" href="/">Back to the start</a>`)}</section>` });
}

// ---------------------------------------------------------------- sign in, register

export function signInPage(ctx: PageCtx, d: { mode: 'signin' | 'register'; next: string; error?: string; username?: string; email?: string }): SafeHtml {
  const reg = d.mode === 'register';
  const nextQ = d.next !== '/' ? `?next=${encodeURIComponent(d.next)}` : '';
  const body = html`
<section class="auth wrap">
  <div class="auth-art" aria-hidden="true"><img src="/static/img/sparrow.webp" alt=""></div>
  <div class="auth-panel panel">
    <p class="eyebrow">${reg ? 'New pilot' : 'Welcome back'}</p>
    <h1>${reg ? 'Create an account' : 'Sign in'}</h1>
    <p class="dim">${reg ? 'One account for the site and the game. Your pilot, ship and progress are kept with it.' : 'The same account you use in the game.'}</p>
    <form method="post" action="/${reg ? 'register' : 'signin'}" class="stack">
      ${csrfField(ctx)}
      <input type="hidden" name="next" value="${d.next}">
      <label for="u">${reg ? 'Pilot name' : 'Pilot name or email'}</label>
      <input id="u" name="username" required autocomplete="username" maxlength="${reg ? 20 : 254}" value="${d.username ?? ''}" ${reg ? raw('pattern="[A-Za-z0-9_\\-]{2,20}" title="2 to 20 letters, numbers, _ or -"') : ''} autofocus>
      ${reg ? html`<p class="hint">2 to 20 letters, numbers, _ or -. Other pilots see it.</p>
      <label for="e">Email</label>
      <input id="e" name="email" type="email" required autocomplete="email" maxlength="254" value="${d.email ?? ''}">
      <p class="hint">Only for your account. Never shown to anyone.</p>` : ''}
      <label for="p">Password</label>
      <input id="p" name="password" type="password" required autocomplete="${reg ? 'new-password' : 'current-password'}" maxlength="200">
      ${d.error ? html`<p class="form-error" role="alert">${d.error}</p>` : ''}
      <button class="btn btn-primary btn-wide" type="submit">${reg ? 'Create account' : 'Sign in'}</button>
    </form>
    <p class="auth-switch">${reg ? html`Already flying? <a href="/signin${nextQ}">Sign in</a>` : html`New here? <a href="/register${nextQ}">Create an account</a>`}</p>
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
  <p class="eyebrow">Your account</p>
  <h1>${a.username}</h1>
  <p class="lede">Pilot since ${fmtDate(a.createdAt)}${a.isAdmin ? html` · <span class="gold">admin</span>` : ''}. <a href="/pilots/${encodeURIComponent(a.username)}">Your public profile</a></p>
</section>
<section class="wrap block-tight account-grid">
  <div class="account-main">
    ${pilotCard(d.card, a.username, { own: true })}
    <div class="panel-row">
      <a class="btn-play" href="/play">Play now</a>
      <span class="dim small">You're signed in here, so the game opens without asking again.</span>
    </div>
  </div>
  <div class="account-forms">
    <section class="panel" aria-labelledby="em-h">
      <div class="panel-head"><h2 id="em-h">Email</h2></div>
      <p class="dim small">Currently <b class="mono">${a.email}</b></p>
      <form method="post" action="/account/email" class="stack">
        ${csrfField(ctx)}
        <label for="em">New email</label><input id="em" name="email" type="email" required maxlength="254" autocomplete="email">
        <label for="em-p">Your password</label><input id="em-p" name="password" type="password" required autocomplete="current-password">
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
        <p class="hint">Signs you out everywhere else (the game included); this browser stays signed in.</p>
      </form>
    </section>
    <section class="panel" aria-labelledby="ev-h">
      <div class="panel-head"><h2 id="ev-h">Sessions</h2></div>
      <form method="post" action="/account/signout-all" class="stack">
        ${csrfField(ctx)}
        <p class="dim small">Lost a device, or signed in somewhere shared? End every session on this account, in the game and on the site.</p>
        ${err('everywhere')}
        <button class="btn" type="submit">Sign out everywhere</button>
      </form>
      <form method="post" action="/signout" class="stack top-gap">${csrfField(ctx)}<button class="btn btn-ghost" type="submit">Sign out of this browser</button></form>
    </section>
    <section class="panel danger" aria-labelledby="del-h">
      <div class="panel-head"><h2 id="del-h">Delete account</h2></div>
      <details${d.errors.delete ? raw(' open') : ''}>
        <summary>Delete this account for good</summary>
        <form method="post" action="/account/delete" class="stack" data-confirm-delete="${a.username}">
          ${csrfField(ctx)}
          <p class="small">This removes your account, your pilot and everything they own. It can't be undone. Your comments and suggestions stay, signed as "a former pilot"; your shouts and votes go.</p>
          <label for="del-n">Type your pilot name, <b class="mono">${a.username}</b>, to confirm</label>
          <input id="del-n" name="confirm" required autocomplete="off" data-confirm-input>
          <label for="del-p">Your password</label><input id="del-p" name="password" type="password" required autocomplete="current-password">
          ${err('delete')}
          <button class="btn btn-danger" type="submit" data-confirm-button>Delete my account</button>
        </form>
      </details>
    </section>
  </div>
</section>`;
  return layout(ctx, { title: 'Account', body });
}
