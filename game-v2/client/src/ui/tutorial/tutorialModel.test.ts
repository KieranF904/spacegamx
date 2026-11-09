import { describe, it, expect } from 'vitest';
import type { TutorialData } from '@space-game/common';
import tutorialJson from '../../../../data/tutorial.json';
import { LeaveFlow, arrowTargets, counterOf, distLabel, edgeArrow, fillKeys, isGhosted, lineText, lookFor, markerStyle, newlyDone, packLines, panelModel, phaseOf, pointsAtBelt, pointsAtStation, ringArrow, risingPanels, targetGained } from './tutorialModel';
import { clearTrainingBodies, inertBody, isTrainingBody, setTrainingBody } from '../../state/trainingBodies';

const data = tutorialJson as unknown as TutorialData;
const obj = (id: string) => data.objects.find((o) => o.id === id)!;
const st = (step: string, done: string[] = [], broken: string[] = [], passed: string[] = []) => ({ step, done, left: false, broken, passed });
const keyOf = (a: string) => ({ forward: 'W', backward: 'S', fire: 'LMB' } as Record<string, string>)[a] ?? a.toUpperCase();

describe('tutorial panel', () => {
  it('renders step n of total, the title, key-capped lines and progress from a state', () => {
    const m = panelModel(st('brake', ['welcome', 'rings']), data, keyOf)!;
    expect(m.n).toBe(3);
    expect(m.total).toBe(data.steps.length);
    expect(m.title).toBe(data.steps[2].title);
    expect(m.lines[0]).toContain('<kbd>S</kbd>');
    expect(m.progress).toBeCloseTo(2 / data.steps.length, 6);
    expect(m.canContinue).toBe(false);
    expect(m.graduate).toBe(false);
  });

  it('offers Continue on the welcome card and the graduate screen on the last step', () => {
    expect(panelModel(st('welcome'), data, keyOf)!.canContinue).toBe(true);
    expect(panelModel(st('graduate'), data, keyOf)!.graduate).toBe(true);
  });

  it('shows nothing after leaving, before a state, or for an unknown step', () => {
    expect(panelModel({ step: '', done: [], left: true, broken: [] }, data, keyOf)).toBeNull();
    expect(panelModel(null, data, keyOf)).toBeNull();
    expect(panelModel(st('nope'), data, keyOf)).toBeNull();
  });

  it('fills key caps, escapes the rest, and knows the power-flow key', () => {
    expect(fillKeys('Press {powerFlow} <b>', keyOf)).toBe('Press <kbd>U</kbd> &lt;b&gt;');
  });

  it('every step line of the data renders', () => {
    for (const s of data.steps) expect(panelModel(st(s.id), data, keyOf)!.lines.length).toBeGreaterThan(0);
  });
});

describe('ghosting', () => {
  it('a body is ghosted once its step is done or the pilot broke it', () => {
    expect(isGhosted(obj('drone_1'), st('drones'))).toBe(false);
    expect(isGhosted(obj('drone_1'), st('drones', [], ['drone_1']))).toBe(true);
    expect(isGhosted(obj('drone_2'), st('drones', [], ['drone_1']))).toBe(false);
    expect(isGhosted(obj('drone_2'), st('mine', ['drones']))).toBe(true);
  });

  it('picks the look: the current step drones live, done ones ghosts, later ones not drawn at all', () => {
    expect(lookFor(obj('drone_1'), st('drones'), data)).toBe('drone');
    expect(lookFor(obj('drone_1'), st('mine', ['drones']), data)).toBe('droneGhost');
    expect(lookFor(obj('drone_1'), st('rings'), data)).toBe('hidden');
    expect(lookFor(obj('drone_1'), st('brake', ['rings']), data)).toBe('hidden');
    expect(lookFor(obj('drone_1'), st('drones', [], ['drone_1']), data)).toBe('droneGhost');
    expect(lookFor(obj('ring_1'), st('rings'), data)).toBeNull();
  });

  it('every object is hidden, live or ghost by where the pilot is: later steps are never shown', () => {
    for (const s of data.steps) {
      const i = data.steps.indexOf(s);
      const done = data.steps.slice(0, i).map((x) => x.id);
      for (const o of data.objects) {
        const at = data.steps.findIndex((x) => x.id === o.step);
        const phase = phaseOf(o, st(s.id, done), data);
        expect(phase, `${o.id} at ${s.id}`).toBe(at > i ? 'hidden' : at === i ? 'live' : 'ghost');
        if (at > i) expect(markerStyle(o, st(s.id, done), s, data), `${o.id} marker at ${s.id}`).toBeNull();
      }
    }
    expect(phaseOf(obj('drone_1'), null, data)).toBe('live');
  });

  it('the mining step points at the belt, not at a training object', () => {
    const mine = data.steps.find((s) => s.id === 'mine')!;
    expect(pointsAtBelt(mine)).toBe(true);
    expect(pointsAtBelt(data.steps.find((s) => s.id === 'drones'))).toBe(false);
    expect(arrowTargets(data, st('mine', ['drones']), mine)).toEqual([]);
  });

  it('nothing is ghosted without a state or once left', () => {
    expect(isGhosted(obj('drone_1'), null)).toBe(false);
    expect(isGhosted(obj('drone_1'), { step: '', done: ['drones'], left: true, broken: [] })).toBe(false);
  });

  it('markers: this step bright, later ones faint, done ones gone; arrows skip broken targets', () => {
    const rings = data.steps.find((s) => s.id === 'rings')!;
    expect(markerStyle(obj('ring_1'), st('rings'), rings, data)).toBe('active');
    expect(markerStyle(obj('stop_zone'), st('rings'), rings, data)).toBeNull();
    expect(markerStyle(obj('ring_1'), st('brake', ['welcome', 'rings']), data.steps[2], data)).toBeNull();
    expect(markerStyle(obj('drone_1'), st('drones'), rings, data)).toBeNull();
    const drones = data.steps.find((s) => s.id === 'drones')!;
    expect(arrowTargets(data, st('drones', [], ['drone_1']), drones).map((o) => o.id)).toEqual(['drone_2', 'drone_3']);
  });
});

