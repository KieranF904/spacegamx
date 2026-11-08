/**
 * Safety net (refactor stage 0): every part's player-facing text, and every ship's summary, pinned as plain text.
 * Each model and each blueprint is its own test and its own snapshot file (golden/__snapshots__/), so a diff
 * names the part or ship that changed.
 *
 * Regenerate deliberately (after an intended wording or number change):
 *   UPDATE_SNAPSHOT=1 npx vitest run client/src/ships/golden/textSnapshots.test.ts
 * (vitest's own switch; `-u` does the same). Review the git diff of __snapshots__ before committing.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { Economy, type Blueprint, partStats, type ItemsFile, type RecipesFile } from '@space-game/common';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../../server/src/proto/createProtoServer';
import items from '../../../../data/items.json';
import recipes from '../../../../data/recipes.json';
import modelsFile from '../../../../data/ships/models.json';
import { familyLabel, keyStats, modelLock, mountBadge, mountingText, sizeText, sizeWord, tradeOff } from '../modelCards';
import { partTipHtml } from '../partTip';
import { partStatsHtml } from '../../ui/windowKit';
import { shipSummary } from '../shipSummary';

const DATA = join(__dirname, '../../../../data');
const config = loadShipConfigCached(DATA);
const bridge = createShipBridge(config);
const { catalog, tuning } = bridge;
const econ = new Economy(items as unknown as ItemsFile, recipes as unknown as RecipesFile, catalog, {});

// Numbers are formatted with toLocaleString(): pin the locale so the text is the same on every machine
const realLocaleString = Number.prototype.toLocaleString;
beforeAll(() => {
  Number.prototype.toLocaleString = function (_l?: string | string[], o?: Intl.NumberFormatOptions) {
    return realLocaleString.call(this, 'en-US', o);
  };
});
afterAll(() => {
  Number.prototype.toLocaleString = realLocaleString;
});

/** HTML to readable text: one line per block or row, entities decoded, runs of spaces collapsed */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>|<\/(div|p|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

const models = (modelsFile as { models: { id: string }[] }).models.map((m) => m.id);
const fnOf = (id: string) => {
  const f = catalog.functions.get(id);
  if (!f) throw new Error(`models.json lists ${id} but the catalog has no such function`);
  return f;
};

/** Every number a model's text shows, from its first piece and material (the way the palette and fabricator show it) */
function modelText(id: string): string {
  const f = fnOf(id);
  const piece = (f.pieces as string[])[0]!;
  const material = f.material ?? '';
  const part = { fn: id, material, piece };
  const tip = partTipHtml(part, {
    catalog,
    tuning,
    econ,
    have: () => 0,
    canMake: () => true,
  });
  const all = econ.items.all();
  const sections: [string, string][] = [
    ['partTip (tooltip)', htmlToText(tip)],
    ['partStats (stats rows)', htmlToText(partStatsHtml(econ, part))],
    ['familyLabel', familyLabel(f)],
    ['sizeWord', sizeWord(catalog, piece)],
    ['sizeText', sizeText(catalog, f)],
    ['tradeOff', tradeOff(f)],
    ['keyStats', keyStats(catalog, tuning, f, piece, material)],
    ['mountBadge', htmlToText(mountBadge(catalog, { fn: id }))],
    ['mountingText', mountingText(catalog, { fn: id }, tuning).join('\n')],
    ['modelLock (locked, level 4)', JSON.stringify(modelLock(f, false, 4, all))],
    ['modelLock (unlocked, level 99)', JSON.stringify(modelLock(f, true, 99, all))],
    ['partStats (raw)', JSON.stringify(partStats(catalog, tuning, part))],
  ];
  return sections.map(([name, body]) => `== ${name} ==\n${body}`).join('\n\n') + '\n';
}

describe('part text, per model (golden)', () => {
  it('covers every model in models.json', () => {
    expect(models.length).toBeGreaterThan(50);
  });

  it.each(models)('%s', async (id) => {
    await expect(modelText(id)).toMatchFileSnapshot(`./__snapshots__/model-${id}.txt`);
  });
});

/** Every blueprint in the plan library (blueprints/*.json) and the dev test ships (blueprints/dev/*.json) */
const ships: [string, string][] = [];
function shipText(bp: Blueprint): string {
  const s = shipSummary(catalog, tuning, econ, bp);
  return s ? JSON.stringify(s, null, 2) + '\n' : 'no summary (the design does not build)\n';
}
for (const [name, bp] of Object.entries(config.library ?? {})) ships.push([`library/${name}`, shipText(bp)]);
for (const [name, bp] of Object.entries(config.dev ?? {})) ships.push([`dev/${name}`, shipText(bp)]);

describe('ship summaries, per blueprint (golden)', () => {
  it('covers the library and the dev ships', () => {
    expect(ships.length).toBeGreaterThan(10);
  });

  it.each(ships.map(([name]) => name))('%s', async (name) => {
    const text = ships.find(([n]) => n === name)![1];
    await expect(text).toMatchFileSnapshot(`./__snapshots__/ship-${name.replace('/', '-')}.txt`);
  });
});
