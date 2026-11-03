/**
 * Post updates to the website from the terminal.
 *
 *   npm run post-update -- path/to/post.md            post it (front matter decides draft or published)
 *   npm run post-update -- post.md --publish          ...published, whatever the front matter says
 *   npm run post-update -- post.md --draft            ...as a draft
 *   npm run post-update -- post.md --dry-run          check it and show what would be sent; send nothing
 *   npm run post-update -- --list                     every post, drafts too
 *   npm run post-update -- --publish-slug <slug>      publish a draft;  --unpublish <slug>;  --delete <slug>
 *   npm run post-update -- --whoami                   check the token
 *   npm run post-update -- --save-token sgs_...       keep a token for this machine (~/.config/spacegame/site-token)
 *
 * Re-running a file updates its post (matched by slug): fix a typo and run it
 * again. Local images (![alt](./shot.png), and `cover: ./hero.png`) are
 * uploaded and their links rewritten; the same image uploads to the same URL.
 *
 * Front matter:
 *   ---
 *   title: Wires, mounts and the helm camera
 *   tags: [ships, parts]
 *   status: draft | published     (or draft: true / publish: true; default draft)
 *   slug: wires-and-mounts        (default: the file name)
 *   summary: One line for the list (default: the first paragraph)
 *   cover: ./images/hero.webp     (default: the first image)
 *   ---
 *
 * Site and credentials:
 *   --site <url> or SITE_URL       (default http://localhost:5310)
 *   SITE_TOKEN=sgs_...             an API token from /admin/tokens (or one saved with --save-token)
 *   SITE_USER + SITE_PASSWORD      or an admin's own sign-in, for this run only; --login asks for them
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { parseFrontMatter, slugify } from '../src/frontmatter.js';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const OPTS_WITH_VALUES = new Set(['--site', '--publish-slug', '--unpublish', '--delete', '--save-token']);
const positional = argv.filter((a, i) => !a.startsWith('--') && !OPTS_WITH_VALUES.has(argv[i - 1] ?? ''));

const SITE = (opt('site') || process.env.SITE_URL || 'http://localhost:5310').replace(/\/$/, '');
const TOKEN_FILE = path.join(os.homedir(), '.config', 'spacegame', 'site-token');
const c = { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, ok: (s: string) => `\x1b[32m${s}\x1b[0m`, warn: (s: string) => `\x1b[33m${s}\x1b[0m`, bad: (s: string) => `\x1b[31m${s}\x1b[0m`, b: (s: string) => `\x1b[1m${s}\x1b[0m` };

/** Stop with a message (thrown, not process.exit: exiting with a fetch socket still closing trips libuv on Windows) */
class Die extends Error {}
function die(msg: string): never { throw new Die(msg); }

function usage(): never {
  console.log(`Post updates to ${SITE}

  npm run post-update -- <post.md> [--publish | --draft] [--dry-run]
  npm run post-update -- --list | --whoami
  npm run post-update -- --publish-slug <slug> | --unpublish <slug> | --delete <slug>
  npm run post-update -- --save-token <sgs_...>

Auth: SITE_TOKEN, a saved token, or SITE_USER/SITE_PASSWORD (--login to be asked).
Site: --site <url> or SITE_URL (default http://localhost:5310). See DEVELOPMENT.md, "Website".`);
  process.exit(0);
}

// ---------------------------------------------------------------- auth

let bearer = '';
let signedIn = false; // a lobby session made for this run (ended at the end)

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
      out._writeToOutput = (s: string) => { if (s.includes(question)) process.stdout.write(s); else if (s === '\r\n' || s === '\n') process.stdout.write(s); };
    }
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
  });
}

async function auth(): Promise<void> {
  if (process.env.SITE_TOKEN) { bearer = process.env.SITE_TOKEN.trim(); return; }
  if (!flag('login') && !process.env.SITE_USER) {
    try { bearer = (await fs.readFile(TOKEN_FILE, 'utf-8')).trim(); if (bearer) return; } catch { /* none saved */ }
  }
  let user = process.env.SITE_USER ?? '';
  let password = process.env.SITE_PASSWORD ?? '';
  if (!user || !password) {
    if (!process.stdin.isTTY) die(`No credentials. Set SITE_TOKEN (make one at ${SITE}/admin/tokens), or SITE_USER and SITE_PASSWORD.`);
    console.log(c.dim(`No API token found: sign in as an admin of ${SITE} for this run.`));
    user ||= await ask('Admin name: ');
    password ||= await ask('Password: ', true);
  }
  const r = await call('POST', '/api/v1/session', { username: user, password }, false);
  if (r.status !== 200) die(`Sign-in refused: ${r.body.error ?? r.status}`);
  bearer = r.body.token;
  signedIn = true;
}

