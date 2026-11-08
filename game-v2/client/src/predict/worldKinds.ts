/**
 * The PT timeline's kinds in the game (C3, the default, and C2; the registry: predict/ptKinds.ts), in their order:
 *
 *   ships   the PT/ST layer (ptst.ts over world.ts): other pilots and the AI it steps, adapted as a kind
 *   bodies  bosses on the replica layer, drawn at their PT tick (predict/kinds/bodiesKind.ts)
 *   guides  homing shells and mobs stepped ahead of the snapshots (predict/kinds/guidesKind.ts)
 *   moves   bodies' moves (boss attacks): their looks at the body's PT tick, their shells drawn ahead (movesKind.ts)
 *
 * Other ships are read past the confirmed tick through AheadReads (the ships kind's PT where it has one), never by
 * stepping them ahead on the replica layer. Prediction.ts installs them while C2/C3 runs (install) and takes them out
 * for the dev alternatives (uninstall): the
 * snapshots' runners and the drawing are as they were.
 */
import { AHEAD_BACK, type FlightBody, type ReplicaState } from '@space-game/common';
import type { GameState } from '../state/GameState';
import type { ShipClient } from '../ships/ShipClient';
import type { Renderer } from '../rendering/Renderer';
import { PtKinds, noPtStats, type PoseXY, type PtKind, type PtKindStats } from './ptKinds';
import { AheadReads } from './aheadReads';
import { BodiesKind } from './kinds/bodiesKind';
import { GuidesKind } from './kinds/guidesKind';
import { MovesKind } from './kinds/movesKind';
import { ShellsKind } from './kinds/shellsKind';
import { setLate } from './late';
import type { PtStLayer } from './ptst';

/** The PT/ST layer as the registry's first kind (ships): it confirms and advances; the others read its PT */
export class ShipsKind implements PtKind {
  readonly name = 'ships';
  readonly order = 0;
  constructor(readonly layer: PtStLayer) {}
  get stats(): PtKindStats {
    const s = this.layer.stats, o = noPtStats();
    return Object.assign(o, { ticks: s.ticks, steps: s.steps, checks: s.checks, matches: s.matches, misses: s.misses, restepThings: s.restepShips, restepTicks: s.restepTicks, resteps: s.resteps, corrections: s.corrections, correctionDist: s.correctionDist, restepMs: s.restepMs, advanceMs: s.advanceMs });
  }
  confirm(c: number): void { this.layer.confirm(c); }
  advance(to: number): void { this.layer.advance(to); }
  reset(): void { this.layer.reset(); }
  has(id: number): boolean { return this.layer.has(id); }
  pose(id: number, t: number): PoseXY | null { return this.layer.pose(id, t); }
}

export interface WorldKinds {
  kinds: PtKinds;
  bodies: BodiesKind;
  guides: GuidesKind;
  moves: MovesKind;
  shells: ShellsKind;
  reads: AheadReads;
  install(): void;
  uninstall(): void;
}

/** `drawTick(id)`: the tick a thing on PT is drawn at this frame (the mode's: ptDrawTick) */
/** `renderer`: the game's, once made (moves' shells are drawn ahead through it; none before it exists) */
/** `kindOf(id)`: the PT kind the ships layer gave a ship (shipKinds.ts: 'ai', 'pilot', 'rows'): other ships' shells read it */
export function worldKinds(state: GameState, sc: ShipClient, renderer: () => Renderer | null, layer: PtStLayer, drawTick: (id: number) => number, kindOf: (id: number) => string | undefined = () => undefined): WorldKinds {
  const self = () => state.playerId, confirmed = () => state.serverTick;
  const reads = new AheadReads({
    reps: sc.replicas, confirmed, self,
    pt: (id, t) => (layer.has(id) ? ((layer.ring.get(id, Math.min(t, layer.head)) as ReplicaState | undefined)?.body ?? null) : null),
  });
  const bodies = new BodiesKind({ ids: () => sc.bodies.told(), at: (id, t) => (sc.replicas.at(id, t) as ReplicaState | null) ?? null });
  const guides = new GuidesKind({ ids: () => sc.guides.ids(), fork: (id) => sc.guides.fork(id), step: (id, f, t) => sc.guides.stepFork(id, f, t, reads) });
  const moves = new MovesKind({
    bodies: () => sc.bodies.ids(),
    fork: (from, id) => sc.forkMoves(from, id, reads),
    self,
    drawTick,
    show: (m, late) => { setLate(m, late); sc.show(m); },
    shell: (row, until) => {
      const d = row.data!, t = d[3], owner = d[6], body: FlightBody | undefined = sc.replicas.at(owner, t - 1)?.body;
      const r = renderer();
      if (!r) return null;
      return r.predictShot({
        pose: body ? { x: body.x, y: body.y, angle: body.angle } : { x: d[4], y: d[5], angle: Math.atan2(row.vy ?? 0, row.vx ?? 0) },
        owner, type: d[0], grade: d[1], spawnX: d[4], spawnY: d[5], spawnTick: t, vx: row.vx ?? 0, vy: row.vy ?? 0, size: d[7] || 1, life: Math.max(1, until - t),
      });
    },
    retract: (h) => { renderer()?.retractShot(h); },
  });
  // (Other ships' shells drawn as their guns fire ahead: their gun lanes, ships/guns/OtherGuns.ts)
  const shells = new ShellsKind({
    layer, kind: kindOf, guns: sc.otherGuns, tuning: sc.store.tuning, confirmed,
    ship: (id) => { const s = sc.store.get(id); return s && s.kind === 'ship' ? s : undefined; },
    env: () => sc.replicaEnv(),
    pose: (id, t) => sc.replicas.preAt(id, t),
    draw: (owner, t, rec, pose, pilot) => sc.predictOtherVolley(owner, t, rec, pose, pilot),
    retract: (h) => sc.retractOther(h),
  });
  const kinds = new PtKinds().add(new ShipsKind(layer)).add(bodies).add(guides).add(moves).add(shells);
  return {
    kinds, bodies, guides, moves, shells, reads,
    install() {
      kinds.reset();
      sc.bodyHost.ahead = reads;
      sc.ptMoves = moves;
    },
    uninstall() {
      sc.bodyHost.ahead = null;
      sc.ptMoves = null;
      kinds.reset();
    },
  };
}

/** The draw tick for a thing on PT that isn't a pilot (bosses, mobs, homing shells): where your shells meet it */
function aheadDraw(render: number, ownDraw: number): number {
  return Math.max(render, ownDraw - AHEAD_BACK);
}
