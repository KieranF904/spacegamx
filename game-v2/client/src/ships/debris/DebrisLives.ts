/**
 * Debris this client runs itself after its spawn (CAPS.DEBRIS; common ships/debrisLife.ts). The server said so on its
 * split (debrisSplit `l`): from then on nothing comes for the piece but its removal. Its parts crumble on their ticks,
 * fixed at its spawn, and each crumble rebuilds it at that tick's rebuild point as the server does: its structure from
 * the tick after, what's left recentred in place (the replica set's debris world asks here: DebrisSplits), the parts'
 * crumble shown, and what broke off as pieces of its own when the server's split names them.
 *
 * Its structures are kept by tick (each crumble's from the tick after it), so a world stepped again from an earlier
 * tick steps it as it was then. A shipSync for it means the server tells it from now on: it is dropped here.
 */
import {
  crumblingParts, crumbleRebuild, recentreShift, quantizeShipBody, shipPointToWorld,
  type ShipState, type FlightBody, type ServerPartDestroyedMessage,
} from '@space-game/common';
import type { ShipStore } from '../ShipStore';

/** A structure it flies from tick `from` on */
interface Version { from: number; ship: ShipState }

interface Life {
  /** Each part's crumble tick */
  decay: readonly number[];
  /** Oldest first; the first from its first step */
  versions: Version[];
  /** Nothing was left of it at this tick's rebuild point */
  end?: number;
  /** Its body at a crumble's tick before it was recentred (a split from it starts there), by tick */
  pre: Map<number, FlightBody>;
  /** Crumbles shown up to this tick (each once, however often the world is stepped again) */
  shown: number;
  /** Only to be seen (it never knocks): kept here as the store's goes with the snapshot's removal, before the world's last steps of it */
  aloof: boolean;
}

const clone = (s: ShipState): ShipState => ({
  ...s, hp: [...s.hp], detached: [...s.detached], ghost: [...s.ghost], rebuildHp: [...s.rebuildHp],
  rounds: [...s.rounds], reload: [...s.reload], charge: [...s.charge], spin: [...s.spin], cooldown: [...s.cooldown], aim: [...s.aim],
});

export class DebrisLives {
  private readonly lives = new Map<number, Life>();
  readonly stats = { pieces: 0, crumbles: 0, gone: 0, dropped: 0 };

  constructor(private readonly host: {
    store: ShipStore;
    /** A crumble to show (as the server's partDestroyed would have) */
    crumbled?: (m: ServerPartDestroyedMessage) => void;
  }) {}

  has(id: number): boolean {
    return this.lives.has(id);
  }

  ids(): IterableIterator<number> {
    return this.lives.keys();
  }

  /** A piece it runs from its spawn: `ship` its state as spawned at `born`, `decay` each part's crumble tick */
  add(id: number, born: number, ship: ShipState, decay: readonly number[], aloof = false): void {
    this.lives.set(id, { decay, versions: [{ from: born + 1, ship }], pre: new Map(), shown: born, aloof });
    this.stats.pieces++;
  }

  /** A connection afresh: the server's ids start over, so none of these are its pieces */
  clear(): void {
    this.lives.clear();
  }

  /** The server tells it from now on (a shipSync), or it's gone */
  drop(id: number): void {
    if (this.lives.delete(id)) this.stats.dropped++;
  }

  /** Only to be seen (undefined: not one it runs) */
  aloofOf(id: number): boolean | undefined {
    return this.lives.get(id)?.aloof;
  }

  /** Each part's crumble tick (a piece breaking off it keeps its parts') */
  decayOf(id: number): readonly number[] | undefined {
    return this.lives.get(id)?.decay;
  }

  /** The structure it flew on tick t's step (null: not one it runs, or nothing left of it by then) */
  versionAt(id: number, t: number): ShipState | null {
    const l = this.lives.get(id);
    if (!l) return null;
    this.upTo(l, t);
    for (let i = l.versions.length - 1; i >= 0; i--) if (l.versions[i].from <= t) return l.versions[i].ship;
    return l.versions[0].ship;
  }

  /** Its body on a crumble's tick before it was recentred (where what broke off starts); null: none kept */
  preAt(id: number, t: number): FlightBody | null {
    return this.lives.get(id)?.pre.get(t) ?? null;
  }

  /** Gone before tick t's step: its time is up (it goes at the start of that tick) */
  gone(id: number, t: number): boolean {
    const l = this.lives.get(id);
    return !!l && t >= l.versions[0].ship.despawnTick;
  }

  /** After tick t's step: a crumble's rebuild recentres it; false: nothing left of it */
  after(id: number, t: number, body: FlightBody): boolean {
    const l = this.lives.get(id);
    if (!l) return true;
    this.upTo(l, t + 1);
    const was = this.flown(l, t);
    const now = l.end === t ? null : this.flown(l, t + 1);
    if (now === was) return true;
    l.pre.set(t, { ...body });
    if (l.pre.size > 8) l.pre.delete(l.pre.keys().next().value!);
    if (t > l.shown) this.show(id, l, t, was, now, body);
    if (!now) return false;
    const w = recentreShift(was.derived.com, now.derived.com, this.host.store.tuning.cellSize, body.angle);
    if (w) {
      body.x += w[0];
      body.y += w[1];
      quantizeShipBody(body);
    }
    return true;
  }

  /** The version flown on t's step (versions worked out that far) */
  private flown(l: Life, t: number): ShipState {
    for (let i = l.versions.length - 1; i >= 0; i--) if (l.versions[i].from <= t) return l.versions[i].ship;
    return l.versions[0].ship;
  }

  /** Its crumbles worked out through tick t - 1's rebuild point (the structure flown on t is known) */
  private upTo(l: Life, t: number): void {
    const { catalog, tuning } = this.host.store;
    for (;;) {
      if (l.end !== undefined) return;
      const v = l.versions[l.versions.length - 1];
      // (Its next crumble: the earliest time among the parts still there, not before this structure is flown)
      let next = Infinity;
      for (let i = 0; i < l.decay.length; i++) if (v.ship.hp[i] > 0 && !v.ship.detached[i]) next = Math.min(next, Math.max(l.decay[i], v.from));
      if (next >= t) return;
      const ship = clone(v.ship);
      crumbleRebuild(ship, crumblingParts(v.ship, l.decay, next), catalog, tuning);
      this.stats.crumbles++;
      if (ship.derived.root < 0) { l.end = next; this.stats.gone++; return; }
      l.versions.push({ from: next + 1, ship });
      if (l.versions.length > 24) l.versions.splice(1, 1);
    }
  }

  /** A crumble on tick t, first stepped: the store has its new structure, and its parts' crumbling shows */
  private show(id: number, l: Life, t: number, was: ShipState, now: ShipState | null, body: FlightBody): void {
    l.shown = t;
    const { store } = this.host;
    if (now) store.bodies.set(id, now);
    if (!this.host.crumbled) return;
    const geom = store.geometry(was), cs = store.tuning.cellSize, r = (v: number) => Math.round(v * 10) / 10;
    for (let i = 0; i < l.decay.length; i++) {
      if (!(was.hp[i] > 0) || was.detached[i] || l.decay[i] > t) continue;
      const [x, y] = shipPointToWorld(was, body, geom[i].centroid, cs);
      this.host.crumbled({
        type: 'partDestroyed', bodyId: id, part: i, fn: was.blueprint.parts[i].fn, how: 'crumble',
        x: r(x), y: r(y), vx: r(body.vx), vy: r(body.vy), size: r(Math.sqrt(geom[i].area) * cs),
      });
    }
  }
}
