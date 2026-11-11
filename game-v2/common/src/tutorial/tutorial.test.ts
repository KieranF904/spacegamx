import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { validateTutorialData, cleanTutorial, newTutorial, objectLive, objectBroken, nextStep, stepIds, type TutorialData } from './index.js';

const data = JSON.parse(readFileSync(join(__dirname, '../../../data/tutorial.json'), 'utf8')) as TutorialData;
const clone = () => JSON.parse(JSON.stringify(data)) as TutorialData;

describe('data/tutorial.json', () => {
  it('has no problems', () => {
    expect(validateTutorialData(data)).toEqual([]);
  });

  it('has the fifteen steps, in order, ending in graduate', () => {
    expect(stepIds(data)).toEqual(['welcome', 'rings', 'brake', 'drones', 'mine', 'hold', 'pickup', 'dock', 'refine', 'hangar', 'power', 'bank', 'guide', 'jump', 'graduate']);
    expect(nextStep(data, 'welcome')).toBe('rings');
    expect(nextStep(data, 'graduate')).toBeUndefined();
  });

  it('names every problem it finds', () => {
    const d = clone();
    d.objects[0].step = 'nope';
    d.objects[4].hp = 0;
    d.steps[2].trigger.objects = ['ring_1'];
    d.starterPack.items = {};
    d.yard.leash = 100;
    const out = validateTutorialData(d);
    expect(out.join('\n')).toMatch(/objects\[0\]\.step: unknown step "nope"/);
    expect(out.join('\n')).toMatch(/objects\[4\]\.hp/);
    expect(out.join('\n')).toMatch(/zoneStop needs a zone object first/);
    expect(out.join('\n')).toMatch(/starterPack\.items/);
    expect(out.join('\n')).toMatch(/yard\.spawnRadius: must be inside the leash/);
    expect(validateTutorialData('x')).toEqual(['tutorial: expected an object']);
  });

  it('checks items and stations against what exists', () => {
    const out = validateTutorialData(data, { item: (id) => id !== 'copper_wire', systems: new Set(['sol']), stations: new Map([['sol_station_yard', 'ashfall']]) });
    expect(out.join('\n')).toMatch(/unknown item "copper_wire"/);
    expect(out.join('\n')).toMatch(/yard\.station/);
  });
});

describe('a pilot\'s tutorial state', () => {
  it('a new pilot starts at the first step; anything saved without it has left', () => {
    expect(newTutorial()).toEqual({ step: 'welcome', done: [], left: false });
    expect(cleanTutorial(undefined)).toEqual({ step: '', done: [], left: true });
    expect(cleanTutorial([])).toEqual({ step: '', done: [], left: true });
    expect(cleanTutorial({ left: true, done: ['welcome', 3] })).toEqual({ step: '', done: ['welcome'], left: true });
    expect(cleanTutorial({ left: false, step: 7, done: 'x' })).toEqual({ step: 'welcome', done: [], left: false });
  });

  it('objects are live until their step is done or the pilot broke them', () => {
    const rock = data.objects.find((o) => o.id === 'drone_1')!;
    const t = newTutorial();
    expect(objectLive(t, rock)).toBe(true);
    t.hits = { drone_1: rock.hp! };
    expect(objectBroken(t, rock)).toBe(true);
    expect(objectLive(t, rock)).toBe(false);
    expect(objectLive({ ...newTutorial(), done: ['drones'] }, rock)).toBe(false);
    expect(objectLive({ step: '', done: [], left: true }, rock)).toBe(false);
    expect(objectLive(undefined, rock)).toBe(false);
  });
});
