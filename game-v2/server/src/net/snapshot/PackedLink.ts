/**
 * One client's bit-packed frames (CAPS.PACKED) and their coalescing (CAPS.COALESCE): what Outbox does for a base-format
 * client (a frame per flush, effects that wait LAZY_TICKS for the next one), but each frame becomes a sub-frame of a
 * packed WebSocket message (common network/packed), and with coalescing a sub-frame with nothing urgent in it waits up
 * to COALESCE_TICKS for the next, so several ticks share one message's headers (~66 B on the wire each).
 *
 * Urgent (sent at once, with whatever waits before it): anything but the tick's stream (CAN_WAIT: answers to requests,
 * deaths, corrections, boss warnings...), a snapshot that corrects the client's own ship (its row or a keyframe), damage
 * to or from it, and the first snapshot after a hit to or from its ship (`wantSnapshot`: Outbox.addDamage marks it).
 * A client that finds its own hits (CAPS.HITS + CAPS.SELF_HITS: `quietHits`) gets none of the hit ones, nor its own
 * row when it went only for its HP or as the periodic safety copy (ClientConnection.selfRowQuiet): it draws its
 * own shells' impacts from what it finds as the snapshot comes, and others' shells (drawn a coalescing hold behind on
 * its interpolated timeline) land when their drawn heads get there, so a hit's frame waiting COALESCE_TICKS changes
 * only when its HP numbers confirm (docs/design/packed-frames.md, follow-ups).
 *
 * The bytes go out through the client's own socket; Outbox counts them.
 */
import { CAPS, PackedEncoder, encodeServerMessage, serverFrame, type BlockStore, type PackedPart, type ServerMessage } from '@space-game/common';
import type { ClientConnection } from '../ClientConnection.js';
import { LAZY_TICKS } from './constants.js';

/** The tick's stream: these can wait for the next frame; anything else is urgent */
const CAN_WAIT = new Set([
  'snapshot', 'damage', 'projectileHit', 'partDestroyed', 'contact', 'detonation', 'ignite', 'stationFire', 'intercept',
  'shipHps', 'shipSync', 'debrisSplit', 'hits', 'hpCheck', 'mapDots', 'pops', 'playerState', 'effect', 'party', 'ops',
  // (The economy views: a purchase's or a pickup's answer is up to COALESCE_TICKS late, 50 ms, and shares the next frame's headers)
  'items', 'profile', 'quests', 'people',
]);

/**
 * Why this message makes its frame go at once (for the client flying `pid`; `quietHits`: it finds its own hits, so
 * damage to or from it can wait), or null: it can wait
 */
export function urgentFor(msg: ServerMessage, pid: number, quietHits = false): string | null {
  if (!CAN_WAIT.has(msg.type)) return msg.type;
  if (msg.type === 'snapshot') {
    for (const e of msg.entities) if (e.id === pid) return 'ownRow';
    if (msg.ships) for (const k of msg.ships) if (k[0] === pid) return 'ownKeyframe';
    return null;
  }
  if (msg.type === 'damage' && !quietHits && (msg.targetId === pid || msg.sourceId === pid)) return 'damage';
  return null;
}

/** A client that finds its own hits (part D): nothing about its hits is urgent */
export function quietHits(caps: number | undefined): boolean {
  return ((caps ?? 0) & (CAPS.HITS | CAPS.SELF_HITS)) === (CAPS.HITS | CAPS.SELF_HITS);
}

const RAW = { raw: true } as const;

/** Does this client take its snapshots in encode-once blocks (CAPS.BLOCKS, with PACKED: common network/packed/blocks.ts)? */
export function blocksFor(caps: number | undefined): boolean {
  return ((caps ?? 0) & (CAPS.PACKED | CAPS.BLOCKS)) === (CAPS.PACKED | CAPS.BLOCKS);
}

export class PackedLink {
  readonly enc: PackedEncoder;
  /** This flush's messages, the effects waiting for a frame, and the sub-frames waiting to go (coalescing) */
  private box: PackedPart[] = [];
  private lazy: PackedPart[] = [];
  private lazySince = -1;
  private held: PackedPart[][] = [];
  private heldSince = -1;
  private urgent = false;
  /** The next snapshot goes at once (a hit to or from its ship: Outbox.addDamage) */
  wantSnapshot = false;
  /** WebSocket messages, sub-frames and bytes sent; messages sent early for being urgent, and what made each so (the netcode probe) */
  readonly stats = { messages: 0, subFrames: 0, bytes: 0, urgent: 0, failed: 0, why: {} as Record<string, number> };
  /** What first made the waiting frames urgent */
  private why = '';

  /** `blocks`: the server's encode-once blocks, shared by every link (its snapshots go as blocks while it takes them) */
  constructor(private readonly conn: ClientConnection, blocks: BlockStore | null = null) {
    this.enc = new PackedEncoder(blocks);
  }

