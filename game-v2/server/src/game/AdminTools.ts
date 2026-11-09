/**
 * Admin tools: every command an admin can run in game, from the admin panel
 * (F2) or as a chat command (/tp, /goto, /bring, /god, ...; /help lists them).
 * Only connections signed in as admins (or every connection on proto/dev
 * servers that make everyone admin) get through; each command is logged.
 *
 * Players are named by username (case doesn't matter, a unique prefix will
 * do) or by entity id; most commands act on the admin when no one is named.
 *
 * Managing players (players, rank, ban, unban) works on accounts whether
 * they're online or not, by username: admin rank and bans are kept by the
 * lobby (AdminHost.accounts), the contributor rank here (ContributorNotes).
 * No admin can demote or ban themselves. Ranks: owner > admin > contributor >
 * player; an owner is an admin for every check. Granting or revoking admin is
 * the owner's; an admin can't change an admin's or the owner's rank, or ban or
 * unban them (an admin has to lose the rank before an admin can ban them; the
 * owner can ban one outright). Nobody bans or demotes the owner here: that
 * rank is set on the lobby's side only. The lobby checks the same rules again
 * (each call names the acting admin).
 */

import type { AdminAccountInfo, Bag } from '@space-game/common';
import type { AccountAdmin, AccountInfo } from '../auth/types.js';
import { activity } from '../activity/index.js';

export interface AdminConn {
  playerId: number;
  username: string;
  isAdmin: boolean;
  /** The owner rank (isAdmin is true for an owner too) */
  isOwner?: boolean;
  ping: number;
  /** Contributor rank (ContributorNotes) */
  isContributor?: boolean;
  /** Their account (null: a guest) */
  userId?: number | null;
}

export interface AdminStation { id: string; name: string; system: string; x: number; y: number }

export interface AdminHost {
  conns(): AdminConn[];
  /** Where a player is (null: no ship) */
  where(c: AdminConn): { system: string; x: number; y: number; dead: boolean } | null;
  systems(): { id: string; name: string }[];
  stations(): AdminStation[];
  factions(): Record<string, string[]>;
  bosses(): string[];
  items(): { id: string; name: string }[];
  travel(c: AdminConn, system: string, x: number, y: number): boolean;
  heal(c: AdminConn): void;
  destroy(c: AdminConn): void;
  addCredits(c: AdminConn, n: number): void;
  addXp(c: AdminConn, n: number): void;
  /** Into their hold, what won't fit into their station storage: how many went to storage */
  give(c: AdminConn, items: Bag): number;
  skillPoints(c: AdminConn, n: number): void;
  /** Records (Codex.admin): one by id, `all`, or `clear` */
  codex?(c: AdminConn, what: string): Result;
  kick(c: AdminConn, reason: string): void;
  spawnPack(system: string, x: number, y: number, faction?: string, ships?: string[], count?: number): number;
  spawnBoss(id: string): boolean;
  /** Destroy (or quietly remove) the hostiles in a system, or within `radius` of a point there */
  clearHostiles(system: string, explode: boolean, at?: { x: number; y: number; radius: number }): number;
  clearPods(system: string): number;
  startEvent(system: string, kind: 'raid' | 'salvage' | 'siege' | 'peak'): boolean;
  announce(text: string): void;
  /** An item's name (null: no such item) */
  itemName(id: string): string | null;
  reply(c: AdminConn, msg: object): void;
  /** Grant or revoke the contributor rank: `online` is their connection (null: by name, from their next sign-in) */
  setContributor(name: string, online: AdminConn | null, on: boolean, by: AdminConn): Result;
  /** Who has the rank */
  contributors(): string[];
  /** The accounts, for admin rank and bans (null or missing: no lobby to ask, e.g. proto and dev servers without one) */
  accounts?: AccountAdmin | null;
  /** An online player's admin rank changed (their account already says so): live, and tell their client */
  setAdminLive?(c: AdminConn, on: boolean): void;
  /** Admins may switch on free build here (dev servers only: GameServer refuses it in production) */
  freeBuildAllowed?(): boolean;
  /**
   * Dev servers only (the caller checks freeBuildAllowed): their repair bank (game/RepairBank.ts) filled, emptied, its
   * deposits cleared, or `items` added to the deposits (none: a kit of every pack). The same code the `devBank` message runs
   */
  devBank?(c: AdminConn, action: 'fill' | 'empty' | 'clearDeposits' | 'grant', items?: Bag): Result;
  /** Someone's free build was switched on or off: tell their hangar */
  freeBuildChanged?(c: AdminConn): void;
  /** Confirmed hits' counters (net/hits/HitLedger.ts) */
  hitStats?(): { hits: number; records: number; legacy: number; d: number; s: number; i: number; checks: number; why: Record<string, number> };
  /** Crowd fallbacks in their system (net/crowd/CrowdControl.ts admin): `to` a level, 'auto', or '' (the status) */
  crowd?(c: AdminConn, to: string): Result;
}

