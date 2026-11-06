/**
 * The map and the overlay during a jump's charge (Kieran, 2026-11-07: the jump goes where the cursor was as it started,
 * common flight.ts FlightBody.jumpAim/jumpTo): lining up, they follow the cursor and the map's lock-on; once the charge
 * has its lock (ShipClient.jumpLocked), they show that, wherever the cursor and the map's hover go.
 */
import { describe, it, expect } from 'vitest';
import type { ClientInputMessage } from '@space-game/common';
import { tickInput, newInputSendState, type InputSendCtx } from './inputSend';

function fakeCtx() {
  const sc = {
    mouseWorld: { x: 5000, y: 0 },
    hover: null as { name: string; x: number; y: number } | null,
    lock: null as { angle: number; dist: number; label: string | null } | null,
    aimed: [] as [number, string | null][],
  };
  const state = {
    serverTick: 1000, playerId: 7, tick: 1000,
    getPlayerPosition: () => ({ x: 0, y: 0 }),
    getInputTargetTick() { return this.tick + 3; },
    inputLate: () => false,
    nextInputSeq: () => 1,
    applyInput: () => {}, predictTick: () => {},
  };
  const map = { aimWorld: () => null, jumpAim: null as { angle: number; dist: number; label: string | null } | null, jumpLock: () => sc.hover, firing: () => false };
  const ctx = {
    loggedIn: true, stationOpen: false, proto: null, menu: { isOpen: false }, adminPanel: null,
    shipClient: {
      hangarOpen: false,
      setJumpAim: (d: number, label: string | null) => { sc.aimed.push([d, label]); },
      jumpAiming: () => true,
      jumpLocked: () => sc.lock,
      helmMode: () => false, jumpHeld: () => true, dodgeControl: () => false, berthed: () => false,
    },
    autopilot: { active: false, cancel: () => {}, tick: () => null },
    context: { flight: () => null, withholdingLeft: () => false, jumpMark: () => false, cancel: () => false },
    playerStatsUI: { addShotFired: () => {} },
    systemMapUI: map,
    navMarkers: null,
    audio: { bumpCombat: () => {} },
    network: { send: (_m: ClientInputMessage) => {}, isConnected: () => true },
    input: { mouseX: 0, mouseY: 0, isKeyDown: () => false, isMouseDown: () => false },
    renderer: { screenToWorld: () => sc.mouseWorld },
    state,
    rightHeld: () => false,
    ...newInputSendState(),
  } as unknown as InputSendCtx;
  return { sc, map, tick: () => { tickInput(ctx); state.tick++; state.serverTick++; } };
}

describe('the jump overlay and the map during a charge', () => {
  it('lining up: the cursor, snapped to the station under the map cursor; charging: the lock, wherever the cursor goes', () => {
    const { sc, map, tick } = fakeCtx();
    sc.hover = { name: 'Sol Station', x: 0, y: 20000 };
    tick();
    // (Lining up over the station: its bearing, just short of it)
    expect(map.jumpAim).toEqual({ angle: Math.PI / 2, dist: 18500, label: 'Sol Station' });
    // The charge starts with that locked; the map's cursor moves off the station and far away
    sc.lock = { angle: Math.PI / 2, dist: 18500, label: 'Sol Station' };
    sc.hover = null;
    sc.mouseWorld = { x: -30000, y: -8000 };
    tick(); tick();
    expect(map.jumpAim).toEqual({ angle: Math.PI / 2, dist: 18500, label: 'Sol Station' });
    expect(sc.aimed.slice(-2)).toEqual([[18500, 'Sol Station'], [18500, 'Sol Station']]);
    // (Burnt or let go: the cursor again)
    sc.lock = null;
    tick();
    expect(map.jumpAim!.label).toBe(null);
    expect(map.jumpAim!.angle).toBeCloseTo(Math.atan2(-8000, -30000), 9);
  });
});
