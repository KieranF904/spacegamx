import { describe, it, expect } from 'vitest';
import { CURSOR_DIST_STEP, dequantizeCursorAngle, quantizeCursorAngle, noseFrame, type ClientInputMessage } from '@space-game/common';
import { tickInput, sendNeutralInput, newInputSendState, type InputSendCtx } from './inputSend';
import { ViewMode, type CameraMode } from '../input/viewMode';

/** A scripted pilot: keys, mouse and a few ship/menu switches the test flips between ticks */
interface Script {
  keys: Set<string>;
  mouse: Set<number>;
  mouseWorld: { x: number; y: number };
  helm: boolean;
  menuOpen: boolean;
  /** Berthed at a station (the server holds the controls neutral), and the station's screen up */
  berthed: boolean;
  station: boolean;
  auto: null | { forward: boolean; backward: boolean; left: boolean; right: boolean; boost: boolean; jump: boolean; targetAngle: number; cursorDist: number };
}

/** A context whose game parts are fakes, recording every send / applyInput / predictTick in order */
function fakeCtx(proto = false) {
  const log: string[] = [];
  const sent: ClientInputMessage[] = [];
  const predicted: ClientInputMessage[] = [];
  const sc: Script = { keys: new Set(), mouse: new Set(), mouseWorld: { x: 100, y: 0 }, helm: false, menuOpen: false, auto: null, berthed: false, station: false };
  let seq = 0;
  const state = {
    serverTick: 1000, playerId: 7, tick: 1000,
    getPlayerPosition: () => ({ x: 0, y: 0 }),
    getInputTargetTick() { return this.tick + 3; },
    // (Catching up after a hitch: ticks before this one would reach the server late)
    lateBefore: -Infinity,
    inputLate(t: number) { return t < this.lateBefore; },
    nextInputSeq: () => ++seq,
    applyInput: (m: ClientInputMessage) => { log.push(`apply:${m.seq}`); },
    predictTick: (m: ClientInputMessage) => { log.push(`predict:${m.targetTick}`); predicted.push({ ...m }); },
  };
  const ctx = {
    loggedIn: true,
    get stationOpen() { return sc.station; },
    proto: proto ? { inputEnabled: () => true } : null,
    get menu() { return { isOpen: sc.menuOpen }; },
    adminPanel: null,
    shipClient: {
      hangarOpen: false,
      setJumpAim: () => {},
      jumpAiming: () => false,
      helmMode: () => sc.helm,
      jumpHeld: () => false,
      dodgeControl: () => sc.keys.has('Space'),
      berthed: () => sc.berthed,
    },
    autopilot: { get active() { return !!sc.auto; }, cancel: () => { log.push('ap.cancel'); }, tick: () => sc.auto },
    context: { flight: () => null, withholdingLeft: () => false, jumpMark: () => false, cancel: () => false },
    playerStatsUI: { addShotFired: () => { log.push('shot'); } },
    systemMapUI: { aimWorld: () => null, jumpAim: null, jumpLock: () => null, firing: () => false },
    navMarkers: null,
    audio: { bumpCombat: () => {} },
    network: { send: (m: ClientInputMessage) => { log.push(`send:${m.seq}`); sent.push({ ...m }); }, isConnected: () => true },
    input: { mouseX: 0, mouseY: 0, isKeyDown: (k: string) => sc.keys.has(k), isMouseDown: (b: number) => sc.mouse.has(b) },
    renderer: { screenToWorld: () => sc.mouseWorld },
    state,
    rightHeld: () => sc.mouse.has(2),
    ...newInputSendState(),
  } as unknown as InputSendCtx;
  const tick = () => { tickInput(ctx); state.tick++; state.serverTick++; };
  return { ctx, sc, log, sent, predicted, tick };
}

