/**
 * Parties: up to four pilots flying together.
 *
 * Invite someone (by name, or from their info card), they accept, and you're a
 * party with a leader. Party members:
 *   - see each other on the map and as markers, wherever they are
 *   - share kill credit: a kill counts for every member nearby (bounty and story steps too)
 *   - fly in a wing: each other member within WING_RANGE adds WING_BONUS damage and mining yield
 *   - can rally (respawn beside a member who isn't in a fight)
 *   - take on fleet operations together (Operations), and talk on party chat (/p)
 *
 * Parties live only as long as their members are online.
 */

import type { ServerMessage, PartyMemberView } from '@space-game/common';
import type { PilotConn } from './Pilots.js';
import { dhypot } from '@space-game/common';

/** Party size when the host doesn't say (it's the leader's: econ/unlocks.ts) */
export const PARTY_MAX = 4;
/** Members this close (same system) count towards the wing bonus */
export const WING_RANGE = 3000;
/** Per wingmate in range: damage and mining yield */
export const WING_BONUS = 0.08;
/** Members this close share a kill */
export const SHARE_RANGE = 8000;
const INVITE_MS = 60_000;
/** Members' positions go to the party in steps this big (the map and the rally need no more), so a party that is only flying is not resent twice a second */
const POS_STEP = 1000;

export interface PartyHost {
  send(conn: PilotConn, msg: ServerMessage): void;
  toast(conn: PilotConn, text: string, kind?: 'info' | 'good' | 'warn' | 'bad'): void;
  /** An online pilot by name (any case) */
  byName(name: string): PilotConn | undefined;
  /** The pilot flying this entity */
  byEntity(eid: number): PilotConn | undefined;
  /** Where a member is and how they're doing (null if they have no ship right now) */
  status(conn: PilotConn): { system: string; x: number; y: number; hull: number; alive: boolean; level: number; ship: string } | null;
  /** How many pilots this one's party holds (theirs as leader) */
  partySize?(conn: PilotConn): number;
  /** Wingmates in range changed: damage and mining multiplier for this pilot */
  setWing?(conn: PilotConn, k: number): void;
  now(): number;
}

interface PartyRec {
  id: number;
  leader: PilotConn;
  members: PilotConn[];
}

export class Party {
  private parties = new Map<number, PartyRec>();
  private of = new Map<PilotConn, number>();
  private invites = new Map<PilotConn, { from: PilotConn; at: number }>();
  private wing = new Map<PilotConn, number>();
  /** What each member was last sent of their party (JSON): an unchanged party is not sent again */
  private sent = new WeakMap<PilotConn, string>();
  private lastPing = new WeakMap<PilotConn, number>();
  private nextId = 1;
  private ticks = 0;

  constructor(private host: PartyHost) {}

  /** Everyone in this pilot's party (themselves included), or just them */
  members(conn: PilotConn): PilotConn[] {
    const p = this.get(conn);
    return p ? [...p.members] : [conn];
  }

  /** Party id (0 = flying solo) */
  partyId(conn: PilotConn): number {
    return this.of.get(conn) ?? 0;
  }

  size(conn: PilotConn): number {
    return this.get(conn)?.members.length ?? 1;
  }

  isLeader(conn: PilotConn): boolean {
    return this.get(conn)?.leader === conn;
  }

  leaderName(conn: PilotConn): string | undefined {
    return this.get(conn)?.leader.username;
  }

  same(a: PilotConn, b: PilotConn): boolean {
    const id = this.of.get(a);
    return id !== undefined && id === this.of.get(b);
  }

  /** Damage / mining multiplier from wingmates in range */
  wingBonus(conn: PilotConn): number {
    return this.wing.get(conn) ?? 1;
  }

  private get(conn: PilotConn): PartyRec | undefined {
    const id = this.of.get(conn);
    return id === undefined ? undefined : this.parties.get(id);
  }

  // ---------------------------------------------------------------------------
  // Requests
  // ---------------------------------------------------------------------------

