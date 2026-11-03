/**
 * The input-send path (split out of Game.tickInput / sendNeutralInput; inputSend.ts never imports Game, it reads an
 * InputSendHost). Once per fixed input tick (TICK_RATE) tickInput samples the keys and mouse, builds the input
 * message, and either sends it (new seq, network.send, state.applyInput) when anything differs from the last one sent,
 * or hands it to state.predictTick unsent. Proto: no targetTick and no prediction queue.
 *
 * PREDICTION-SENSITIVE: the message fields, their quantisation (quantizeCursorAngle / CURSOR_DIST_STEP), the seq
 * order and the send-vs-predict branch must match what the server replays (server/src/golden/parity.test.ts).
 * The "last sent" bookkeeping uses common inputFields.ts INPUT_BOOLS / INPUT_HELD, so it cannot drift from the message.
 *
 * Per tick: no closures here; the context object (host getters plus the last-sent state) is built once by Game.
 */
import {
  ClientInputMessage,
  ClientTransport,
  quantizeCursorAngle,
  dequantizeCursorAngle,
  CURSOR_RADIUS,
  quantizeCursorDist,
  INPUT_BOOLS, INPUT_HELD, type InputBool,
  CURSOR_DIST_STEP,
} from '@space-game/common';
import type { GameMenuUI } from '../ui/GameMenuUI';
import type { PlayerStatsUI } from '../ui/PlayerStatsUI';
import type { SystemMapUI } from '../ui/SystemMapUI';
import type { NavMarkersUI } from '../ui/NavMarkersUI';
import type { AdminPanel } from '../ui/AdminPanel';
import type { AudioManager } from '../audio/AudioManager';
import type { InputManager } from '../input/InputManager';
import type { ContextActions } from '../input/ContextActions';
import type { Renderer } from '../rendering/Renderer';
import type { ShipClient } from '../ships/ShipClient';
import type { Autopilot } from '../ships/Autopilot';
import type { GameState } from '../state/GameState';
import type { ProtoHooks } from '../Game';

/** What the input path reads from the game (Game supplies it as getters, so late-built windows resolve at use) */
export interface InputSendHost {
  readonly loggedIn: boolean;
  readonly stationOpen: boolean;
  readonly proto: ProtoHooks | null;
  readonly menu: GameMenuUI;
  readonly adminPanel: AdminPanel | null;
  readonly shipClient: ShipClient;
  readonly autopilot: Autopilot;
  readonly context: ContextActions;
  readonly playerStatsUI: PlayerStatsUI;
  readonly systemMapUI: SystemMapUI;
  readonly navMarkers: NavMarkersUI | null;
  readonly audio: AudioManager;
  readonly network: ClientTransport;
  readonly input: InputManager;
  readonly renderer: Renderer;
  readonly state: GameState;
  /** The right mouse button as the guns see it (Game.rightHeld) */
  rightHeld(): boolean;
}

/** What the input path remembers between ticks (owned by the context object, not by Game) */
export interface InputSendState {
  /** The on/off keys last sent (common inputFields.ts INPUT_BOOLS; dodge: the Burst Strafer's control, ships/features/strafer) */
  readonly lastSent: Record<InputBool, boolean | undefined>;
  lastSentAngle: number;          // quantized angle (int)
  lastSentCursorDist: number;
  // Weapon firing state (for the shots-fired stat)
  lastFireLeft: boolean;
  lastFireRight: boolean;
}

/** The context tickInput / sendNeutralInput run on: the host plus the last-sent state. Build it once. */
export interface InputSendCtx extends InputSendHost, InputSendState {}

/** The last-sent state before anything has been sent (once, at start-up) */
export function newInputSendState(): InputSendState {
  return {
    lastSent: {
      forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false,
      strafeLeft: false, strafeRight: false, helm: false, jump: false, dodge: false,
    },
    lastSentAngle: 0,
    lastSentCursorDist: 0,
    lastFireLeft: false,
    lastFireRight: false,
  };
}

/**
 * Fixed-rate input tick (runs at TICK_RATE = 60Hz).
 * Samples current input state, runs local prediction, and only sends
 * a network message if the input actually changed from last send.
 */
