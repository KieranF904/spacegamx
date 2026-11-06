/**
 * The dev Sim tools' handle on the game's prediction (client predict/Prediction.ts, C3 by default): the live mode
 * switch for comparing the alternatives (F7 *Prediction mode* buttons, `?predict=C2`, `window.__simTools.predict.set()`),
 * plus the dev-only measures: the hit tally (hitTally.ts, fed by WeaponFx.tally via Renderer.shotTally) and where
 * other ships are drawn against their ST (drawGap). Dev builds only (app/devTools.ts makes it).
 */
import { EntityType, ReplicaMode } from '@space-game/common';
import type { GameState } from '../../state/GameState';
import type { ShipClient } from '../../ships/ShipClient';
import type { Renderer } from '../../rendering/Renderer';
import type { Prediction } from '../../predict/Prediction';
import type { PtStLayer } from '../../predict/ptst';
import type { ModeCtx, ModeId, PredictMode } from '../../predict/modes';
import { HitTally, StrikeOffsets } from './hitTally';
import { shieldOf } from '../../ships/drawnHit';

export class PredictController {
  readonly tally: HitTally;
  readonly strikes: StrikeOffsets;
  /**
   * Where every other ship is drawn against where your shells would meet it: sampled 4 times a second, each ship's
   * drawn place and the tick your shells are drawn at, against its ST there once confirmed (StrikeOffsets' gap),
   * apart for other pilots and for AI ships
   */
  readonly drawGap: { pilot: StrikeOffsets; ai: StrikeOffsets };
  onChange: ((m: { id: string; blurb: string }) => void) | null = null;

  constructor(readonly prediction: Prediction, state: GameState, sc: ShipClient, renderer: Renderer) {
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
    prediction.onChange = (m) => {
      this.tally.reset();
      this.strikes.reset();
      this.drawGap.pilot.reset();
      this.drawGap.ai.reset();
      this.onChange?.(m);
    };
  }

  get layer(): PtStLayer { return this.prediction.layer; }
  get ctx(): ModeCtx { return this.prediction.ctx; }
  get mode(): PredictMode { return this.prediction.mode; }
  get modes(): readonly PredictMode[] { return this.prediction.modes; }
  get switchedAt(): number { return this.prediction.switchedAt; }

  set(id: ModeId | string): boolean {
    return this.prediction.set(id);
  }

  get lerpMs(): number { return this.prediction.lerpMs; }
  set lerpMs(v: number) { this.prediction.lerpMs = v; }
}
