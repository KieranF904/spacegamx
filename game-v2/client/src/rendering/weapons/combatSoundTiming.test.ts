/**
 * Combat sounds on the timeline their visuals are drawn on (WeaponFx.sounds -> audio/CombatSounds.ts). Real WeaponFx, a
 * stand-in game state, one frame a tick: the frame a shell is first drawn against the frame its sound plays, for your
 * own shot (predicted on its fire tick, the server's copy a round trip later), another ship's drawn ahead (the PT
 * timeline), and impacts (a strike at a drawn surface, the told hit after it). The old way heard a shot as its
 * projectile row first appeared and an impact as its projectileHit came: those frames are kept for the comparison.
 */
import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import { EntityType, WeaponType } from '@space-game/common';
import { WeaponFx, type PredictedShell } from './WeaponFx';
import { CombatSounds } from '../../audio/CombatSounds';
import type { GameState } from '../../state/GameState';

const ME = 7, OTHER = 9;
/** A 100 ms round trip with a snapshot every 3 ticks: the server's row for a shell comes ~6-9 ticks after it's fired here */
const RTT_TICKS = 6 + 3;

interface ShotView { id: number; head: { x: number; y: number } | null; fading: number | null }

function rig() {
  const entities = new Map<number, Record<string, unknown>>();
  const state = {
    entities: Object.assign(entities, { ofType: (t: number) => [...entities.values()].filter((e) => e.type === t) }),
    playerId: ME, serverTick: 100, predictionEnabled: true, triggerScreenShake() {},
  };
  const fx = new WeaponFx(new Container());
  (fx as unknown as { draw: () => void }).draw = () => {};
  const shots = () => [...(fx as unknown as { shots: Map<number, ShotView> }).shots.values()];
  const heard: { frame: number; id: string; x: number; y: number }[] = [];
  let frameNo = 0;
  const cs = new CombatSounds({ play: (id, x, y) => heard.push({ frame: frameNo, id, x, y }), random: () => 0.5 });
  fx.sounds = cs;
  /** The frame each shell was first drawn (a head on screen), by the shell record */
  const firstDrawn = new Map<ShotView, number>();
  /** One frame at present tick `tick` (others drawn 6 behind, at the render tick), Game's order: the sounds' frame, then the shells */
  const frame = (tick: number) => {
    frameNo = tick;
    state.serverTick = tick - 1;
    cs.frame(true);
    fx.update(state as unknown as GameState, 1 / 60, tick, tick - 6);
    for (const s of shots()) if (s.head && !firstDrawn.has(s)) firstDrawn.set(s, tick);
  };
  const fire = (p: Partial<PredictedShell> & { spawnTick: number }) =>
    fx.predict({ pose: { x: 0, y: 0, angle: -Math.PI / 2 }, owner: ME, type: WeaponType.Cannon, grade: 1, life: 60, spawnX: 0, spawnY: 0, vx: 0, vy: -20, size: 1, ...p } as PredictedShell);
  /** The server's row for a shell (as the snapshot brings it) */
  const row = (id: number, owner: number, spawnTick: number) => entities.set(id, {
    id, type: EntityType.Projectile, x: 0, y: 0, vx: 0, vy: -20, spawnX: 0, spawnY: 0, spawnTick, renderX: 0, renderY: 0, data: [WeaponType.Cannon, 1, 30, 0, 0, 0, owner, 1, 0, 0],
  });
  return { fx, cs, frame, fire, row, heard, shots, firstDrawn, entities };
}