type Args = Record<string, unknown>;
/** `quiet`: the panel asked for a list (a successful one isn't logged or answered with a line) */
export type Result = { ok: boolean; text: string; quiet?: boolean };
type Rank = AdminAccountInfo['rank'];

const OWNER_ONLY = 'Only the owner can grant or revoke admin';
const NO_LOBBY = "This server has no lobby to keep accounts (or no LOBBY_ADMIN_SECRET): admin rank and bans can't be changed here";
/** Accounts in one `players` answer */
const PAGE = 50;
/** Ban lengths: 30m, 12h, 1d, 2w (or perm) */
const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };
/** A ban's length in ms (null: for good; undefined: not a length) */
const banLength = (v: string): number | null | undefined => {
  if (/^(perm|permanent|forever)$/i.test(v)) return null;
  const m = /^(\d+)\s*([mhdw])$/i.exec(v);
  return m && Number(m[1]) > 0 ? Number(m[1]) * UNITS[m[2].toLowerCase()] : undefined;
};
const banText = (ban: { until: number | null; reason: string }) =>
  `${ban.until === null ? 'permanently' : `until ${new Date(ban.until).toISOString().slice(0, 16).replace('T', ' ')} UTC`}${ban.reason ? `: ${ban.reason}` : ''}`;

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const onOff = (v: unknown, was: boolean) => (v === undefined || v === '' ? !was : v === true || v === 'on' || v === '1' || v === 1);

const HELP = [
  '/tp x y [system] · /tp name (go to them) · /tp name x y [system] · /goto station-or-player · /bring name',
  '/god [on|off] [name] · /hide [on|off] (hostiles ignore you) · /heal [name] · /kill name · /boot name [reason] (kick from the server)',
  '/credits n [name] · /xp n [name] · /give item [n] [name] · /skillpoints n [name] · /codex [name] id|all|clear (records)',
  '/spawn [faction] [ship ...] [xN] (near you) · /boss id · /clear [radius] (destroy hostiles) · /clearpods · /event raid|salvage|siege',
  '/announce text · /who · F2: admin panel · F3: teleport to the cursor · /tutorial (training yard: reset, step id, leave)',
  '/mail name|everyone [subject |] text (to their inbox on the join screen: a banner until read)',
  '/contributor name on|off (the contributor rank: map notes, F6) · /contributors (who has it)',
  '/freebuild [on|off] (dev servers: place any part in the hangar, nothing taken)',
  '/bank fill|empty|clear|grant [item n] (dev servers: your repair bank; grant: deposits, no item: a kit of every pack)',
  '/hits [on|off] [name] (confirmed hits: the network test switch; no on/off: the counters)',
  '/crowd [0-8|auto] (crowd fallbacks in your system: force a level, or back to automatic; none: the levels and costs)',
  '/players [name] (online or not) · /rank name player|contributor|admin (admin: the owner only) · /ban name 1h|1d|7d|perm [reason] · /unban name',
  'Party: /p message · /invite name · /leave · /kick name · /promote name',
];

export class AdminTools {
  /** Admins in god mode, and admins hostiles leave alone */
  readonly god = new Set<AdminConn>();
  readonly hidden = new Set<AdminConn>();
  /** Admins building for free in the hangar (dev servers only) */
  private readonly freeBuilders = new Set<AdminConn>();

  constructor(private host: AdminHost) {}

  /** Is this player entity in god mode (cheap when no one is) */
  isGod(eid: number): boolean {
    if (!this.god.size) return false;
    for (const c of this.god) if (c.playerId === eid) return true;
    return false;
  }

  isHidden(eid: number): boolean {
    if (!this.hidden.size) return false;
    for (const c of this.hidden) if (c.playerId === eid) return true;
    return false;
  }

  /** Free build is on for this connection: an admin, on a server that allows it */
  freeBuild(c: AdminConn): boolean {
    return this.freeBuilders.has(c) && c.isAdmin && !!this.host.freeBuildAllowed?.();
  }

  /** An admin on a dev server (one that allows free build): the dev-only tools (the repair bank's) are theirs */
  devTools(c: AdminConn): boolean {
    return !!c.isAdmin && !!this.host.freeBuildAllowed?.();
  }

  /** A connection left (or lost the rank) */
  forget(c: AdminConn): void {
    this.god.delete(c);
    this.hidden.delete(c);
    if (this.freeBuilders.delete(c)) this.host.freeBuildChanged?.(c);
  }

