/**
 * The site's settings, from the environment (defaults are for local dev).
 *
 *   SITE_PORT            5310
 *   SITE_HOST            127.0.0.1 (bind address; nginx in front in production)
 *   SITE_ORIGIN          http://localhost:5310 (public origin: RSS links, Origin checks; production: required, https)
 *   SITE_NAME            Space Game
 *   SITE_SECRET          CSRF key (production: required, 32+ characters; dev: random each start)
 *   SITE_DATA_DIR        ../data/site   (site.json, uploads/)
 *   SITE_PROFILES_DIR    ../data/profiles  (read-only)
 *   SITE_STATUS_FILE     ../data/status/live.json  (read-only)
 *   SITE_GUIDES_DIR      ./guides  (the guides: Markdown files)
 *   SITE_GUIDES          0 (the guides are hidden: no nav link, their pages 404; 1 shows them again)
 *   SITE_CATALOG_FILE    ../data/catalog/catalog.json  (the game's own catalog, if it writes one; else site/catalog/catalog.json)
 *   SITE_AUTHORS         admin=Kieran  (the name shown on a post by an account: account=Name, comma separated)
 *   SITE_GAME_KEY        (a long secret the game server sends to share ships: Authorization: Bearer; unset = sharing is off)
 *   SITE_TRUST_PROXY     1 behind nginx: the visitor's address from X-Forwarded-For / X-Real-IP
 *   LOBBY_URL            http://localhost:8787
 *   LOBBY_ADMIN_SECRET   dev: the lobby's dev secret (admin account tools); production: required, the lobby's own
 *   GAME_MODE            proxy (dev) | static (production) | link   (see play.ts)
 *   GAME_DEV_URL         http://localhost:5273
 *   GAME_INDEX_FILE      ../client/dist/index.html
 *   GAME_URL             http://localhost:5273 (link mode, and the direct link)
 *   SITE_STORE_BACKEND   json | postgres (+ DATABASE_URL)
 *   ACTIVITY_LOBBIES     the lobbies the admin Activity page reads, "Name=url,Name=url" (dev default: Local=LOBBY_URL and
 *                        Production=https://space.brotherk3d.com/lobby; production default: LOBBY_URL alone). The one
 *                        at LOBBY_URL uses your site session; any other, a session you sign in to on that page
 *   NODE_ENV=production  Secure cookies, HSTS, no dev defaults: a missing secret stops the site with a message
 *
 * (.env.example lists them all; deploy/vps keeps the real values in /etc/spacegame/site.env, never in the repo.
 * API tokens for posting updates aren't settings: an admin makes them in the panel and the site keeps their hashes.)
 */

import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..'); // game-v2/

export interface SiteConfig {
  port: number;
  host: string;
  origin: string;
  name: string;
  secret: string;
  production: boolean;
  secureCookies: boolean;
  trustProxy: boolean;
  dataDir: string;
  profilesDir: string;
  statusFile: string;
  publicDir: string;
  /** The guides: Markdown files (src/guides.ts) */
  guidesDir: string;
  /** The guides are on show (off: hidden from the nav and the home page, and their pages are a 404) */
  guides: boolean;
  /** The site's catalog snapshot, and the game's own catalog file (used instead when it exists and is valid) */
  catalogFile: string;
  catalogGameFile: string;
  /** The name shown on a post for the account that wrote it (lower-case account -> shown name) */
  authors: Record<string, string>;
  /** The key the game server sends to share ships (empty: off) */
  gameKey: string;
  lobbyUrl: string;
  lobbyAdminSecret: string;
  /** The lobbies the admin Activity page reads (src/activity.ts); `own`: this site's lobby (its session works there) */
  activityLobbies: ActivityLobby[];
  game: { mode: 'proxy' | 'static' | 'link'; devUrl: string; indexFile: string; url: string };
}

/** Production has no dev defaults: say everything that's missing at once, rather than run with a made-up secret */
function checkProductionEnv(env: NodeJS.ProcessEnv): void {
  const problems: string[] = [];
  if (!env.SITE_SECRET) problems.push('SITE_SECRET is not set (a long random string: it signs the forms; generate one with: openssl rand -hex 32)');
  else if (env.SITE_SECRET.length < 32) problems.push('SITE_SECRET is too short (32+ characters)');
  if (!env.LOBBY_ADMIN_SECRET) problems.push("LOBBY_ADMIN_SECRET is not set (the lobby's own: the site uses it for account tools)");
  if (!(env.SITE_ORIGIN || '').startsWith('https://')) problems.push('SITE_ORIGIN must be the public https address, e.g. https://space.brotherk3d.com');
  if ((env.SITE_STORE_BACKEND || '').toLowerCase() === 'postgres' && !env.DATABASE_URL) problems.push('SITE_STORE_BACKEND=postgres needs DATABASE_URL');
  if (env.SITE_GAME_KEY && env.SITE_GAME_KEY.length < 32) problems.push('SITE_GAME_KEY is too short (32+ characters)');
  if (problems.length) throw new Error(`The site can't start in production:\n  - ${problems.join('\n  - ')}`);
}

