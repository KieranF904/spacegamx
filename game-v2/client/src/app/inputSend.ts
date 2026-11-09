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
 * With compact inputs (CAPS.INPUTS) what goes and when is decided by inputCompactSend.ts (aim past a small step, a
 * settle send, every tick while firing). In both layouts nothing is sent where the server already knows the controls:
 * berthed at a station (it let go of them when it docked us) or dead (a new ship starts with none); the last-sent state
 * goes the same way, so the first input after is the change from there. A click on the station's screen isn't fire.
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
import { compactSend } from './inputCompactSend';
import type { GameMenuUI } from '../ui/GameMenuUI';
import type { PlayerStatsUI } from '../ui/PlayerStatsUI';
import type { SystemMapUI } from '../ui/SystemMapUI';
import type { AdminPanel } from '../ui/AdminPanel';
import type { AudioManager } from '../audio/AudioManager';
import type { InputManager } from '../input/InputManager';
import type { ContextActions } from '../input/ContextActions';
import type { Renderer } from '../rendering/Renderer';
import type { ShipClient } from '../ships/ShipClient';
import type { Autopilot } from '../ships/Autopilot';
import type { GameState } from '../state/GameState';
import type { ProtoHooks } from '../Game';
import { groupSelection } from '../ships/weaponGroups/selection';

/** What the input path reads from the game (Game supplies it as getters, so late-built windows resolve at use) */
export interface InputSendHost {
  readonly loggedIn: boolean;
  readonly stationOpen: boolean;
  /** Our ship is gone (the death screen): the server takes no input for it */
  readonly localDead?: boolean;
  /** Compact inputs, by inputCompactSend.ts's rules (a socket's encoder: not the local transport) */
  readonly compactInputs?: boolean;
  /**
   * Mouse-steer with the view on the heading (input/viewMode.ts pinnedAim): the movement
   * keys push along the ship, said by both strafe bits (common flight.ts noseFrame)
   */
  readonly noseThrust?: boolean;
  readonly proto: ProtoHooks | null;
  readonly menu: GameMenuUI;
  readonly adminPanel: AdminPanel | null;
  readonly shipClient: ShipClient;
  readonly autopilot: Autopilot;
  readonly context: ContextActions;
  readonly playerStatsUI: PlayerStatsUI;
  readonly systemMapUI: SystemMapUI;
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
  /** The cursor distance last sent, as sent (compact inputs: the server holds it until the next) */
  sentDist: number;
  /** The mouse's aim last tick, and for how many ticks it hasn't changed (compact inputs: the settle send) */
  aimSeen: number;
  aimStill: number;
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
    sentDist: 0,
    aimSeen: -1,
    aimStill: 0,
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
  // (A charge under way: where it goes was locked as it started (common flight.ts FlightBody.jumpAim/jumpTo), so the
  // map and the overlay show that, and the cursor is the cursor again: nothing it does moves the jump)
  const locked = s.loggedIn ? s.shipClient.jumpLocked?.() ?? null : null;
  if (order) {
    rawAngle = order.angle;
    aimDist = order.dist;
    s.shipClient.setJumpAim(aimDist, null);
    s.systemMapUI.jumpAim = { angle: rawAngle, dist: aimDist, label: null };
  } else if (locked) {
    s.shipClient.setJumpAim(locked.dist, locked.label);
    s.systemMapUI.jumpAim = { angle: locked.angle, dist: locked.dist, label: locked.label };
  } else if (s.loggedIn && s.shipClient.jumpAiming()) {
    // Exactly where the cursor is (Kieran, 2026-11-06: no snapping in flight). On the system map, a marker under the map's
    // cursor is the target (jumpLock): just short of it
    const best: { name: string; x: number; y: number; stop?: number } | null = s.systemMapUI.jumpLock();
    if (best) {
      const far = Math.hypot(best.x - playerPos.x, best.y - playerPos.y);
      rawAngle = Math.atan2(best.y - playerPos.y, best.x - playerPos.x);
      aimDist = Math.max(0, far - (best.stop ?? 1500));
    }
    s.shipClient.setJumpAim(aimDist, best?.name ?? null);
    s.systemMapUI.jumpAim = { angle: rawAngle, dist: aimDist, label: best?.name ?? null };
  }