describe('leave flow', () => {
  it('asks first, sends only after confirm, and only once', () => {
    let sent = 0;
    const f = new LeaveFlow(() => sent++);
    f.confirm();
    expect(sent).toBe(0);
    f.ask();
    expect(f.phase).toBe('confirm');
    f.cancel();
    expect(f.phase).toBe('idle');
    f.ask();
    f.confirm();
    f.confirm();
    f.ask();
    expect(sent).toBe(1);
    expect(f.phase).toBe('sent');
  });

  it('Enter Sol on the graduate screen sends without asking', () => {
    let sent = 0;
    const f = new LeaveFlow(() => sent++);
    f.enter();
    f.enter();
    expect(sent).toBe(1);
  });
});

describe('toast, pack, panel reports, arrows', () => {
  it('names the steps that became done', () => {
    expect(newlyDone(st('rings', ['welcome']), st('brake', ['welcome', 'rings']), data)).toEqual([data.steps[1].title]);
    expect(newlyDone(null, st('brake', ['welcome']), data)).toEqual([]);
  });

  it('lists credits then items of the starter pack', () => {
    const lines = packLines(data, (id) => id.toUpperCase());
    expect(lines.length).toBe(Object.keys(data.starterPack.items).length + (data.starterPack.credits > 0 ? 1 : 0));
    if (data.starterPack.credits > 0) expect(lines[0]).toMatch(/credits$/);
  });

  it('reports a panel only as it opens', () => {
    expect(risingPanels({ hold: false, map: true }, { hold: true, map: true })).toEqual(['hold']);
    expect(risingPanels({ hold: true }, { hold: true })).toEqual([]);
  });

  it('keeps an off-screen arrow on the edge, towards the target', () => {
    const a = edgeArrow(2000, 300, 1000, 600, 40);
    expect(a.onScreen).toBe(false);
    expect(a.x).toBeCloseTo(960, 5);
    expect(a.y).toBeGreaterThan(300 - 1);
    expect(a.y).toBeLessThan(600);
    const b = edgeArrow(500, -900, 1000, 600, 40);
    expect(b.y).toBeCloseTo(40, 5);
    expect(edgeArrow(400, 200, 1000, 600, 40).onScreen).toBe(true);
  });

  it('puts an off-screen arrow on an ellipse round the ship, clear of the HUD at the sides, the card on top and the bars below', () => {
    const w = 1280, h = 800;
    for (const [sx, sy] of [[-5000, 400], [9000, 400], [640, -9000], [640, 9000], [-3000, -3000]]) {
      const a = ringArrow(sx, sy, w, h);
      expect(a.x).toBeGreaterThanOrEqual(380 - 1e-6);
      expect(a.x).toBeLessThanOrEqual(900 + 1e-6);
      expect(a.y).toBeGreaterThanOrEqual(210 - 1e-6);
      expect(a.y).toBeLessThanOrEqual(590 + 1e-6);
      expect(a.angle).toBeCloseTo(Math.atan2(sy - h / 2, sx - w / 2), 9);
    }
  });

  it('writes distances as the nav markers do', () => {
    expect(distLabel(644)).toBe('640');
    expect(distLabel(3530)).toBe('3.5k');
    expect(distLabel(10160)).toBe('10.2k');
  });
});

describe('training bodies (state/trainingBodies.ts)', () => {
  it('a hidden or ghosted drone is inert for this pilot; a live one is a training body but not inert; others are neither', () => {
    clearTrainingBodies();
    setTrainingBody(7, 'hidden');
    setTrainingBody(8, 'droneGhost');
    setTrainingBody(9, 'drone');
    expect([inertBody(7), inertBody(8), inertBody(9), inertBody(10)]).toEqual([true, true, false, false]);
    expect([isTrainingBody(7), isTrainingBody(9), isTrainingBody(10)]).toEqual([true, true, false]);
    setTrainingBody(7, null);
    expect(isTrainingBody(7)).toBe(false);
    clearTrainingBodies();
    expect(isTrainingBody(9)).toBe(false);
  });
});