/** "admin=Kieran, other=Name" to a map keyed by lower-case account name */
export function parseAuthors(v: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of v.split(',')) {
    const i = part.indexOf('=');
    const k = part.slice(0, i).trim().toLowerCase(), n = part.slice(i + 1).trim().slice(0, 40);
    if (i > 0 && k && n) out[k] = n;
  }
  return out;
}

export interface ActivityLobby { id: string; name: string; url: string; own: boolean }

/** The production lobby's public address (nginx: /lobby/activity/ goes to it) */
export const PRODUCTION_LOBBY = 'https://space.brotherk3d.com/lobby';

/** "Local=http://localhost:8787,Production=https://..." (http(s) only; at most 6) */
export function parseActivityLobbies(v: string | undefined, lobbyUrl: string, production: boolean): ActivityLobby[] {
  const spec = v ?? (production ? `Live=${lobbyUrl}` : `Local=${lobbyUrl},Production=${PRODUCTION_LOBBY}`);
  const out: ActivityLobby[] = [];
  for (const part of spec.split(',')) {
    const i = part.indexOf('=');
    const name = part.slice(0, i).trim().slice(0, 24), url = part.slice(i + 1).trim().replace(/\/$/, '');
    if (i <= 0 || !name || !/^https?:\/\/[^\s]+$/.test(url) || out.length >= 6) continue;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `l${out.length}`;
    if (out.some((l) => l.id === id)) continue;
    out.push({ id, name, url, own: url === lobbyUrl });
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SiteConfig {
  const production = env.NODE_ENV === 'production';
  const port = parseInt(env.SITE_PORT || '5310', 10);
  const mode = (env.GAME_MODE || (production ? 'static' : 'proxy')) as SiteConfig['game']['mode'];
  if (production) checkProductionEnv(env);
  return {
    port,
    host: env.SITE_HOST || '127.0.0.1',
    origin: (env.SITE_ORIGIN || `http://localhost:${port}`).replace(/\/$/, ''),
    name: env.SITE_NAME || 'Space Game',
    secret: env.SITE_SECRET || crypto.randomBytes(32).toString('hex'),
    production,
    secureCookies: env.SITE_SECURE_COOKIES ? env.SITE_SECURE_COOKIES === '1' : production,
    trustProxy: env.SITE_TRUST_PROXY ? env.SITE_TRUST_PROXY === '1' : production,
    dataDir: path.resolve(env.SITE_DATA_DIR || path.join(root, 'data/site')),
    profilesDir: path.resolve(env.SITE_PROFILES_DIR || path.join(root, 'data/profiles')),
    statusFile: path.resolve(env.SITE_STATUS_FILE || path.join(root, 'data/status/live.json')),
    publicDir: path.resolve(here, '../public'),
    guidesDir: path.resolve(env.SITE_GUIDES_DIR || path.join(here, '../guides')),
    guides: env.SITE_GUIDES === '1',
    catalogFile: path.resolve(here, '../catalog/catalog.json'),
    catalogGameFile: path.resolve(env.SITE_CATALOG_FILE || path.join(root, 'data/catalog/catalog.json')),
    authors: parseAuthors(env.SITE_AUTHORS ?? 'admin=Kieran'),
    gameKey: env.SITE_GAME_KEY || '',
    lobbyUrl: (env.LOBBY_URL || 'http://localhost:8787').replace(/\/$/, ''),
    lobbyAdminSecret: env.LOBBY_ADMIN_SECRET || (production ? '' : 'dev-lobby-admin-secret'),
    activityLobbies: parseActivityLobbies(env.ACTIVITY_LOBBIES, (env.LOBBY_URL || 'http://localhost:8787').replace(/\/$/, ''), production),
    game: {
      mode: ['proxy', 'static', 'link'].includes(mode) ? mode : 'link',
      devUrl: (env.GAME_DEV_URL || 'http://localhost:5273').replace(/\/$/, ''),
      indexFile: path.resolve(env.GAME_INDEX_FILE || path.join(root, 'client/dist/index.html')),
      url: env.GAME_URL || 'http://localhost:5273',
    },
  };
}
