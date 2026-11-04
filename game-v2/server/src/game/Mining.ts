/**
 * Mining: turning damage done to asteroids into ore.
 *
 * Every asteroid has a composition (common/src/econ/mining.ts): an ore mix, a
 * hardness, maybe a gem seam, and a number of ore units. Any weapon mines: the
 * ore extracted is damage × the tool's yield ÷ damagePerUnit, provided the tool
 * is hard enough for the rock (harder ores and gems need better tools).
 * Extracted ore breaks off as small chunks (loot pods) that the miner's tractor
 * pulls in. Breaking an asteroid wastes most of what's left; mining lasers
 * extract far more per damage, so they get the most out of a rock.
 * Broken asteroids come back after a while.
 *
 * Outliers (a rock in a hundred or so, several times the size) come apart in
 * stages: mined down to what the next stage holds, or blasted apart, a stage
 * breaks away and leaves a smaller rock with the ore that's left, until the
 * last stage breaks up like any other rock.
 */

import { Composition, MiningTable, Bag, asteroidComposition, pickOre, MARKS, type TraceSource, dcos, dhypot, dsin } from '@space-game/common';

export interface MiningTool {
  yield: number;
  hardness: number;
  /** A mining laser's grade (its yield depends on it against the rock's tier) */
  grade?: number;
}

/** A chunk thrown at its miner flies this much faster (units a tick, on top of 1.2 to 2.6) */
const CHUNK_BOOST = 3.6;

export interface MiningHost {
  /** Drop a chunk of ore as a loot pod (`miner`: who broke it off, for quests) */
  spawnChunk(systemNum: number, x: number, y: number, vx: number, vy: number, items: Bag, miner?: number): void;
  /** Where a miner is (a broken-off chunk is thrown to them) */
  minerAt?(playerEid: number): { x: number; y: number } | null;
  /** A player's chance of an extra unit of ore (mining skill, a wing) */
  miningSkill?(playerEid: number): number;
  /** Ore a player extracted from a rock (for the rare traces it will yield at the refinery) */
  mined?(playerEid: number, ores: Bag, from: TraceSource): void;
  /** Award mining XP to a player entity */
  awardXp(playerEid: number, xp: number): void;
  /** Tell a player something (throttled by the caller) */
  notify(playerEid: number, text: string): void;
  /** A rock type's tier for its traces here and now, if above the system's (the comet passing) */
  traceTier?(systemNum: number, type: string): number;
  /** A system's rock tier (its Mk: 1-5) */
  rockTier?(systemNum: number): number;
  /** Re-create an asteroid that broke */
  respawn(systemNum: number, index: number): void;
  /** A rock mined out: crumble it away (it will grow back) */
  crumble(asteroid: number): void;
  /** An outlier's stage broke away: put the next, smaller, in its place (holding `left` units) */
  shed?(asteroid: number, stage: number, size: number, left: number): void;
  tick(): number;
}

interface Rock extends Composition {
  /** The system's rock tier (Mk): mining lasers behind it make slow work of it */
  tier: number;
  systemNum: number;
  index: number;
  left: number;
  /** Fractional units owed per miner, and ore broken off but not yet thrown out */
  progress: Map<number, number>;
  pending: Map<number, Bag>;
  seed: number;
  /** An outlier: its size whole (each stage's is a share of that) */
  wholeSize?: number;
}

export class Mining {
  private rocks = new Map<number, Rock>();
  private respawns: { systemNum: number; index: number; at: number }[] = [];
  private xpOwed = new Map<number, number>();
  private warned = new Map<number, number>();

  constructor(private host: MiningHost, readonly table: MiningTable) {}

  /** `outlier`: an outlier's stage, its size whole and (past the first stage) the units it still holds */
  register(eid: number, systemNum: number, index: number, type: string, key: string, size: number, tier: number, outlier?: { stage: number; wholeSize: number; left?: number }): void {
    const c = asteroidComposition(this.table, type, key, size, tier, outlier?.stage);
    this.rocks.set(eid, {
      ...c, systemNum, index, left: Math.min(c.units, outlier?.left ?? c.units), progress: new Map(), pending: new Map(), seed: (eid * 2654435761) >>> 0, tier: this.host.rockTier?.(systemNum) ?? 1,
      ...(outlier ? { wholeSize: outlier.wholeSize } : {}),
    });
  }

