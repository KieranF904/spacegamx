/**
 * The station's repair bank tab and its pack list, the admin bank buttons, and the field guide's wording. Pure html: no page.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'path';
import { Economy, setUnlockTable, depositable, packDefs, type ItemsFile, type RecipesFile, type ServerRepairBankMessage, type Stack, type UnlockTable } from '@space-game/common';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../../server/src/ships/createShipBridge';
import items from '../../../../data/items.json';
import recipes from '../../../../data/recipes.json';
import unlockData from '../../../../data/unlocks.json';
import { bankHtml, depositRows, depositStacks, freeShare, fullInText } from './BankPanel';
import { packRows, packsHtml } from './packs';
import { devBankHtml, devBankMessage, packKit } from './devBank';
import { setBank, getBank } from './bankStore';
import { guideHtml, GUIDE_TABS } from '../fieldGuide';

const bridge = createShipBridge(loadShipConfigCached(join(__dirname, '../../../../data')));
const econ = new Economy(items as unknown as ItemsFile, recipes as unknown as RecipesFile, bridge.catalog, {});
const icon = () => '';

const msg: ServerRepairBankMessage = {
  type: 'repairBank',
  free: { alloy_plate: 12, copper_wire: 8 },
  cap: { alloy_plate: 16, copper_wire: 8 },
  fullIn: 450,
  spare: { copper_wire: 2 },
  deposits: { pack_hull: 3, steel_plate: 5 },
  rebuilding: 2,
};

describe('bank panel', () => {
  it('renders the free part and the deposits apart from a repairBank message, and what the bank does not do', () => {
    const html = bankHtml(econ, icon, msg, 0);
    expect(html).toContain('full in 8 min');
    expect(html).toContain('width:83%');
    expect(html).toMatch(/Free part/);
    expect(html).toMatch(/data-bank="deposits"/);
    expect(html).toMatch(/starter-level parts/);
    expect(html).toMatch(/A lost ship, or a part you've only planned, has to be fabricated/);
    expect(html).not.toMatch(/respawn/i);
    expect(html.indexOf('Free part')).toBeLessThan(html.indexOf('Deposits'));
  });

  it('counts "full in" down between reports, and says full when it is', () => {
    expect(bankHtml(econ, icon, msg, 400)).toContain('full in 50 s');
    expect(bankHtml(econ, icon, { ...msg, free: { ...msg.cap }, fullIn: 0 }, 0)).toContain('>full<');
    expect(fullInText(3700)).toBe('1 h 2 min');
    expect(freeShare({ free: {}, cap: { a: 4 } })).toBe(0);
  });

  it('says so when nothing is deposited', () => {
    const html = bankHtml(econ, icon, { ...msg, deposits: {}, spare: {}, rebuilding: undefined });
    expect(html).toContain('none yet');
  });

  it('waits for the first report', () => {
    expect(bankHtml(econ, icon, null)).toContain('Reading your repair bank');
    expect(getBank()).toBeNull();
    setBank(msg, 1000);
    expect(getBank()).toEqual({ msg, at: 1000 });
  });

  it('offers only depositable items: packs, refined materials and components', () => {
    const ammo = econ.items.all().find((d) => d.category === 'ammo');
    const stacks: Stack[] = [
      { id: 'pack_hull', n: 2 }, { id: 'steel_plate', n: 4 }, { id: 'iron_ore', n: 9 }, { id: 'not_an_item', n: 1 }, { id: 'copper_wire', n: 0 },
      ...(ammo ? [{ id: ammo.id, n: 3 }] : []),
    ];
    const ids = depositStacks(econ, stacks).map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['pack_hull', 'steel_plate']));
    expect(ids).not.toContain('iron_ore');
    expect(ids).not.toContain('copper_wire');
    if (ammo) expect(ids).not.toContain(ammo.id);
    for (const id of ids) expect(depositable(econ, id), id).toBe(true);
    const html = depositRows(econ, icon, stacks, 'cargo');
    expect(html).toContain('data-dep="pack_hull"');
    expect(html).toContain('data-from="cargo"');
    expect(html).not.toContain('iron_ore');
    expect(depositRows(econ, icon, [{ id: 'iron_ore', n: 5 }], 'storage')).toContain('Nothing here');
  });
});

describe('packs', () => {
  it('lists every pack with its contents from the item data and the field note', () => {
    const rows = packRows(econ, [], 20, [{ id: 'alloy_plate', n: 2 }, { id: 'composite_sheet', n: 2 }, { id: 'steel_plate', n: 2 }]);
    expect(rows.map((r) => r.id).sort()).toEqual(packDefs(econ.items).map((p) => p.id).sort());
    const hull = rows.find((r) => r.id === 'pack_hull')!;
    expect(hull.contents).toEqual({ alloy_plate: 2, composite_sheet: 2, steel_plate: 2 });
    expect(hull.open && hull.afford).toBe(true);
    expect(rows.find((r) => r.id === 'pack_drive')!.afford).toBe(false);
    const html = packsHtml(econ, icon, rows);
    expect(html).toContain('data-pack="pack_hull"');
    expect(html).toContain('pays 1 unit');
    expect(html).toContain('60% faster');
    expect(html).toContain('gives all of it');
  });
});

describe('admin bank buttons', () => {
  it('are hidden unless the server is a dev server', () => {
    expect(devBankHtml(false)).toBe('');
    const html = devBankHtml(true);
    for (const a of ['fill', 'empty', 'clearDeposits', 'grant']) expect(html).toContain(`data-devbank="${a}"`);
  });

  it('send devBank, and grant carries a kit of every pack', () => {
    expect(devBankMessage(econ, 'fill')).toEqual({ type: 'devBank', action: 'fill' });
    expect(devBankMessage(econ, 'clearDeposits')).toEqual({ type: 'devBank', action: 'clearDeposits' });
    const g = devBankMessage(econ, 'grant')!;
    expect(Object.keys(g.items!).sort()).toEqual(Object.keys(packKit(econ)).sort());
    expect(Object.keys(g.items!)).toContain('pack_hull');
    expect(devBankMessage(econ, 'nonsense')).toBeNull();
  });
});

describe('field guide wording', () => {
  beforeAll(() => setUnlockTable(unlockData as unknown as Partial<UnlockTable>));
  const deps = { k: (a: string) => `<kbd>${a}</kbd>`, threats: () => ({}), myRating: () => 0, level: () => 12, xp: () => 30000, icon: () => '' };

  it('has no insurance, loaner or repair kit in any tab', () => {
    for (const t of GUIDE_TABS) expect(guideHtml(t.id, deps).toLowerCase(), t.id).not.toMatch(/insurance|loaner|repair kit/);
  });

});