describe('inputSend: an input-script replay', () => {
  it('catching up after a hitch: late ticks go as what was last sent (held), the change from the first on time', () => {
    const { sc, sent, predicted, tick, ctx } = fakeCtx();
    const st = (ctx as unknown as { state: { tick: number; lateBefore: number } }).state;
    tick();                              // the cursor distance: sent
    st.lateBefore = st.tick + 3 + 2;     // the next two ticks' inputs would be late
    sc.keys.add('KeyW');
    tick(); tick();                      // late: held as last sent, not sent
    tick();                              // on time: thrust goes
    expect(predicted.slice(-2).map((m) => m.forward)).toEqual([false, false]);
    expect(sent.length).toBe(2);
    expect(sent[1].forward).toBe(true);
    expect(sent[1].targetTick).toBe(st.tick - 1 + 3);
  });

  it('sends only on change, predicts otherwise, in order, with the same seq, ticks and quantisation', () => {
    const { ctx, sc, log, sent, predicted, tick } = fakeCtx();

    tick();                              // first tick: the cursor distance differs from the initial 0, so it is sent
    tick();                              // nothing changed: predicted, not sent
    sc.keys.add('KeyW'); tick();         // thrust
    sc.mouseWorld = { x: 100, y: 0.001 }; tick(); // inside the same 13-bit aim step and distance step: unsent
    sc.mouse.add(0); tick();             // fire: one shot counted
    tick();                              // still firing: no new shot, unsent
    sc.mouse.delete(0); sc.helm = true; sc.keys.add('KeyQ'); tick(); // helm with a strafe
    sc.mouseWorld = { x: 0, y: 300 }; tick(); // aim a quarter turn

    expect(log).toEqual([
      'send:1', 'apply:1',
      'predict:1004',
      'send:2', 'apply:2',
      'predict:1006',
      'shot', 'send:3', 'apply:3',
      'predict:1008',
      'send:4', 'apply:4',
      'send:5', 'apply:5',
    ]);
    expect(sent.map((m) => [m.seq, m.tick, m.targetTick])).toEqual([[1, 1000, 1003], [2, 1002, 1005], [3, 1004, 1007], [4, 1006, 1009], [5, 1007, 1010]]);
    expect(sent[0]).toEqual({
      type: 'input', seq: 1, tick: 1000, targetTick: 1003,
      forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false,
      targetAngle: 0, strafeLeft: false, strafeRight: false, helm: false, cursorDist: 25 * CURSOR_DIST_STEP, jump: false, dodge: false,
    });
    expect(sent[1].forward).toBe(true);
    expect(sent[2].fireLeft).toBe(true);
    expect([sent[3].helm, sent[3].strafeLeft, sent[3].fireLeft]).toEqual([true, true, false]);
    expect(sent[4].targetAngle).toBe(dequantizeCursorAngle(quantizeCursorAngle(Math.PI / 2)));
    expect(sent[4].cursorDist).toBe(300);
    // The unsent ticks carry seq 0 and the input as it stood
    expect(predicted.map((m) => [m.seq, m.forward, m.fireLeft])).toEqual([[0, false, false], [0, true, false], [0, true, true]]);
    // The last-sent bookkeeping is the last message sent
    expect([ctx.lastSentAngle, ctx.lastSentCursorDist, ctx.lastSent.helm, ctx.lastSent.forward]).toEqual([quantizeCursorAngle(Math.PI / 2), 75, true, true]);
  });

  it('neutral input: all keys up but helm, the last aim, straight to the network; the next tick sends again', () => {
    const { ctx, sc, log, sent, tick } = fakeCtx();
    sc.helm = true; sc.keys.add('KeyW'); sc.keys.add('KeyQ'); sc.mouse.add(2);
    tick();
    sendNeutralInput(ctx);
    tick();                              // the keys are still down: differs from the neutral one, so sent
    expect(log).toEqual(['shot', 'send:1', 'apply:1', 'send:2', 'apply:2', 'send:3', 'apply:3']);
    expect(sent[1]).toEqual({
      type: 'input', seq: 2, tick: 1001, targetTick: 1004,
      forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false,
      targetAngle: sent[0].targetAngle, strafeLeft: false, strafeRight: false, helm: true, cursorDist: sent[0].cursorDist, jump: false, dodge: false,
    });
    expect([sent[2].forward, sent[2].strafeLeft, sent[2].fireRight, sent[2].helm]).toEqual([true, true, true, true]);
  });

  it('a menu open lets go of the flight keys (helm stays); the autopilot flies its own controls', () => {
    const { sc, sent, tick } = fakeCtx();
    sc.helm = true; sc.keys.add('KeyW');
    tick();
    sc.menuOpen = true; tick();
    expect([sent[1].forward, sent[1].helm]).toEqual([false, true]);
    sc.menuOpen = false;
    sc.auto = { forward: true, backward: false, left: false, right: true, boost: true, jump: false, targetAngle: Math.PI, cursorDist: 9999 };
    tick();
    const m = sent[2];
    expect([m.forward, m.right, m.boost, m.helm, m.strafeLeft]).toEqual([true, true, true, false, false]);
    expect(m.targetAngle).toBe(dequantizeCursorAngle(quantizeCursorAngle(Math.PI)));
    expect(m.cursorDist).toBe(100);      // not jumping: the cursor's own distance
  });

  it('proto: sent with no targetTick, no prediction, nothing when unchanged', () => {
    const { ctx, sc, log, sent, tick } = fakeCtx(true);
    tick(); tick();
    sc.keys.add('KeyD'); tick();
    sendNeutralInput(ctx);
    expect(log).toEqual(['send:1', 'send:2', 'send:3']);
    expect(sent.map((m) => m.targetTick)).toEqual([undefined, undefined, undefined]);
    expect(sent[1].right).toBe(true);
  });

  it('berthed: nothing is sent (the server let go of the controls), the prediction steps them neutral; a station click is no shot', () => {
    const { ctx, sc, log, sent, predicted, tick } = fakeCtx();
    sc.keys.add('KeyW'); tick();
    sc.berthed = true; sc.station = true; sc.mouse.add(0);
    for (let i = 0; i < 5; i++) { sc.mouseWorld = { x: 100, y: i * 20 }; tick(); }
    sendNeutralInput(ctx);
    expect(log.filter((l) => l.startsWith('send'))).toEqual(['send:1']);
    expect(predicted.every((m) => !m.forward && !m.fireLeft)).toBe(true);
    // Out again with W held: sent (it was let go of at the dock)
    sc.berthed = false; sc.station = false; sc.mouse.clear(); tick();
    expect(sent[1].forward).toBe(true);
    // The station's screen up but not berthed (the dev hangar anywhere): a click isn't fire
    const n = sent.length;
    sc.station = true; sc.mouse.add(0); tick();
    expect(sent.length).toBe(n);
    expect(predicted[predicted.length - 1].fireLeft).toBe(false);
  });

  it('neutral input does nothing when not connected or not in the game', () => {
    const { ctx, log } = fakeCtx();
    (ctx as unknown as { loggedIn: boolean }).loggedIn = false;
    sendNeutralInput(ctx);
    expect(log).toEqual([]);
  });
});

