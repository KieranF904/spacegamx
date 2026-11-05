/**
 * Front matter for posts written as files (the post-update CLI):
 *
 *   ---
 *   title: Wires, mounts and a new way to fly
 *   tags: [parts, ships]        (or: tags: parts, ships)
 *   status: published           (or draft; also `draft: true` / `publish: true`)
 *   slug: wires-and-mounts      (optional: from the file name otherwise)
 *   summary: One line for lists (optional: the first paragraph otherwise)
 *   cover: ./images/hero.png    (optional: the first image otherwise)
 *   ---
 *   The Markdown body...
 *
 * A small YAML subset: `key: value` lines, quoted or not, and [a, b] lists.
 */

export interface FrontMatter {
  title?: string;
  tags?: string[];
  status?: 'draft' | 'published';
  slug?: string;
  summary?: string;
  cover?: string;
  [key: string]: unknown;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

export function parseList(v: string): string[] {
  const t = v.trim().replace(/^\[/, '').replace(/\]$/, '');
  return t.split(',').map(unquote).map((s) => s.trim()).filter(Boolean);
}

const yes = (v: string) => /^(true|yes|on)$/i.test(v.trim());
const no = (v: string) => /^(false|no|off)$/i.test(v.trim());

export function parseFrontMatter(text: string): { meta: FrontMatter; body: string } {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(\n|$)/.exec(src);
  if (!m) return { meta: {}, body: src.trim() };
  const meta: FrontMatter = {};
  for (const line of m[1].split('\n')) {
    const kv = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2];
    if (key === 'tags') meta.tags = [...new Set(parseList(value).map(normaliseTag).filter(Boolean))];
    else if (key === 'draft') { if (yes(value)) meta.status = 'draft'; else if (no(value)) meta.status = 'published'; }
    else if (key === 'publish' || key === 'published') { if (yes(value)) meta.status = 'published'; else if (no(value)) meta.status = 'draft'; }
    else if (key === 'status') {
      const s = unquote(value).toLowerCase();
      if (s === 'draft') meta.status = 'draft';
      else if (s === 'published' || s === 'publish' || s === 'live') meta.status = 'published';
    } else meta[key] = unquote(value);
  }
  return { meta, body: src.slice(m[0].length).trim() };
}

export function normaliseTag(t: string): string {
  return t.toLowerCase().trim().replace(/[^a-z0-9 -]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 24);
}

/** A URL slug from a title or file name */
export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '') || 'post';
}