  /** A snapshot's blocks are made as it's queued (in snapshot order, whenever its frame goes) */
  private prepare(part: PackedPart): void {
    if (part.msg.type === 'snapshot' && blocksFor(this.conn.caps)) this.enc.prepare(part.msg, this.conn.playerId);
  }

  /** Anything waiting (this flush's messages, effects, sub-frames held back) */
  get waiting(): boolean {
    return this.box.length > 0 || this.lazy.length > 0 || this.held.length > 0;
  }

  /** A message for the next flush (`lazy`: an effect that can wait LAZY_TICKS for a frame) */
  add(part: PackedPart, lazy: boolean, tick: number): void {
    this.prepare(part);
    if (lazy) {
      if (!this.lazy.length) this.lazySince = tick;
      this.lazy.push(part);
    } else this.box.push(part);
    const quiet = quietHits(this.conn.caps);
    let why = urgentFor(part.msg, this.conn.playerId, quiet);
    // (its own row only for its HP, or now and then: not a correction)
    if (why === 'ownRow' && quiet && this.conn.selfRowQuiet) why = null;
    if (why) this.markUrgent(why);
    else if (this.wantSnapshot && part.msg.type === 'snapshot') { this.markUrgent('hitSnapshot'); this.wantSnapshot = false; }
  }

  /**
   * The flush (Outbox.flushOutbox): this flush's messages become a sub-frame (the effects waiting ride with them, or go
   * alone once they've waited LAZY_TICKS), then what waits goes if coalescing is off, it's urgent, or it has waited
   * `coalesce` ticks. Returns the bytes sent
   */
  flush(tick: number, coalesce: number): number {
    if (this.box.length) {
      this.hold(this.lazy.length ? this.lazy.concat(this.box) : this.box, tick);
      this.box = [];
      this.lazy = [];
    } else if (this.lazy.length && tick - this.lazySince >= LAZY_TICKS) {
      this.hold(this.lazy, tick);
      this.lazy = [];
    }
    if (!this.held.length) return 0;
    if (!coalesce || this.urgent || tick - this.heldSince >= coalesce) return this.emit();
    return 0;
  }

  /** A message that goes now (a pong, or one sent outside a tick or request), after whatever waits */
  now(part: PackedPart, tick: number): number {
    this.prepare(part);
    this.hold([part], tick);
    return this.emit();
  }

  /** The effects waiting go now, with whatever waits (Outbox.flushLazy) */
  flushLazy(tick: number): number {
    if (this.lazy.length) { this.hold(this.lazy, tick); this.lazy = []; }
    return this.held.length ? this.emit() : 0;
  }

  /** Everything goes now (the client switched packed frames off: the base format follows) */
  drain(tick: number): number {
    if (this.box.length || this.lazy.length) this.hold(this.lazy.concat(this.box), tick);
    this.box = [];
    this.lazy = [];
    return this.held.length ? this.emit() : 0;
  }

  /** The client lost track (packedResync): the next message starts afresh */
  resync(): void {
    this.enc.reset();
  }

  private markUrgent(why: string): void {
    if (!this.urgent) this.why = why;
    this.urgent = true;
  }

  private hold(sub: PackedPart[], tick: number): void {
    if (!sub.length) return;
    if (!this.held.length) this.heldSince = tick;
    this.held.push(sub);
  }

  private emit(): number {
    let data: Uint8Array;
    try {
      data = this.enc.encode(this.held, this.conn.playerId);
    } catch (e) {
      // (A message the codec choked on: its tables may be half written, so the next packed message starts afresh, and
      // these frames go in the base format, which the client reads as ever. Never thrown into the tick)
      this.enc.reset();
      this.stats.failed++;
      if (this.stats.failed === 1) console.error('[packed] encode failed; sent as base frames', e);
      return this.emitBase();
    }
    this.stats.messages++;
    this.stats.subFrames += this.held.length;
    this.stats.bytes += data.length;
    if (this.urgent) { this.stats.urgent++; this.stats.why[this.why] = (this.stats.why[this.why] ?? 0) + 1; }
    this.held = [];
    this.heldSince = -1;
    this.urgent = false;
    // (Encode-once frames go undeflated: bit-packed already, and deflate is per socket: docs/design/awareness-model.md 7.6)
    if (this.conn.ws.isOpen()) this.conn.ws.send(data, blocksFor(this.conn.caps) ? RAW : undefined);
    return data.length;
  }

  /** What waits, as base-format frames (one per sub-frame, in order) */
  private emitBase(): number {
    const held = this.held;
    this.held = [];
    this.heldSince = -1;
    this.urgent = false;
    let n = 0;
    for (const sub of held) {
      const data = serverFrame(sub.map((p) => p.bytes ?? encodeServerMessage(p.msg)));
      n += data.length;
      if (this.conn.ws.isOpen()) this.conn.ws.send(data);
    }
    return n;
  }
}