  invite(conn: PilotConn, who: { name?: string; id?: number }): void {
    const target = who.id !== undefined ? this.host.byEntity(Number(who.id)) : this.host.byName(String(who.name ?? '').trim());
    if (!target) return this.host.toast(conn, who.name ? `No pilot called ${who.name} is online` : 'That pilot is gone', 'warn');
    if (target === conn) return this.host.toast(conn, "You can't invite yourself", 'warn');
    const mine = this.get(conn);
    if (mine && mine.leader !== conn) return this.host.toast(conn, `Only your party leader (${mine.leader.username}) can invite`, 'warn');
    const max = this.host.partySize?.(mine?.leader ?? conn) ?? PARTY_MAX;
    if (mine && mine.members.length >= max) return this.host.toast(conn, `Your party holds ${max} pilots`, 'warn');
    if (this.of.has(target)) return this.host.toast(conn, `${target.username} is already in a party`, 'warn');
    this.invites.set(target, { from: conn, at: this.host.now() });
    this.host.send(target, { type: 'partyInvite', from: conn.username, size: mine?.members.length ?? 1 });
    this.host.toast(conn, `Invited ${target.username} to your party`, 'info');
  }

  respond(conn: PilotConn, accept: boolean): void {
    const inv = this.invites.get(conn);
    this.invites.delete(conn);
    if (!inv || this.host.now() - inv.at > INVITE_MS) return this.host.toast(conn, 'That invitation has expired', 'warn');
    if (!accept) return this.host.toast(inv.from, `${conn.username} declined your invitation`, 'info');
    if (this.of.has(conn)) return this.host.toast(conn, 'Leave your party first', 'warn');
    let p = this.get(inv.from);
    if (p && p.leader !== inv.from) return this.host.toast(conn, 'That invitation is no longer valid', 'warn');
    if (!p) {
      if (!this.host.status(inv.from) && !this.connected(inv.from)) return this.host.toast(conn, `${inv.from.username} has gone`, 'warn');
      p = { id: this.nextId++, leader: inv.from, members: [inv.from] };
      this.parties.set(p.id, p);
      this.of.set(inv.from, p.id);
    }
    if (p.members.length >= (this.host.partySize?.(p.leader) ?? PARTY_MAX)) return this.host.toast(conn, 'That party is full', 'warn');
    p.members.push(conn);
    this.of.set(conn, p.id);
    for (const m of p.members) this.host.toast(m, m === conn ? `You joined ${p.leader.username}'s party` : `${conn.username} joined the party`, 'good');
    this.broadcast(p);
  }

  leave(conn: PilotConn): void {
    const p = this.get(conn);
    if (!p) return;
    for (const m of p.members) if (m !== conn) this.host.toast(m, `${conn.username} left the party`, 'info');
    this.host.toast(conn, 'You left the party', 'info');
    this.drop(p, conn);
  }

  kick(conn: PilotConn, name: string): void {
    const p = this.get(conn);
    if (!p || p.leader !== conn) return this.host.toast(conn, 'Only the party leader can do that', 'warn');
    const m = p.members.find((x) => x.username.toLowerCase() === String(name).toLowerCase());
    if (!m || m === conn) return;
    this.host.toast(m, `${conn.username} removed you from the party`, 'warn');
    for (const x of p.members) if (x !== m) this.host.toast(x, `${m.username} was removed from the party`, 'info');
    this.drop(p, m);
  }

  promote(conn: PilotConn, name: string): void {
    const p = this.get(conn);
    if (!p || p.leader !== conn) return this.host.toast(conn, 'Only the party leader can do that', 'warn');
    const m = p.members.find((x) => x.username.toLowerCase() === String(name).toLowerCase());
    if (!m || m === conn) return;
    p.leader = m;
    for (const x of p.members) this.host.toast(x, `${m.username} now leads the party`, 'info');
    this.broadcast(p);
  }

  /** Disconnected */
  remove(conn: PilotConn): void {
    this.invites.delete(conn);
    for (const [k, inv] of this.invites) if (inv.from === conn) this.invites.delete(k);
    this.wing.delete(conn);
    const p = this.get(conn);
    if (!p) return;
    for (const m of p.members) if (m !== conn) this.host.toast(m, `${conn.username} went offline and left the party`, 'info');
    this.drop(p, conn);
  }