  /** An outlier's next stage: its size and the units it holds (null: this is its last) */
  private nextStage(r: Rock): { size: number; units: number } | null {
    const stages = this.table.outliers?.stages;
    const at = r.stage?.at;
    if (at === undefined || !r.wholeSize || !stages || at + 1 >= stages.length) return null;
    const size = r.wholeSize * stages[at + 1];
    return { size, units: Math.max(3, Math.round(size * this.table.unitsPerSize)) };
  }

  get(eid: number): Composition | undefined {
    return this.rocks.get(eid);
  }

  /** Units still in a rock (0..units) */
  remaining(eid: number): number {
    return this.rocks.get(eid)?.left ?? 0;
  }

  private rand(r: Rock): number {
    r.seed = (r.seed + 0x6d2b79f5) >>> 0;
    let t = r.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * A tool did `damage` to an asteroid at (x, y); (nx, ny) points out of the
   * surface. Extract what it can, throwing chunks out as they fill.
   */
  extract(asteroid: number, miner: number, damage: number, tool: MiningTool, x: number, y: number, nx: number, ny: number): void {
    const r = this.rocks.get(asteroid);
    if (!r || r.left <= 0 || damage <= 0 || tool.yield <= 0) return;
    if (tool.hardness < r.hardness) {
      this.warn(miner, `This rock is too hard for your ${tool.hardness <= 1 ? 'guns: fit a mining laser' : 'tools'}`);
      return;
    }
    // A mining laser behind the system's tier makes slow work of its rock
    let eff = 1;
    if (tool.grade !== undefined) {
      const gap = Math.max(-2, Math.min(2, tool.grade - r.tier));
      eff = this.table.tierEfficiency?.[String(gap)] ?? 1;
      if (eff < 1) this.warn(miner, `Mk ${MARKS[r.tier]} rock: your Mk ${MARKS[tool.grade]} mining laser gets ${Math.round(eff * 100)}% of what a Mk ${MARKS[r.tier]} one would`);
    }
    let owed = (r.progress.get(miner) ?? 0) + (damage * tool.yield * eff) / this.table.damagePerUnit;
    const bag = r.pending.get(miner) ?? {};
    const got: Bag = {};
    let units = 0;
    // (An outlier's stage gives only its share: the rest stays for the next)
    const floor = this.nextStage(r)?.units ?? 0;
    while (owed >= 1 && r.left > floor) {
      owed -= 1;
      r.left -= 1;
      units++;
      // A gem from the seam, or an ore the tool can crack (harder ores are left in the rock)
      let id: string;
      if (r.seam && tool.hardness >= r.seam.hardness && this.rand(r) < this.table.seamGemChance) id = r.seam.gem;
      else {
        id = pickOre(r, this.rand(r));
        if ((this.table.oreHardness[id] ?? 1) > tool.hardness) id = this.softest(r, tool);
      }
      let n = 1;
      // Skilled miners get more out of the same rock
      // Mining skill (and a wing): the chance of an extra unit
      const bonus = this.host.miningSkill?.(miner) ?? 0;
      if (bonus > 0 && this.rand(r) < bonus) n++;
      bag[id] = (bag[id] ?? 0) + n;
      got[id] = (got[id] ?? 0) + n;
    }
    if (units) this.host.mined?.(miner, got, { tier: Math.max(r.tier, this.host.traceTier?.(r.systemNum, r.type) ?? 0), seam: !!r.seam, traceMul: this.table.types[r.type]?.traceMul, traceBoost: this.table.types[r.type]?.traceBoost });
    r.progress.set(miner, owed);
    r.pending.set(miner, bag);
    if (units) this.addXp(miner, units * this.table.xpPerUnit);
    // Throw a chunk out once it's big enough (or the rock is spent)
    const total = Object.values(bag).reduce((a, b) => a + b, 0);
    const [lo, hi] = this.table.chunkUnits;
    const want = lo + Math.floor(this.rand(r) * (hi - lo + 1));
    if (total >= want || (r.left <= floor && total > 0)) {
      let s = 1.2 + this.rand(r) * 1.4, spread = (this.rand(r) - 0.5) * 1.4;
      const sx = x + nx * 14, sy = y + ny * 14;
      // Thrown towards whoever broke it off, with a little extra speed (a loose chunk drifts the rest of the way); with no miner to aim at, straight out of the rock
      let dx = nx, dy = ny;
      const at = this.host.minerAt?.(miner);
      if (at) {
        const d = dhypot(at.x - sx, at.y - sy);
        if (d > 1) { dx = (at.x - sx) / d; dy = (at.y - sy) / d; spread *= 0.25; s += CHUNK_BOOST; }
      }
      const c = dcos(spread), sn = dsin(spread);
      this.host.spawnChunk(r.systemNum, sx, sy, (dx * c - dy * sn) * s, (dx * sn + dy * c) * s, bag, miner);
      r.pending.set(miner, {});
    }
    // Mined out (or an outlier, mined down to its next stage): nothing left to hold it together
    if (r.left <= floor) this.host.crumble(asteroid);
  }

  /** The most common ore in the rock that the tool can crack */
  private softest(r: Rock, tool: MiningTool): string {
    let best = '', w = -1;
    for (const [id, v] of Object.entries(r.ores)) {
      if ((this.table.oreHardness[id] ?? 1) <= tool.hardness && v > w) { best = id; w = v; }
    }
    return best || r.primary;
  }

  /** An asteroid broke: a little of what's left spills out, and it comes back later */
  onBroken(asteroid: number, x: number, y: number): void {
    const r = this.rocks.get(asteroid);
    if (!r) return;
    this.rocks.delete(asteroid);
    // Chunks still owed to miners
    for (const [miner, bag] of r.pending) if (Object.keys(bag).length) this.host.spawnChunk(r.systemNum, x, y, 0, 0, bag, miner);
    // An outlier's stage: the next takes the ore that's left (what it can't hold spills, as from any break)
    const next = this.nextStage(r);
    const keep = next && this.host.shed ? Math.min(r.left, next.units) : 0;
    if (keep > 0) r.left -= keep;
    const spill = Math.floor(r.left * this.table.breakFraction);
    if (spill > 0) {
      const bag: Bag = {};
      for (let i = 0; i < spill; i++) {
        const id = pickOre(r, this.rand(r));
        if ((this.table.oreHardness[id] ?? 1) <= 1) bag[id] = (bag[id] ?? 0) + 1;
      }
      if (Object.keys(bag).length) this.host.spawnChunk(r.systemNum, x, y, (this.rand(r) - 0.5) * 2, (this.rand(r) - 0.5) * 2, bag);
    }
    if (keep > 0) return this.host.shed!(asteroid, r.stage!.at + 1, next!.size, keep);
    this.respawns.push({ systemNum: r.systemNum, index: r.index, at: this.host.tick() + this.table.respawnSeconds * 60 });
  }

  forget(asteroid: number): void {
    this.rocks.delete(asteroid);
  }

  tick(): void {
    const now = this.host.tick();
    for (let i = this.respawns.length - 1; i >= 0; i--) {
      if (this.respawns[i].at > now) continue;
      const r = this.respawns[i];
      this.respawns.splice(i, 1);
      this.host.respawn(r.systemNum, r.index);
    }
    // Mining XP in whole points, about once a second
    if (now % 60 === 0) {
      for (const [eid, xp] of this.xpOwed) {
        if (xp < 1) continue;
        this.host.awardXp(eid, Math.floor(xp));
        this.xpOwed.set(eid, xp - Math.floor(xp));
      }
    }
  }

  private addXp(eid: number, xp: number): void {
    this.xpOwed.set(eid, (this.xpOwed.get(eid) ?? 0) + xp);
  }

  private warn(eid: number, text: string): void {
    const now = this.host.tick();
    if (now - (this.warned.get(eid) ?? -1e9) < 60 * 6) return;
    this.warned.set(eid, now);
    this.host.notify(eid, text);
  }
}
