/**
 * The mines this client knows (common/src/ships/features/minebay/minebay.ts and blasts.ts; server:
 * ships/features/minebay/Minefield.ts). Every mine is derived from its drop record (`minesLaid`): where it slides and
 * rests, when it arms and when it fizzles out. No DOM, no pixi: the drawing is MinesLayer.ts.
 *
 * A mine's end comes three ways, and they are reconciled here so a blast is drawn once:
 *   predicted  drawn at once: each frame an armed mine is checked against the ships as drawn (`predict`), the same
 *              rule as the search (mineFindable ships, hull reach). Only a picture: it is confirmed by an end below, or
 *              undone (the mine comes back, its blast is cut) once the windows past it are settled without one
 *   found      on the tick-faithful layer, as each snapshot window is searched (`window`: common findMineBlasts against
 *              the ships exact there); the server sends nothing for these
 *   told       `minesGone` (a blast this client couldn't find, the cap's and a clear's fizzles), and `minesKept` (a blast
 *              it may have found that the server never had: undone, and from then on that mine's end is only told)
 * The server mirrors the search exactly (HitLedger.poseExact), so what it leaves untold is what this client finds.
 *
 * The pilot's own drop is predicted too: a press draws the batch at once from the own ship's predicted pose and tick
 * (the same record the server makes on that tick: the press carries it), and the server's `minesLaid` replaces it when
 * it comes (the oldest prediction first); a refused press (`mineBay refused`) or one never answered takes it away.
 */
import {
  MINES, findMineBlasts, makeDrop, mineArmed, mineExpired, mineFindable, mineId, minePos, mineRest, mineTouches, nextReady, pickBay,
  type DropPose, type FoundBlast, type MineBayInfo, type MineDrop, type SearchDrop, type SearchShips,
  type ServerMineBayMessage, type ServerMinesGoneMessage, type ServerMinesKeptMessage, type MineEnd,
} from '@space-game/common';

/** A prediction the server never answered is dropped after this long (ms) */
const PREDICT_TIMEOUT_MS = 3000;
/** A blast is drawn this long (ms) */
export const BLAST_MS = 450;
/**
 * A predicted blast is undone once the windows this many ticks past it are settled with no end for its mine (the drawn
 * ships are near where the tick layer has them, so a real touch is found within a few ticks of the drawn one)
 */
export const PREDICT_SLACK = 30;
/** After a prediction is undone, its mine isn't predicted again for this long (ticks): no flicker while a drawn ship sits on it */
export const PREDICT_HOLD = 120;

/** How a mine's end is known: told by the server, or found on the tick layer */
export interface MineEndRec { tick: number; how: MineEnd; src: 'told' | 'found' }

export interface Blast {
  x: number; y: number; tick: number; owner: number;
  /** performance.now() when it was made (kept a while after) */
  shown: number;
  /** The drawing's start (MinesLayer) */
  start?: number;
}

export interface KnownDrop {
  d: MineDrop;
  /** Predicted by this client (not yet the server's) */
  predicted: boolean;
  /** performance.now() when predicted */
  at: number;
  /** Each mine's end as known (undefined: live) */
  ends: (MineEndRec | undefined)[];
  /** Each mine's predicted blast not yet confirmed or undone: its tick and drawing */
  preds: ({ tick: number; blast: Blast } | undefined)[];
  /** Each mine's blast drawn for its end (found or told) */
  blasts: (Blast | undefined)[];
  /** Mines whose ends are only told (minesKept): bit i, mine i */
  kept: number;
  /** Mines not to be predicted before this tick (an undone prediction), by index */
  holdTo: (number | undefined)[];
}

/** A ship as drawn this frame (a prediction's check) */
export interface DrawnShip { id: number; x: number; y: number; radius: number; side: number }