  /** What the panel needs to fill its lists */
  info(): object {
    return {
      type: 'adminInfo',
      systems: this.host.systems(),
      stations: this.host.stations(),
      factions: this.host.factions(),
      bosses: this.host.bosses(),
      items: this.host.items(),
      freeBuild: !!this.host.freeBuildAllowed?.(),
    };
  }

  /** The players, for the panel (sent with the server stats) */
  players(): object[] {
    return this.host.conns().map((c) => {
      const w = this.host.where(c);
      return {
        id: c.playerId, name: c.username, ping: c.ping, admin: c.isAdmin, ...(c.isOwner ? { owner: true } : {}),
        system: w?.system ?? '?', x: Math.round(w?.x ?? 0), y: Math.round(w?.y ?? 0), dead: w?.dead ?? true,
        god: this.god.has(c), hidden: this.hidden.has(c), contributor: !!c.isContributor, freeBuild: this.freeBuild(c),
      };
    });
  }

  /**
   * Commands other modules add (the dev bots: server/src/bots): chat words in, a result out. Looked at before the built-in
   * ones; an extension that doesn't want the line returns null.
   */
  readonly extensions = new Map<string, (c: AdminConn, words: string[]) => Result | null>();

  /** A chat line starting with / from an admin: true if it was an admin command */
  chat(c: AdminConn, text: string): boolean {
    const m = /^\/(\w+)\s*(.*)$/.exec(text);
    if (!m || !c.isAdmin) return false;
    const [, name, rest] = m;
    const ext = this.extensions.get(name.toLowerCase());
    if (ext) {
      const r = ext(c, rest.split(/\s+/).filter(Boolean));
      if (r) { this.host.reply(c, { type: 'adminResult', ok: r.ok, text: r.text }); return true; }
    }
    const a = rest.split(/\s+/).filter(Boolean);
    const cmd = name.toLowerCase();
    const parsed = this.parseChat(c, cmd, a, rest);
    if (!parsed) return false;
    this.run(c, parsed.cmd, parsed.args);
    return true;
  }

  /**
   * Run a command (from the panel, or a parsed chat command) and answer the
   * admin. The ones that ask the lobby (players, rank, ban, unban) answer when
   * it has: a promise of the result.
   */
  run(c: AdminConn, cmd: string, args: Args = {}): Result | Promise<Result> {
    if (!c.isAdmin) {
      this.host.reply(c, { type: 'adminResult', ok: false, text: 'Admins only' });
      return { ok: false, text: 'Admins only' };
    }
    const failed = (e: unknown): Result => ({ ok: false, text: `Failed: ${(e as Error).message}` });
    const done = (r: Result): Result => {
      if (r.quiet && r.ok) return r;
      console.log(`[admin] ${c.username}: ${cmd} ${JSON.stringify(args)} -> ${r.ok ? 'ok' : 'refused'}: ${r.text}`);
      activity.admin(c.username, cmd, args, r);
      this.host.reply(c, { type: 'adminResult', ok: r.ok, text: r.text });
      return r;
    };
    let r: Result | Promise<Result>;
    try {
      r = this.exec(c, cmd, args);
    } catch (e) {
      return done(failed(e));
    }
    return r instanceof Promise ? r.catch(failed).then(done) : done(r);
  }

  // ---------------------------------------------------------------------------