export function tickInput(s: InputSendCtx): void {
  // The system map open: the ship faces the map cursor
  const mouseWorld = s.systemMapUI.aimWorld() ?? s.renderer.screenToWorld(
    s.input.mouseX,
    s.input.mouseY
  );

  const playerPos = s.state.getPlayerPosition();

  // Clamp cursor to circle of CURSOR_RADIUS and compute angle
  let dx = mouseWorld.x - playerPos.x;
  let dy = mouseWorld.y - playerPos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > CURSOR_RADIUS) {
    dx = dx / dist * CURSOR_RADIUS;
    dy = dy / dist * CURSOR_RADIUS;
  }

  let rawAngle = Math.atan2(dy, dx);
  // True distance (not the clamped one): turrets converge on the cursor point
  let aimDist = Math.hypot(mouseWorld.x - playerPos.x, mouseWorld.y - playerPos.y);
  // Lining up a jump: lock on to a station, gate or marker near the cursor, and stop just short of it (a stillstone: inside its field)
  // A menu jump: its mark, wherever the cursor is
  const inputEnabled = (s.proto?.inputEnabled?.() ?? true) && !s.shipClient.hangarOpen && !s.menu.isOpen && !s.adminPanel?.capturesFlight;
  const order = inputEnabled ? s.context.flight() : null;
  if (order) {
    rawAngle = order.angle;
    aimDist = order.dist;
    s.shipClient.setJumpAim(aimDist, null);
    s.systemMapUI.jumpAim = { angle: rawAngle, dist: aimDist, label: null };
  } else if (s.loggedIn && s.shipClient.jumpAiming()) {
    // Cursor right on a destination, or pointing straight at one (off-screen ones too: aim at its edge marker)
    // (On the map, whatever's under its cursor wins)
    let best: { name: string; x: number; y: number; stop?: number } | null = s.systemMapUI.jumpLock(), bd = best ? -Infinity : Infinity;
    const aimA = Math.atan2(mouseWorld.y - playerPos.y, mouseWorld.x - playerPos.x);
    for (const t of s.navMarkers?.snapTargets() ?? []) {
      const far = Math.hypot(t.x - playerPos.x, t.y - playerPos.y);
      if (far < 2500) continue;
      const near = Math.hypot(t.x - mouseWorld.x, t.y - mouseWorld.y);
      let da = Math.abs(Math.atan2(t.y - playerPos.y, t.x - playerPos.x) - aimA);
      if (da > Math.PI) da = 2 * Math.PI - da;
      const onPoint = near < Math.max(1500, far * 0.12);
      const onLine = da < Math.max(0.05, Math.atan2(1200, far));
      if (!onPoint && !onLine) continue;
      const score = onPoint ? near / far : da;
      if (score < bd) { bd = score; best = t; }
    }
    if (best) {
      const far = Math.hypot(best.x - playerPos.x, best.y - playerPos.y);
      rawAngle = Math.atan2(best.y - playerPos.y, best.x - playerPos.x);
      aimDist = Math.max(0, far - (best.stop ?? 1500));
    }
    s.shipClient.setJumpAim(aimDist, best?.name ?? null);
    s.systemMapUI.jumpAim = { angle: rawAngle, dist: aimDist, label: best?.name ?? null };
  }

  let fireLeft = inputEnabled && ((s.input.isMouseDown(0) && !s.context.withholdingLeft()) || s.systemMapUI.firing());
  let fireRight = inputEnabled && s.rightHeld();
  // A click calls off a menu jump too
  if (fireLeft && s.context.jumpMark()) s.context.cancel('Jump cancelled');
  // The autopilot flies until a click (or a flight key) takes over
  if (s.autopilot.active && (fireLeft || fireRight)) s.autopilot.cancel('Autopilot off');
  const auto = s.loggedIn && inputEnabled && !s.stationOpen ? s.autopilot.tick() : null;
  if (auto) { fireLeft = fireRight = false; }

  // Gun sounds come from the shots themselves (updateSounds); firing stirs the combat music
  if (fireLeft && !s.lastFireLeft) s.playerStatsUI.addShotFired();
  if (fireRight && !s.lastFireRight) s.playerStatsUI.addShotFired();
  if (fireLeft || fireRight) s.audio.bumpCombat(1);
  s.lastFireLeft = fireLeft;
  s.lastFireRight = fireRight;

  // Fire state is now passed to renderer AFTER drainDelayQueue() in the
  // update loop, using the drained (tick-accurate) angle rather than the
  // live mouse angle. This ensures the laser visual matches what the server
  // actually processes (N ticks delayed).

  let forward = inputEnabled && (s.input.isKeyDown('KeyW') || s.input.isKeyDown('ArrowUp'));
  let backward = inputEnabled && (s.input.isKeyDown('KeyS') || s.input.isKeyDown('ArrowDown'));
  let left = inputEnabled && (s.input.isKeyDown('KeyA') || s.input.isKeyDown('ArrowLeft'));
  let right = inputEnabled && (s.input.isKeyDown('KeyD') || s.input.isKeyDown('ArrowRight'));
  let boost = inputEnabled && (s.input.isKeyDown('ShiftLeft') || s.input.isKeyDown('ShiftRight'));
  // Proto helm controls: left/right turn the ship, Q/E strafe
  let helm = s.shipClient.helmMode();
  let strafeLeft = helm && inputEnabled && s.input.isKeyDown('KeyQ');
  let strafeRight = helm && inputEnabled && s.input.isKeyDown('KeyE');
  // Jump drive: J latches it on, and it stays on until the jump fires (or J again cancels)
  let jump = inputEnabled && s.shipClient.jumpHeld();
  // Burst Strafer: a press of the dodge key (Space) asks for one burst, the way you're steering (ShipClient.dodgeControl)
  let dodge = inputEnabled && s.shipClient.dodgeControl();
  // (The angle is quantized to 13 bits, so client and server use the same value for hitscan: see CURSOR_STATE.md)
  let quantized = quantizeCursorAngle(rawAngle);
  let cursorDistQ = quantizeCursorDist(aimDist);
  // A menu jump has the controls as the autopilot does: no thrust, mouse-steer, the drive as it says
  if (order) {
    forward = backward = left = right = boost = helm = strafeLeft = strafeRight = dodge = false;
    jump = order.jump;
  }
  if (auto) {
    ({ forward, backward, left, right, boost, jump } = auto);
    helm = strafeLeft = strafeRight = dodge = false;
    quantized = quantizeCursorAngle(auto.targetAngle);
    cursorDistQ = quantizeCursorDist(auto.jump ? auto.cursorDist : aimDist);
  }
  const targetAngle = dequantizeCursorAngle(quantized);

  // Stamp targetTick using local tick counter — each tick iteration
  // gets a unique targetTick, ensuring one physics step per drain.
  const targetTick = s.state.getInputTargetTick();

  const msg: ClientInputMessage = {
    type: 'input',
    seq: 0, // set below only if we send
    tick: s.state.serverTick,
    targetTick,
    forward,
    backward,
    left,
    right,
    boost,
    fireLeft,
    fireRight,
    targetAngle,
    strafeLeft,
    strafeRight,
    helm,
    cursorDist: cursorDistQ * CURSOR_DIST_STEP,
    jump,
    dodge,
  };

  // Check if anything changed from last sent state
  const changed = inputChanged(s, msg, quantized, cursorDistQ);
  // Debris worked out here is confirmed on the next input, which goes now if nothing else would (ShipClient.takeAcks)
  const acks = s.shipClient?.takeAcks?.();
  if (acks) msg.acks = acks;
  const send = changed || !!acks;

  // Proto: no targetTick (applied on the next tick) and no prediction queue.
  if (s.proto) {
    if (send) {
      msg.seq = s.state.nextInputSeq();
      msg.targetTick = undefined;
      s.network.send(msg);
      markSent(s, msg, quantized, cursorDistQ);
    }
    return;
  }

  // Only send over network if something changed (or debris is to be confirmed)
  if (send) {
    msg.seq = s.state.nextInputSeq();
    s.network.send(msg);
    // Queue for delayed application (physics runs when targetTick is reached)
    s.state.applyInput(msg);
    markSent(s, msg, quantized, cursorDistQ);
  } else {
    // Queue for delayed application (server also applies same input on same tick)
    s.state.predictTick(msg);
  }
}

