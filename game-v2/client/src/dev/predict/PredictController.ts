/**
 * The live switch for the dev prediction modes (modes.ts): installs a mode's hook on GameState.drawMode, runs the PT/ST
 * layer for C2/C3 (ptst.ts over replicaWorld.ts), and keeps the hit tally (hitTally.ts, fed by WeaponFx.tally). Dev
 * builds only (app/devTools.ts makes it); mode A (no hook) until switched. `?predict=C2` in the URL starts in a mode.
 */
import { EntityType, ReplicaMode } from '@space-game/common';
import type { GameState } from '../../state/GameState';
import type { ShipClient } from '../../ships/ShipClient';
import type { Renderer } from '../../rendering/Renderer';
import { PtStLayer } from './ptst';
import { ReplicaPtWorld } from './replicaWorld';
import { HitTally, StrikeOffsets } from './hitTally';
import { shieldOf } from '../../ships/drawnHit';
import { PREDICT_MODES, modeById, type ModeCtx, type ModeId, type PredictMode } from './modes';

export class PredictController {
  readonly layer: PtStLayer;
  readonly tally: HitTally;
  readonly strikes: StrikeOffsets;
  /**
   * Where every other ship is drawn against where your shells would meet it: sampled 4 times a second, each ship's
   * drawn place and the tick your shells are drawn at, against its ST there once confirmed (StrikeOffsets' gap),
   * apart for other pilots and for AI ships
   */
  readonly drawGap: { pilot: StrikeOffsets; ai: StrikeOffsets };
  readonly ctx: ModeCtx;
  private current: PredictMode = PREDICT_MODES[0];
  /** When the mode was last switched (the overlay's rates start again from there) */
  switchedAt = 0;
  onChange: ((m: { id: string; blurb: string }) => void) | null = null;

  constructor(private readonly state: GameState, sc: ShipClient, renderer: Renderer) {
    this.layer = new PtStLayer(new ReplicaPtWorld(state, sc), { touch: false });
    const self = () => state.playerId;
    const ship = (target: number) => { const e = state.entities.get(target); return !!e && (e.type === EntityType.Player || e.type === EntityType.Enemy || e.type === EntityType.NPC || e.type === EntityType.ShipBody); };
    const shielded = (target: number) => { const e = state.entities.get(target); return !!e && shieldOf(e) > 0; };
    this.tally = new HitTally((owner) => owner === self(), ship, undefined, undefined, shielded);
    this.strikes = new StrikeOffsets((id, t) => sc.replicas.at(id, t)?.body ?? null, () => state.serverTick);
    const tally = this.tally.tally;
    const st = (id: number, t: number) => sc.replicas.at(id, t)?.body ?? null, conf = () => state.serverTick;
    this.drawGap = { pilot: new StrikeOffsets(st, conf), ai: new StrikeOffsets(st, conf) };
    window.setInterval(() => {
      const me = state.entities.get(state.playerId);
      if (!me || state.predictedTick <= 0) return;
      const k = Math.round(state.ownDrawTick());
      for (const [id, e] of state.entities) {
        if (id === state.playerId || !ship(id) || Math.hypot(e.renderX - me.renderX, e.renderY - me.renderY) > 2500) continue;
        const m = sc.replicas.modeOf(id), r = sc.store.get(id)?.derived.radius;
        if (m === undefined || m === ReplicaMode.Drift || m === ReplicaMode.Docked || !r) continue;
        const pilot = m === ReplicaMode.Player;
        (pilot ? this.drawGap.pilot : this.drawGap.ai).strike(id, k, pilot, e.renderX, e.renderY, r);
      }
    }, 250);
    renderer.shotTally = (what, shot, owner, target) => {
      tally(what, shot, owner, target);
      // (A strike on a hull: where the ship was drawn, for the gap to where it really was then)
      if (what !== 'struck' || owner !== self() || !ship(target) || shielded(target)) return;
      const e = state.entities.get(target)!, r = sc.store.get(target)?.derived.radius;
      if (r) this.strikes.strike(target, Math.round(state.ownDrawTick()), sc.replicas.modeOf(target) === ReplicaMode.Player, e.renderX, e.renderY, r);
    };
    this.ctx = {
      self,
      renderTick: () => state.renderTickNow,
      confirmedTick: () => state.serverTick,
      predictedTick: () => state.predictedTick,
      ownDraw: () => state.timelineAt().ownDraw(),
      ai: (id) => sc.bodies.ahead(id),
      pilot: (id) => sc.replicas.modeOf(id) === ReplicaMode.Player,
      layer: this.layer,
    };
  }

  get mode(): PredictMode { return this.current; }
  readonly modes = PREDICT_MODES;

  set(id: ModeId | string): boolean {
    const m = modeById(id);
    if (!m) return false;
    this.current = m;
    this.layer.reset();
    if (m.ptst) this.layer.set({ touch: m.ptst.touch });
    this.state.drawMode = m.hook(this.ctx);
    this.tally.reset();
    this.strikes.reset();
    this.drawGap.pilot.reset();
    this.drawGap.ai.reset();
    this.switchedAt = performance.now();
    this.onChange?.(m);
    return true;
  }

  get lerpMs(): number { return this.layer.opts.lerpMs; }
  set lerpMs(v: number) { this.layer.set({ lerpMs: v }); }
}