export class MineStore {
  readonly drops: KnownDrop[] = [];
  readonly blasts: Blast[] = [];
  /** The own magazines as last told (null: never told: no Mine Bay, or not yet) */
  bay: { loaded: Record<number, number>; readyAt: number; readyBy: Record<number, number> } | null = null;
  /** Bumped on every change the chip shows */
  version = 0;
  /** The last window settled (every end up to it is known: found or told) */
  settled = -1;
  readonly stats = { predicted: 0, confirmed: 0, undone: 0, found: 0, told: 0, kept: 0 };
  private readonly found: FoundBlast[] = [];

  reset(): void {
    this.drops.length = 0;
    this.blasts.length = 0;
    this.bay = null;
    this.settled = -1;
    this.version++;
  }

  /** A drop the server made (an own one replaces the oldest prediction) */
  laid(d: MineDrop, me: number): void {
    const rec: MineDrop = { owner: d.owner, bay: d.bay, tick: d.tick, n: d.n, x: d.x, y: d.y, angle: d.angle, vx: d.vx, vy: d.vy, seed: d.seed };
    if (this.drops.some((k) => !k.predicted && k.d.owner === rec.owner && k.d.tick === rec.tick && k.d.bay === rec.bay)) return;
    if (rec.owner === me) {
      const i = this.drops.findIndex((k) => k.predicted);
      if (i >= 0) this.drops.splice(i, 1);
    }
    this.drops.push(known(rec, false, 0));
  }

  /** Mines told gone (a blast is drawn where the mine rested, once: a predicted one is confirmed) */
  gone(msg: Pick<ServerMinesGoneMessage, 'tick' | 'ids' | 'how'>, now = performance.now()): void {
    for (const id of msg.ids) {
      const m = this.mine(id);
      if (m) this.end(m.k, m.i, { tick: msg.tick, how: msg.how, src: 'told' }, now);
    }
  }

  /**
   * Mines the server says did not go off on `tick` (minesKept): any blast this client found or predicted for them is
   * taken back (the mine comes back), and from now on their ends are only told
   */
  kept(msg: Pick<ServerMinesKeptMessage, 'tick' | 'ids'>): void {
    for (const id of msg.ids) {
      const m = this.mine(id);
      if (!m) continue;
      const { k, i } = m;
      k.kept |= 1 << i;
      this.stats.kept++;
      if (k.ends[i]?.src === 'found') { this.cut(k.blasts[i]); k.blasts[i] = undefined; k.ends[i] = undefined; }
      if (k.preds[i]) this.undo(k, i);
    }
  }

  /**
   * A snapshot window searched (ships/hits/SelfHits.window): the blasts found on it against the ships exact there
   * (none: the server tells all of this one), then the predictions settled: one past PREDICT_SLACK with no end undone
   */
  window(from: number, to: number, ships: SearchShips | null, now = performance.now()): void {
    if (ships) {
      const search: SearchDrop[] = [];
      for (const k of this.drops) {
        if (k.predicted) continue;
        search.push({ d: k.d, goneFrom: (i) => ((k.kept >> i) & 1 ? -Infinity : k.ends[i]?.tick ?? Infinity) });
      }
      const found = findMineBlasts(search, from, to, ships, this.found);
      for (const f of found) {
        const k = this.drops.find((x) => x.d === f.drop.d);
        if (k) { this.end(k, f.i, { tick: f.tick, how: 'blast', src: 'found' }, now); this.stats.found++; }
      }
    }
    this.settled = Math.max(this.settled, to);
    for (const k of this.drops) {
      for (let i = 0; i < k.d.n; i++) {
        const p = k.preds[i];
        if (p && !k.ends[i] && this.settled >= p.tick + PREDICT_SLACK) this.undo(k, i);
      }
    }
  }

