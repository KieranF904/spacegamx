import { describe, it, expect } from 'vitest';
import {
  InputEncoder, InputDecoder, quantizeCursorAngle, dequantizeCursorAngle, aimStep, cursorDistOnGrid, CI, CI_FLAG,
  type ClientInputMessage,
} from '@space-game/common';
import { tickInput, sendNeutralInput, newInputSendState, type InputSendCtx } from './inputSend';
import { AIM_SEND_STEPS, AIM_SETTLE_TICKS } from './inputCompactSend';

/**
 * A scripted pilot on compact inputs: the mouse as an aim angle and distance, keys and buttons, and the states the
 * server knows (berthed, dead). Every send goes through an InputEncoder and a server-side InputDecoder; the test keeps
 * what the server would fly each target tick (the last input for it) beside what the client predicted for it.
 */
function compactCtx() {
  const enc = new InputEncoder(), dec = new InputDecoder();
  const sent: ClientInputMessage[] = [];
  const bytes: Uint8Array[] = [];
  const decoded: ClientInputMessage[] = [];
  /** Per target tick: what the client stepped (sent or predicted), and what the server flies (the last decoded) */
  const client = new Map<number, ClientInputMessage>();
  const sc = { keys: new Set<string>(), mouse: new Set<number>(), aim: 0, dist: 300, berthed: false, dead: false, station: false };
  let seq = 0;
  const state = {
    serverTick: 1000, playerId: 7, tick: 1000,
    getPlayerPosition: () => ({ x: 0, y: 0 }),
    getInputTargetTick() { return this.tick + 3; },
    nextInputSeq: () => ++seq,
    applyInput: (m: ClientInputMessage) => { client.set(m.targetTick!, { ...m }); },
    predictTick: (m: ClientInputMessage) => { client.set(m.targetTick!, { ...m }); },
  };
  const ctx = {
    loggedIn: true, compactInputs: true,
    get stationOpen() { return sc.station; },
    get localDead() { return sc.dead; },
    proto: null,
    menu: { isOpen: false },
    adminPanel: null,
    shipClient: {
      hangarOpen: false, setJumpAim: () => {}, jumpAiming: () => false, helmMode: () => false, jumpHeld: () => false, dodgeControl: () => false,
      berthed: () => sc.berthed,
    },
    autopilot: { active: false, cancel: () => {}, tick: () => null },
    context: { flight: () => null, withholdingLeft: () => false, jumpMark: () => false, cancel: () => false },
    playerStatsUI: { addShotFired: () => {} },
    systemMapUI: { aimWorld: () => null, jumpAim: null, jumpLock: () => null, firing: () => false },
    navMarkers: null,
    audio: { bumpCombat: () => {} },
    network: {
      isConnected: () => true,
      send: (m: ClientInputMessage) => {
        const b = new Uint8Array(enc.encode(m, true));
        sent.push({ ...m }); bytes.push(b); decoded.push(dec.decode(b));
      },
    },
    input: { mouseX: 0, mouseY: 0, isKeyDown: (k: string) => sc.keys.has(k), isMouseDown: (b: number) => sc.mouse.has(b) },
    renderer: { screenToWorld: () => ({ x: Math.cos(sc.aim) * sc.dist, y: Math.sin(sc.aim) * sc.dist }) },
    state,
    rightHeld: () => sc.mouse.has(2),
    ...newInputSendState(),
  } as unknown as InputSendCtx;
  const tick = () => { tickInput(ctx); state.tick++; state.serverTick++; };
  /** The server's controls for each target tick the client stepped: the last decoded input stamped at or before it */
  const serverAt = (t: number) => {
    let best: ClientInputMessage | undefined;
    for (const m of decoded) if (m.targetTick! <= t && (!best || m.targetTick! >= best.targetTick!)) best = m;
    return best;
  };
  return { ctx, sc, sent, bytes, decoded, client, tick, serverAt, state };
}

const step = Math.PI * 2 / 8191; // one 13-bit aim step
const q = (a: number) => quantizeCursorAngle(a);

