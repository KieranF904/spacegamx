/**
 * The two card levels and the system index: every public system lists its rocks, resources and enemies consistently with the reverse lookups,
 * private and tutorial systems are left out, and chances show as tiers only.
 */
import { describe, it, expect } from 'vitest';
import { RESOURCE_DATA, resourceEntries, sourceIndex } from './resourceData';
import { detailHtml, entryIds, pageHtml, previewHtml, type View } from './entryCards';
import { isPublicSystem } from './sourceIndex';

const deps = { icon: () => '' };
const ix = sourceIndex();
const VIEWS: View[] = ['res', 'rock', 'enemy', 'sys'];

describe('system index', () => {
  it('has one entry per public system and none for private, tutorial, gun range or instances', () => {
    const publicIds = RESOURCE_DATA.systems.filter(isPublicSystem).map((s) => s.id);
    expect(ix.systems.map((s) => s.id).sort()).toEqual([...publicIds].sort());
    for (const id of ['homestead', 'gun_range', 'vesta_yard', 'ashfall_surface', 'selene_siege']) expect(ix.systems.some((s) => s.id === id), id).toBe(false);
    expect(ix.systems.some((s) => s.id === 'sol')).toBe(true);
  });

  it('agrees with the rock side: a system lists a rock exactly when the rock lists the system', () => {
    for (const s of ix.systems) for (const r of s.rocks) expect(ix.rocks.find((x) => x.id === r.rock)!.systems.some((p) => p.id === s.id), `${s.id} ${r.rock}`).toBe(true);
    for (const r of ix.rocks) for (const p of r.systems) expect(ix.systems.find((x) => x.id === p.id)!.rocks.some((x) => x.rock === r.id), `${p.id} ${r.id}`).toBe(true);
  });

  it('agrees with the enemy side', () => {
    for (const s of ix.systems) for (const e of s.enemies) expect(ix.enemies.find((x) => x.id === e)!.systemIds, `${s.id} ${e}`).toContain(s.id);
    for (const e of ix.enemies) for (const id of e.systemIds) expect(ix.systems.find((x) => x.id === id)!.enemies, `${id} ${e.id}`).toContain(e.id);
  });

  it('agrees with the resource side: an item lists a system exactly when the system lists the item', () => {
    for (const s of ix.systems) for (const x of s.items) expect(ix.columns.get(x.item)!.systems.some((y) => y.id === s.id && y.tier === x.tier), `${s.id} ${x.item}`).toBe(true);
    for (const [item, c] of ix.columns) for (const y of c.systems) expect(ix.systems.find((s) => s.id === y.id)!.items.some((x) => x.item === item), `${item} ${y.id}`).toBe(true);
  });

  it('puts mined ore in the systems of its rocks, and a boss in its own system', () => {
    const sol = ix.systems.find((s) => s.id === 'sol')!;
    expect(sol.items.some((x) => x.item === 'iron_ore')).toBe(true);
    expect(sol.enemies).toContain('boss_tallyman');
    expect(ix.systems.find((s) => s.id === 'void_sector')!.enemies).toContain('boss_void_leviathan');
  });

  it('gives every public system with a belt some rocks', () => {
    for (const s of RESOURCE_DATA.systems.filter((x) => isPublicSystem(x) && x.asteroidField)) expect(ix.systems.find((x) => x.id === s.id)!.rocks.length, s.id).toBeGreaterThan(0);
  });
});

describe('cards', () => {
  it('render for every entry of every view, and name it', () => {
    for (const v of VIEWS) for (const id of entryIds(v)) {
      expect(detailHtml(v, id, deps), `${v} ${id}`).toContain('ec-head');
      expect(previewHtml(v, id, deps), `${v} ${id}`).toContain('ec-head');
    }
  });

  it('link both ways: a rock card lists its systems, a system card lists its rocks and enemies', () => {
    const rock = ix.rocks[0];
    for (const p of rock.systems) expect(detailHtml('rock', rock.id, deps)).toContain(`data-go="sys:${p.id}"`);
    const sys = ix.systems.find((s) => s.rocks.length)!;
    for (const r of sys.rocks) expect(detailHtml('sys', sys.id, deps)).toContain(`data-go="rock:${r.rock}"`);
    for (const e of ix.systems.find((s) => s.id === 'sol')!.enemies) expect(detailHtml('sys', 'sol', deps)).toContain(`data-go="enemy:${e}"`);
  });

  it('the preview is not clickable and shows one source row for a resource', () => {
    for (const e of resourceEntries()) {
      const p = previewHtml('res', e.id, deps);
      expect(p, e.id).not.toContain('data-go');
      expect((p.match(/class="ec-sec"/g) ?? []).length, e.id).toBeLessThanOrEqual(1);
    }
  });

  it('shows tiers and never a percentage or a chance number', () => {
    // (an item's own description and hint may quote a stat; chances and shares are what must stay tiers)
    const noDesc = (x: string) => x.replace(/<div class="ec-(?:desc|hint)[^"]*">.*?<\/div>/g, '');
    for (const v of VIEWS) for (const id of entryIds(v)) for (const h of [noDesc(detailHtml(v, id, deps)), noDesc(previewHtml(v, id, deps)), noDesc(pageHtml(v, id, deps))]) {
      expect(h, `${v} ${id}`).not.toMatch(/\d\s*%|per 100|chance:? ?\d/i);
      for (const m of h.matchAll(/(?:title|aria-label)="([^"]*)"/g)) expect(m[1], `${v} ${id}`).not.toMatch(/\d\s*%/);
    }
    expect(detailHtml('res', 'iron_ore', deps)).toMatch(/: (High|Medium|Low)"/);
  });
});
