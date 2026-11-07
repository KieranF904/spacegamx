/**
 * The mines this client knows (common/src/ships/features/minebay/minebay.ts; server: ships/features/minebay/Minefield.ts).
 * Every mine is derived from its drop record (`minesLaid`): where it slides and rests, when it arms and when it fizzles
 * out. The server tells only what can't be worked out: a mine gone off, fizzled past the cap or cleared (`minesGone`),
 * and the pilot's own magazines (`mineBay`). No DOM, no pixi: the drawing is MinesLayer.ts.
 *
 * The pilot's own drop is predicted: a press draws the batch at once from the own ship's predicted pose and tick (the
 * same record the server makes on that tick: the press carries it), and the server's `minesLaid` replaces it when it
 * comes (the oldest prediction first); a refused press (`mineBay refused`) or one never answered takes it away.
 */
import {
  MINES, makeDrop, mineExpired, mineId, minePos, nextReady, pickBay,
  type DropPose, type MineBayInfo, type MineDrop, type ServerMineBayMessage, type ServerMinesGoneMessage,
} from '@space-game/common';

/** A prediction the server never answered is dropped after this long (ms) */
const PREDICT_TIMEOUT_MS = 3000;
/** A blast is drawn this long (ms) */
export const BLAST_MS = 450;

export interface KnownDrop {
  d: MineDrop;
  /** Predicted by this client (not yet the server's) */
  predicted: boolean;
  /** performance.now() when predicted */
  at: number;
  /** Mines told gone, by index: the tick they went */
  goneAt: (number | undefined)[];
}

export interface Blast { x: number; y: number; tick: number; owner: number; shown: number }

export class MineStore {
  readonly drops: KnownDrop[] = [];
  readonly blasts: Blast[] = [];
  /** The own magazines as last told (null: never told: no Mine Bay, or not yet) */
  bay: { loaded: Record<number, number>; readyAt: number; readyBy: Record<number, number> } | null = null;
  /** Bumped on every change the chip shows */
  version = 0;

  reset(): void {
    this.drops.length = 0;
    this.blasts.length = 0;
    this.bay = null;
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
    this.drops.push({ d: rec, predicted: false, at: 0, goneAt: [] });
  }

  /** Mines told gone: a blast is drawn where the mine rested */
  gone(msg: Pick<ServerMinesGoneMessage, 'tick' | 'ids' | 'how'>, now = performance.now()): void {
    for (const id of msg.ids) {
      for (const k of this.drops) {
        if (k.predicted) continue;
        for (let i = 0; i < k.d.n; i++) {
          if (mineId(k.d.owner, k.d.tick, i) !== id) continue;
          k.goneAt[i] = Math.min(k.goneAt[i] ?? Infinity, msg.tick);
          if (msg.how === 'blast') {
            const [x, y] = minePos(k.d, i, msg.tick);
            this.blasts.push({ x, y, tick: msg.tick, owner: k.d.owner, shown: now });
          }
        }
      }
    }
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
    this.drops.push({ d, predicted: true, at: now, goneAt: [] });
    this.version++;
    return d;
  }

  /** Forget what's over: drops past their life (or every mine gone), blasts drawn, predictions never answered */
  prune(tickOf: (owner: number) => number, now = performance.now()): void {
    for (let k = this.drops.length - 1; k >= 0; k--) {
      const r = this.drops[k], t = tickOf(r.d.owner);
      let all = true;
      for (let i = 0; i < r.d.n && all; i++) if (r.goneAt[i] === undefined || t < r.goneAt[i]!) all = false;
      if (mineExpired(r.d, t) || all || (r.predicted && now - r.at > PREDICT_TIMEOUT_MS)) this.drops.splice(k, 1);
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
        const g = r.goneAt[i];
        if (g !== undefined && t >= g) continue;
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
}

/** The one store (serverMessages.ts feeds it; the feature draws and presses from it) */
export const mineClient = new MineStore();
