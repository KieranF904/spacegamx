/**
 * Outgoing messages: each client's outbox (one frame per client per tick, or straight after one of its requests),
 * the effects that can wait for the next frame (lazy), the broadcasts to a system or to the clients near a point, and
 * the byte counters the admin dashboard reads. Moved verbatim from GameServer, which keeps one-line delegates
 * (send, flushOutbox, flushLazy, broadcastToSystem, broadcastProjectileHit, broadcastNear) and bumps `batching`
 * around a tick or a request.
 *
 * Per-tick path: no closures or objects beyond what the moved bodies already made; the host's pieces are plain fields.
 *
 * A joined client (every one runs the full caps set) gets its messages through its PackedLink (ClientConnection.packed):
 * each frame a sub-frame of a bit-packed message, frames with nothing urgent waiting a few ticks to share one
 * (PackedLink.ts). Base-format frames are only for a connection that hasn't joined yet (sign-in answers).
 */
import { hasComponent, type IWorld } from 'bitecs';
import { BlockStore, InSystem, Player, Position, encodeServerMessage, serverFrame, type ClientSocket, type ServerMessage, dhypot } from '@space-game/common';
import type { ClientConnection } from '../ClientConnection.js';
import { LAZY_TYPES, LAZY_TICKS, FX_RANGE, COALESCE_TICKS } from './constants.js';
import { PackedLink } from './PackedLink.js';

/** What the outbox needs of the server (GameServer itself) */
export interface OutboxHost {
  readonly world: IWorld;
  readonly clients: ReadonlyMap<ClientSocket, ClientConnection>;
  readonly currentTick: number;
}

export class Outbox {
  private readonly world: IWorld;
  private readonly clients: ReadonlyMap<ClientSocket, ClientConnection>;
  private readonly host: OutboxHost;
  /**
   * Encode-once blocks: every packed link's snapshot rows about other entities, each bit-packed once a
   * snapshot (common network/packed/blocks.ts). SnapshotBuilder tells it what was removed (its wire ids go back)
   */
  readonly blocks = new BlockStore((eid) => InSystem.systemId[eid]);
  /** Bytes sent since the admin dashboard last asked, all told and by message type (it resets them) */
  snapshotBytesSent = 0;
  bytesByType: Record<string, number> = {};

  constructor(host: OutboxHost) {
    this.world = host.world;
    this.clients = host.clients;
    this.host = host;
  }

  private get currentTick(): number {
    return this.host.currentTick;
  }

  /** Get byte length of encoded message (string or ArrayBuffer) */
  private getMessageByteLength(data: string | ArrayBuffer | Uint8Array): number {
    if (typeof data === 'string') {
      return data.length; // Approximation for ASCII/UTF-8 JSON
    }
    return data.byteLength;
  }

  /**
   * Messages for a client wait in its outbox and go out together, one frame per
   * tick (or straight after handling one of its requests), instead of a frame each.
   */
  readonly outbox = new Map<ClientSocket, Uint8Array[]>();
  /** Inside a tick or a request: messages wait for the flush (outside, e.g. timers, they go at once) */
  batching = 0;

  /**
   * Effects only for the eye and ear (hit sparks, damage numbers, parts blowing
   * off, bumps) needn't have a frame of their own: they wait (up to LAZY_TICKS)
   * to go with the next frame a client gets anyway, usually a snapshot. Saves
   * a packet's headers each time, for a delay of a tick or two.
   */
  readonly lazy = new Map<ClientSocket, { since: number; parts: Uint8Array[] }>();

  send(ws: ClientSocket, msg: ServerMessage): void {
    if (ws.isOpen()) {
      const conn = this.clients.get(ws);
      if (conn && this.packedOf(conn)) { this.packedQueue(conn, msg, null); return; }
      const data = encodeServerMessage(msg);
      const byteLen = data.length;
      this.snapshotBytesSent += byteLen;
      this.bytesByType[msg.type] = (this.bytesByType[msg.type] || 0) + byteLen;
      // Pongs go at once: they measure the round trip
      if (msg.type === 'pong') { ws.send(serverFrame([data])); return; }
      this.queue(ws, data, LAZY_TYPES.has(msg.type));
    }
  }

  /** A client's packed link once it has joined (made then; before, sign-in answers go as base frames) */
  private packedOf(conn: ClientConnection): PackedLink | null {
    if (!conn.joined) return null;
    if (!conn.packed) {
      conn.packed = new PackedLink(conn, this.blocks);
      // (Effects waiting in the base format go first)
      const l = this.lazy.get(conn.ws);
      if (l) { this.lazy.delete(conn.ws); if (conn.ws.isOpen()) conn.ws.send(serverFrame(l.parts)); }
    }
    return conn.packed;
  }