  /** A ping: everyone in the party sees it (flying solo, just you) */
  ping(conn: PilotConn, msg: { x: number; y: number; kind: string; target?: number }, system: string): void {
    const now = this.host.now();
    if (now - (this.lastPing.get(conn) ?? 0) < 600) return;
    this.lastPing.set(conn, now);
    const kind = (['here', 'attack', 'danger', 'loot'] as const).find((k) => k === msg.kind) ?? 'here';
    const x = Math.round(Number(msg.x)), y = Math.round(Number(msg.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const target = Number.isInteger(msg.target) ? msg.target : undefined;
    for (const m of this.members(conn)) this.host.send(m, { type: 'mapPing', from: conn.username, system, x, y, kind, target });
  }

  /** Party chat */
  chat(conn: PilotConn, text: string): boolean {
    const p = this.get(conn);
    if (!p) { this.host.toast(conn, "You're not in a party", 'warn'); return false; }
    for (const m of p.members) this.host.send(m, { type: 'chat', playerId: 0, playerName: `[Party] ${conn.username}`, text, timestamp: this.host.now() } as ServerMessage);
    return true;
  }

  private drop(p: PartyRec, conn: PilotConn): void {
    p.members = p.members.filter((m) => m !== conn);
    this.of.delete(conn);
    this.wing.delete(conn);
    this.host.setWing?.(conn, 1);
    this.sent.delete(conn);
    this.host.send(conn, { type: 'party', id: 0, leader: '', members: [] });
    if (p.members.length <= 1) {
      // A party of one is no party
      for (const m of p.members) {
        this.of.delete(m);
        this.wing.delete(m);
        this.host.setWing?.(m, 1);
        this.sent.delete(m);
        this.host.send(m, { type: 'party', id: 0, leader: '', members: [] });
        if (m !== conn) this.host.toast(m, 'Your party has disbanded', 'info');
      }
      this.parties.delete(p.id);
      return;
    }
    if (p.leader === conn) p.leader = p.members[0];
    this.broadcast(p);
  }

  private connected(conn: PilotConn): boolean {
    return this.host.byEntity(conn.playerId) === conn;
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  /** Twice a second: member positions and health to the party, and the wing bonus */
  tick(): void {
    if (++this.ticks % 30) return;
    for (const p of this.parties.values()) {
      const st = new Map(p.members.map((m) => [m, this.host.status(m)]));
      for (const m of p.members) {
        const me = st.get(m);
        let near = 0;
        if (me?.alive) {
          for (const o of p.members) {
            const s = st.get(o);
            if (o !== m && s?.alive && s.system === me.system && dhypot(s.x - me.x, s.y - me.y) < WING_RANGE) near++;
          }
        }
        const k = 1 + WING_BONUS * Math.min(3, near);
        if (k !== (this.wing.get(m) ?? 1)) {
          this.wing.set(m, k);
          this.host.setWing?.(m, k);
        }
      }
      this.broadcast(p, st);
    }
  }

  private broadcast(p: PartyRec, st = new Map(p.members.map((m) => [m, this.host.status(m)]))): void {
    const members: PartyMemberView[] = p.members.map((m) => {
      const s = st.get(m);
      return {
        name: m.username, eid: m.playerId, leader: m === p.leader, level: s?.level ?? 1, ship: s?.ship ?? '',
        system: s?.system ?? '', x: Math.round((s?.x ?? 0) / POS_STEP) * POS_STEP, y: Math.round((s?.y ?? 0) / POS_STEP) * POS_STEP, hull: Math.round((s?.hull ?? 0) * 20) * 5, alive: !!s?.alive,
        wing: this.wing.get(m) ?? 1,
      };
    });
    const msg = { type: 'party' as const, id: p.id, leader: p.leader.username, members };
    const key = JSON.stringify(msg);
    for (const m of p.members) {
      if (this.sent.get(m) === key) continue;
      this.sent.set(m, key);
      this.host.send(m, msg);
    }
  }
}
