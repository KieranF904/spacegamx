import { describe, it, expect } from 'vitest';
import {
  Input, CTL, controlBits, buildFlightInputs, newFlightControls, simControls, simAim, simAimQ, replicaAngle, ReplicaMode, quantizeReplicaAngle,
  InputSlots, ScriptedInputs, NO_INPUT, type FlightInputSource,
} from '@space-game/common';
import { PilotInputSource, ControllerInputSource, readPilotInput } from './inputs.js';
import type { BridgeCtx } from './bridge/core.js';

const EID = 7;
const BODY = { x: 0, y: 0, angle: 0.4 };

function setInput(i: Partial<Record<'forward' | 'backward' | 'left' | 'right' | 'boost' | 'helm' | 'strafeLeft' | 'strafeRight' | 'jump' | 'dodge', number>>, aim: number, dist: number): void {
  for (const k of ['forward', 'backward', 'left', 'right', 'boost', 'helm', 'strafeLeft', 'strafeRight', 'jump', 'dodge'] as const) Input[k][EID] = i[k] ?? 0;
  Input.targetAngle[EID] = aim;
  Input.cursorDist[EID] = dist;
}

describe('PilotInputSource', () => {
  it('flies what stepMovement flies: bits, aim, jumpDist', () => {
    // (an aim off the wire: already on the grid)
    const aim = simAim(simAimQ(1.234));
    for (const held of [{}, { forward: 1, boost: 1 }, { left: 1, helm: 1, jump: 1 }, { strafeRight: 1, dodge: 1, backward: 1 }]) {
      setInput(held, aim, 480);
      const src = new PilotInputSource(EID, () => 99);
      const inp = src.inputAt();
      const h = (k: keyof typeof held) => (held as Record<string, number>)[k] === 1;
      const today = buildFlightInputs({ forward: h("forward" as never), backward: h("backward" as never), left: h("left" as never), right: h("right" as never), boost: h("boost" as never), helm: h("helm" as never), strafeLeft: h("strafeLeft" as never), strafeRight: h("strafeRight" as never), jump: h("jump" as never), dodge: h("dodge" as never), targetAngle: aim, cursorDist: 480 } as FlightInputSource, false, newFlightControls());
      expect(inp.bits).toBe(controlBits(today));
      expect(inp.q).toBe(quantizeReplicaAngle(aim));
      expect(inp.jumpDist).toBe(480);
      // (the step's controls from the input equal today's, aim included)
      const c = simControls(inp, BODY);
      expect({ ...c, jumpDist: 0 }).toEqual({ ...today, jumpDist: 0 });
      expect(c.jumpDist).toBe(480);
      expect(src.knowledge).toBe('confirmed');
      expect(src.confirmedThrough()).toBe(99);
    }
  });

  it('reads the guns: trigger, secondary, aim distance', () => {
    setInput({}, 0, 400);
    Input.fireLeft[EID] = 1; Input.fireRight[EID] = 0;
    expect(readPilotInput(EID)).toMatchObject({ fire: true, fireAlt: false, aimDist: 100 });
    Input.fireLeft[EID] = 0; Input.fireRight[EID] = 1;
    expect(readPilotInput(EID)).toMatchObject({ fire: false, fireAlt: true });
  });
});

function ctx(o: { orders?: unknown; auto?: unknown; pinned?: boolean }): BridgeCtx {
  const auto = o.auto as { forward: boolean; backward: boolean; left: boolean; right: boolean; boost: boolean; targetAngle: number } | undefined;
  return {
    bodies: new Map([[EID, {}]]),
    controllers: new Map(o.orders ? [[EID, () => o.orders]] : []),
    autopilot: new Map(auto ? [[EID, { x: 0, y: 0, arriveRadius: 1 }]] : []),
    pinned: new Map(o.pinned ? [[EID, { x: 0, y: 0 }]] : []),
    autopilotControls: () => auto,
  } as unknown as BridgeCtx;
}

describe('ControllerInputSource', () => {
  const controls = { forward: true, backward: false, left: false, right: true, boost: true, targetAngle: 2.2 };

  it('an AI order flies as stepPilotless has it: bits, quantised aim, impulse, guns', () => {
    const orders = { controls, firing: true, aimDist: 300, impulse: [1.5, -2] as [number, number] };
    const src = new ControllerInputSource(ctx({ orders }), EID);
    const inp = src.inputAt(5);
    expect(inp.bits).toBe(controlBits(controls));
    expect(inp.q).toBe(quantizeReplicaAngle(controls.targetAngle));
    expect(inp.impulse).toEqual([1.5, -2]);
    expect(inp).toMatchObject({ fire: true, jumpDist: -1, aimDist: 75 });
    // (the step's aim: the grid aim, float32; stepPilotless used the unrounded grid angle: within float32)
    expect(Math.abs(simAim(inp.q) - replicaAngle(ReplicaMode.Pilotless, inp.q))).toBeLessThan(1e-6);
    expect(src.knowledge).toBe('decided');
    expect(src.confirmedThrough()).toBe(5);
  });

  it('the autopilot flies when there is no controller; pinned ships only turn', () => {
    const src = new ControllerInputSource(ctx({ auto: controls, pinned: true }), EID);
    const inp = src.inputAt(1);
    expect(inp.bits).toBe(0);
    expect(inp.q).toBe(quantizeReplicaAngle(controls.targetAngle));
    const free = new ControllerInputSource(ctx({ auto: controls }), EID).inputAt(1);
    expect(free.bits).toBe(controlBits(controls));
  });

  it('with neither, it holds its heading', () => {
    const inp = new ControllerInputSource(ctx({}), EID).inputAt(1);
    expect(inp.bits).toBe(CTL.hold);
    expect(inp.q).toBe(0);
  });
});

describe('InputSlots possess (server)', () => {
  it('possess then release restores the ship\'s own source', () => {
    const slots = new InputSlots();
    const own = new PilotInputSource(EID, () => 0), admin = new ScriptedInputs('confirmed', () => NO_INPUT);
    slots.set(EID, own);
    slots.possess(EID, admin);
    expect(slots.get(EID)).toBe(admin);
    expect(slots.possessed(EID)).toBe(true);
    slots.release(EID);
    expect(slots.get(EID)).toBe(own);
    expect(slots.possessed(EID)).toBe(false);
  });
});
