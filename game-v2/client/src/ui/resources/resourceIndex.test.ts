/**
 * The resource dictionary's index: every resource item has an entry with a way to get it, mined ores name their belts,
 * refined items name their recipe.
 */
import { describe, it, expect } from 'vitest';
import { buildResourceIndex } from './resourceIndex';
import { RESOURCE_DATA } from './resourceData';

const entries = buildResourceIndex(RESOURCE_DATA);
const by = (id: string) => entries.find((e) => e.id === id)!;
const text = (id: string) => by(id).sources.map((s) => `${s.text} ${(s.where ?? []).join(' ')}`).join('\n');

/** Items with no source in the data yet: update this list as sources are added (it should only shrink) */
const NOT_OBTAINABLE_YET: string[] = [];

describe('resource index', () => {
  it('covers every ore, refined, component, pack and ammo item', () => {
    const cats: Record<string, string> = { mineral: 'ore', gem: 'ore', volatile: 'ore', refined: 'refined', component: 'component', ammo: 'ammo' };
    for (const it of RESOURCE_DATA.items) {
      const want = it.category === 'consumable' ? (it.pack ? 'pack' : 'component') : cats[it.category];
      if (!want) continue;
      expect(by(it.id), it.id).toBeTruthy();
      expect(by(it.id).category, it.id).toBe(want);
    }
  });

  it('an entry with no source is marked, and only the known ones are', () => {
    for (const e of entries) expect(e.notObtainable, e.id).toBe(e.sources.length === 0);
    expect(entries.filter((e) => e.notObtainable).map((e) => e.id).sort()).toEqual([...NOT_OBTAINABLE_YET].sort());
  });

  it('platinoid ore lists the Void Sector belt, and its rock', () => {
    const t = text('platinoid_ore');
    expect(t).toContain('Platinoid Shard');
    expect(t).toContain('Void Sector');
    expect(by('platinoid_ore').sources.find((s) => s.kind === 'mined')!.where).toContain('Void Sector (danger 7)');
  });

  it('a refined item lists its recipe, and what it is used for', () => {
    expect(text('alloy_plate')).toContain('2 Iron Ore + 1 Nickel Ore');
    expect(by('alloy_plate').usedFor.join(' ')).toContain('Alloy');
    expect(text('catalyst')).toContain('3 Platinoid Ore');
    expect(by('platinoid_ore').usedFor.join(' ')).toContain('Catalyst');
  });

  it('components, packs and ammo list how they are made', () => {
    expect(text('barrel_assembly')).toContain('Fabricator');
    expect(text('pack_hull')).toContain('Fabricator');
    expect(text('railgun_slugs')).toContain('Fabricator');
    expect(by('pack_hull').usedFor.join(' ')).toMatch(/repair bank/);
  });

  it('boss drops, trace metals and quartermaster stock are found', () => {
    expect(text('rustjaw_cog')).toContain('Rustjaw');
    expect(text('aurum')).toMatch(/refine/i);
    expect(text('pack_optics')).toMatch(/quartermaster/);
    expect(text('hush_pane')).toContain('Hushwing');
  });

  it('hand-written hints attach by item id and name real items', () => {
    for (const id of Object.keys(RESOURCE_DATA.hints)) expect(by(id), id).toBeTruthy();
    expect(by('copper_ore').hint).toBeTruthy();
  });
});
