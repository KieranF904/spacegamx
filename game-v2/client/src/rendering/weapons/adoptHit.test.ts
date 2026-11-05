/**
 * A hit on one of your own shells that no snapshot ever brought (fired and spent between two snapshots: a Spark bolt
 * at close range, a stream at point-blank; or made and gone inside one coalesced message). The client draws the shell
 * it predicted from the moment you fired; with no row for it, nothing claimed that prediction, the hit's id matched no
 * tracer, and the predicted bolt flew on through what it hit to the end of its reach (the Spark's: about 4,000) with
 * only a mark left at the hit. WeaponFx.adopt gives the hit to the predicted shell on its line.
 *
 * Real WeaponFx, a stand-in game state (no projectile rows at all: that is the case), drawing stubbed out.
 */
import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import { EntityType, WeaponType } from '@space-game/common';
import { WeaponFx, type PredictedShell } from './WeaponFx';
import type { GameState } from '../../state/GameState';

const ME = 7;

interface ShotView { id: number; predicted: boolean; fading: number | null; hit: { x: number; y: number } | null; head: { x: number; y: number } | null; spawnTick: number }

function rig() {
  const entities = new Map<number, { id: number; type: number }>();
  const state = {
    entities: Object.assign(entities, { ofType: (t: number) => [...entities.values()].filter((e) => e.type === t) }),
    playerId: ME, serverTick: 100, predictionEnabled: true, triggerScreenShake() {},
  };
  const fx = new WeaponFx(new Container());
  // (no textures in node: nothing is drawn, the shots' state is what's checked)
  (fx as unknown as { draw: () => void }).draw = () => {};
  const shots = () => [...(fx as unknown as { shots: Map<number, ShotView> }).shots.values()];
  let present = 100;
  /** One frame on the present timeline at `tick` (the server's last snapshot `serverTick`) */
  const frame = (tick: number, serverTick = tick - 1) => {
    present = tick;
    state.serverTick = serverTick;
    fx.update(state as unknown as GameState, 1 / 60, present, present - 6);
  };
  const fire = (p: Partial<PredictedShell> & { spawnTick: number }) =>
    fx.predict({ pose: { x: 0, y: 0, angle: -Math.PI / 2 }, owner: ME, type: WeaponType.Arc, model: 'arc_spark', life: 36, spawnX: 0, spawnY: 0, vx: 0, vy: -110, size: 1, ...p } as PredictedShell);
  return { fx, state, shots, frame, fire, entities };
}

describe('a hit on your shell that no snapshot brought (WeaponFx.adopt)', () => {
  it('stops the bolt you predicted at the hit, instead of letting it fly on through', () => {
    const { fx, shots, frame, fire } = rig();
    fire({ spawnTick: 100 });
    frame(101);
    frame(102);
    // The server's shell (id 500, never in a snapshot) hit 330 out, on tick 103; told with the snapshot at 103
    frame(104, 103);
    fx.onHit(500, 0, -330);
    frame(105, 103);
    const s = shots().find((x) => x.id === 500);
    expect(s, 'the predicted bolt took the hit').toBeDefined();
    expect(s!.predicted).toBe(false);
    expect(s!.hit).toEqual({ x: 0, y: -330 });
    expect(s!.fading).not.toBeNull();
    // ...and nothing flies on past the target: the bolt stays where it struck, fading (the fade itself is in draw)
    for (let t = 106; t < 130; t++) {
      frame(t);
      for (const o of shots()) expect(o.head?.y ?? 0).toBeGreaterThanOrEqual(-330.01);
    }
    expect(shots().map((o) => [o.id, o.predicted, o.fading !== null])).toEqual([[500, false, true]]);
  });

  it('gives a stream\'s hits to its shells in firing order', () => {
    const { fx, shots, frame, fire } = rig();
    // A stream from one gun: three shells on one line, four ticks apart
    fire({ spawnTick: 100, type: WeaponType.Autocannon, model: 'autocannon_chainsaw', vy: -60 });
    frame(102);
    fire({ spawnTick: 104, type: WeaponType.Autocannon, model: 'autocannon_chainsaw', vy: -60 });
    frame(105);
    fire({ spawnTick: 108, type: WeaponType.Autocannon, model: 'autocannon_chainsaw', vy: -60 });
    // The first hits 200 out (tick 103), told at 106: the oldest takes it, the other two fly on
    fx.onHit(601, 0, -200);
    frame(107, 106);
    const first = shots().find((x) => x.id === 601)!;
    expect(first.spawnTick).toBe(100);
    expect(shots().filter((x) => x.predicted).map((x) => x.spawnTick)).toEqual([104, 108]);
    // The second, at the same place four ticks later
    fx.onHit(602, 0, -200);
    frame(110, 109);
    expect(shots().find((x) => x.id === 602)!.spawnTick).toBe(104);
    expect(shots().filter((x) => x.predicted).map((x) => x.spawnTick)).toEqual([108]);
  });

  it('takes the bolt whose line runs through the hit (twin turrets), and leaves a hit on no line of yours alone', () => {
    const { fx, shots, frame, fire } = rig();
    // Two turrets 100 apart, firing at a point 600 out between them
    const aim = (x0: number) => { const dx = -x0, dy = -600, d = Math.hypot(dx, dy); return { spawnX: x0, vx: (dx / d) * 110, vy: (dy / d) * 110 }; };
    fire({ spawnTick: 100, ...aim(-50) });
    fire({ spawnTick: 100, ...aim(50) });
    frame(101);
    // Someone else's shell hit something off to the side: not yours
    fx.onHit(700, 400, -200);
    frame(102, 101);
    expect(shots().filter((x) => x.predicted)).toHaveLength(2);
    // The right-hand bolt hit 300 along its line
    const r = aim(50), k = 300 / 110;
    fx.onHit(701, 50 + r.vx * k, r.vy * k);
    frame(104, 103);
    const s = shots().find((x) => x.id === 701) as ShotView & { spawnX: number };
    expect(s.spawnX).toBe(50);
    expect(shots().filter((x) => x.predicted).map((x) => (x as ShotView & { spawnX: number }).spawnX)).toEqual([-50]);
  });

  it('a shell that did come in a snapshot is still the one its hit stops (claim, then hit)', () => {
    const { fx, shots, frame, fire, entities } = rig();
    fire({ spawnTick: 100 });
    frame(101);
    // Its row: the server's copy takes the predicted bolt over
    entities.set(800, { id: 800, type: EntityType.Projectile, data: [WeaponType.Arc, 2, 0, 100, 0, 0, ME, 1, 1, 0, 3], spawnTick: 100, spawnX: 0, spawnY: 0, x: 0, y: -110, vx: 0, vy: -110 } as never);
    frame(102, 101);
    expect(shots().map((x) => [x.id, x.predicted])).toEqual([[800, false]]);
    fx.onHit(800, 0, -330);
    entities.delete(800);
    frame(104, 103);
    expect(shots()[0].hit).toEqual({ x: 0, y: -330 });
  });
});