describe('tutorial control-mode lines and chips', () => {
  const keys = (a: string) => ({ forward: 'W', left: 'A', backward: 'S', right: 'D', fire: 'Left click' } as Record<string, string>)[a] ?? a;
  it('picks the line variant for the control mode', () => {
    const l = { screen: 'screen text', helm: 'helm text' };
    expect(lineText(l, false)).toBe('screen text');
    expect(lineText(l, true)).toBe('helm text');
    expect(lineText('plain', true)).toBe('plain');
  });
  it('the rings and brake cards read right for each mode', () => {
    const screen = panelModel(st('rings'), data, keys, false)!.lines[0];
    const helm = panelModel(st('rings'), data, keys, true)!.lines[0];
    expect(screen).toContain('<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>');
    expect(screen).toContain('face the cursor');
    expect(helm).toContain('<kbd>A</kbd> and <kbd>D</kbd>');
    expect(helm).not.toContain('face the cursor');
    expect(panelModel(st('brake'), data, keys, false)!.lines[0]).toContain('<kbd>S</kbd>');
    expect(panelModel(st('brake'), data, keys, true)!.lines[0]).toContain('Thrust back with <kbd>S</kbd>');
    // (ships glide to a stop by themselves: the card never says there is no brake)
    expect(panelModel(st('brake'), data, keys, false)!.lines[0]).toContain('glide to a stop');
  });
  it('key chips follow rebinding', () => {
    expect(fillKeys('Move {wasd}', (a) => ({ forward: '↑', left: '←', backward: '↓', right: '→' } as Record<string, string>)[a])).toBe('Move <kbd>↑</kbd><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd>');
  });
  it('no step mentions a bare "W key" and every line has no more than 14 words', () => {
    for (const s of data.steps) for (const l of s.lines) for (const t of typeof l === 'string' ? [l] : [l.screen, l.helm]) {
      expect(t).not.toMatch(/\bW key\b/);
      expect(t.replace(/\{[a-zA-Z]+\}/g, 'K').split(/\s+/).length).toBeLessThanOrEqual(14);
    }
  });
});

describe('tutorial multi-target progress', () => {
  const step = data.steps.find((x) => x.id === 'rings')!;
  it('counts rings passed and drones broken', () => {
    expect(counterOf(st('rings'), step)).toEqual({ label: 'Rings', done: 0, total: 3 });
    expect(counterOf(st('rings', [], [], ['ring_1', 'ring_2']), step)!.done).toBe(2);
    const drones = data.steps.find((x) => x.id === 'drones')!;
    expect(counterOf(st('drones', [], ['drone_1']), drones)).toEqual({ label: 'Drones', done: 1, total: 3 });
    expect(counterOf(st('brake'), data.steps.find((x) => x.id === 'brake'))).toBeNull();
    expect(panelModel(st('rings', [], [], ['ring_1']), data, keyOf)!.counter).toEqual({ label: 'Rings', done: 1, total: 3 });
  });
  it('lights the next ring, ticks the passed ones, and the arrow follows the next', () => {
    const s0 = st('rings'), s1 = st('rings', [], [], ['ring_1']);
    expect(markerStyle(obj('ring_1'), s0, step, data)).toBe('active');
    expect(markerStyle(obj('ring_2'), s0, step, data)).toBe('upcoming');
    expect(markerStyle(obj('ring_1'), s1, step, data)).toBe('passed');
    expect(markerStyle(obj('ring_2'), s1, step, data)).toBe('active');
    expect(arrowTargets(data, s0, step).map((o) => o.id)).toEqual(['ring_1']);
    expect(arrowTargets(data, s1, step).map((o) => o.id)).toEqual(['ring_2']);
    expect(arrowTargets(data, st('rings', [], [], ['ring_1', 'ring_2', 'ring_3']), step)).toEqual([]);
  });
  it('a gained target (not a finished step) is what chimes', () => {
    expect(targetGained(st('rings'), st('rings', [], [], ['ring_1']), data)).toBe(true);
    expect(targetGained(st('rings', [], [], ['ring_1']), st('rings', [], [], ['ring_1']), data)).toBe(false);
    expect(targetGained(st('rings', [], [], ['ring_1', 'ring_2']), st('brake', ['rings']), data)).toBe(false);
    expect(targetGained(st('drones'), st('drones', [], ['drone_2']), data)).toBe(true);
  });
  it('only the dock step points at the station', () => {
    expect(pointsAtStation(data.steps.find((x) => x.id === 'dock'))).toBe(true);
    expect(pointsAtStation(step)).toBe(false);
  });
});