  /** A message for a packed client (it has a link: packedOf): as queue does (a pong, or outside a tick or request: at once) */
  private packedQueue(conn: ClientConnection, msg: ServerMessage, bytes: Uint8Array | null): void {
    const link = conn.packed!;
    if (msg.type === 'pong' || !this.batching) { this.countPacked(link.now({ msg, bytes }, this.currentTick)); return; }
    // (The first snapshot after a hit to or from its ship goes at once; not once it finds its own hits)
    if (msg.type === 'snapshot' && this.hitPilots.delete(conn.playerId) && !conn.started) link.wantSnapshot = true;
    link.add({ msg, bytes }, LAZY_TYPES.has(msg.type), this.currentTick);
    this.packedWaiting.add(conn);
  }

  private countPacked(n: number): void {
    if (!n) return;
    this.snapshotBytesSent += n;
    this.bytesByType['(packed)'] = (this.bytesByType['(packed)'] || 0) + n;
  }

  /** Pilots hit, or whose ships hit something, and when (a packed link sends the next snapshot after at once) */
  private readonly hitPilots = new Map<number, number>();
  private prunedAt = -1;
  /** Packed clients with something waiting (only they are looked at in a flush: one runs after every request) */
  private readonly packedWaiting = new Set<ClientConnection>();

  private queue(ws: ClientSocket, data: Uint8Array, lazy = false): void {
    if (!this.batching) { ws.send(serverFrame([data])); return; }
    if (lazy) {
      const l = this.lazy.get(ws);
      if (l) l.parts.push(data); else this.lazy.set(ws, { since: this.currentTick, parts: [data] });
      return;
    }
    const box = this.outbox.get(ws);
    if (box) box.push(data); else this.outbox.set(ws, [data]);
  }

  /** Send everything waiting: one frame per client (effects that can wait, wait: see lazy) */
  flushOutbox(): void {
    for (const [ws, box] of this.outbox) {
      const l = this.lazy.get(ws);
      if (l) this.lazy.delete(ws);
      if (ws.isOpen() && box.length) ws.send(serverFrame(l ? [...l.parts, ...box] : box));
    }
    this.outbox.clear();
    for (const [ws, l] of this.lazy) {
      if (!ws.isOpen()) { this.lazy.delete(ws); continue; }
      if (this.currentTick - l.since >= LAZY_TICKS) { ws.send(serverFrame(l.parts)); this.lazy.delete(ws); }
    }
    // Packed clients: the same frames, as sub-frames (coalesced)
    for (const conn of this.packedWaiting) {
      const link = conn.packed;
      if (!link || this.clients.get(conn.ws) !== conn) { this.packedWaiting.delete(conn); continue; }
      this.countPacked(link.flush(this.currentTick, COALESCE_TICKS));
      if (!link.waiting) this.packedWaiting.delete(conn);
    }
    // (A hit's snapshot is due within a snapshot's ticks; older marks are for clients that got none. Once a tick)
    if (this.hitPilots.size && this.prunedAt !== this.currentTick) {
      this.prunedAt = this.currentTick;
      for (const [pid, at] of this.hitPilots) if (this.currentTick - at > 2 * LAZY_TICKS + COALESCE_TICKS) this.hitPilots.delete(pid);
    }
  }

  /** Send the effects still waiting now (tests that look at a tick's messages straight after it) */
  flushLazy(): void {
    for (const [ws, l] of this.lazy) if (ws.isOpen()) ws.send(serverFrame(l.parts));
    this.lazy.clear();
    for (const conn of this.packedWaiting) if (conn.packed) this.countPacked(conn.packed.flushLazy(this.currentTick));
  }

  /** `skip`: leave out the clients it says (a move's look a client works out itself: GameServer.moveFx) */
  broadcastToSystem(systemId: number, msg: ServerMessage, skip?: (client: ClientConnection) => boolean): void {
    // An effect only for the eye and ear (LAZY_TYPES) that happens somewhere goes only to clients near enough to see it
    if (LAZY_TYPES.has(msg.type)) {
      const at = fxPoint(msg);
      if (at) { this.broadcastNear(systemId, at[0], at[1], msg, [], skip); return; }
    }
    const data = encodeServerMessage(msg);
    const byteLen = this.getMessageByteLength(data);
    let sent = 0;
    for (const client of this.clients.values()) {
      // (System first: the cheapest check, and it rules out most)
      if (InSystem.systemId[client.playerId] !== systemId) continue;
      if (!client.ws.isOpen() || !hasComponent(this.world, Player, client.playerId)) continue;
      if (skip?.(client)) continue;
      if (this.packedOf(client)) this.packedQueue(client, msg, data);
      else { this.queue(client.ws, data, LAZY_TYPES.has(msg.type)); sent++; }
    }
    const total = byteLen * sent;
    this.snapshotBytesSent += total;
    this.bytesByType[msg.type] = (this.bytesByType[msg.type] || 0) + total;
  }