describe('compact inputs: the send rules', () => {
  it('a slow drag goes in steps of AIM_SEND_STEPS; the mouse stopping sends the exact aim once, then nothing', () => {
    const { sc, sent, tick } = compactCtx();
    sc.aim = 0.5; tick();
    expect(sent.length).toBe(1);
    // 1 step a tick: below the threshold until it has gone AIM_SEND_STEPS
    for (let i = 0; i < 40; i++) { sc.aim += step; tick(); }
    expect(sent.length).toBe(1 + Math.floor(40 / AIM_SEND_STEPS));
    for (let i = 1; i < sent.length; i++) expect(Math.abs(aimStep(q(sent[i - 1].targetAngle), q(sent[i].targetAngle)))).toBe(AIM_SEND_STEPS);
    // stop: AIM_SETTLE_TICKS later the exact aim, once
    const n = sent.length;
    for (let i = 0; i < 20; i++) tick();
    expect(sent.length).toBe(n + 1);
    expect(q(sent[n].targetAngle)).toBe(q(sc.aim));
    // A one-pixel nudge (4 steps at 300 px) still turns the ship: it goes as the settle send
    sc.aim += 4 * step;
    for (let i = 0; i < AIM_SETTLE_TICKS; i++) tick();
    expect(sent.length).toBe(n + 1);
    tick();
    expect(sent.length).toBe(n + 2);
    expect(q(sent[n + 1].targetAngle)).toBe(q(sc.aim));
  });

  it('fine mouse-steer still turns the ship: following a slow drag, the heading lags no more than the steering does on its own', () => {
    // (The mouse-steer ease of common ships/flight.ts steerSpin for small angles: the turn covers turnGain of what's
    // left each tick, tuning.json turnGain 0.5. A drag of AIM_SEND_STEPS a tick sends every tick, so the ship lags it by
    // (1 - g) / g of a step: the threshold adds no more lag than that to slower drags.)
    const g = 0.5;
    for (const perTick of [0.25, 0.5, 1, 2, 4, 8, 16]) {
      const { sc, sent, client, tick, state } = compactCtx();
      let heading = 0.5;
      sc.aim = 0.5; tick();
      let maxLag = 0;
      for (let i = 0; i < 400; i++) {
        sc.aim += perTick * step;
        tick();
        const m = client.get(state.tick + 2)!;
        heading += g * (m.targetAngle - heading);
        maxLag = Math.max(maxLag, (sc.aim - heading) / step);
      }
      expect(sent.length).toBeGreaterThan(1);
      // the ship kept turning with the mouse, never further behind than the threshold plus the steering's own lag
      expect(maxLag).toBeLessThanOrEqual(AIM_SEND_STEPS + perTick * (1 / g) + 1);
      expect((sc.aim - heading) / step).toBeLessThan(AIM_SEND_STEPS + perTick * 2 + 1);
    }
  });

  it('firing: every tick the aim changed goes, and the cursor distance with it', () => {
    const { sc, sent, tick } = compactCtx();
    sc.aim = 1; tick();
    sc.mouse.add(0); tick();
    const n = sent.length;
    for (let i = 0; i < 10; i++) { sc.aim += step * 2; sc.dist += 10; tick(); }
    expect(sent.length).toBe(n + 10);
    expect(sent[sent.length - 1].cursorDist).toBe(cursorDistOnGrid(sc.dist));
    // a tick nothing changed: nothing goes
    tick();
    expect(sent.length).toBe(n + 10);
  });

  it('the cursor distance alone goes only while firing; it rides along on anything else that goes', () => {
    const { sc, sent, client, tick, state } = compactCtx();
    // (the first aim goes as a step from a new ship's 0, here a coarse one: the settle send puts it right)
    sc.aim = 1; for (let i = 0; i < 4; i++) tick();
    const n = sent.length;
    expect(q(sent[n - 1].targetAngle)).toBe(q(1));
    sc.dist = 450; tick(); tick(); tick();
    expect(sent.length).toBe(n);
    // the prediction steps the distance the server holds
    expect(client.get(state.tick + 2)!.cursorDist).toBe(sent[0].cursorDist);
    // a key: the distance (and any pending aim, on the fine grid) rides along
    sc.aim += 3 * step;
    sc.keys.add('KeyW'); tick();
    expect(sent.length).toBe(n + 1);
    expect(sent[n].cursorDist).toBe(cursorDistOnGrid(450));
    expect(q(sent[n].targetAngle)).toBe(q(1) + 2);
  });

  it('a flick goes as a coarse step, the rest the next tick; the prediction steps exactly what went', () => {
    const { sc, sent, bytes, decoded, client, tick, state } = compactCtx();
    sc.aim = 1; tick();
    sc.mouse.add(0); tick();
    sc.aim = 1 + 40 * Math.PI / 180; tick();
    const a = sent.length - 1;
    expect(bytes[a][0] & (CI.AIM_FINE | CI.AIM_COARSE)).toBe(CI.AIM_COARSE);
    tick();
    expect(sent.length).toBe(a + 2);
    expect(Math.abs(aimStep(q(sent[a + 1].targetAngle), q(sc.aim)))).toBeLessThanOrEqual(1);
    for (let i = 0; i < 6; i++) tick();
    // Server and client agree on every tick stepped: same aim, same keys, same distance
    for (let t = 1003; t < state.tick + 3; t++) {
      const c = client.get(t)!, s = (decoded.filter((m) => m.targetTick! <= t).pop())!;
      expect(q(c.targetAngle)).toBe(q(s.targetAngle));
      expect([c.forward, c.fireLeft, c.cursorDist]).toEqual([s.forward, s.fireLeft, s.cursorDist]);
    }
    // (and every compact input is small: the groups byte and a step or two)
    expect(Math.max(...bytes.slice(1).map((b) => b.length))).toBeLessThanOrEqual(4);
    expect(bytes.every((b) => (b[0] & CI_FLAG) !== 0)).toBe(true);
  });
});