describe('inputSend: the four control / view combinations (input/viewMode.ts)', () => {
  // (What Game's noseThrust getter is: the server took CAPS.NOSE and the aim is pinned, viewMode.pinnedAim)
  const combos: [string, boolean, CameraMode][] = [
    ['mouse + north up', false, 'north'],
    ['helm + follow heading', true, 'heading'],
    ['helm + north up', true, 'north'],
    ['mouse + follow heading', false, 'heading'],
  ];
  const keysOf = (m: ClientInputMessage) => [m.forward, m.backward, m.left, m.right, m.strafeLeft, m.strafeRight, m.helm];

  it.each(combos)('%s', (name, helm, camera) => {
    for (const caps of [true, false]) {
      const { ctx, sc, sent, tick } = fakeCtx();
      const v = new ViewMode(() => camera);
      (ctx as unknown as { noseThrust: boolean }).noseThrust = caps && v.pinnedAim(helm);
      sc.helm = helm;
      sc.keys.add('KeyW'); sc.keys.add('KeyD'); sc.keys.add('KeyQ');
      tick();
      const m = sent[sent.length - 1];
      const nose = caps && name === 'mouse + follow heading';
      // Helm (either view): W along the nose, D turns, Q strafes. Mouse: W/D as they are, along the screen; with the
      // view on the heading (and the server taking it) both strafe bits say "along the ship" (common flight.ts noseFrame)
      expect(keysOf(m)).toEqual(helm ? [true, false, false, true, true, false, true] : [true, false, false, true, nose, nose, false]);
      expect(noseFrame(m)).toBe(nose);
      // The view never changes the aim the input carries: the cursor's world point (renderer.screenToWorld) is all it reads
      expect(m.targetAngle).toBe(0);
    }
  });

  it('mouse + follow heading: the pair stays on with no key held (no mode bits flapping), and goes with the autopilot', () => {
    const { ctx, sc, sent, predicted, tick } = fakeCtx();
    (ctx as unknown as { noseThrust: boolean }).noseThrust = true;
    tick();
    expect([sent[0].strafeLeft, sent[0].strafeRight, sent[0].forward]).toEqual([true, true, false]);
    sc.auto = { forward: true, backward: false, left: false, right: false, boost: false, jump: false, targetAngle: 1, cursorDist: 100 };
    tick();
    const m = sent.length > 1 ? sent[sent.length - 1] : predicted[predicted.length - 1];
    // (The autopilot's keys are along the world)
    expect([m.forward, m.strafeLeft, m.strafeRight]).toEqual([true, false, false]);
  });
});