  /**
   * Damage dealt since the last snapshot, summed per target, source and glancing (one number for a burst of hits, not
   * one each), handed on when the next snapshot goes (flushDamage) for each client's share (HitLedger.write), to a tenth
   */
  private readonly damageSums = new Map<string, { sys: number; target: number; source: number; glancing: boolean; amount: number }>();

  addDamage(systemId: number, target: number, amount: number, source: number, glancing: boolean): void {
    this.hitPilots.set(target, this.currentTick);
    this.hitPilots.set(source, this.currentTick);
    const key = `${target},${source},${glancing ? 1 : 0}`;
    const e = this.damageSums.get(key);
    if (e) e.amount += amount;
    else this.damageSums.set(key, { sys: systemId, target, source, glancing, amount });
  }

  /**
   * The sums the last flushDamage handed on: each client's share, less what its hit records cover, goes after its
   * snapshot (net/hits/HitLedger.ts write), until the next flush
   */
  heldDamage: { sys: number; target: number; source: number; glancing: boolean; amount: number }[] = [];

  /** The damage summed since the last snapshot, handed on for the clients' shares (just before the snapshot) */
  flushDamage(): void {
    this.heldDamage = [...this.damageSums.values()];
    this.damageSums.clear();
  }

  /** A shell's end told to everyone near (one that hit no ship: a rock, a station; or a stuck shell) */
  broadcastProjectileHit(proj: number, x: number, y: number): void {
    this.broadcastNear(InSystem.systemId[proj], x, y, projectileHitMessage(proj, x, y));
  }

  /** Clients in a system near a point (combat effects: nobody further out has the ships involved) */
  broadcastNear(systemId: number, x: number, y: number, msg: ServerMessage, also: number[] = [], skip?: (client: ClientConnection) => boolean): void {
    const data = encodeServerMessage(msg);
    // (A part of a piece of debris crumbling: a client running the piece (or told to, its check on the way) shows that
    // itself, CAPS.DEBRIS)
    const crumble = msg.type === 'partDestroyed' && msg.how === 'crumble' ? msg.bodyId : -1;
    for (const client of this.clients.values()) {
      if (InSystem.systemId[client.playerId] !== systemId) continue;
      if (!client.ws.isOpen() || !hasComponent(this.world, Player, client.playerId)) continue;
      const pid = client.playerId;
      if (dhypot(Position.x[pid] - x, Position.y[pid] - y) > FX_RANGE && !also.includes(pid)) continue;
      if (crumble >= 0 && (client.debrisLive?.has(crumble) || client.debrisHeld.get(crumble)?.live)) continue;
      if (skip?.(client)) continue;
      if (this.packedOf(client)) { this.packedQueue(client, msg, data); continue; }
      this.queue(client.ws, data, LAZY_TYPES.has(msg.type));
      this.snapshotBytesSent += this.getMessageByteLength(data);
    }
  }

  /** Would broadcastNear send this client something (in the system, near the point, or `also`)? */
  nearClient(client: ClientConnection, systemId: number, x: number, y: number, also = -1): boolean {
    if (InSystem.systemId[client.playerId] !== systemId) return false;
    if (!client.ws.isOpen() || !hasComponent(this.world, Player, client.playerId)) return false;
    const pid = client.playerId;
    return dhypot(Position.x[pid] - x, Position.y[pid] - y) <= FX_RANGE || pid === also;
  }

  /** One client's copy of what broadcastToSystem sends (a confirmed hit gone the old way after all) */
  sendAsSystem(client: ClientConnection, systemId: number, msg: ServerMessage): void {
    const at = LAZY_TYPES.has(msg.type) ? fxPoint(msg) : null;
    if (at ? this.nearClient(client, systemId, at[0], at[1]) : InSystem.systemId[client.playerId] === systemId && client.ws.isOpen() && hasComponent(this.world, Player, client.playerId)) this.send(client.ws, msg);
  }
}

/** A damage sum's message, as flushDamage sends it */
export function damageMessage(e: { target: number; source: number; glancing: boolean }, amount: number): ServerMessage {
  return { type: 'damage', targetId: e.target, amount, sourceId: e.source, ...(e.glancing ? { glancing: true } : {}) };
}

/** A shell's hit point, as broadcastProjectileHit sends it */
export function projectileHitMessage(proj: number, x: number, y: number): ServerMessage {
  return { type: 'projectileHit', id: proj, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

/** Where an effect happens: its own x, y, or the entity it's about (a part catching fire, a station firing). null: nowhere in particular */
function fxPoint(msg: ServerMessage): [number, number] | null {
  const m = msg as unknown as Record<string, unknown>;
  if (typeof m.x === 'number' && typeof m.y === 'number') return [m.x, m.y];
  const id = m.bodyId ?? m.targetId ?? m.station ?? m.entityId;
  return typeof id === 'number' ? [Position.x[id], Position.y[id]] : null;
}
