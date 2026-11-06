/**
 * Player activity for the website's admin panel: what pilots do on this server, sent to the lobby, which keeps a
 * capped history per server (server-browser/src/activity). Admins read it on the website (Admin, Activity).
 *
 * `activity` is the one feed for the process. It's off (every call does nothing) until index.ts starts it with the
 * lobby's address, LOBBY_ADMIN_SECRET and this server's name (SERVER_NAME), so tests, benches and the browser proto
 * never send anything. Hook points call it with one line each; each method here says what goes out.
 *
 * Never chat or private-message contents, passwords or tokens: private messages and friend actions are counts.
 * Frequent things (PvE kills, ore, crafting, small sales, ship edits) are summed per pilot (ActivityFeed.tally).
 */

import { ActivityFeed, FLUSH_MS, type FeedEvent } from './ActivityFeed.js';

/** A pilot as the hook points know them */
interface Who { username: string; userId: number | null }

/** The pilots module, as far as the feed listens to it (Pilots.onEvent; eid to pilot; item names) */
interface PilotsLike {
  onEvent(fn: (conn: Who, ev: { type: string; [k: string]: any }) => void): void;
  connOf(eid: number): Who | undefined;
  econ: { items: { name(id: string): string } };
}

/** A sale at least this big is its own line; smaller ones are summed */
export const BIG_SALE = 5000;
/** One "docked" line per pilot and station in this long */
const DOCK_QUIET_MS = 10 * 60_000;
/** One line per error source in this long */
const ERROR_QUIET_MS = 60_000;
/** Admin commands that only look */
const READ_ONLY_ADMIN = new Set(['info', 'help', 'who', 'players', 'hits', 'crowd']);

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** "12 kills: Pirates 8, Drones 4" (the top few) */
function breakdown(total: string, counts: Map<string, number>): string {
  const top = [...counts].sort((a, b) => b[1] - a[1]);
  if (top.length === 1 && top[0][0] === '') return total;
  const shown = top.slice(0, 4).map(([k, n]) => `${k} ${n.toLocaleString('en-US')}`);
  return `${total}: ${shown.join(', ')}${top.length > 4 ? ', ...' : ''}`;
}
const sum = (c: Map<string, number>) => [...c.values()].reduce((a, b) => a + b, 0);

