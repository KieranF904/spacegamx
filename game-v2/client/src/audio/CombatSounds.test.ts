/**
 * Combat sounds heard as their visuals are drawn (CombatSounds): once a shell, once a volley a frame, a few a frame,
 * nothing on arrival, a drawn-ahead shot taken back while held never heard, an impact drawn twice for one shell heard once.
 */
import { describe, expect, it } from 'vitest';
import { CANNON_GRADE_PITCH, CombatSounds, type ShotHeard } from './CombatSounds';

function rig(opts: { shield?: boolean } = {}) {
  const played: { id: string; x: number; y: number; volume: number; pitch: number }[] = [];
  const cs = new CombatSounds({
    play: (id, x, y, volume, pitch) => played.push({ id, x, y, volume, pitch }),
    shieldAt: () => !!opts.shield,
    shotSound: (model, type, turret) => (model ? `m:${model}` : turret ? 'turret_shot' : `t${type}`),
    random: () => 0.5,
  });
  cs.frame(true);
  const shot = (p: Partial<ShotHeard> & { id: number }): ShotHeard => ({ spawnTick: 100, owner: 1, type: 2, grade: 1, turret: false, x: 0, y: 0, ahead: false, ...p });
  return { cs, played, shot };
}

describe('CombatSounds', () => {
  it('hears a shell once, at its flash, and never again under the id the server gives it', () => {
    const { cs, played, shot } = rig();
    cs.shot(shot({ id: -1 }));
    expect(played.map((p) => p.id)).toEqual(['t2']);
    // (the server's copy takes the drawn one over: renamed; a report under its new id is the same shell)
    cs.renamed(-1, 500);
    cs.frame(true);
    cs.shot(shot({ id: 500 }));
    expect(played).toHaveLength(1);
    expect(cs.stats.dupShots).toBe(1);
  });

  it('hears a reused id again when it is a new shell (another spawn tick)', () => {
    const { cs, played, shot } = rig();
    cs.shot(shot({ id: 7 }));
    cs.frame(true);
    cs.shot(shot({ id: 7, spawnTick: 400 }));
    expect(played).toHaveLength(2);
  });

  it('hears one sound a volley a frame, and a few shots a frame at most', () => {
    const { cs, played, shot } = rig();
    for (let i = 0; i < 5; i++) cs.shot(shot({ id: -1 - i }));
    expect(played).toHaveLength(1);
    expect(cs.stats.volleyMerged).toBe(4);
    cs.frame(true);
    for (let o = 0; o < 8; o++) cs.shot(shot({ id: 100 + o, owner: o }));
    expect(played).toHaveLength(1 + 4);
    expect(cs.stats.capped).toBe(4);
  });

  it('hears nothing already flying on arrival (the settle window), nor those shells later', () => {
    const { cs, played, shot } = rig();
    cs.frame(false);
    cs.shot(shot({ id: 9 }));
    cs.frame(true);
    cs.shot(shot({ id: 9 }));
    expect(played).toHaveLength(0);
  });

  it('keeps the per-model sound and the cannon grade pitch', () => {
    const { cs, played, shot } = rig();
    cs.shot(shot({ id: 1, type: 1, grade: 2, owner: 1 }));
    cs.shot(shot({ id: 2, type: 1, grade: 2, owner: 2, model: 'cannon_hammer' }));
    cs.shot(shot({ id: 3, type: 3, owner: 3, turret: true }));
    expect(played.map((p) => [p.id, p.pitch])).toEqual([['t1', CANNON_GRADE_PITCH[1]], ['m:cannon_hammer', 1], ['turret_shot', 1]]);
  });

  it('a shot taken back after it was heard: the one drawn again for it is not heard again', () => {
    const { cs, played, shot } = rig();
    cs.shot(shot({ id: -1, ahead: true, owner: 4, spawnTick: 100 }));
    cs.shot(shot({ id: -2, ahead: true, owner: 4, spawnTick: 100 }));
    expect(played).toHaveLength(1);
    // (both taken back a round trip on: the snapshot drew the volley from another pose)
    for (let i = 0; i < 16; i++) cs.frame(true);
    cs.retracted(-1);
    cs.retracted(-2);
    // The snapshot's own shells for it (fire tick within one), another gun of the same ship a tick on is heard
    cs.shot(shot({ id: 300, owner: 4, spawnTick: 100 }));
    cs.shot(shot({ id: 301, owner: 4, spawnTick: 101 }));
    expect(played).toHaveLength(1);
    expect(cs.stats).toMatchObject({ retractedHeard: 2, redrawn: 2 });
    cs.frame(true);
    cs.shot(shot({ id: 302, owner: 4, spawnTick: 101 }));
    expect(played).toHaveLength(2);
  });

  it('forgets a taken-back shot never drawn again (a trigger let go): later shots are heard', () => {
    const { cs, played, shot } = rig();
    cs.shot(shot({ id: -1, ahead: true, owner: 4, spawnTick: 100 }));
    cs.retracted(-1);
    for (let i = 0; i < 100; i++) cs.frame(true);
    cs.shot(shot({ id: 5, owner: 4, spawnTick: 100 }));
    expect(played).toHaveLength(2);
  });

  it('a shot taken back before it was heard leaves nothing behind', () => {
    const { cs, played, shot } = rig();
    cs.retracted(-9);
    cs.shot(shot({ id: 5, owner: 4 }));
    expect(played).toHaveLength(1);
  });

  it('hears an impact where drawn; one shell drawn striking the same place twice is heard once; a pierce on another hull again', () => {
    const { cs, played } = rig();
    cs.impact({ shell: 10, owner: 1, x: 100, y: 0 });
    cs.frame(true);
    cs.impact({ shell: 10, owner: 1, x: 105, y: 0 });
    expect(played.map((p) => [p.id, p.x])).toEqual([['hit', 100]]);
    expect(cs.stats.dupImpacts).toBe(1);
    cs.frame(true);
    cs.impact({ shell: 10, owner: 1, x: 300, y: 0 });
    expect(played).toHaveLength(2);
    // (an impact with no shell known is always heard)
    cs.frame(true);
    cs.impact({ shell: -1, owner: -1, x: 300, y: 0 });
    expect(played).toHaveLength(3);
  });

  it('throttles impacts a source a frame, and a few a frame', () => {
    const { cs, played } = rig();
    for (let i = 0; i < 6; i++) cs.impact({ shell: i, owner: 1, x: i * 100, y: 0 });
    expect(played).toHaveLength(1);
    cs.frame(true);
    for (let i = 0; i < 6; i++) cs.impact({ shell: 20 + i, owner: i, x: i * 100, y: 0 });
    expect(played).toHaveLength(1 + 4);
  });

  it('hears a shell on a raised bubble as shield_hit', () => {
    const { cs, played } = rig({ shield: true });
    cs.impact({ shell: 1, owner: 1, x: 0, y: 0 });
    expect(played[0].id).toBe('shield_hit');
  });

  it('hears impacts even in the settle window (they are new)', () => {
    const { cs, played } = rig();
    cs.frame(false);
    cs.impact({ shell: 1, owner: 1, x: 0, y: 0 });
    expect(played).toHaveLength(1);
  });
});
