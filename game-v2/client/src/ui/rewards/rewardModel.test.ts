import { describe, it, expect } from 'vitest';
import type { RewardView } from '@space-game/common';
import quests from '../../../../data/quests.json';
import tutorial from '../../../../data/tutorial.json';
import { packLines } from '../tutorial/tutorialModel';
import { CARD_OPEN_MS, CARD_PILL_MS, CardLife, packRewardLines, questRewardLines, shortOutro } from './rewardModel';

const names = { item: (id: string) => id.toUpperCase(), icon: (id: string) => `icon:${id}` };
const base: RewardView = { xp: 0, credits: 0, items: {}, plans: [], recipes: [], licences: [], reputation: {}, skillPoints: 0 };

describe('quest reward lines', () => {
  it('lists credits, XP, items with icons, skill points, standing, then unlocks', () => {
    const lines = questRewardLines({ ...base, xp: 120, credits: 2500, items: { iron: 3 }, skillPoints: 1, reputation: { 'Sol Patrol': 2 }, plans: ['Prospector'], recipes: ['Ion thruster'], licences: ['Cinder'] }, names);
    expect(lines.map((l) => l.kind)).toEqual(['credits', 'xp', 'item', 'skill', 'rep', 'unlock', 'unlock', 'unlock']);
    expect(lines[0]).toMatchObject({ label: 'credits', count: 2500 });
    expect(lines[2]).toEqual({ kind: 'item', label: 'IRON', count: 3, icon: 'icon:iron' });
    expect(lines[4].label).toBe('Sol Patrol standing');
    expect(lines[5].label).toBe('Ship plan: Prospector');
  });
  it('is empty for a job that pays nothing', () => {
    expect(questRewardLines(base, names)).toEqual([]);
  });
  it('reads the rewards of every real quest', () => {
    const file = quests as unknown as { quests: { id: string; rewards?: { credits?: number; xp?: number; items?: Record<string, number> } }[] };
    expect(file.quests.length).toBeGreaterThan(0);
    for (const q of file.quests) {
      const r = q.rewards ?? {};
      const lines = questRewardLines({ ...base, credits: r.credits ?? 0, xp: r.xp ?? 0, items: r.items ?? {} }, names);
      expect(lines.length).toBe((r.credits ? 1 : 0) + (r.xp ? 1 : 0) + Object.keys(r.items ?? {}).length);
    }
  });
});

describe('tutorial starter pack', () => {
  it('lists the same items as the text lines, with their icons', () => {
    const data = tutorial as unknown as Parameters<typeof packLines>[0];
    const text = packLines(data, names.item);
    const lines = packRewardLines(data.starterPack, names);
    expect(lines.length).toBe(text.length);
    for (const l of lines) {
      const expected = l.kind === 'credits' ? `${l.count!.toLocaleString('en-US')} credits` : `${l.count} × ${l.label}`;
      expect(text).toContain(expected);
      if (l.kind === 'item') expect(l.icon).toMatch(/^icon:/);
    }
  });
});

describe('short outro', () => {
  it('keeps a short line and cuts a long one at a sentence', () => {
    expect(shortOutro('Well flown.')).toBe('Well flown.');
    expect(shortOutro(undefined)).toBe('');
    const long = `${'Signed for and sealed. '.repeat(3)}${'More words follow here. '.repeat(10)}`;
    const cut = shortOutro(long, 80);
    expect(cut.length).toBeLessThanOrEqual(80);
    expect(cut.endsWith('.')).toBe(true);
  });
});

describe('compact card life', () => {
  it('opens full when calm and folds to a pill on its own, then goes', () => {
    const c = new CardLife();
    c.open(0, false);
    expect(c.state).toBe('open');
    expect(c.tick(CARD_OPEN_MS - 1, false)).toBe(false);
    expect(c.tick(CARD_OPEN_MS, false)).toBe(true);
    expect(c.state).toBe('pill');
    c.tick(CARD_OPEN_MS + CARD_PILL_MS, false);
    expect(c.state).toBe('gone');
  });
  it('opens as a pill in combat, and folds an open card the moment combat starts', () => {
    const c = new CardLife();
    c.open(0, true);
    expect(c.state).toBe('pill');
    c.open(0, false);
    expect(c.tick(100, true)).toBe(true);
    expect(c.state).toBe('pill');
  });
  it('View reopens it, even in combat, until its time is up; dismiss folds then drops', () => {
    const c = new CardLife();
    c.open(0, true);
    c.view(10);
    expect(c.state).toBe('open');
    expect(c.tick(20, true)).toBe(false);
    c.dismiss(30);
    expect(c.state).toBe('pill');
    c.dismiss(40);
    expect(c.state).toBe('gone');
  });
});