describe('combat sounds play on the frame their visuals are drawn', () => {
  it('your own shot: heard on the frame its predicted shell is first drawn, not again when the server\'s copy comes', () => {
    const { frame, fire, row, heard, shots, firstDrawn } = rig();
    fire({ spawnTick: 100 });
    for (let t = 101; t <= 101 + RTT_TICKS; t++) frame(t);
    const drawnAt = firstDrawn.get(shots()[0])!;
    // (the server's row, a round trip later: the old way heard the shot here)
    const rowAt = 102 + RTT_TICKS;
    row(500, ME, 100);
    for (let t = rowAt; t < rowAt + 10; t++) frame(t);
    expect(heard.map((h) => h.frame)).toEqual([drawnAt]);
    expect(shots().map((s) => s.id)).toEqual([500]);
    // eslint-disable-next-line no-console
    console.log(`[timing] own shot: first drawn f${drawnAt}, heard f${heard[0].frame} (delta 0); old way (row arrival) f${rowAt}: delta ${rowAt - drawnAt} frames`);
  });

  it('another ship\'s shot drawn ahead (PT): heard as it flashes on its timeline, once', () => {
    const { frame, fire, row, heard, shots, firstDrawn } = rig();
    // (drawn ahead on tick 100, its owner's timeline the render tick, six behind)
    fire({ spawnTick: 100, owner: OTHER });
    for (let t = 101; t <= 112; t++) frame(t);
    const drawnAt = firstDrawn.get(shots()[0])!;
    expect(heard.map((h) => h.frame)).toEqual([drawnAt]);
    row(600, OTHER, 100);
    for (let t = 113; t < 130; t++) frame(t);
    expect(heard).toHaveLength(1);
  });

  it('a shot drawn ahead and taken back before its flash is never heard', () => {
    const { fx, frame, fire, heard } = rig();
    const h = fire({ spawnTick: 110, owner: OTHER });
    for (let t = 101; t <= 112; t++) frame(t);
    fx.retract(h);
    for (let t = 113; t <= 130; t++) frame(t);
    expect(heard).toHaveLength(0);
  });

  it('a shot drawn ahead, heard, then taken back as the snapshot draws it otherwise: its snapshot shell is not heard again', () => {
    const { fx, frame, fire, row, heard } = rig();
    const h = fire({ spawnTick: 100, owner: OTHER });
    for (let t = 101; t <= 115; t++) frame(t);
    expect(heard).toHaveLength(1);
    fx.retract(h);
    row(650, OTHER, 100);
    for (let t = 116; t <= 130; t++) frame(t);
    expect(heard).toHaveLength(1);
  });

  it('a shell first seen by its row (not predicted) is heard as it\'s first drawn', () => {
    const { frame, row, heard, shots, firstDrawn } = rig();
    row(700, OTHER, 100);
    for (let t = 101; t <= 110; t++) frame(t);
    expect(heard.map((h) => h.frame)).toEqual([firstDrawn.get(shots()[0])!]);
  });

  it('an impact: heard where the shell is drawn striking, the told hit after it not heard again', () => {
    const { fx, frame, fire, row, heard, shots, firstDrawn } = rig();
    // A wall 200 out: every drawn shell stops at it
    fx.castHit = (x0, y0, x1, y1, _o, _s, out) => {
      if (y1 > -200 || y0 < -200) return false;
      out.x = 0; out.y = -200; out.target = 3; out.t = 0;
      return true;
    };
    fire({ spawnTick: 100 });
    let struckAt = -1;
    for (let t = 101; t <= 130; t++) {
      frame(t);
      if (struckAt < 0 && shots()[0]?.fading !== null) struckAt = t;
    }
    expect(firstDrawn.size).toBe(1);
    const impacts = heard.filter((h) => h.id === 'hit');
    expect(impacts.map((h) => [h.frame, h.y])).toEqual([[struckAt, -200]]);
    // The server's row and its hit, a round trip after the strike: the old way heard the hit here
    row(800, ME, 100);
    const toldAt = struckAt + RTT_TICKS;
    frame(toldAt);
    fx.onHit(800, 0, -200);
    for (let t = toldAt + 1; t < toldAt + 10; t++) frame(t);
    expect(heard.filter((h) => h.id === 'hit')).toHaveLength(1);
    // eslint-disable-next-line no-console
    console.log(`[timing] impact: drawn striking f${struckAt}, heard f${impacts[0].frame} (delta 0); old way (projectileHit) f${toldAt}: delta ${toldAt - struckAt} frames`);
  });

  it('a told hit on a shell never drawn is heard as its impact is drawn', () => {
    const { fx, frame, heard } = rig();
    frame(101);
    fx.onHit(900, 50, -50);
    expect(heard).toHaveLength(0);
    frame(102);
    expect(heard.map((h) => [h.frame, h.id, h.x])).toEqual([[102, 'hit', 50]]);
  });
});