/** Whether this input differs from the last one sent: any key (INPUT_BOOLS), the quantized aim or cursor distance */
export function inputChanged(s: InputSendState, msg: ClientInputMessage, quantized: number, cursorDistQ: number): boolean {
  for (let i = 0; i < INPUT_BOOLS.length; i++) { const k = INPUT_BOOLS[i]; if (msg[k] !== s.lastSent[k]) return true; }
  return quantized !== s.lastSentAngle || cursorDistQ !== s.lastSentCursorDist;
}

/** Remember this input as the last one sent */
export function markSent(s: InputSendState, msg: ClientInputMessage, quantized: number, cursorDistQ: number): void {
  for (let i = 0; i < INPUT_BOOLS.length; i++) { const k = INPUT_BOOLS[i]; s.lastSent[k] = msg[k]; }
  s.lastSentAngle = quantized;
  s.lastSentCursorDist = cursorDistQ;
}

/**
 * The window lost focus or the tab was hidden: one neutral input (all keys
 * up, no fire), straight to the network. A hidden tab's ticker stops, so
 * tickInput wouldn't send it until the player came back, and the ship would
 * fly on (the server also stops a ship that hasn't sent input for a while).
 */
export function sendNeutralInput(s: InputSendCtx): void {
  if (!s.loggedIn || !s.state.playerId || !s.network.isConnected()) return;
  const msg: ClientInputMessage = {
    type: 'input',
    seq: s.state.nextInputSeq(),
    tick: s.state.serverTick,
    targetTick: s.proto ? undefined : s.state.getInputTargetTick(),
    forward: false,
    backward: false,
    left: false,
    right: false,
    boost: false,
    fireLeft: false,
    fireRight: false,
    targetAngle: dequantizeCursorAngle(s.lastSentAngle),
    strafeLeft: false,
    strafeRight: false,
    helm: s.lastSent.helm,
    cursorDist: s.lastSentCursorDist * CURSOR_DIST_STEP,
    jump: false,
    dodge: false,
  };
  s.network.send(msg);
  // The prediction steps the same input (proto has none)
  if (!s.proto) s.state.applyInput(msg);
  for (let i = 0; i < INPUT_HELD.length; i++) s.lastSent[INPUT_HELD[i]] = false;
}
