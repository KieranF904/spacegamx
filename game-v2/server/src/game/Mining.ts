/**
 * Mining: turning damage done to asteroids into ore.
 *
 * Every asteroid has a composition (common/src/econ/mining.ts): an ore mix, a
 * hardness, maybe a gem seam, and a number of ore units. Mining has two sides:
 *
 * - The work: how fast a tool takes the rock apart (rock units: damage x the
 *   tool's yield x its work rate / damagePerUnit). The rock loses every unit
 *   worked, kept or not, and a chunk is due every chunkUnits worked (3 to 5),
 *   so the work sets how often chunks come.
 * - The keep: the chance each unit worked ends up in the chunk; every unit is
 *   a dice roll (the rock's dice, from the server's secret: payoutDice.ts), and
 *   a failed roll is lost from the rock all the same. A chunk holds what was kept; a chunk due with nothing
 *   kept yet waits for the next unit that is kept (the carry), so no drop is ever skipped or empty and a tool that
 *   keeps little still drops about as often as the work says (unitsPerDrop). The averages are the keep; the drops vary.
 *
 * Mining lasers keep all they work on rock of their grade or below (a grade or
 * two ahead works it a little faster). A grade or two behind the rock's tier
 * (the system's Mk) they work it a little slower and keep less (laserGap);
 * further behind, or on rock too hard for them, they can't mine it. Each laser
 * mines on its own: two on a rock mine it twice as fast. What limits them is
 * the power to run them (a mining laser draws most of a Cell Reactor).
 *
 * Guns (anything but a mining tool) mine soft rock only (hardness 1), at about
 * a mining laser's pace, and keep little of it (GunMining).
 *
 * Outliers (a rock in a hundred or so, several times the size) come apart in
 * stages: mined down to what the next stage holds, or blasted apart, a stage
 * breaks away and leaves a smaller rock with the ore that's left, until the
 * last stage breaks up like any other rock.
 */

import { Composition, MiningTable, Bag, asteroidComposition, pickOre, MARKS, type TraceSource, type GunMining, dcos, dhypot, dsin, workedUnits, gunDps, gunPace } from '@space-game/common';
import { PayoutDice, type Dice } from './payoutDice.js';

export interface MiningTool {
  yield: number;
  hardness: number;
  /** A mining laser's grade (how it does depends on it against the rock's tier: laserGap) */
  grade?: number;
  /** A mining tool with no grade (charges, the siphon): it keeps all it works. Without either, a gun */
  mining?: boolean;
}

/** A miner's work on one rock */
interface Work {
  /** Rock units owed (the fraction of the next) */
  owed: number;
  /** Rock units worked since the last chunk, and how many the next chunk wants (chunkUnits) */
  worked: number;
  want: number;
  /**
   * The chunk's units' dice, rolled when it starts (UNIT_DRAWS a unit: seam, ore, keep, bonus), so the unit it's thrown
   * at is known then (`due`: the first at or past `want` with something kept) and its miner is told (MiningHost.chunk)
   */
  draws: number[];
  due: number;
  /** The tool `due` was worked out for (its keep, hardness and kind): another tool, it's worked out again */
  toolKey: string;
  /** What's been kept and not yet thrown */
  bag: Bag;
  /** Guns: damage on the rock in about the last second (a leaking sum), as of tick `t` */
  dps: number;
  t: number;
}

/** A chunk thrown at its miner flies this much faster (units a tick, on top of 1.2 to 2.6) */
const CHUNK_BOOST = 3.6;
/** Dice a unit worked draws (seam, ore, keep, bonus), and the most units a chunk's dice are rolled ahead for */
const UNIT_DRAWS = 4, MAX_AHEAD = 512;

