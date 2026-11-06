/**
 * The client's prediction of the world: other ships on the PT/ST layer (ptst.ts) over the tick layer (world.ts), and
 * with them the PT timeline's other kinds (worldKinds.ts: bosses, homing shells and mobs, boss attacks), drawn by the
 * current mode's hook (modes.ts) on GameState.drawMode. Game.ts makes one when prediction is on (not proto) and it
 * starts in C3 (DEFAULT_MODE) in every build. The dev Sim tools (F7: client dev/predict/PredictController.ts) switch
 * it live to the other modes (A, B, C1, C2) for comparison; `?predict=C2` in a dev URL starts in one.
 */
import { AHEAD_BACK, EntityType } from '@space-game/common';
import type { GameState } from '../state/GameState';
import type { ShipClient } from '../ships/ShipClient';
import type { Renderer } from '../rendering/Renderer';
import { worldKinds, type WorldKinds } from './worldKinds';
import { PtStLayer } from './ptst';
import { ReplicaPtWorld, type PtHost } from './world';
import { DEFAULT_MODE, PREDICT_MODES, modeById, ptDrawTick, type ModeCtx, type ModeId, type PredictMode } from './modes';

/** The kinds of entity that can be ships on the PT layer (drones and dummies are ship bodies; debris is left out by its replica mode) */
const SHIP_TYPES = [EntityType.Player, EntityType.Enemy, EntityType.NPC, EntityType.ShipBody];

/** The PT layer's host over the game: GameState's ticks and entities, ShipClient's tick layer */
export function gameHost(state: GameState, sc: ShipClient): PtHost {
  return {
    reps: sc.replicas, store: sc.store, bodies: sc.bodies, tuning: sc.tuning,
    self: () => state.playerId,
    confirmed: () => state.serverTick,
    predicted: () => state.predictedTick,
    *candidates() { for (const type of SHIP_TYPES) for (const e of state.entities.ofType(type)) yield e.id; },
    derivedAt: (id, t) => sc.derivedAt(id, t),
  };
}

/** A confirmed tick this far behind the layer's: a new connection (the server's clock started over), the layer too */
const RESTART_BACK = 120;

export class Prediction {
  readonly world: ReplicaPtWorld;
  readonly layer: PtStLayer;
  /**
   * The PT timeline's kinds (predict/ptKinds.ts, worldKinds.ts): the ships layer first, then bosses, homing shells and
   * mobs, and boss attacks, all stepped to your tick; installed in C2/C3 (the snapshots' runners draw as they always
   * did in the other modes)
   */
  readonly kinds: WorldKinds;
  readonly ctx: ModeCtx;
  readonly modes = PREDICT_MODES;
  private current: PredictMode;
  /** When the mode was last switched (the dev overlay's rates start again from there) */
  switchedAt = 0;
  onChange: ((m: { id: string; blurb: string }) => void) | null = null;

  /** `renderer`: the game's, once it's made (boss attacks' shells are drawn ahead through it) */
  constructor(private readonly state: GameState, sc: ShipClient, renderer: () => Renderer | null, initial: ModeId = DEFAULT_MODE) {
    this.world = new ReplicaPtWorld(gameHost(state, sc));
    this.layer = new PtStLayer(this.world, { touch: true });
    const layer = this.layer;
    this.ctx = {
      self: () => state.playerId,
      renderTick: () => state.renderTickNow,
      confirmedTick: () => {
        const c = state.serverTick;
        if (c < layer.confirmed - RESTART_BACK) layer.reset();
        return c;
      },
      predictedTick: () => state.predictedTick,
      ownDraw: () => state.timelineAt().ownDraw(),
      ai: (id) => sc.bodies.ahead(id),
      drawBack: (id) => this.world.kind(id)?.drawBack ?? AHEAD_BACK,
      layer,
    };
    this.kinds = worldKinds(state, sc, renderer, layer, (id) => ptDrawTick(this.ctx, id, this.ctx.ownDraw()));
    this.ctx.kinds = this.kinds.kinds;
    this.current = modeById(initial) ?? PREDICT_MODES[0];
    this.install();
  }

  get mode(): PredictMode { return this.current; }

  set(id: ModeId | string): boolean {
    const m = modeById(id);
    if (!m) return false;
    this.current = m;
    this.install();
    this.onChange?.(m);
    return true;
  }

  private install(): void {
    const m = this.current;
    this.layer.reset();
    if (m.ptst) this.layer.set({ touch: m.ptst.touch });
    if (m.ptst) this.kinds.install(); else this.kinds.uninstall();
    this.state.drawMode = m.hook(this.ctx);
    this.switchedAt = performance.now();
  }

  get lerpMs(): number { return this.layer.opts.lerpMs; }
  set lerpMs(v: number) {
    this.layer.set({ lerpMs: v });
    this.kinds.bodies.ease.lerpMs = v;
    this.kinds.guides.ease.lerpMs = v;
  }
}