  // (A click on the station's screen is a click on the screen)
  let fireLeft = inputEnabled && !s.stationOpen && ((s.input.isMouseDown(0) && !s.context.withholdingLeft()) || s.systemMapUI.firing());
  let fireRight = inputEnabled && !s.stationOpen && s.rightHeld();
  // A click calls off a menu jump too
  if (fireLeft && s.context.jumpMark()) s.context.cancel('Jump cancelled');
  // The autopilot flies until a click (or a flight key) takes over
  if (s.autopilot.active && (fireLeft || fireRight)) s.autopilot.cancel('Autopilot off');
  const auto = s.loggedIn && inputEnabled && !s.stationOpen ? s.autopilot.tick() : null;
  if (auto) { fireLeft = fireRight = false; }

  // Gun sounds come from the shots themselves, heard as drawn (audio/CombatSounds.ts); firing stirs the combat music
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
  // (Mouse-steer, the view on the heading: WASD along the ship, as the screen shows it, said by both strafe bits)
  const nose = !helm && !!s.noseThrust;
  let strafeLeft = nose || (helm && inputEnabled && s.input.isKeyDown('KeyQ'));
  let strafeRight = nose || (helm && inputEnabled && s.input.isKeyDown('KeyE'));
  // Jump drive: J latches it on, and it stays on until the jump fires (or J again cancels)
  let jump = inputEnabled && s.shipClient.jumpHeld();
  // Burst Strafer: a press of the dodge key (Space) asks for one burst, the way you're steering (ShipClient.dodgeControl)
  let dodge = inputEnabled && s.shipClient.dodgeControl();
  // (The angle is quantized to 13 bits, so client and server use the same value for hitscan: see CURSOR_STATE.md)
  let quantized = quantizeCursorAngle(rawAngle);
  // (A jump aimed at the ship itself goes one distance step, a hop: 0 on the wire means as far as the drive goes, flightInputs.ts)
  if (jump && aimDist < CURSOR_DIST_STEP) aimDist = CURSOR_DIST_STEP;
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