async function endSession(): Promise<void> {
  if (signedIn) await call('DELETE', '/api/v1/session', undefined).catch(() => undefined);
}

async function call(method: string, p: string, body?: unknown, authed = true, raw?: { buf: Buffer; type: string }): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (authed && bearer) headers.Authorization = `Bearer ${bearer}`;
  if (raw) headers['Content-Type'] = raw.type;
  else if (body !== undefined) headers['Content-Type'] = 'application/json';
  let r: Response;
  try {
    r = await fetch(`${SITE}${p}`, { method, headers, body: raw ? new Uint8Array(raw.buf) : body !== undefined ? JSON.stringify(body) : undefined });
  } catch (e) {
    die(`Can't reach ${SITE} (${(e as Error).message}). Is the site running? (cd game-v2/site && npm run dev)`);
  }
  let parsed: any = {};
  try { parsed = await r.json(); } catch { /* not JSON */ }
  if (r.status === 401 && authed) die(`${parsed.error ?? 'Not authorised'}. Check SITE_TOKEN (or make a token at ${SITE}/admin/tokens).`);
  return { status: r.status, body: parsed };
}

// ---------------------------------------------------------------- images

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

function isLocal(url: string): boolean {
  return !!url && !/^(https?:|mailto:|data:|#|\/)/i.test(url);
}

async function upload(file: string, dry: boolean): Promise<string> {
  const ext = path.extname(file).toLowerCase();
  const type = IMAGE_TYPES[ext];
  if (!type) die(`${file}: only PNG, JPEG, GIF and WebP images can be uploaded`);
  let buf: Buffer;
  try { buf = await fs.readFile(file); } catch { die(`Image not found: ${file}`); }
  if (dry) { console.log(c.dim(`  would upload ${path.relative(process.cwd(), file)} (${Math.round(buf.length / 1024)} KB)`)); return `/uploads/(dry-run)/${path.basename(file)}`; }
  let r = await call('POST', '/api/v1/uploads', undefined, true, { buf, type });
  // The site allows 30 uploads a minute; a post with more images waits out the window and carries on
  for (let tries = 0; r.status === 429 && tries < 3; tries++) {
    console.log(c.dim('  upload limit reached, waiting 60 s'));
    await new Promise((res) => setTimeout(res, 61_000));
    r = await call('POST', '/api/v1/uploads', undefined, true, { buf, type });
  }
  if (r.status !== 201) die(`Upload of ${file} failed: ${r.body.error ?? r.status}`);
  console.log(c.dim(`  ↑ ${path.relative(process.cwd(), file)} → ${r.body.url}`));
  return r.body.url;
}

// ---------------------------------------------------------------- commands

async function postFile(file: string): Promise<void> {
  const dry = flag('dry-run');
  const abs = path.resolve(file);
  let text: string;
  try { text = await fs.readFile(abs, 'utf-8'); } catch { die(`No such file: ${file}`); }
  const { meta, body: rawBody } = parseFrontMatter(text);
  const dir = path.dirname(abs);
  if (!meta.title) die(`${file}: add a title in the front matter (---\\ntitle: ...\\n---)`);
  if (!rawBody) die(`${file}: the post has no text`);

  // Local images: upload each once, rewrite the links
  const done = new Map<string, string>();
  let body = rawBody;
  const refs = [...rawBody.matchAll(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?((?:\s+"[^"]*")?)\s*\)/g)];
  for (const m of refs) {
    const url = m[2];
    if (!isLocal(url)) continue;
    if (!done.has(url)) done.set(url, await upload(path.resolve(dir, decodeURIComponent(url)), dry));
  }
  if (done.size) body = body.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?((?:\s+"[^"]*")?)\s*\)/g, (all, alt, url, title) => (done.has(url) ? `![${alt}](${done.get(url)}${title})` : all));
  let cover = typeof meta.cover === 'string' ? meta.cover : '';
  if (cover && isLocal(cover)) cover = done.get(cover) ?? await upload(path.resolve(dir, cover), dry);

  const status = flag('publish') ? 'published' : flag('draft') ? 'draft' : meta.status ?? 'draft';
  const payload = {
    title: meta.title,
    slug: typeof meta.slug === 'string' && meta.slug ? meta.slug : slugify(path.basename(file, path.extname(file)).replace(/^\d+[-_]/, '')), // (02-name.md: name)
    tags: meta.tags ?? [],
    summary: typeof meta.summary === 'string' ? meta.summary : '',
    cover,
    status,
    body,
  };
  if (dry) {
    console.log(c.b(`Dry run: would post "${payload.title}"`));
    console.log(`  slug    ${payload.slug}\n  status  ${status}\n  tags    ${payload.tags.join(', ') || c.dim('(none)')}\n  images  ${done.size}\n  length  ${body.length} chars`);
    return;
  }
  const r = await call('POST', '/api/v1/posts', payload);
  if (r.status !== 200 && r.status !== 201) die(`The site refused it: ${r.body.error ?? r.status}`);
  const p = r.body.post;
  const verb = r.body.created ? 'Created' : 'Updated';
  console.log(`${c.ok('✓')} ${verb} ${c.b(`"${p.title}"`)} ${p.status === 'published' ? c.ok('published') : c.warn('draft')}`);
  console.log(`  ${p.url}`);
  if (p.status === 'draft') console.log(c.dim(`  (a draft: only admins see it. Publish with --publish, or: npm run post-update -- --publish-slug ${p.slug})`));
}

async function list(): Promise<void> {
  const r = await call('GET', '/api/v1/posts?status=all');
  if (r.status !== 200) die(r.body.error ?? String(r.status));
  if (!r.body.posts.length) { console.log(c.dim('No posts yet.')); return; }
  for (const p of r.body.posts) {
    const when = (p.publishedAt ?? p.updatedAt).slice(0, 10);
    console.log(`${p.status === 'published' ? c.ok('●') : c.warn('○')} ${when}  ${c.b(p.title)}  ${c.dim(p.slug)}${p.tags.length ? c.dim(`  [${p.tags.join(', ')}]`) : ''}`);
  }
}

async function setStatus(slug: string, status: 'published' | 'draft'): Promise<void> {
  const r = await call('PATCH', `/api/v1/posts/${encodeURIComponent(slug)}`, { status });
  if (r.status !== 200) die(r.body.error ?? String(r.status));
  console.log(`${c.ok('✓')} ${r.body.post.title}: ${status}\n  ${r.body.post.url}`);
}

async function remove(slug: string): Promise<void> {
  if (process.stdin.isTTY && !flag('yes')) {
    const a = await ask(`Delete "${slug}" and its comments for good? (y/N) `);
    if (!/^y/i.test(a)) { console.log('Kept.'); return; }
  }
  const r = await call('DELETE', `/api/v1/posts/${encodeURIComponent(slug)}`);
  if (r.status !== 200) die(r.body.error ?? String(r.status));
  console.log(`${c.ok('✓')} Deleted ${slug}`);
}

async function main(): Promise<void> {
  if (flag('help') || flag('h') || (!positional.length && !['list', 'whoami', 'publish-slug', 'unpublish', 'delete', 'save-token'].some(flag))) usage();
  const save = opt('save-token');
  if (flag('save-token')) {
    if (!save?.startsWith('sgs_')) die('That doesn\'t look like a site API token (they start sgs_)');
    await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
    await fs.writeFile(TOKEN_FILE, save + '\n', { mode: 0o600 });
    bearer = save;
    const r = await call('GET', '/api/v1/me');
    console.log(`${c.ok('✓')} Saved to ${TOKEN_FILE}${r.status === 200 ? ` (acts as ${r.body.name} on ${SITE})` : ''}`);
    return;
  }
  if (flag('dry-run') && positional.length) { for (const f of positional) await postFile(f); return; }
  await auth();
  try {
    if (flag('whoami')) { const r = await call('GET', '/api/v1/me'); console.log(`${c.ok('✓')} ${r.body.name} on ${SITE} (${r.body.via})`); }
    else if (flag('list')) await list();
    else if (opt('publish-slug')) await setStatus(opt('publish-slug')!, 'published');
    else if (opt('unpublish')) await setStatus(opt('unpublish')!, 'draft');
    else if (opt('delete')) await remove(opt('delete')!);
    else for (const f of positional) await postFile(f);
  } finally { await endSession(); }
}

try {
  await main();
} catch (e) {
  if (!(e instanceof Die)) throw e;
  console.error(c.bad(`✗ ${e.message}`));
  process.exitCode = 1;
}