/** How a tool takes a rock's units: what it keeps (the gun's lower keep off the common ores), the hardest it cracks */
interface UnitRule {
  keep: number;
  gun: GunMining | undefined;
  hardness: number;
}

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
  /**
   * A miner's chunk on a rock: its next drop comes at `due` rock units worked into it, and `at` are worked so far
   * (fractions too); `drop`: one was just thrown. Told when a chunk starts (the first hit on a rock, each drop) and when
   * another tool changes where it's due: the dice are the server's, so the client can't know (MiningProgress.ts)
   */
  chunk?(playerEid: number, asteroid: number, due: number, at: number, drop: boolean): void;
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
  /** Each miner's work on it */
  work: Map<number, Work>;
  /**
   * Its dice (its keep, gem, ore and bonus rolls, its chunks' sizes and throws): from the server's secret, never from
   * anything a client knows (payoutDice.ts). Its composition, which a client works out for its looks and odds, is
   * from the rock's own key as ever
   */
  dice: Dice;
  /** An outlier: its size whole (each stage's is a share of that) */
  wholeSize?: number;
}

export class Mining {
  private rocks = new Map<number, Rock>();
  private respawns: { systemNum: number; index: number; at: number }[] = [];
  private xpOwed = new Map<number, number>();
  private warned = new Map<number, number>();

  /** Rocks registered so far: each one's dice are its own (a rock come back under the same id too) */
  private registered = 0;

  /** `payout`: the server's payout dice (GameServer's; none: a secret of its own) */
  constructor(private host: MiningHost, readonly table: MiningTable, private readonly payout: PayoutDice = new PayoutDice()) {}

  /** `outlier`: an outlier's stage, its size whole and (past the first stage) the units it still holds */
  register(eid: number, systemNum: number, index: number, type: string, key: string, size: number, tier: number, outlier?: { stage: number; wholeSize: number; left?: number }): void {
    const c = asteroidComposition(this.table, type, key, size, tier, outlier?.stage);
    this.rocks.set(eid, {
      ...c, systemNum, index, left: Math.min(c.units, outlier?.left ?? c.units), work: new Map(), dice: this.payout.stream('rock', eid, this.registered++), tier: this.host.rockTier?.(systemNum) ?? 1,
      ...(outlier ? { wholeSize: outlier.wholeSize } : {}),
    });
  }

  /** An outlier's next stage: its size and the units it holds (null: this is its last) */
  private nextStage(r: Rock): { size: number; units: number } | null {
    const stages = this.table.outliers?.stages;
    const at = r.stage?.at;
    if (at === undefined || !r.wholeSize || !stages || at + 1 >= stages.length) return null;
    const size = r.wholeSize * stages[at + 1];
    return { size, units: Math.max(3, Math.round(size * this.table.unitsPerSize * (this.table.types[r.type]?.density ?? 1))) };
  }

  get(eid: number): Composition | undefined {
    return this.rocks.get(eid);
  }

  /** Units still in a rock (0..units) */
  remaining(eid: number): number {
    return this.rocks.get(eid)?.left ?? 0;
  }

  /** A miner's chunk on a rock: rock units worked into it (fractions too) and where its drop falls (as MiningHost.chunk tells) */
  chunkOf(eid: number, miner: number): { at: number; due: number } | null {
    const w = this.rocks.get(eid)?.work.get(miner);
    return w ? { at: w.worked + w.owed, due: w.due } : null;
  }

  private rand(r: Rock): number {
    return r.dice();
  }

