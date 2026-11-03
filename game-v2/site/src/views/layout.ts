/** The page shell and the small pieces every page shares */

import { html, raw, SafeHtml } from '../html.js';
import type { LobbyUser } from '../lobby.js';
import type { SuggestionStatus } from '../store/types.js';

export interface PageCtx {
  siteName: string;
  user: LobbyUser | null;
  csrf: string;
  /** Path of this page (nav highlight, sign-in return) */
  path: string;
  live: { players: number; fresh: boolean } | null;
  origin: string;
  /** A fixed note after a redirect (?ok=...) */
  notice?: { kind: 'ok' | 'error'; text: string } | null;
}

export interface PageOpts {
  title: string;
  body: SafeHtml;
  description?: string;
  image?: string | null;
  /** Extra class on <body> */
  bodyClass?: string;
  /** Status note at the top (fixed messages only, never echoed input) */
  notice?: { kind: 'ok' | 'error'; text: string } | null;
  feed?: boolean;
}

const NAV: [string, string][] = [['/updates', 'Updates'], ['/suggestions', 'Suggestions'], ['/pilots', 'Pilots']];

/** The ship mark beside the wordmark: a small arrowhead hull with a lit core */
export const MARK = raw(`<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2 27 26l-11-5-11 5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M16 11v7" stroke="var(--gold)" stroke-width="3" stroke-linecap="round"/></svg>`);

export function csrfField(ctx: PageCtx): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${ctx.csrf}">`;
}

export function livePill(live: PageCtx['live'], big = false): SafeHtml {
  const n = live?.fresh ? live.players : 0;
  const state = !live?.fresh ? 'offline' : n > 0 ? 'on' : 'idle';
  const text = !live?.fresh ? 'Server offline' : `${n} ${n === 1 ? 'pilot' : 'pilots'} online`;
  return html`<span class="live live-${state}${big ? ' live-big' : ''}" data-live aria-live="polite"><i aria-hidden="true"></i><span data-live-text>${text}</span></span>`;
}

export function layout(ctx: PageCtx, p: PageOpts): SafeHtml {
  const title = p.title ? `${p.title} · ${ctx.siteName}` : ctx.siteName;
  const here = (href: string) => ctx.path === href || ctx.path.startsWith(href + '/');
  const nav = [...NAV, ...(ctx.user?.isAdmin ? [['/admin', 'Admin'] as [string, string]] : [])];
  const next = encodeURIComponent(ctx.path);
  const notice = p.notice ?? ctx.notice;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${p.description ?? `${ctx.siteName}: a space game about building ships.`}">
<meta name="csrf-token" content="${ctx.csrf}">
<meta name="color-scheme" content="dark">
<meta property="og:title" content="${p.title || ctx.siteName}">
<meta property="og:site_name" content="${ctx.siteName}">
${p.image ? html`<meta property="og:image" content="${p.image.startsWith('/') ? ctx.origin + p.image : p.image}">` : ''}
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/rss+xml" title="${ctx.siteName} updates" href="/rss.xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/static/site.css?v=2">
<script src="/static/site.js?v=2" defer></script>
</head>
<body class="${p.bodyClass ?? ''}">
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="top-in">
    <a class="brand" href="/" aria-label="${ctx.siteName}, home">${MARK}<span class="word">${ctx.siteName}</span></a>
    <input type="checkbox" id="navtoggle" class="navtoggle" aria-hidden="true" tabindex="-1">
    <label for="navtoggle" class="navbtn" aria-label="Menu"><span></span></label>
    <nav class="nav" aria-label="Main">
      ${nav.map(([href, label]) => html`<a href="${href}"${here(href) ? raw(' aria-current="page"') : ''}>${label}</a>`)}
    </nav>
    <div class="top-right">
      ${livePill(ctx.live)}
      ${ctx.user
        ? html`<a class="who" href="/account"${here('/account') ? raw(' aria-current="page"') : ''}><span class="who-dot" aria-hidden="true">${ctx.user.username.slice(0, 1).toUpperCase()}</span><span class="who-name">${ctx.user.username}</span></a>`
        : html`<a class="signin" href="/signin?next=${next}">Sign in</a>`}
      <a class="btn-play btn-play-sm" href="/play">Play</a>
    </div>
  </div>
</header>
${notice ? html`<div class="notice notice-${notice.kind}" role="${notice.kind === 'error' ? 'alert' : 'status'}"><div class="wrap">${notice.text}</div></div>` : ''}
<main id="main">
${p.body}
</main>
<footer class="foot">
  <div class="wrap foot-in">
    <div class="foot-brand">${MARK}<span>${ctx.siteName}</span><span class="dim">in development</span></div>
    <nav class="foot-nav" aria-label="Footer">
      <a href="/updates">Updates</a><a href="/suggestions">Suggestions</a><a href="/pilots">Pilots</a><a href="/rss.xml">RSS</a>
      ${ctx.user ? html`<a href="/account">Account</a>` : html`<a href="/register">Create an account</a>`}
    </nav>
  </div>
</footer>
</body>
</html>`;
}

// ---------------------------------------------------------------- pieces

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} ${d === 1 ? 'day' : 'days'} ago`;
  return fmtDate(iso);
}

/** A <time> the page's script keeps relative ("3 min ago") */
export function when(iso: string, relative = true): SafeHtml {
  return html`<time datetime="${iso}"${relative ? raw(' data-rel') : ''} title="${new Date(iso).toUTCString()}">${relative ? timeAgo(iso) : fmtDate(iso)}</time>`;
}

export function tagChip(tag: string, active = false): SafeHtml {
  return html`<a class="tag${active ? ' on' : ''}" href="/updates?tag=${encodeURIComponent(tag)}">${tag}</a>`;
}

export const STATUS_LABEL: Record<SuggestionStatus, string> = {
  open: 'Open', planned: 'Planned', in_progress: 'In progress', done: 'Done', declined: 'Declined',
};

export function statusBadge(s: SuggestionStatus): SafeHtml {
  return html`<span class="status status-${s}">${STATUS_LABEL[s]}</span>`;
}

/** An empty state: a line of what's missing, and what to do about it */
export function empty(title: string, text: string | SafeHtml, action?: SafeHtml): SafeHtml {
  return html`<div class="empty"><div class="empty-scope" aria-hidden="true"><i></i><i></i><i></i></div><h3>${title}</h3><p>${text}</p>${action ?? ''}</div>`;
}

export function sectionHead(label: string, title: string | SafeHtml, extra?: SafeHtml): SafeHtml {
  return html`<div class="sec-head"><div><p class="eyebrow">${label}</p><h2>${title}</h2></div>${extra ?? ''}</div>`;
}

export function fmtNum(n: number): string {
  return Math.round(n).toLocaleString('en-GB');
}

export function signInPrompt(ctx: PageCtx, what: string): SafeHtml {
  const next = encodeURIComponent(ctx.path);
  return html`<p class="signin-prompt"><a href="/signin?next=${next}">Sign in</a> or <a href="/register?next=${next}">create an account</a> ${what}</p>`;
}