  private exec(me: AdminConn, cmd: string, a: Args): Result | Promise<Result> {
    const who = (key = 'player'): AdminConn | string => {
      const ref = str(a[key]);
      if (!ref) return me;
      return this.find(ref) ?? `No player "${ref}"`;
    };
    const target = (key = 'player') => {
      const t = who(key);
      if (typeof t === 'string') throw new Error(t);
      return t;
    };
    const here = (c: AdminConn) => {
      const w = this.host.where(c);
      if (!w) throw new Error(`${c.username} has no ship`);
      return w;
    };

    switch (cmd) {
      case 'info':
        this.host.reply(me, this.info());
        return { ok: true, text: 'Lists refreshed' };

      case 'help':
        return { ok: true, text: HELP.join('\n') };

      case 'who':
        return { ok: true, text: this.players().map((p: any) => `${p.name} (#${p.id}) ${p.system} ${p.x}, ${p.y}${p.dead ? ' [dead]' : ''}`).join('\n') || 'Nobody' };

      case 'tp': {
        // Someone (default me) to a point, or to another player
        const t = target();
        if (str(a.to)) {
          const to = this.find(str(a.to));
          if (!to) return { ok: false, text: `No player "${str(a.to)}"` };
          const w = here(to);
          return this.travel(t, w.system, w.x + 250, w.y, `${t.username} to ${to.username}`);
        }
        const w = this.host.where(t);
        const system = str(a.system) || w?.system || '';
        if (!Number.isFinite(num(a.x, NaN)) || !Number.isFinite(num(a.y, NaN))) return { ok: false, text: 'Needs x and y' };
        return this.travel(t, system, num(a.x), num(a.y), `${t.username} to ${system} ${Math.round(num(a.x))}, ${Math.round(num(a.y))}`);
      }

      case 'goto': {
        // Me (or `player`) to a station or a player
        const t = target();
        const ref = str(a.station) || str(a.to);
        if (!ref) return { ok: false, text: 'Go where?' };
        const st = this.findStation(ref);
        if (st) return this.travel(t, st.system, st.x + 900, st.y, `${t.username} to ${st.name}`);
        const p = this.find(ref);
        if (!p) return { ok: false, text: `No station or player "${ref}"` };
        const w = here(p);
        return this.travel(t, w.system, w.x + 250, w.y, `${t.username} to ${p.username}`);
      }

      case 'bring': {
        const t = target();
        const w = here(me);
        return this.travel(t, w.system, w.x + 250, w.y, `${t.username} brought to you`);
      }

      case 'god': {
        const t = target();
        const on = onOff(a.on, this.god.has(t));
        if (on) this.god.add(t); else this.god.delete(t);
        if (on) this.host.heal(t);
        return { ok: true, text: `God mode ${on ? 'on' : 'off'} for ${t.username}` };
      }

      case 'hide': {
        const t = target();
        const on = onOff(a.on, this.hidden.has(t));
        if (on) this.hidden.add(t); else this.hidden.delete(t);
        return { ok: true, text: `${t.username} is ${on ? 'hidden from' : 'visible to'} hostiles` };
      }

      case 'freebuild': {
        // (Yourself only, and never on a production server)
        if (!this.host.freeBuildAllowed?.()) return { ok: false, text: 'Free build is only on dev servers' };
        const on = onOff(a.on, this.freeBuilders.has(me));
        if (on) this.freeBuilders.add(me); else this.freeBuilders.delete(me);
        this.host.freeBuildChanged?.(me);
        return { ok: true, text: `Free build ${on ? 'on: place any part in the hangar, and saves take nothing' : 'off'}` };
      }

      case 'bank': {
        // (Yourself only, and never on a production server)
        if (!this.host.freeBuildAllowed?.()) return { ok: false, text: 'The bank commands are only on dev servers' };
        if (!this.host.devBank) return { ok: false, text: "This server has no repair bank" };
        const what = str(a.what).toLowerCase();
        const action = what === 'fill' ? 'fill' : what === 'empty' ? 'empty' : what === 'clear' || what === 'cleardeposits' ? 'clearDeposits' : what === 'grant' ? 'grant' : null;
        if (!action) return { ok: false, text: 'Usage: /bank fill | empty | clear | grant [item n]' };
        const item = str(a.item);
        const n = Math.max(1, Math.floor(num(a.n, 1)));
        return this.host.devBank(me, action, action === 'grant' && item ? { [item]: n } : undefined);
      }

      case 'hits': {
        // Confirmed hits' counters (docs/design/confirmed-hits.md; every client takes them: there's no switch)
        const st = this.host.hitStats?.();
        if (!st) return { ok: false, text: 'No hit counters on this server' };
        return { ok: true, text: `Confirmed hits · hits ${st.hits}, records ${st.records}, old way ${st.legacy} ${JSON.stringify(st.why)}, D ${st.d} S ${st.s} I ${st.i}, checks ${st.checks}` };
      }

      case 'crowd': {
        here(me);
        return this.host.crowd?.(me, str(a.to)) ?? { ok: false, text: "This server doesn't take crowd fallbacks" };
      }

      case 'heal': {
        const t = target();
        here(t);
        this.host.heal(t);
        return { ok: true, text: `Repaired ${t.username}` };
      }

      case 'kill': {
        const t = target();
        if (here(t).dead) return { ok: false, text: `${t.username} is already dead` };
        this.god.delete(t);
        this.host.destroy(t);
        return { ok: true, text: `Destroyed ${t.username}'s ship` };
      }

      case 'kick': {
        const t = target();
        if (t === me) return { ok: false, text: "You can't kick yourself" };
        this.host.kick(t, str(a.reason) || 'Removed from the server by an admin.');
        return { ok: true, text: `Kicked ${t.username}` };
      }

      case 'credits': case 'xp': case 'skillpoints': {
        const t = target();
        const n = Math.round(num(a.n));
        if (!n) return { ok: false, text: 'How many?' };
        if (cmd === 'credits') this.host.addCredits(t, n);
        else if (cmd === 'xp') { if (n < 0) return { ok: false, text: 'XP only goes up' }; this.host.addXp(t, n); }
        else this.host.skillPoints(t, n);
        return { ok: true, text: `${n > 0 ? '+' : ''}${n} ${cmd === 'skillpoints' ? 'skill points' : cmd} to ${t.username}` };
      }

      case 'give': {
        const t = target();
        const ref = str(a.item);
        const id = this.host.itemName(ref) ? ref : this.host.items().find((i) => i.name.toLowerCase() === ref.toLowerCase())?.id;
        if (!id) return { ok: false, text: `No item "${ref}"` };
        const n = Math.max(1, Math.round(num(a.n, 1)));
        const stored = this.host.give(t, { [id]: n });
        return { ok: true, text: `Gave ${n} × ${this.host.itemName(id)} to ${t.username}${stored ? ` (${stored} to station storage: the hold was full)` : ''}` };
      }

      case 'spawn': {
        const w = here(me);
        // No spot given: a little way off, not on top of you
        const off = Number.isFinite(num(a.x, NaN)) ? 0 : 1500;
        const x = num(a.x, w.x + off), y = num(a.y, w.y);
        const ships = Array.isArray(a.ships) ? (a.ships as unknown[]).map(str).filter(Boolean) : undefined;
        const n = this.host.spawnPack(str(a.system) || w.system, x, y, str(a.faction) || undefined, ships, Math.round(num(a.count, 0)) || undefined);
        return n ? { ok: true, text: `Spawned ${n} hostile${n === 1 ? '' : 's'}` } : { ok: false, text: 'Nothing to spawn (check the faction and ship names)' };
      }

      case 'boss': {
        const id = str(a.id);
        return this.host.spawnBoss(id) ? { ok: true, text: `${id} is at its lair` } : { ok: false, text: `Couldn't spawn "${id}" (unknown, or already out)` };
      }

      case 'clear': {
        const w = here(me);
        const r = num(a.radius, 0);
        const n = this.host.clearHostiles(str(a.system) || w.system, a.quiet !== true, r > 0 ? { x: w.x, y: w.y, radius: r } : undefined);
        return { ok: true, text: `${a.quiet === true ? 'Removed' : 'Destroyed'} ${n} hostile${n === 1 ? '' : 's'}` };
      }

      case 'clearpods': {
        const n = this.host.clearPods(str(a.system) || here(me).system);
        return { ok: true, text: `Cleared ${n} loot pod${n === 1 ? '' : 's'}` };
      }

      case 'event': {
        const kind = str(a.kind) === 'salvage' ? 'salvage' : str(a.kind) === 'siege' ? 'siege' : str(a.kind) === 'peak' ? 'peak' : 'raid';
        return this.host.startEvent(str(a.system) || here(me).system, kind)
          ? { ok: true, text: `Started a ${kind}` } : { ok: false, text: `Couldn't start a ${kind} here` };
      }

      case 'contributor': {
        // By name: online players by name or id as usual, else an account name for their next sign-in
        const ref = str(a.player);
        if (!ref) {
          const list = this.host.contributors();
          return { ok: true, text: list.length ? `Contributors: ${list.join(', ')}` : 'No contributors yet (/contributor name on)' };
        }
        const online = this.find(ref);
        if (!online && !/^[A-Za-z0-9_.-]{1,32}$/.test(ref)) return { ok: false, text: `No player "${ref}"` };
        const on = onOff(a.on, !!online?.isContributor || this.host.contributors().some((n) => n.toLowerCase() === ref.toLowerCase()));
        return this.host.setContributor(ref, online, on, me);
      }

      case 'players': return this.listPlayers(me, str(a.search), Math.max(0, Math.round(num(a.offset))), a.quiet === true);
      case 'rank': return this.setRank(me, str(a.player), str(a.rank).toLowerCase());
      case 'ban': return this.ban(me, str(a.player), str(a.duration), str(a.reason).slice(0, 200));
      case 'unban': return this.unban(me, str(a.player));
      case 'mail': return this.mail(me, str(a.to), str(a.text));

      case 'codex': {
        const t = target();
        if (!this.host.codex) return { ok: false, text: 'No records here' };
        const what = str(a.what);
        if (!what) return { ok: false, text: 'Which record? (/codex [name] id|all|clear)' };
        const r = this.host.codex(t, what);
        return { ok: r.ok, text: `${t.username}: ${r.text}` };
      }

      case 'announce': {
        const text = str(a.text).slice(0, 200);
        if (!text) return { ok: false, text: 'Announce what?' };
        this.host.announce(text);
        return { ok: true, text: 'Announced' };
      }
    }
    return { ok: false, text: `Unknown command "${cmd}" (/help lists them)` };
  }