  /**
   * A tool did `damage` to an asteroid at (x, y); (nx, ny) points out of the
   * surface. Work the rock, keep what the tool keeps, and throw a chunk out
   * every chunkUnits worked (or at the first kept unit after, if none was).
   */
  extract(asteroid: number, miner: number, damage: number, tool: MiningTool, x: number, y: number, nx: number, ny: number): void {
    const r = this.rocks.get(asteroid);
    if (!r || r.left <= 0 || damage <= 0 || tool.yield <= 0) return;
    const isGun = tool.grade === undefined && !tool.mining, gun = isGun ? this.table.guns : undefined;
    // Guns crack soft rock only; anything else needs a hard enough tool
    if (isGun ? r.hardness > 1 : tool.hardness < r.hardness) {
      this.warn(miner, `This rock is too hard for your ${isGun ? 'guns: fit a mining laser' : tool.grade !== undefined ? 'mining laser: fit a harder one' : 'tools'}`);
      return;
    }
    let work = 1, keep = 1;
    if (tool.grade !== undefined) {
      // A mining laser against the rock's tier: behind it, a little slower and it keeps less; too far behind, nothing
      const gap = Math.min(2, tool.grade - r.tier);
      const g = this.table.laserGap?.[String(gap)];
      if (this.table.laserGap && !g) {
        this.warn(miner, `Mk ${MARKS[r.tier]} rock is too far past your Mk ${MARKS[tool.grade]} mining laser: fit a better one`);
        return;
      }
      if (g) { work = g.work; keep = g.keep; }
      if (keep < 1) this.warn(miner, `Mk ${MARKS[r.tier]} rock: your Mk ${MARKS[tool.grade]} mining laser works it ${Math.round(work * 100)}% as fast and keeps ${Math.round(keep * 100)}% of the ore`);
    } else if (gun) {
      // Guns keep little of what they knock loose, less again past Mk I
      keep = gun.keep * (gun.keepByTier[String(r.tier)] ?? 1);
      if (r.tier > 1) this.warn(miner, `Mk ${MARKS[r.tier]} rock: guns keep only ${Math.round(keep * 100)}% of the ore: fit a mining laser`);
    }
    // (An outlier's stage gives only its share: the rest stays for the next)
    const floor = this.nextStage(r)?.units ?? 0;
    const rule: UnitRule = { keep, gun, hardness: tool.hardness };
    const fresh = !r.work.has(miner);
    const w = this.workOf(r, miner);
    // A new chunk, or another tool on this one (its keep says where the drop falls): where it's due, rolled ahead
    let tell = fresh, drop = false;
    const key = `${keep}|${gun ? 1 : 0}|${tool.hardness}`;
    if (key !== w.toolKey) {
      const was = w.due;
      w.toolKey = key;
      w.due = this.dueOf(r, w, rule, floor);
      if (w.due !== was) tell = true;
    }
    // Guns: past refDps damage a second on the rock, the pace grows only with its square root
    if (gun) {
      const now = this.host.tick();
      w.dps = gunDps(w.dps, (now - w.t) / 60, damage);
      w.t = now;
      work *= gunPace(this.table, w.dps);
    }
    w.owed += workedUnits(this.table, damage, tool.yield, work);
    const got: Bag = {};
    let units = 0;
    while (w.owed >= 1 && r.left > floor) {
      w.owed -= 1;
      r.left -= 1;
      // The unit's dice, rolled when the chunk started: a gem or an ore the tool can crack, kept or lost (a failed
      // roll still takes the unit out of the rock), and the mining skill's (and a wing's) chance of an extra one
      const at = w.worked * UNIT_DRAWS;
      while (w.draws.length < at + UNIT_DRAWS) w.draws.push(this.rand(r));
      const u = this.unitOf(r, rule, w.draws[at], w.draws[at + 1], w.draws[at + 2]);
      w.worked++;
      if (u.kept) {
        units++;
        let n = 1;
        const bonus = this.host.miningSkill?.(miner) ?? 0;
        if (bonus > 0 && w.draws[at + 3] < bonus) n++;
        w.bag[u.id] = (w.bag[u.id] ?? 0) + n;
        got[u.id] = (got[u.id] ?? 0) + n;
      }
      // Its due unit: throw what was kept (due is the first unit at or past the chunk's want with something kept: the
      // carry, so a tool that keeps a third still drops every chunk or so rather than skipping a drop in two)
      if (w.worked >= w.due) {
        if (Object.keys(w.bag).length) {
          this.throwChunk(r, miner, w, x, y, nx, ny);
          this.newChunk(r, w);
          w.toolKey = key;
          drop = true;
        }
        // (Rolled no further ahead than MAX_AHEAD or the rock: roll on)
        w.due = this.dueOf(r, w, rule, floor);
        tell = true;
      }
    }
    if (units) this.host.mined?.(miner, got, { tier: Math.max(r.tier, this.host.traceTier?.(r.systemNum, r.type) ?? 0), seam: !!r.seam, traceMul: this.table.types[r.type]?.traceMul, traceBoost: this.table.types[r.type]?.traceBoost });
    if (units) this.addXp(miner, units * this.table.xpPerUnit);
    if (r.left > floor) {
      if (tell) this.host.chunk?.(miner, asteroid, w.due, w.worked + w.owed, drop);
      return;
    }
    // The rock spent (or an outlier, mined down to its next stage): what's kept goes out with it, and nothing's left to hold it together
    if (Object.keys(w.bag).length) this.throwChunk(r, miner, w, x, y, nx, ny);
    this.host.crumble(asteroid);
  }

