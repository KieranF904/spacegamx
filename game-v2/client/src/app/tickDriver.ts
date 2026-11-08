/**
 * @contract client.app.tickDriver
 * owns:       the per-frame tick stepping (proto: fixed-rate input ticks; online: one prediction step per tick number) and the 1 Hz state hash check
 * needs:      TickHost (state, input send context, send), app/inputSend tickInput, common TICK_MS and computeStateHash
 * invariants: every tick number is stepped exactly once, up to the server's estimated tick — none pinned
 * extend:     none (the tick order is fixed)
 */

import { TICK_MS, computeStateHash, type ClientMessage } from '@space-game/common';
import type { GameState } from '../state/GameState';
import { tickInput, type InputSendCtx } from './inputSend';

/** What the tick driver reads from the game */
export interface TickHost {
  readonly state: GameState;
  readonly ctx: InputSendCtx;
  readonly proto: boolean;
  send(msg: ClientMessage): void;
}

export class TickDriver {
  /** ms accumulator for fixed-rate input ticks (proto) */
  private accum = 0;
  private lastHash = 0;

  constructor(private h: TickHost) {}

  /** Steps the ticks due this frame (delta in seconds); call while logged in and connected */
  run(delta: number): void {
    const h = this.h;
    if (h.proto) {
      // Proto: no prediction. Inputs go straight to the in-process simulation, at the tick rate.
      h.state.updateCachedServerTick();
      this.accum += delta * 1000; // delta is in seconds
      let ticksRun = 0;
      while (this.accum >= TICK_MS && ticksRun < 4) {
        tickInput(h.ctx);
        this.accum -= TICK_MS;
        ticksRun++;
      }
      if (this.accum > TICK_MS * 4) this.accum = 0;
    } else {
      // Prediction: one physics step per tick number, every tick number once, up to the
      // server's tick (estimated). The replay after a snapshot then steps exactly the
      // ticks the server will (see GameState.ticksDue: tick numbers and steps can't drift apart).
      const due = Math.min(4, h.state.ticksDue());
      for (let i = 0; i < due; i++) {
        h.state.cachedServerTick = h.state.predictedTick;
        tickInput(h.ctx);       // sample input, queued for targetTick = tick + input delay
        h.state.drainDelayQueue();   // apply what's due and step to predictedTick + 1
        h.state.predictedTick++;
      }
      h.state.cachedServerTick = h.state.predictedTick;
    }
  }

  /** Periodic state hash for snapshot-on-mismatch (1 Hz); call while logged in and connected, not in proto */
  sendHash(now: number): void {
    const h = this.h;
    if (now - this.lastHash > 1000) {
      const player = h.state.entities.get(h.state.playerId);
      if (player) {
        const hash = computeStateHash(
          player.x,
          player.y,
          player.angle || 0,
          player.vx || 0,
          player.vy || 0,
          player.hp || 0,
          h.state.boostFuel,
          h.state.systemId,
        );
        // The tick the prediction is at: the server checks it against its own record of that tick
        h.send({ type: 'stateHash', tick: h.state.cachedServerTick, hash });
        this.lastHash = now;
      }
    }
  }
}
