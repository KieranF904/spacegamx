/**
 * The "What's new" feed for the game's menu: published posts as small JSON items.
 *
 *   GET /api/v1/changelog[?since=<iso>][&tag=<tag>][&limit=<1-50>]
 *
 * Public and cached; nothing in it is private (it is the updates list). `since` returns only posts published after
 * that time, which is how the game counts unread ones. `tag` narrows to a tag, for example "game", if some posts
 * are meant for the menu and others only for the site. Drafts never appear.
 */

import { coverOf, summaryOf } from './views/pages.js';
import type { Post } from './store/types.js';

export interface ChangelogItem {
  slug: string;
  title: string;
  summary: string;
  publishedAt: string;
  url: string;
  /** An absolute image URL, or null */
  cover: string | null;
  tags: string[];
}

export interface ChangelogOpts { origin: string; since?: string | null; tag?: string | null; limit?: number }

const absolute = (origin: string, u: string | null) => (u ? (u.startsWith('/') ? origin + u : u) : null);

export function changelogItems(posts: Post[], o: ChangelogOpts): ChangelogItem[] {
  const since = o.since ? Date.parse(o.since) : NaN;
  const limit = Math.max(1, Math.min(50, o.limit ?? 20));
  return posts
    .filter((p) => p.status === 'published' && p.publishedAt)
    .filter((p) => (Number.isNaN(since) ? true : Date.parse(p.publishedAt!) > since))
    .filter((p) => !o.tag || p.tags.includes(o.tag))
    .sort((a, b) => b.publishedAt!.localeCompare(a.publishedAt!))
    .slice(0, limit)
    .map((p) => ({
      slug: p.slug, title: p.title, summary: summaryOf(p, 200), publishedAt: p.publishedAt!,
      url: `${o.origin}/updates/${encodeURIComponent(p.slug)}`, cover: absolute(o.origin, coverOf(p)), tags: p.tags,
    }));
}
