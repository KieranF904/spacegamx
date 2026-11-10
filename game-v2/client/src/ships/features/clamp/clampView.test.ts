/**
 * Docking Clamps' prompt and HUD state (clampView.ts): the prompt shows at the prompt's slack and not past it, matches
 * same-size clamps only, and the links, asks and breaks it was told.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CLAMP, clampOffset, clampWorld, clampFit, clampLinedUp, createShipState, parseBlueprint, followerPose, type ShipState, type ShipTuning, type ClampBody,
} from '@space-game/common';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../../../../../common/src/ships/testData';
import { findPrompt, ClampView, breakText } from './clampView';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const sparrow = readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8');
const CS = tuning.cellSize;

function clamped(id: number, side: 'E' | 'W'): ShipState {
  const bp = parseBlueprint(sparrow);
  bp.parts.push({ uid: 60, piece: 'sq', fn: 'docking_clamp', material: 'alloy', x: side === 'E' ? 3 : -2, y: 0, rot: 0, flip: false, facing: side } as never);
  return createShipState(catalog, tuning, id, bp, 0);
}

const A = clamped(1, 'E'), B = clamped(2, 'W');
const ca = A.derived.fx!.clamp!.clamps[0], cb = B.derived.fx!.clamp!.clamps[0];
const offset = clampOffset(ca, A.derived.com, cb, B.derived.com, CS);
const lead: ClampBody = { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0 };

/** The other ship moved off the snapped pose: across the clamps by `side` */
function other(side: number, ship = B): { id: number; ship: ShipState; body: ClampBody } {
  const f = followerPose(lead, offset), n = clampWorld(ca, A.derived.com, CS, lead);
  return { id: 2, ship, body: { ...f, x: f.x - n.ny * side + n.nx * 4, y: f.y + n.nx * side + n.ny * 4 } };
}

describe('docking clamps: the prompt', () => {
  it('shows at the prompt\'s slack, where the lock would refuse, and not past it', () => {
    const me = { id: 1, ship: A, body: lead };
    expect(findPrompt(me, [other(0)], CS)).toEqual({ with: 2, clamp: ca.uid, theirs: cb.uid });
    // (Past the lock's tolerance sideways, within the prompt's: shown; the lock itself refuses there)
    const o = other(CLAMP.lateral + 2);
    expect(findPrompt(me, [o], CS)).not.toBeNull();
    const fit = clampFit(clampWorld(ca, A.derived.com, CS, lead), clampWorld(cb, B.derived.com, CS, o.body));
    expect(clampLinedUp(fit, lead, o.body)).toBe(false);
    expect(findPrompt(me, [other(CLAMP.lateral * CLAMP.promptSlack + 2)], CS)).toBeNull();
  });

  it('matches only clamps of the same size', () => {
    // (A Heavy Docking Clamp's mouth where ours meets: size 2)
    expect(catalog.functions.get('docking_clamp_heavy')?.clamp?.size).toBe(2);
    const heavy = { ...B, derived: { ...B.derived, fx: { clamp: { clamps: [{ ...cb, size: 2 }] } } } } as ShipState;
    expect(findPrompt({ id: 1, ship: A, body: lead }, [other(0, heavy)], CS)).toBeNull();
  });

  it('keeps the links, asks and breaks it was told', () => {
    const v = new ClampView();
    v.onAsk({ type: 'clampAsk', from: 2, what: 'dock', until: 100 }, 0);
    expect(v.ask?.from).toBe(2);
    v.onLink({ type: 'clampLink', tick: 5, leader: 2, follower: 1, lc: 60, fc: 60, offset }, 1);
    expect(v.ask).toBeNull();
    expect(v.linkOf(1)?.leader).toBe(2);
    // (A swap: the same pair's new record)
    v.onLink({ type: 'clampLink', tick: 9, leader: 1, follower: 2, lc: 60, fc: 60, offset }, 1);
    expect(v.links.size).toBe(1);
    expect(v.linkOf(2)?.leader).toBe(1);
    v.onBreak({ type: 'clampBreak', tick: 20, a: 1, b: 2, why: 'jump' }, 1, breakText);
    expect(v.linkOf(1)).toBeUndefined();
    expect(v.notice).toBe('Undocked to jump');
  });
});
