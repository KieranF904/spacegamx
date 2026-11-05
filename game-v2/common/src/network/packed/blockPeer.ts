/**
 * Encode-once blocks (CAPS.BLOCKS, blocks.ts): what one connection's two ends keep of them. Both ends change it only
 * with what goes through the connection, in the same order, so they agree; a reset clears both.
 *
 * Reader (the client): its wire id table (wid -> entity id) and, per entity, the chain bases its blocks were last
 * settled to (`e` its status rows', `k` its keyframes'). Writer (the server's encoder for that client): the ids it
 * has introduced (entity -> wid, and wid -> entity, so a wid given to another entity drops the first), and per entity
 * the chain generation the client holds (-1: none it can step from, so an absolute block goes).
 *
 * No imports: packedIO.ts makes one per PackedIO.
 */
export class BlockPeer {
  // ---- Reader ----
  readonly wids = new Map<number, number>();
  readonly chains = new Map<number, { e?: number[]; k?: number[] }>();
  // ---- Writer ----
  readonly intro = new Map<number, number>();
  readonly owner = new Map<number, number>();
  readonly gens = new Map<number, { e: number; k: number }>();
  /** Shell rows' gun chains (blocks.ts gunKey): the reader's bases, the writer's generations. Both ends hold the same keys */
  readonly guns = new Map<number, number[]>();
  readonly gunGens = new Map<number, number>();

  reset(): void {
    this.guns.clear();
    this.gunGens.clear();
    this.wids.clear();
    this.chains.clear();
    this.intro.clear();
    this.owner.clear();
    this.gens.clear();
  }

  /** (Writer) Is this entity known to the client by this wid? */
  knows(eid: number, wid: number): boolean {
    return this.intro.get(eid) === wid;
  }

  /** (Writer) The client is told wid = eid: whatever had that wid before is no longer known by it */
  introduce(eid: number, wid: number): void {
    const was = this.owner.get(wid);
    if (was !== undefined && was !== eid) { this.intro.delete(was); this.gens.delete(was); }
    const old = this.intro.get(eid);
    if (old !== undefined && old !== wid) this.owner.delete(old);
    this.intro.set(eid, wid);
    this.owner.set(wid, eid);
  }

  /** (Writer) The generation the client holds of an entity's chain (`k`: keyframes; else status rows), -1 none */
  gen(eid: number, k: boolean): number {
    const g = this.gens.get(eid);
    return g ? (k ? g.k : g.e) : -1;
  }

  setGen(eid: number, k: boolean, gen: number): void {
    let g = this.gens.get(eid);
    if (!g) { g = { e: -1, k: -1 }; this.gens.set(eid, g); }
    if (k) g.k = gen; else g.e = gen;
  }

  /** Both ends, after each BLOCKS snapshot: the gun chains start afresh when there are many (both ends have the same keys) */
  trimGuns(): void {
    if (this.guns.size > 4096) this.guns.clear();
    if (this.gunGens.size > 4096) this.gunGens.clear();
  }

  /** Both ends, after a snapshot that removed or dropped an entity (its removed and out lists): its chains go */
  forget(eid: number): void {
    this.chains.delete(eid);
    this.gens.delete(eid);
  }
}
