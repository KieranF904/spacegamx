/** Checking what's sent for a post (the admin editor and the API share it) */

import { normaliseTag, parseList, slugify } from './frontmatter.js';
import { safeUrl } from './markdown.js';
import type { PostPatch, PostStatus } from './store/types.js';

export const LIMITS = { title: 140, summary: 300, body: 100_000, tags: 8, slug: 80, cover: 300 };

export type PostFields = Required<Pick<PostPatch, 'title' | 'body' | 'slug' | 'summary' | 'tags' | 'cover' | 'status'>>;

const s = (v: unknown) => (typeof v === 'string' ? v : '');

function tagsFrom(v: unknown): string[] {
  const list = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? parseList(v) : [];
  return [...new Set(list.map(normaliseTag).filter(Boolean))].slice(0, LIMITS.tags);
}

function statusFrom(v: unknown): PostStatus | null {
  const t = s(v).toLowerCase();
  if (t === 'draft') return 'draft';
  if (t === 'published' || t === 'publish') return 'published';
  return null;
}

/**
 * A whole post (create): every field checked and tidied, or the first problem.
 * `partial`: only the fields given (an update); absent ones stay as they are.
 */
export function checkPost(input: Record<string, unknown>, partial: false): { ok: true; value: PostFields } | { ok: false; error: string };
export function checkPost(input: Record<string, unknown>, partial: true): { ok: true; value: PostPatch } | { ok: false; error: string };
export function checkPost(input: Record<string, unknown>, partial: boolean): { ok: true; value: PostPatch } | { ok: false; error: string } {
  const out: PostPatch = {};
  const has = (k: string) => input[k] !== undefined && input[k] !== null;

  if (!partial || has('title')) {
    const title = s(input.title).replace(/\s+/g, ' ').trim();
    if (!title) return { ok: false, error: 'A post needs a title' };
    if (title.length > LIMITS.title) return { ok: false, error: `Titles can be ${LIMITS.title} characters at most` };
    out.title = title;
  }
  if (!partial || has('body')) {
    const body = s(input.body).replace(/\r\n/g, '\n').trim();
    if (!body) return { ok: false, error: 'A post needs some text' };
    if (body.length > LIMITS.body) return { ok: false, error: 'That post is too long' };
    out.body = body;
  }
  if (!partial || has('slug')) {
    const raw = s(input.slug).trim();
    const slug = raw ? slugify(raw) : out.title ? slugify(out.title) : '';
    if (partial && !slug) return { ok: false, error: 'A slug needs letters or numbers' };
    out.slug = slug;
  }
  if (!partial || has('summary')) out.summary = s(input.summary).replace(/\s+/g, ' ').trim().slice(0, LIMITS.summary);
  if (!partial || has('tags')) out.tags = tagsFrom(input.tags);
  if (!partial || has('cover')) {
    const cover = s(input.cover).trim();
    if (cover && (cover.length > LIMITS.cover || !safeUrl(cover, 'image'))) return { ok: false, error: 'The cover must be an http(s) URL or a path on this site' };
    out.cover = cover || null;
  }
  if (!partial || has('status')) {
    const st = has('status') ? statusFrom(input.status) : 'draft';
    if (!st) return { ok: false, error: 'Status is draft or published' };
    out.status = st;
  }
  return { ok: true, value: out };
}
