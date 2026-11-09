import { describe, it, expect } from 'vitest';
import type { TutorialData } from '@space-game/common';
import tutorialJson from '../../../../data/tutorial.json';
import { LeaveFlow, arrowTargets, edgeArrow, fillKeys, isGhosted, lookFor, markerStyle, newlyDone, packLines, panelModel, risingPanels } from './tutorialModel';

const data = tutorialJson as unknown as TutorialData;
const obj = (id: string) => data.objects.find((o) => o.id === id)!;
const st = (step: string, done: string[] = [], broken: string[] = []) => ({ step, done, left: false, broken });
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
    expect(isGhosted(obj('training_rock'), st('mine', ['drones']))).toBe(false);
    expect(isGhosted(obj('training_rock'), st('hold', ['mine']))).toBe(true);
  });

  it('picks the look: live drones are drawn as drones, live rocks as normal rocks, done ones as ghosts', () => {
    expect(lookFor(obj('drone_1'), st('drones'))).toBe('drone');
    expect(lookFor(obj('drone_1'), st('mine', ['drones']))).toBe('droneGhost');
    expect(lookFor(obj('training_rock'), st('mine'))).toBeNull();
    expect(lookFor(obj('training_rock'), st('hold', ['mine']))).toBe('rockGhost');
    expect(lookFor(obj('ring_1'), st('rings'))).toBeNull();
  });

  it('nothing is ghosted without a state or once left', () => {
    expect(isGhosted(obj('drone_1'), null)).toBe(false);
    expect(isGhosted(obj('drone_1'), { step: '', done: ['drones'], left: true, broken: [] })).toBe(false);
  });

  it('markers: this step bright, later ones faint, done ones gone; arrows skip broken targets', () => {
    const rings = data.steps.find((s) => s.id === 'rings')!;
    expect(markerStyle(obj('ring_1'), st('rings'), rings)).toBe('active');
    expect(markerStyle(obj('stop_zone'), st('rings'), rings)).toBe('upcoming');
    expect(markerStyle(obj('ring_1'), st('brake', ['welcome', 'rings']), data.steps[2])).toBeNull();
    expect(markerStyle(obj('drone_1'), st('drones'), rings)).toBeNull();
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
});