  // --- Managing players, online or not ---------------------------------------

  /** Online players (matching the search) first, then the accounts that aren't on; sent to the panel too */
  private async listPlayers(me: AdminConn, search: string, offset: number, quiet: boolean): Promise<Result> {
    const low = search.toLowerCase();
    const online = this.host.conns().filter((c) => c.username.toLowerCase().startsWith(low));
    const contributors = new Set(this.host.contributors().map((n) => n.toLowerCase()));
    let accounts: AccountInfo[] = [];
    let total = 0;
    let error: string | undefined;
    if (!this.host.accounts) error = NO_LOBBY;
    else {
      try { ({ users: accounts, total } = await this.host.accounts.list(search, offset, PAGE)); } catch (e) { error = (e as Error).message; }
    }
    const players: AdminAccountInfo[] = [
      ...online.map((c) => {
        // (By account id: a guest may have picked an account's name)
        const acc = c.userId != null ? accounts.find((u) => u.id === c.userId) : undefined;
        const rank: Rank = c.isOwner ? 'owner' : c.isAdmin ? 'admin' : c.isContributor ? 'contributor' : 'player';
        return { name: c.username, online: c.playerId, account: c.userId != null, rank, ban: acc?.ban ?? null };
      }),
      ...accounts.filter((u) => !online.some((c) => c.userId === u.id)).map((u): AdminAccountInfo => ({
        name: u.username, online: null, account: true,
        rank: u.isOwner ? 'owner' : u.isAdmin ? 'admin' : contributors.has(u.username.toLowerCase()) ? 'contributor' : 'player', ban: u.ban,
      })),
    ];
    const more = total > offset + accounts.length;
    this.host.reply(me, { type: 'adminAccounts', search, players, total, more, error });
    const lines = players.slice(0, 30).map((p) => `${p.online !== null ? '● ' : '  '}${p.name}${p.account ? '' : ' (guest)'}${p.rank === 'player' ? '' : ` [${p.rank}]`}${p.ban ? ` [banned ${banText(p.ban)}]` : ''}`);
    return { ok: true, text: (lines.join('\n') || 'Nobody') + (more ? `\n(${total} accounts match: add more of the name)` : '') + (error ? `\n(${error})` : ''), quiet };
  }