  private workOf(r: Rock, miner: number): Work {
    let w = r.work.get(miner);
    if (!w) {
      r.work.set(miner, (w = { owed: 0, worked: 0, want: 0, draws: [], due: 0, toolKey: '', bag: {}, dps: 0, t: this.host.tick() }));
      this.newChunk(r, w);
    }
    return w;
  }

  /** A miner's next chunk on a rock: its want (chunkUnits), its dice not yet rolled */
  private newChunk(r: Rock, w: Work): void {
    w.worked = 0;
    w.want = this.chunkWant(r);
    w.draws = [];
    w.toolKey = '';
  }

  /** A unit worked by a tool, from its dice (seam, ore, keep): what it is, and is it kept */
  private unitOf(r: Rock, rule: UnitRule, seam: number, ore: number, keep: number): { id: string; kept: boolean } {
    let id: string;
    if (r.seam && rule.hardness >= r.seam.hardness && seam < this.table.seamGemChance) id = r.seam.gem;
    else {
      id = pickOre(r, ore);
      if ((this.table.oreHardness[id] ?? 1) > rule.hardness) id = this.softest(r, rule.hardness);
    }
    const p = rule.gun && !rule.gun.common.includes(id) ? rule.keep * rule.gun.keepOther : rule.keep;
    return { id, kept: p >= 1 || keep < p };
  }

  /**
   * The unit (counted from the chunk's start) a miner's chunk is thrown at: the first at or past its want with
   * something kept by then, its dice rolled ahead as far as that. No further than the rock holds (spent, it crumbles and
   * throws what's kept) or MAX_AHEAD units ahead
   */
  private dueOf(r: Rock, w: Work, rule: UnitRule, floor: number): number {
    let kept = Object.keys(w.bag).length > 0;
    const end = w.worked + Math.min(MAX_AHEAD, Math.max(0, r.left - floor));
    for (let i = w.worked; i < end; i++) {
      while (w.draws.length < (i + 1) * UNIT_DRAWS) w.draws.push(this.rand(r));
      const at = i * UNIT_DRAWS;
      if (!kept) kept = this.unitOf(r, rule, w.draws[at], w.draws[at + 1], w.draws[at + 2]).kept;
      if (kept && i + 1 >= w.want) return i + 1;
    }
    return Math.max(end, w.worked + 1);
  }

  /** Rock units the next chunk wants worked (chunkUnits) */
  private chunkWant(r: Rock): number {
    const [lo, hi] = this.table.chunkUnits;
    return lo + Math.floor(this.rand(r) * (hi - lo + 1));
  }

  /** Throw a miner's kept ore out of the rock as a chunk */
  private throwChunk(r: Rock, miner: number, w: Work, x: number, y: number, nx: number, ny: number): void {
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
    this.host.spawnChunk(r.systemNum, sx, sy, (dx * c - dy * sn) * s, (dx * sn + dy * c) * s, w.bag, miner);
    w.bag = {};
  }

  /** The most common ore in the rock that the tool can crack */
  private softest(r: Rock, hardness: number): string {
    let best = '', w = -1;
    for (const [id, v] of Object.entries(r.ores)) {
      if ((this.table.oreHardness[id] ?? 1) <= hardness && v > w) { best = id; w = v; }
    }
    return best || r.primary;
  }

  /** An asteroid broke: a little of what's left spills out, and it comes back later */
  onBroken(asteroid: number, x: number, y: number): void {
    const r = this.rocks.get(asteroid);
    if (!r) return;
    this.rocks.delete(asteroid);
    // Chunks still owed to miners
    for (const [miner, w] of r.work) if (Object.keys(w.bag).length) this.host.spawnChunk(r.systemNum, x, y, 0, 0, w.bag, miner);
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