  /**
   * The frame's check against the ships as drawn on the drawing tick `tick` (the replicas'): an armed mine a findable
   * ship touches goes off now, as a prediction. Not a mine whose end is known, one already predicted, one whose ends
   * are only told, or one held after an undone prediction
   */
  predict(ships: readonly DrawnShip[], tick: number, now = performance.now()): number {
    if (!ships.length) return 0;
    let made = 0;
    for (const k of this.drops) {
      if (k.predicted || !mineArmed(k.d, tick)) continue;
      for (let i = 0; i < k.d.n; i++) {
        if (!predictable(k, i, tick)) continue;
        const [mx, my] = mineRest(k.d, i, REST);
        for (const s of ships) {
          if (s.id === k.d.owner || !mineFindable(s.side) || !mineTouches(mx, my, s.x, s.y, s.radius)) continue;
          const blast: Blast = { x: mx, y: my, tick, owner: k.d.owner, shown: now };
          k.preds[i] = { tick, blast };
          this.blasts.push(blast);
          this.stats.predicted++;
          made++;
          break;
        }
      }
    }
    return made;
  }

  /**
   * Where a prediction could happen on drawing tick `tick`: the box round the armed mines it may predict (min x, min y,
   * max x, max y), or null: none (the frame looks at no ship)
   */
  predictBox(tick: number, out: [number, number, number, number]): [number, number, number, number] | null {
    let any = false;
    for (const k of this.drops) {
      if (k.predicted || !mineArmed(k.d, tick)) continue;
      for (let i = 0; i < k.d.n; i++) {
        if (!predictable(k, i, tick)) continue;
        const [x, y] = mineRest(k.d, i, REST);
        if (!any) { out[0] = out[2] = x; out[1] = out[3] = y; any = true; }
        else { out[0] = Math.min(out[0], x); out[1] = Math.min(out[1], y); out[2] = Math.max(out[2], x); out[3] = Math.max(out[3], y); }
      }
    }
    return any ? out : null;
  }

  /** The own magazines; `refused`: the oldest prediction goes */
  bayState(msg: Pick<ServerMineBayMessage, 'loaded' | 'readyAt' | 'readyBy' | 'refused'>): void {
    this.bay = { loaded: { ...msg.loaded }, readyAt: msg.readyAt, readyBy: { ...(msg.readyBy ?? {}) } };
    if (msg.refused) {
      const i = this.drops.findIndex((k) => k.predicted);
      if (i >= 0) this.drops.splice(i, 1);
    }
    this.version++;
  }

  /**
   * A press on `tick` (the own predicted tick): the drop it makes, worked out as the server will (the fullest ready
   * bay), drawn at once; the magazines as told are spent here too, until the server's own say comes. Null: none can drop
   */
  press(me: number, info: Readonly<MineBayInfo> | undefined, com: readonly number[], cellSize: number, pose: Readonly<DropPose>, tick: number, now = performance.now()): MineDrop | null {
    const b = this.bay;
    if (!info || !b) return null;
    const pick = pickBay(info, b.loaded, b.readyBy, tick);
    if (pick < 0) return null;
    const bay = info.bays[pick];
    const n = Math.min(bay.batch, Math.max(0, Math.floor(b.loaded[bay.uid] ?? 0)));
    b.loaded[bay.uid] = (b.loaded[bay.uid] ?? 0) - n;
    b.readyBy[bay.uid] = tick + bay.cooldown;
    b.readyAt = nextReady(info, b.loaded, b.readyBy);
    const d = makeDrop(me, bay, tick, n, com, cellSize, pose);
    this.drops.push(known(d, true, now));
    this.version++;
    return d;
  }

  /** Forget what's over: drops past their life (or every mine gone and settled), blasts drawn, predictions never answered */
  prune(tickOf: (owner: number) => number, now = performance.now()): void {
    for (let k = this.drops.length - 1; k >= 0; k--) {
      const r = this.drops[k], t = tickOf(r.d.owner);
      let all = true;
      for (let i = 0; i < r.d.n && all; i++) { const e = r.ends[i]; if (!e || t < e.tick || r.preds[i]) all = false; }
      if (mineExpired(r.d, t) || all || (r.predicted && now - r.at > PREDICT_TIMEOUT_MS)) {
        for (let i = 0; i < r.d.n; i++) if (r.preds[i]) this.cut(r.preds[i]!.blast);
        this.drops.splice(k, 1);
      }
    }
    for (let k = this.blasts.length - 1; k >= 0; k--) if (now - this.blasts[k].shown > BLAST_MS + 4000) this.blasts.splice(k, 1);
  }