/** "1 h 12 min", "3 min", "40 s" */
export function sessionLength(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export interface StartOptions {
  /** The lobby (BROWSER_URL) */
  url: string;
  secret: string;
  /** This server's name (SERVER_NAME): every event carries it */
  server: string;
  /** (Tests) */
  send?: (events: FeedEvent[]) => Promise<boolean>;
  now?: () => number;
  /** Run pump() on a timer (default true) */
  timer?: boolean;
}

export class Activity {
  feed: ActivityFeed | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sessions = new Map<object, { name: string; at: number }>();
  private now: () => number = Date.now;
  private nameOf: (eid: number) => string | undefined = () => undefined;
  private itemName: (id: string) => string = (id) => id;

  get on(): boolean {
    return this.feed !== null;
  }

  start(o: StartOptions): void {
    this.stopTimer();
    this.now = o.now ?? Date.now;
    const send = o.send ?? lobbySender(o.url, o.secret, o.server);
    this.feed = new ActivityFeed({ send, now: this.now });
    if (o.timer !== false) {
      this.timer = setInterval(() => void this.feed?.pump(), FLUSH_MS);
      (this.timer as { unref?: () => void }).unref?.();
    }
    this.feed.emit('server', '', 'Server started');
  }

  /** Off again; what's queued is sent first (best effort, within `ms`) */
  async stop(ms = 2000): Promise<void> {
    const feed = this.feed;
    if (!feed) return;
    feed.emit('server', '', 'Server stopping');
    for (const [conn] of this.sessions) this.leave(conn as Who);
    feed.flushTallies(undefined, true);
    this.stopTimer();
    const deadline = this.now() + ms;
    while (feed.pending && !feed.failing && this.now() < deadline) await feed.pump();
    this.feed = null;
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Listen to the pilots' events (levels, kills, ore, crafting, refits) and learn their names */
  watch(pilots: PilotsLike): void {
    this.nameOf = (eid) => pilots.connOf(eid)?.username;
    this.itemName = (id) => { try { return pilots.econ.items.name(id); } catch { return id; } };
    pilots.onEvent((conn, ev) => {
      if (!this.feed) return;
      try { this.pilotEvent(conn, ev); } catch { /* never into the game */ }
    });
  }

  private pilotEvent(conn: Who, ev: { type: string; [k: string]: any }): void {
    const f = this.feed!, who = conn.username;
    if (ev.type === 'level') f.emit('level', who, `Reached level ${ev.level}`);
    else if (ev.type === 'refit') f.tally('refit', who, '', 1, (c) => `${plural(sum(c), 'ship change')} (refits, swaps)`);
    else if (ev.type === 'items' && ev.source === 'crafted') {
      for (const [id, n] of Object.entries(ev.items as Record<string, number>)) f.tally('craft', who, this.itemName(id), n, (c) => breakdown(`Crafted ${plural(sum(c), 'item')}`, c));
    } else if (ev.type === 'stat') {
      const key = String(ev.key);
      if (key.startsWith('kills:')) f.tally('kills', who, key.slice(6), ev.n, (c) => breakdown(`${plural(sum(c), 'kill')} (PvE)`, c));
      else if (key === 'assists') f.tally('kills', who, 'assists', ev.n, (c) => breakdown(`${plural(sum(c), 'kill')} (PvE)`, c));
      else if (key === 'mined') f.tally('mined', who, '', ev.n, (c) => `Mined ${plural(sum(c), 'unit')} of ore`);
      else if (key === 'salvaged') f.tally('salvage', who, '', ev.n, (c) => `Salvaged ${plural(sum(c), 'wreck')}`);
    }
  }

  // ------------------------------------------------------------------ sessions

  /** Joined the server (signed in, or a guest) */
  join(conn: Who): void {
    if (!this.feed) return;
    this.sessions.set(conn, { name: conn.username, at: this.now() });
    this.feed.emit('join', conn.username, conn.userId !== null ? 'Joined (signed in)' : 'Joined as a guest');
  }

  /** Left (the socket closed): with how long they were on */
  leave(conn: Who): void {
    const s = this.sessions.get(conn);
    if (!s) return;
    this.sessions.delete(conn);
    if (!this.feed) return;
    this.feed.flushTallies(s.name);
    this.feed.emit('leave', s.name, `Left after ${sessionLength(this.now() - s.at)}`);
  }

  /** Turned away or sent off: a kick (they were on), or a refused sign-in or join */
  refused(conn: Who, reason: string | undefined): void {
    if (!this.feed) return;
    const on = this.sessions.has(conn);
    this.feed.emit(on ? 'kick' : 'refused', on ? conn.username : '', `${on ? 'Disconnected' : 'Refused'}: ${reason || 'no reason given'}`);
  }

  /** A client built for another wire format */
  protocol(client: unknown, server: number): void {
    this.feed?.emit('protocol', '', `Client protocol ${String(client ?? 'none').slice(0, 12)}, server ${server}: told to reload`, '', { key: String(client), ms: ERROR_QUIET_MS });
  }

  // ------------------------------------------------------------------ fights

  /** A pilot's ship was destroyed: by a pilot (PvP, both named), or else what (cause: GameServer.deathCause) */
  death(conn: Who, cause: Record<string, unknown>, killer?: string): void {
    if (!this.feed) return;
    if (killer && killer !== conn.username) { this.feed.emit('pvp', conn.username, `Killed by ${killer}`, killer); return; }
    const by = typeof cause.by === 'string' && cause.by !== 'other' && cause.by !== 'pilot' ? cause.by : '';
    const where = typeof cause.region === 'string' ? ` in ${cause.region}` : '';
    this.feed.emit('death', conn.username, `${by ? `Destroyed by ${by}` : 'Ship destroyed'}${where}`);
  }

  /** A boss fight: started (pilots met it), killed (the winners), failed (everyone left or died) */
  boss(what: 'start' | 'kill' | 'fail', boss: string, players: number[]): void {
    if (!this.feed) return;
    const names = [...new Set(players.map((p) => this.nameOf(p)).filter((n): n is string => !!n))];
    const list = names.length > 4 ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more` : names.join(', ');
    const text = what === 'start' ? `Fight with ${boss} started` : what === 'kill' ? `${boss} killed` : `Fight with ${boss} ended without a kill`;
    this.feed.emit(`boss_${what}`, names[0] ?? '', `${text}${list ? ` (${list})` : ''}`, names[1] ?? '', what === 'start' ? { key: boss, ms: 60_000 } : undefined);
  }

  // ------------------------------------------------------------------ economy

  /** Sold at a market: a big sale is its own line, smaller ones are summed */
  sale(conn: Who, what: string, credits: number, station: string): void {
    if (!this.feed || !(credits > 0)) return;
    if (credits >= BIG_SALE) this.feed.emit('sale', conn.username, `Sold ${what} for ${credits.toLocaleString('en-US')} cr at ${station}`);
    else this.feed.tally('sales', conn.username, '', credits, (c) => `Market sales: ${sum(c).toLocaleString('en-US')} cr`);
  }

  /** A trade between two pilots went through (counts, not a list) */
  trade(a: Who, b: Who, aGave: { items: Record<string, number>; credits: number }, bGave: { items: Record<string, number>; credits: number }): void {
    if (!this.feed) return;
    const side = (o: { items: Record<string, number>; credits: number }) => {
      const n = Object.values(o.items).reduce((x, y) => x + y, 0);
      return [n ? plural(n, 'item') : '', o.credits ? `${o.credits.toLocaleString('en-US')} cr` : ''].filter(Boolean).join(' + ') || 'nothing';
    };
    this.feed.emit('trade', a.username, `Traded ${side(aGave)} for ${side(bGave)} with ${b.username}`, b.username);
  }

  quest(conn: Who, name: string): void {
    this.feed?.emit('quest', conn.username, `Completed "${name}"`);
  }

  dock(conn: Who, station: string): void {
    this.feed?.emit('dock', conn.username, `Docked at ${station}`, '', { key: station, ms: DOCK_QUIET_MS });
  }

  /** Took another ship out of the hangar */
  ship(conn: Who, name: string): void {
    this.feed?.emit('ship', conn.username, `Now flying the ${name}`);
  }

  /** A ship on order is finished */
  built(conn: Who, name: string, rebuilt: boolean): void {
    this.feed?.emit('build', conn.username, `${rebuilt ? 'Rebuilt' : 'Built'} the ${name}`);
  }

  // ------------------------------------------------------------------ social, admin, errors

  /** A private message or friend action: counted only (never who to, never the text) */
  social(conn: Who, what: 'private messages' | 'friend requests' | 'friends accepted' | 'requests declined' | 'friends removed'): void {
    this.feed?.tally('social', conn.username, what, 1, (c) => [...c].map(([k, n]) => `${n} ${k}`).join(', '));
  }

  /** An admin command that changed something (never message texts: a mail's or announcement's words stay out) */
  admin(admin: string, cmd: string, args: Record<string, unknown>, result: { ok: boolean; text: string }): void {
    if (!this.feed || READ_ONLY_ADMIN.has(cmd)) return;
    const target = typeof args.player === 'string' ? args.player : typeof args.to === 'string' ? args.to : '';
    const detail = `/${cmd}${target ? ` ${target}` : ''}: ${result.ok ? 'done' : 'refused'}${cmd === 'mail' || cmd === 'announce' ? '' : ` (${result.text.slice(0, 120)})`}`;
    this.feed.emit('admin', admin, detail, target.slice(0, 40));
  }

  /** Something threw on the server (GameServer.fault): one line per source a minute */
  error(where: string, e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    this.feed?.emit('error', '', `${where}: ${msg.slice(0, 150)}`, '', { key: where, ms: ERROR_QUIET_MS });
  }
}

/** Batches to the lobby's /admin/activity/ingest with the shared secret (8 s timeout) */
export function lobbySender(url: string, secret: string, server: string): (events: FeedEvent[]) => Promise<boolean> {
  const warned = new Set<number>();
  return async (events) => {
    const r = await fetch(`${url.replace(/\/$/, '')}/admin/activity/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ server, events }),
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) return true;
    // (A batch it refused as bad won't get better by sending again: only "try later" answers are kept for another go.
    // 404: a lobby from before the feed; 403: LOBBY_ADMIN_SECRET differs. Said once each, never the secret)
    if (!warned.has(r.status)) { warned.add(r.status); console.warn(`[activity] the lobby answered ${r.status}${r.status === 404 ? " (it has no activity feed yet)" : r.status === 403 ? " (LOBBY_ADMIN_SECRET isn't the same here and there)" : ''}`); }
    return r.status >= 400 && r.status < 500 && r.status !== 429 && r.status !== 408;
  };
}

/** The process's feed (off until index.ts starts it) */
export const activity = new Activity();