  // Where the server already knows the controls (berthed: Docking let go of them; dead: a new ship starts with none),
  // they're neutral on both sides and nothing is sent but what rides on inputs
  const berthed = !!s.shipClient.berthed?.(), dead = !!s.localDead;
  if (dead) forgetSent(s);
  else if (berthed) for (let i = 0; i < INPUT_HELD.length; i++) s.lastSent[INPUT_HELD[i]] = false;
  const compact = !!s.compactInputs && !s.proto;
  let changed: boolean;
  if (berthed || dead) {
    for (let i = 0; i < INPUT_HELD.length; i++) msg[INPUT_HELD[i]] = false;
    msg.helm = !!s.lastSent.helm;
    msg.targetAngle = dequantizeCursorAngle(s.lastSentAngle);
    msg.cursorDist = compact ? s.sentDist : s.lastSentCursorDist * CURSOR_DIST_STEP;
    quantized = s.lastSentAngle;
    cursorDistQ = quantizeCursorDist(msg.cursorDist);
    changed = false;
  } else if (!s.proto && s.state.inputLate?.(targetTick)) {
    // Catching up after a hitch: a tick the server has run (or will before this gets there) flew what it last had, so
    // it goes as that, held (the server takes it as nothing new: no correction); what changed goes from the next on time
    for (let i = 0; i < INPUT_BOOLS.length; i++) { const k = INPUT_BOOLS[i]; (msg as unknown as Record<string, boolean>)[k] = !!s.lastSent[k]; }
    msg.targetAngle = dequantizeCursorAngle(s.lastSentAngle);
    msg.cursorDist = compact ? s.sentDist : s.lastSentCursorDist * CURSOR_DIST_STEP;
    quantized = s.lastSentAngle;
    cursorDistQ = quantizeCursorDist(msg.cursorDist);
    changed = false;
  } else if (compact) {
    // (What goes and when: inputCompactSend.ts; the aim and distance become what goes, or what the server holds)
    const plan = compactSend(s, msg, quantized, auto?.jump ? auto.cursorDist : aimDist, !inputEnabled || s.stationOpen);
    quantized = plan.q;
    cursorDistQ = quantizeCursorDist(msg.cursorDist ?? 0);
    changed = plan.send;
  } else {
    // Check if anything changed from last sent state
    changed = inputChanged(s, msg, quantized, cursorDistQ);
  }
  // The weapon groups selection is state, not a held key: it goes on the input it changes on, and on the first one after a
  // welcome or a respawn (not while berthed or dead: the server holds it, and it goes on the first input after). No delay:
  // an input that was going to be sent goes as it did, and a change sends one now
  if (groupSelection.due() && !berthed && !dead && !(!s.proto && s.state.inputLate?.(targetTick))) {
    msg.weaponGroups = groupSelection.packed;
    changed = true;
  }
  // (The jump overlay draws from the aim and distance the server flies: the burn goes along the aim, flight.ts jumpAimed)
  s.shipClient.setJumpSent?.(msg.targetAngle, msg.cursorDist ?? 0);
  // Debris worked out here is confirmed on the next input, which goes now if nothing else would (ShipClient.takeAcks)
  const acks = s.shipClient?.takeAcks?.();
  if (acks) msg.acks = acks;
  // Client-detected hits: the hit chain's report rides on an input going anyway, or goes on its own after a few ticks (SelfHits)
  const hitReport = s.shipClient?.takeHitReport?.(changed || !!acks);
  if (hitReport) msg.hitReport = hitReport;
  // Its own ship's check (CAPS.OWN_SIM) rides too, or goes on its own now and then (ShipClient.takeOwnCheck)
  const ownCheck = s.shipClient?.takeOwnCheck?.(changed || !!acks || !!hitReport);
  if (ownCheck) msg.ownCheck = ownCheck;
  // ...and the bosses' bodies' (CAPS.BODIES), only ever riding an input that goes anyway (ShipClient.takeBodyCheck)
  const bodyCheck = s.shipClient?.takeBodyCheck?.(changed || !!acks || !!hitReport || !!ownCheck);
  if (bodyCheck) msg.bodyCheck = bodyCheck;
  const send = changed || !!acks || !!hitReport || !!ownCheck;

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
    // Its own ship on the tick-aligned layer flies it from its target tick (CAPS.OWN_SIM)
    s.shipClient?.noteInput?.(msg);
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

/** Back to nothing sent: a new ship's controls start neutral on the server, aim and distance 0 (Input is zeroed) */
export function forgetSent(s: InputSendState): void {
  const n = newInputSendState();
  for (let i = 0; i < INPUT_BOOLS.length; i++) { const k = INPUT_BOOLS[i]; s.lastSent[k] = n.lastSent[k]; }
  s.lastSentAngle = n.lastSentAngle;
  s.lastSentCursorDist = n.lastSentCursorDist;
  s.sentDist = n.sentDist;
  groupSelection.forget();
}

/**
 * A new connection: the server's new session holds nothing we sent on the last one (a new ship, Input zeroed), so all of
 * the last-sent state goes back to its start. Otherwise keys still held when the socket dropped are never sent again
 * (unchanged from "the last sent"), the server flies the ship without them and the prediction is corrected without end
 */
export function forgetSession(s: InputSendState): void {
  forgetSent(s);
  const n = newInputSendState();
  s.aimSeen = n.aimSeen;
  s.aimStill = n.aimStill;
  s.lastFireLeft = n.lastFireLeft;
  s.lastFireRight = n.lastFireRight;
}

/** Remember this input as the last one sent */
export function markSent(s: InputSendState, msg: ClientInputMessage, quantized: number, cursorDistQ: number): void {
  for (let i = 0; i < INPUT_BOOLS.length; i++) { const k = INPUT_BOOLS[i]; s.lastSent[k] = msg[k]; }
  s.lastSentAngle = quantized;
  s.lastSentCursorDist = cursorDistQ;
  s.sentDist = msg.cursorDist ?? 0;
  if (msg.weaponGroups !== undefined) groupSelection.sent(msg.weaponGroups);
}

/**
 * The window lost focus or the tab was hidden: one neutral input (all keys
 * up, no fire), straight to the network. A hidden tab's ticker stops, so
 * tickInput wouldn't send it until the player came back, and the ship would
 * fly on (the server also stops a ship that hasn't sent input for a while).
 */
export function sendNeutralInput(s: InputSendCtx): void {
  if (!s.loggedIn || !s.state.playerId || !s.network.isConnected()) return;
  // (Berthed or dead: the server holds them neutral already)
  if (s.localDead || s.shipClient.berthed?.()) return;
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
    cursorDist: s.compactInputs && !s.proto ? s.sentDist : s.lastSentCursorDist * CURSOR_DIST_STEP,
    jump: false,
    dodge: false,
  };
  s.network.send(msg);
  s.shipClient?.noteInput?.(msg);
  // The prediction steps the same input (proto has none)
  if (!s.proto) s.state.applyInput(msg);
  for (let i = 0; i < INPUT_HELD.length; i++) s.lastSent[INPUT_HELD[i]] = false;
}
