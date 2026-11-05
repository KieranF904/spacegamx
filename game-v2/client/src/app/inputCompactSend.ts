/**
 * The send rules for compact inputs (CAPS.INPUTS: common network/inputCompact.ts), no added latency:
 *   - a key or fire change goes at once, as before;
 *   - the aim goes once it is AIM_SEND_STEPS off what was sent (fine mouse-steer still turns the ship: the steering
 *     eases in on any angle left, common ships/flight.ts steerSpin, so a slow drag goes in steps of this);
 *   - when the mouse stops (AIM_SETTLE_TICKS without the aim changing) the exact aim goes once;
 *   - firing or spooling a jump, every tick the aim (or the cursor distance) changed goes;
 *   - whatever aim and distance are pending ride along on anything that goes.
 * The cursor distance only matters to guns, mining lasers and the jump (and to the tow when it takes hold), so it goes
 * only while they're on, or along with something else. What is sent is planned to be cheap on the wire (planAim: a fine
 * or coarse step; the distance on its grid) and the ship is predicted with exactly what was sent (or held), so the
 * prediction steps what the server steps. No ticks are batched.
 *
 * PREDICTION-SENSITIVE: msg.targetAngle and msg.cursorDist are rewritten here to what goes (or what the server holds).
 */
import { planAim, aimStep, cursorDistOnGrid, dequantizeCursorAngle, INPUT_BOOLS, type ClientInputMessage, type InputBool } from '@space-game/common';

/** Aim moves smaller than this (13-bit steps: 8 = 0.35 deg, 3 pixels at the cursor's 500-unit ring) wait, unless firing */
export const AIM_SEND_STEPS = 16;
/** Ticks the aim must hold still for the mouse to count as stopped (the settle send) */
export const AIM_SETTLE_TICKS = 2;

/** What the compact rules remember between ticks (part of InputSendState) */
export interface CompactSendState {
  readonly lastSent: Record<InputBool, boolean | undefined>;
  lastSentAngle: number;
  /** The cursor distance last sent, as sent (world units: the server holds it until the next) */
  sentDist: number;
  /** The aim the mouse asked for last tick, and for how many ticks it hasn't changed */
  aimSeen: number;
  aimStill: number;
}

/**
 * Whether this tick's input goes; msg's aim and distance become what goes (or what the server already holds).
 * `want` is the mouse's 13-bit aim, `wantDist` its distance; `frozen`: the mouse is on a window, not flying (aim held).
 */
export function compactSend(s: CompactSendState, msg: ClientInputMessage, want: number, wantDist: number, frozen: boolean): { send: boolean; q: number } {
  s.aimStill = want === s.aimSeen ? s.aimStill + 1 : 0;
  s.aimSeen = want;
  const urgent = !!(msg.fireLeft || msg.fireRight || msg.jump);
  let keys = false;
  for (let i = 0; i < INPUT_BOOLS.length; i++) { const k = INPUT_BOOLS[i]; if (msg[k] !== s.lastSent[k]) { keys = true; break; } }
  // (Settling: the aim exactly. Otherwise the cheapest step towards it, which may fall short by a 13-bit step or, on a flick, a few)
  const settle = s.aimStill >= AIM_SETTLE_TICKS;
  const target = frozen ? s.lastSentAngle : settle ? want : planAim(s.lastSentAngle, want);
  const off = Math.abs(aimStep(s.lastSentAngle, target));
  const aimDue = off > 0 && (urgent || settle || off >= AIM_SEND_STEPS);
  const dist = frozen ? s.sentDist : cursorDistOnGrid(wantDist);
  const distDue = urgent && dist !== s.sentDist;
  const send = keys || aimDue || distDue;
  const q = send ? target : s.lastSentAngle;
  msg.targetAngle = dequantizeCursorAngle(q);
  msg.cursorDist = send ? dist : s.sentDist;
  return { send, q };
}