  /** Live mines of all drops (what the layer draws), into `out` */
  live(tickOf: (owner: number) => number, out: { x: number; y: number; armed: boolean; owner: number; age: number }[]): typeof out {
    out.length = 0;
    for (const r of this.drops) {
      const t = tickOf(r.d.owner);
      if (t < r.d.tick || mineExpired(r.d, t)) continue;
      for (let i = 0; i < r.d.n; i++) {
        const e = r.ends[i], p = r.preds[i];
        if ((e && t >= e.tick) || p) continue;
        const [x, y] = minePos(r.d, i, t);
        out.push({ x, y, armed: t - r.d.tick >= MINES.armTicks, owner: r.d.owner, age: t - r.d.tick });
      }
    }
    return out;
  }

  /** Loaded mines across the own bays, as last told or predicted */
  loaded(info: Readonly<MineBayInfo> | undefined): number {
    let n = 0;
    for (const b of info?.bays ?? []) n += Math.max(0, Math.min(b.capacity, Math.floor(this.bay?.loaded[b.uid] ?? 0)));
    return n;
  }

  // ---------------------------------------------------------------- the reconciling

  /** A mine by its name, in a drop the server made */
  private mine(id: number): { k: KnownDrop; i: number } | null {
    for (const k of this.drops) {
      if (k.predicted) continue;
      for (let i = 0; i < k.d.n; i++) if (mineId(k.d.owner, k.d.tick, i) === id) return { k, i };
    }
    return null;
  }

  /**
   * A mine's end known (found or told): the earliest stands. A blast is drawn once: a predicted one is confirmed (its
   * drawing kept), else one is drawn now (from its tick on the drawing timeline). A quiet end leaves a prediction's
   * drawing as it is: the mine went either way
   */
  private end(k: KnownDrop, i: number, e: MineEndRec, now: number): void {
    const was = k.ends[i];
    // (told again, or found and then told: one blast, the first end's)
    if (was && was.tick <= e.tick) return;
    k.ends[i] = e;
    if (e.src === 'told') this.stats.told++;
    const p = k.preds[i];
    if (p) {
      k.preds[i] = undefined;
      k.blasts[i] = p.blast;
      this.stats.confirmed++;
      return;
    }
    if (e.how !== 'blast') return;
    if (k.blasts[i]) { k.blasts[i]!.tick = e.tick; return; }
    k.blasts[i] = this.drawn(k, i, e.tick, now);
  }

  private drawn(k: KnownDrop, i: number, tick: number, now: number): Blast {
    const [x, y] = mineRest(k.d, i, REST);
    const b: Blast = { x, y, tick, owner: k.d.owner, shown: now };
    this.blasts.push(b);
    return b;
  }

  /** A prediction undone: its drawing cut, the mine back, and not predicted again for a while */
  private undo(k: KnownDrop, i: number): void {
    const p = k.preds[i];
    if (!p) return;
    this.cut(p.blast);
    k.preds[i] = undefined;
    k.holdTo[i] = p.tick + PREDICT_HOLD;
    this.stats.undone++;
  }

  private cut(b: Blast | undefined): void {
    if (!b) return;
    const j = this.blasts.indexOf(b);
    if (j >= 0) this.blasts.splice(j, 1);
  }
}

const REST: [number, number] = [0, 0];

/** May mine i be predicted on drawing tick `tick`: no end known, not predicted already, not told only, not held */
function predictable(k: KnownDrop, i: number, tick: number): boolean {
  return !k.ends[i] && !k.preds[i] && !((k.kept >> i) & 1) && tick >= (k.holdTo[i] ?? -Infinity);
}

function known(d: MineDrop, predicted: boolean, at: number): KnownDrop {
  return { d, predicted, at, ends: [], preds: [], blasts: [], kept: 0, holdTo: [] };
}

/** The one store (serverMessages.ts feeds it; the feature draws, predicts, searches and presses from it) */
export const mineClient = new MineStore();
