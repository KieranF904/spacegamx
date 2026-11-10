/**
 * @contract client.ship.thrust-command
 * owns:       what the local pilot's keys ask the engines for (ship grid frame), read by the thruster effects and the status panel
 * needs:      ThrustHost (state, hangarOpen, inputEnabled, jumpPhase, helm, noseThrust, isKeyDown), common worldToLocalDir
 * invariants: the drive has the engines while charging or burning (idle command) — client/src/ships/own/thrustCommand.test.ts
 * extend:     a new control scheme is one more branch on helm / noseThrust
 */

import { worldToLocalDir } from '@space-game/common';
import type { GameState } from '../../state/GameState';
import type { ThrustCommand } from '../ThrusterFx';

export interface ThrustHost {
  readonly state: GameState;
  hangarOpen(): boolean;
  inputEnabled?(): boolean;
  jumpPhase(): string;
  helm(): boolean;
  noseThrust?(): boolean;
  isKeyDown(code: string): boolean;
}

/** What the local pilot's keys ask the engines for (ship grid frame), for the thruster effects */
export function localThrustCommand(h: ThrustHost): ThrustCommand {
  const me = h.state.entities.get(h.state.playerId);
  const idle: ThrustCommand = { dir: [0, 0], turn: 0, boost: false };
  if (!me || h.hangarOpen() || !(h.inputEnabled?.() ?? true)) return idle;
  if (h.jumpPhase() !== 'ready' && h.jumpPhase() !== 'cooldown') return idle; // the drive has the engines
  const k = (...codes: string[]) => (codes.some((c) => h.isKeyDown(c)) ? 1 : 0);
  const fwd = k('KeyW', 'ArrowUp'), back = k('KeyS', 'ArrowDown'), left = k('KeyA', 'ArrowLeft'), right = k('KeyD', 'ArrowRight');
  const boost = k('ShiftLeft', 'ShiftRight') === 1;
  let dir: [number, number], turn: number;
  if (h.helm()) {
    dir = [k('KeyE') - k('KeyQ'), back - fwd];
    turn = right - left;
  } else if (h.noseThrust?.()) {
    // Along the ship (W the nose); turning follows the spin
    dir = [right - left, back - fwd];
    turn = Math.max(-1, Math.min(1, (me.angVel ?? 0) / 0.05));
  } else {
    // Screen-relative keys, turned into the ship's frame; turning follows the spin
    dir = worldToLocalDir([right - left, back - fwd], me.renderAngle) as [number, number];
    turn = Math.max(-1, Math.min(1, (me.angVel ?? 0) / 0.05));
  }
  const m = Math.hypot(dir[0], dir[1]);
  if (m > 1) dir = [dir[0] / m, dir[1] / m];
  return { dir, turn, boost: boost && m > 0 };
}