describe('compact inputs: states the server already knows', () => {
  it('berthed: nothing goes, the prediction steps neutral controls, and after leaving the first input is the change from neutral', () => {
    const { sc, sent, client, tick, state } = compactCtx();
    sc.keys.add('KeyW'); sc.aim = 1; tick();
    expect(sent[0].forward).toBe(true);
    sc.berthed = true; sc.station = true;
    for (let i = 0; i < 30; i++) { sc.aim += 0.05; if (i % 7 === 0) sc.mouse.add(0); else sc.mouse.delete(0); tick(); }
    expect(sent.length).toBe(1);
    const p = client.get(state.tick + 2)!;
    expect([p.forward, p.fireLeft, q(p.targetAngle)]).toEqual([false, false, q(sent[0].targetAngle)]);
    sendNeutralInput(compactCtx().ctx); // (a context of its own: nothing to do with this one)
    // Out again, W still held: it goes (the server let go of it at the dock)
    sc.berthed = false; sc.station = false; sc.mouse.clear(); tick();
    expect(sent.length).toBe(2);
    expect(sent[1].forward).toBe(true);
  });

  it("a click on the station's screen isn't fire", () => {
    const { sc, sent, client, tick, state } = compactCtx();
    sc.station = true; sc.mouse.add(0); sc.mouse.add(2); tick(); tick();
    // (and the mouse on the screen isn't aim either: nothing goes)
    expect(sent.length).toBe(0);
    const p = client.get(state.tick + 2)!;
    expect([p.fireLeft, p.fireRight]).toEqual([false, false]);
  });

  it('dead: nothing goes; after the respawn everything is the change from a new ship (aim 0, nothing held)', () => {
    const { ctx, sc, sent, tick } = compactCtx();
    sc.keys.add('KeyW'); sc.aim = 1; tick();
    sc.dead = true;
    for (let i = 0; i < 10; i++) { sc.aim += 0.1; tick(); }
    sendNeutralInput(ctx);
    expect(sent.length).toBe(1);
    sc.dead = false; sc.keys.clear(); tick();
    expect(sent.length).toBe(2);
    expect([sent[1].forward, q(sent[1].targetAngle)]).toEqual([false, q(sc.aim)]);
  });

  it('a seeded scramble of everything: the server flies exactly what the client predicted, every tick', () => {
    const { sc, client, tick, state, serverAt, bytes } = compactCtx();
    let seed = 5;
    // (Where a berth began: the server let go of the controls there, as Docking does)
    const berthAt: number[] = [];
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 3000; i++) {
      if (rnd() < 0.05) { const k = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft'][Math.floor(rnd() * 5)]; if (sc.keys.has(k)) sc.keys.delete(k); else sc.keys.add(k); }
      if (rnd() < 0.03) { if (sc.mouse.has(0)) sc.mouse.delete(0); else sc.mouse.add(0); }
      if (rnd() < 0.6) sc.aim += (rnd() - 0.5) * (rnd() < 0.05 ? 3 : 0.1);
      if (rnd() < 0.3) sc.dist = Math.max(0, sc.dist + (rnd() - 0.5) * 200);
      if (rnd() < 0.003) { sc.berthed = sc.station = !sc.berthed; if (sc.berthed) berthAt.push(state.tick + 3); }
      tick();
    }
    let checked = 0;
    for (let t = 1003; t < state.tick + 3; t++) {
      const c = client.get(t), s0 = serverAt(t);
      if (!c || !s0) continue;
      const released = berthAt.some((b) => b > s0.targetTick! && b <= t);
      const s = released ? { ...s0, forward: false, left: false, boost: false, fireLeft: false } : s0;
      expect([q(c.targetAngle), c.cursorDist, c.forward, c.left, c.boost, c.fireLeft]).toEqual([q(s.targetAngle), s.cursorDist, s.forward, s.left, s.boost, s.fireLeft]);
      checked++;
    }
    expect(checked).toBeGreaterThan(2000);
    expect(bytes.reduce((n, b) => n + b.length, 0) / bytes.length).toBeLessThan(4);
    void dequantizeCursorAngle;
  });
});
