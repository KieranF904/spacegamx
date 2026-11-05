/**
 * Play: the game, opened from the site with the visitor already signed in.
 *
 * The game client keeps its lobby session in localStorage under `authToken`
 * and, on load, resumes it (client/src/Game.ts resumeSession: it asks the lobby
 * whether the token is still good, and if so skips the sign-in screen). The
 * site's session IS a lobby session token (the same kind the game makes when
 * you sign in there), so the handoff is: serve the game's index.html at /play,
 * on the site's own origin, with one small script first in <head> that puts
 * the visitor's token in localStorage. No change to the game client is needed,
 * and the token never appears in a URL.
 *
 * That only works same-origin, which is how /play is served in every mode:
 *   GAME_MODE=proxy  (dev default) /play is the Vite dev server's index.html, and
 *                    the paths the game loads (/src, /@vite, /node_modules, /sfx,
 *                    ...) are passed through to Vite, HMR socket included; so
 *                    http://localhost:5310/play is the live dev game.
 *   GAME_MODE=static (production) /play is client/dist/index.html read from disk;
 *                    nginx serves /assets/ and /sfx/ from client/dist as now.
 *   GAME_MODE=link   no handoff: /play redirects to GAME_URL (another origin;
 *                    the player signs in again there).
 */

import fs from 'fs/promises';
import http from 'http';
import net from 'net';
import type { Duplex } from 'stream';

/** Paths the Vite dev server answers for the game (proxy mode) */
export const DEV_GAME_PREFIXES = ['/src/', '/@vite/', '/@fs/', '/@id/', '/node_modules/', '/sfx/', '/__ships/', '/@react-refresh'];

export function isDevGamePath(pathname: string): boolean {
  return DEV_GAME_PREFIXES.some((p) => pathname === p.replace(/\/$/, '') || pathname.startsWith(p));
}

/** A lobby token as the site issues them (hex), so nothing else can reach the script */
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,256}$/;

/** The script that hands the session over (and drops a stale one when signed out of the site) */
export function handoffScript(token: string | null): string {
  if (token && TOKEN_SHAPE.test(token)) {
    return `<script>try{localStorage.setItem('authToken',${JSON.stringify(token)})}catch(e){}</script>`;
  }
  return '';
}

/** The game's index.html with the handoff first in <head> */
export function injectHandoff(indexHtml: string, token: string | null): string {
  const script = handoffScript(token);
  if (!script) return indexHtml;
  const m = /<head[^>]*>/i.exec(indexHtml);
  if (!m) return script + indexHtml;
  return indexHtml.slice(0, m.index + m[0].length) + script + indexHtml.slice(m.index + m[0].length);
}

export interface GameConfig {
  mode: 'proxy' | 'static' | 'link';
  /** proxy: the Vite dev server */
  devUrl: string;
  /** static: the built client's index.html */
  indexFile: string;
  /** link: where the game is */
  url: string;
}

export async function gameIndex(cfg: GameConfig): Promise<string | null> {
  try {
    if (cfg.mode === 'static') return await fs.readFile(cfg.indexFile, 'utf-8');
    if (cfg.mode === 'proxy') {
      const r = await fetch(`${cfg.devUrl}/`, { signal: AbortSignal.timeout(5000) });
      return r.ok ? await r.text() : null;
    }
  } catch (e) {
    console.error('[Site] game index unavailable:', (e as Error).message);
  }
  return null;
}

/** Pass a request through to the Vite dev server (proxy mode) */
export function proxyToDev(devUrl: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  const target = new URL(devUrl);
  const headers = { ...req.headers, host: target.host };
  delete headers.cookie; // the site's cookies are no business of Vite's
  const up = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); } res.end('Game dev server unavailable'); });
  req.pipe(up);
}

/** Pass a WebSocket upgrade (Vite's HMR) through to the dev server */
export function proxyUpgradeToDev(devUrl: string, req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
  const target = new URL(devUrl);
  const up = net.connect(Number(target.port || 80), target.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      if (k.toLowerCase() === 'host') lines.push(`Host: ${target.host}`);
      else if (k.toLowerCase() !== 'cookie') lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
    }
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const end = () => { up.destroy(); socket.destroy(); };
  up.on('error', end);
  socket.on('error', end);
}