  /**
   * Who `ref` is: an online player (by id or name, as for every command) or an
   * account by its exact username. A unique prefix of someone online loses to
   * an account with exactly that name.
   */
  private async resolve(ref: string): Promise<{ name: string; online: AdminConn | null; info: AccountInfo | null }> {
    if (!ref) throw new Error('Who?');
    const accounts = this.host.accounts;
    let online = this.find(ref);
    let info: AccountInfo | null = null;
    if (online && online.userId != null && accounts) info = await accounts.get(online.username);
    if (online && online.username.toLowerCase() !== ref.toLowerCase() && !/^#?\d+$/.test(ref) && accounts) {
      const exact = await accounts.get(ref);
      if (exact && exact.id !== online.userId) { online = null; info = exact; }
    }
    if (online) return { name: online.username, online, info };
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(ref)) throw new Error(`No player "${ref}"`);
    if (accounts) info = await accounts.get(ref);
    if (accounts && !info) throw new Error(`No player or account "${ref}"`);
    // (Somebody else online on the same account is them too)
    online = info ? this.host.conns().find((c) => c.userId === info!.id) ?? null : null;
    return { name: info?.username ?? ref, online, info };
  }

  private isMe(me: AdminConn, t: { online: AdminConn | null; info: AccountInfo | null }): boolean {
    return t.online === me || (!!t.info && me.userId != null && t.info.id === me.userId);
  }

  private async setRank(me: AdminConn, ref: string, rank: string): Promise<Result> {
    if (rank !== 'player' && rank !== 'contributor' && rank !== 'admin') return { ok: false, text: 'Which rank? player, contributor or admin' };
    const t = await this.resolve(ref);
    if (t.online && t.online.userId == null) return { ok: false, text: `${t.name} is a guest: only signed-in accounts have ranks` };
    const owner = this.isOwner(t);
    if (owner) return { ok: false, text: `${t.name} is the owner: the owner rank is set on the server only` };
    if (this.isMe(me, t) && rank !== 'admin') return { ok: false, text: "You can't demote yourself" };
    const accounts = this.host.accounts;
    const wasAdmin = t.info?.isAdmin ?? t.online?.isAdmin ?? false;
    const adminChanges = (rank === 'admin') !== wasAdmin;
    if (wasAdmin && !me.isOwner && !this.isMe(me, t)) return { ok: false, text: `${t.name} is an admin: only the owner can change an admin's rank` };
    if (adminChanges && !me.isOwner) return { ok: false, text: OWNER_ONLY };
    if (adminChanges && !accounts) return { ok: false, text: NO_LOBBY };
    // Admins keep a contributor rank they had (it's theirs if they're demoted); players lose it
    // (first: then the admin rank's change tells their client both at once)
    const wasContributor = t.online ? !!t.online.isContributor : this.host.contributors().some((n) => n.toLowerCase() === t.name.toLowerCase());
    if (rank !== 'admin' && wasContributor !== (rank === 'contributor')) {
      const r = this.host.setContributor(t.name, t.online, rank === 'contributor', me);
      if (!r.ok) return r;
    }
    if (adminChanges) {
      await accounts!.setAdmin(t.name, rank === 'admin', this.actor(me));
      for (const c of this.sessions(t)) {
        // (A demoted admin's god mode and hiding go with the rank)
        if (rank !== 'admin') this.forget(c);
        this.host.setAdminLive?.(c, rank === 'admin');
      }
    }
    const same = (rank === 'admin') === wasAdmin && (rank === 'admin' || wasContributor === (rank === 'contributor'));
    return { ok: true, text: same ? `${t.name} is already ${rank === 'admin' ? 'an admin' : `a ${rank}`}` : `${t.name} is now ${rank === 'admin' ? 'an admin' : `a ${rank}`}${t.online ? '' : ' (offline)'}` };
  }

  private async ban(me: AdminConn, ref: string, duration: string, reason: string): Promise<Result> {
    const length = banLength(duration);
    if (length === undefined) return { ok: false, text: 'How long? 30m, 1h, 1d, 7d, 2w or perm' };
    const accounts = this.host.accounts;
    if (!accounts) return { ok: false, text: NO_LOBBY };
    const t = await this.resolve(ref);
    if (!t.info) return { ok: false, text: `${t.name} is a guest (no account to ban): /boot them instead` };
    if (this.isMe(me, t)) return { ok: false, text: "You can't ban yourself" };
    if (this.isOwner(t)) return { ok: false, text: `${t.name} is the owner: owners can't be banned` };
    if (t.info.isAdmin && !me.isOwner) return { ok: false, text: `${t.name} is an admin: only the owner can ban an admin` };
    const info = await accounts.ban(t.name, length === null ? null : Date.now() + length, reason, me.username, this.actor(me));
    const ban = info.ban ?? { until: null, reason, by: me.username };
    // Everyone on that account goes, told why (their sessions are refused until it's over)
    const gone = this.sessions(t);
    for (const c of gone) { this.forget(c); this.host.kick(c, `You've been banned ${banText(ban)}`); }
    return { ok: true, text: `Banned ${t.name} ${banText(ban)}${gone.length ? ' (kicked)' : ''}` };
  }

  private async unban(me: AdminConn, ref: string): Promise<Result> {
    const accounts = this.host.accounts;
    if (!accounts) return { ok: false, text: NO_LOBBY };
    const t = await this.resolve(ref);
    if (!t.info) return { ok: false, text: `${t.name} is a guest: guests can't be banned` };
    if (!t.info.ban) return { ok: false, text: `${t.name} isn't banned` };
    if (t.info.isAdmin && !me.isOwner) return { ok: false, text: `${t.name} is ${this.isOwner(t) ? 'the owner' : 'an admin'}: only the owner can change that` };
    await accounts.unban(t.name, this.actor(me));
    return { ok: true, text: `Unbanned ${t.name}` };
  }

  /** A message to a player's inbox (or everyone's), kept by the lobby: "subject | text", or just the text */
  private async mail(me: AdminConn, to: string, text: string): Promise<Result> {
    const accounts = this.host.accounts;
    if (!accounts?.mail) return { ok: false, text: NO_LOBBY.replace("admin rank and bans can't be changed here", "mail can't be sent from here") };
    if (me.userId == null) return { ok: false, text: 'Sign in to an admin account to send mail' };
    if (!to || !text) return { ok: false, text: 'Usage: /mail name|everyone [subject |] text' };
    const bar = text.indexOf('|');
    const subject = bar > 0 ? text.slice(0, bar).trim() : '';
    const body = bar > 0 ? text.slice(bar + 1).trim() : text;
    const everyone = /^(\*|everyone|all)$/i.test(to);
    const r = await accounts.mail(everyone ? null : to, subject, body, me.username);
    return { ok: true, text: r.to === '*' ? `Mailed everyone (${r.sent} accounts)` : `Mailed ${r.to}` };
  }

  /** Has the owner rank (by their account, or their connection) */
  private isOwner(t: { online: AdminConn | null; info: AccountInfo | null }): boolean {
    return !!(t.info?.isOwner ?? t.online?.isOwner);
  }

  /** Who the lobby is told the change is for (the lobby checks their rank too): a signed-in admin, by account name */
  private actor(me: AdminConn): string | undefined {
    return me.userId != null ? me.username : undefined;
  }

  /** Every connection signed in to that account */
  private sessions(t: { online: AdminConn | null; info: AccountInfo | null }): AdminConn[] {
    const id = t.info?.id ?? t.online?.userId;
    if (id == null) return t.online ? [t.online] : [];
    return this.host.conns().filter((c) => c.userId === id);
  }

  private travel(t: AdminConn, system: string, x: number, y: number, what: string): Result {
    return this.host.travel(t, system, x, y) ? { ok: true, text: `Moved ${what}` } : { ok: false, text: `Can't move ${t.username} there` };
  }

  /** A player by id, exact name, or unique name prefix */
  private find(ref: string): AdminConn | null {
    const conns = this.host.conns();
    const id = Number(ref.replace(/^#/, ''));
    if (Number.isInteger(id)) { const c = conns.find((x) => x.playerId === id); if (c) return c; }
    const low = ref.toLowerCase();
    const exact = conns.find((x) => x.username.toLowerCase() === low);
    if (exact) return exact;
    const pre = conns.filter((x) => x.username.toLowerCase().startsWith(low));
    return pre.length === 1 ? pre[0] : null;
  }

  private findStation(ref: string): AdminStation | null {
    const low = ref.toLowerCase();
    const all = this.host.stations();
    return all.find((s) => s.id === ref) ?? all.find((s) => s.name.toLowerCase() === low)
      ?? (all.filter((s) => s.name.toLowerCase().includes(low)).length === 1 ? all.find((s) => s.name.toLowerCase().includes(low))! : null);
  }

  /** Chat words into a command */
  private parseChat(me: AdminConn, cmd: string, a: string[], rest: string): { cmd: string; args: Args } | null {
    const isNum = (s?: string) => s !== undefined && s !== '' && Number.isFinite(Number(s));
    switch (cmd) {
      case 'help': case 'who': case 'clearpods': return { cmd, args: {} };
      case 'tp':
        if (isNum(a[0]) && isNum(a[1])) return { cmd, args: { x: a[0], y: a[1], system: a[2] } };
        if (a.length >= 3 && isNum(a[1]) && isNum(a[2])) return { cmd, args: { player: a[0], x: a[1], y: a[2], system: a[3] } };
        if (a.length === 2) return { cmd, args: { player: a[0], to: a[1] } };
        if (a.length === 1) return { cmd: 'goto', args: { to: a[0] } };
        return { cmd, args: {} };
      case 'goto': return { cmd, args: { to: rest.trim() } };
      case 'bring': case 'heal': case 'kill': return { cmd, args: { player: a[0] } };
      // (/kick is the party's)
      case 'boot': return { cmd: 'kick', args: { player: a[0], reason: a.slice(1).join(' ') } };
      case 'god': case 'hide': {
        const flag = a[0] === 'on' || a[0] === 'off' ? a.shift() : undefined;
        return { cmd, args: { on: flag, player: a[0] } };
      }
      case 'freebuild': return { cmd, args: { on: a[0] } };
      case 'crowd': return { cmd, args: { to: a[0] ?? '' } };
      case 'bank': return { cmd, args: { what: a[0], item: a[1], n: a[2] } };
      case 'hits': return { cmd, args: {} };
      case 'credits': case 'xp': case 'skillpoints': return { cmd, args: { n: a[0], player: a[1] } };
      case 'codex': return { cmd, args: a.length > 1 ? { player: a[0], what: a[1] } : { what: a[0] } };
      case 'give': {
        const n = isNum(a[1]) ? a[1] : undefined;
        return { cmd, args: { item: a[0], n: n ?? 1, player: n ? a[2] : a[1] } };
      }
      case 'spawn': {
        const count = a.find((w) => /^x\d+$/i.test(w));
        const words = a.filter((w) => w !== count);
        const factions = this.host.factions();
        const faction = words[0] && factions[words[0]] ? words.shift() : undefined;
        return { cmd, args: { faction, ships: words.length ? words : undefined, count: count ? Number(count.slice(1)) : undefined } };
      }
      case 'boss': return { cmd, args: { id: a[0] } };
      case 'clear': return { cmd, args: { radius: a[0] } };
      case 'event': return { cmd, args: { kind: a[0] } };
      case 'announce': return { cmd, args: { text: rest } };
      case 'contributor': return { cmd, args: { player: a[0], on: a[1] } };
      case 'contributors': return { cmd: 'contributor', args: {} };
      case 'players': return { cmd, args: { search: a[0] } };
      case 'rank': return { cmd, args: { player: a[0], rank: a[1] } };
      case 'ban': return { cmd, args: { player: a[0], duration: a[1], reason: a.slice(2).join(' ') } };
      case 'unban': return { cmd, args: { player: a[0] } };
      case 'mail': return { cmd, args: { to: a[0], text: rest.trim().slice((a[0] ?? '').length).trim() } };
    }
    void me;
    return null;
  }
}
