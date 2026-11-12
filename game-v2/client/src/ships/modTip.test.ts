/**
 * Weapon modifiers in words (modTip.ts): the tooltip rows of each kind of part on the showcase ship, the plain reason
 * for everything that does nothing, and nothing at all on a ship without modifier parts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createPortsState, createShipState, parseBlueprint, type Blueprint, type Economy, type ModBlockInfo, type ModIdle, type PlacedPart, type Rot, type ShipTuning } from '@space-game/common';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../../../common/src/ships/testData';
import { modsOf, type FxOff } from './build/modExplain';
import { idleWords, modGuide, modTipHtml, modWarnings, modsPanelHtml, OFF, type ModTipCtx } from './modTip';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const mt = tuning.modifiers!;
// (A part's name is its model's)
const econ = { items: { name: (id: string) => catalog.functions.get(id.split(':')[2] ?? '')?.name ?? id } } as unknown as Economy;
const dev = (name: string) => parseBlueprint(readFileSync(join(SHIP_DATA_DIR, `blueprints/dev/${name}.json`), 'utf-8'));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function built(bp: Blueprint) {
  const ship = createShipState(catalog, tuning, 1, bp, 0), parts = ship.blueprint.parts;
  const ctx: ModTipCtx = { catalog, tuning, econ, derived: ship.derived, parts };
  const at = (fn: string, x: number, y: number) => parts.findIndex((p) => p.fn === fn && p.x === x && p.y === y);
  const name = (i: number) => catalog.functions.get(parts[i].fn)?.name ?? parts[i].fn;
  return { ship, ctx, at, name, tip: (i: number) => text(modTipHtml(i, ctx)), L: ship.derived.ports!, ex: modsOf(catalog, tuning, parts, ship.derived) };
}

function line(blocks: [fn: string, x: number, y: number][], conduit = 'power_conduit'): Blueprint {
  const part = (fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart => {
    const def = catalog.functions.get(fn), piece = fn === 'core' ? 'rect2' : Array.isArray(def?.pieces) ? def.pieces[0] : 'sq';
    return { uid: 0, piece, fn, material: def?.material ?? 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra };
  };
  // (Up x = 0: a reactor, three Mounts with their sockets to the right, a line part, a Pip)
  const parts = [
    part('core', 0, 0), part('hull', 0, -1), ...[-1, -2, -3, -4, -5, -6, -7].map((y) => part('hull', -1, y)),
    part('power_cell_reactor', 0, -2), part('mod_mount', 0, -3), part('mod_mount', 0, -4), part('mod_mount', 0, -5), part(conduit, 0, -6), part('cannon_pip', 0, -7, { facing: 'N' }),
    ...blocks.map(([fn, x, y]) => part(fn, x, y)),
  ];
  parts.forEach((p, i) => (p.uid = i + 1));
  return { name: 'test', catalogVersion: 1, parts };
}

describe('weapon modifier tooltips: the showcase ship', () => {
  const s = built(dev('mod-showcase-1'));

  it('a gun lists its effects in order, each with its strength and what it does', () => {
    const t = s.tip(s.at('cannon_pip', -1, -7));
    expect(t).toContain('Its shots carry');
    const order = ['velocity', 'rapid', 'explosive', 'split'].map((id) => t.indexOf(`${mt.say[id].name} 100%`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const id of ['velocity', 'rapid', 'explosive', 'split']) expect(t).toContain(mt.say[id].say);
    expect(t).not.toContain('off:');
  });

  it('a fused mount names its effect, what fused, and that it replaces the two', () => {
    const t = s.tip(s.at('mod_mount_double', 2, -2));
    expect(t).toContain('Sockets filled 2 of 2');
    expect(t).toMatch(/Gives Pierce : (Coil \+ Prism|Prism \+ Coil) fused, in place of (Velocity and Split|Split and Velocity)/);
    expect(t).toContain('Treats now 60 E/s');
    expect(t).toContain('Upkeep now 2 E/s');
    expect(t).toContain(`Reaches ${s.name(s.at('cannon_hammer', 2, -4))}`);
  });

  it('a single mount, its block, a special and its hopper, and the line part say what they do here', () => {
    expect(s.tip(s.at('mod_mount', -3, -3))).toMatch(/Sockets filled 1 of 1 Gives Velocity from its Coil Treats now 24 E\/s Upkeep now 1 E\/s Reaches /);
    expect(s.tip(s.at('mod_coil', -2, -3))).toContain('On this ship gives Velocity to');
    expect(s.tip(s.at('mod_coil', 1, -3))).toContain('On this ship fused into Pierce to');
    const arc = s.tip(s.at('mod_arc', -4, -3));
    expect(arc).toContain('gives Chain to');
    expect(arc).toContain(`Fed by ${s.name(s.at('hopper_arcsalt', -4, -2))}`);
    const hop = s.tip(s.at('hopper_arcsalt', -4, -2));
    expect(hop).toContain(`Feeds ${s.name(s.at('mod_arc', -4, -3))}`);
    expect(hop).toContain('refilled when docked');
    const lineTip = s.tip(s.at('power_conduit_3', -1, -6));
    expect(lineTip).toContain('Carrying 4 of 4 effects');
    expect(lineTip).toContain('of 900 treated E/s');
    expect(lineTip).not.toContain('Drops');
  });

  it('parts the modifiers do not touch gain nothing; the panel has no warnings', () => {
    expect(s.tip(s.at('core', -1, 0))).toBe('');
    expect(s.tip(s.at('power_cell_reactor', -1, -1))).toBe('');
    expect(modWarnings(s.ex!, s.L, mt, s.name)).toEqual([]);
    const panel = text(modsPanelHtml(s.ctx, s.name));
    expect(panel).toContain('MODIFIERS 5 guns changed · 8 of 8 mounts working · upkeep 9 E/s');
    expect(panel).toContain('Every modifier reaches a gun.');
    expect(panel).toContain('How modifiers work');
  });

  it('with the ship\'s power state, an effect that is off is dimmed and says why', () => {
    const e = createPortsState(s.L);
    e.held[s.at('hopper_arcsalt', -4, -2)] = 0;
    const html = modTipHtml(s.at('autocannon_rattler', -5, -4), { ...s.ctx, power: e });
    expect(html).toContain('opacity:0.45');
    expect(text(html)).toContain(`(off: ${OFF.hopper})`);
  });
});

describe('weapon modifier tooltips: what does nothing says so', () => {
  it('a Conduit past three mounts names the effect it drops, on itself, on the gun and in the panel', () => {
    const s = built(line([['mod_coil', 1, -3], ['mod_chamber', 1, -4], ['mod_prism', 1, -5]]));
    const conduit = s.at('power_conduit', 0, -6), dropped = mt.say[mt.effects[s.ex!.lines.get(conduit)!.dropped[0]]].name;
    expect(s.tip(conduit)).toContain('Carrying 2 of 2 effects');
    expect(s.tip(conduit)).toContain(`Drops ${dropped}: it carries 2 effects (tier II carries 3, up to 300 E/s)`);
    expect(s.tip(s.at('cannon_pip', 0, -7))).toContain(`${dropped} never arrives: Conduit carries 2 effects and dropped it`);
    expect(modWarnings(s.ex!, s.L, mt, s.name)).toEqual([`Conduit drops ${dropped}: it carries 2 effects (tier II carries 3, up to 300 E/s)`]);
    // (A Conduit II carries all three: nothing to say)
    const ok = built(line([['mod_coil', 1, -3], ['mod_chamber', 1, -4], ['mod_prism', 1, -5]], 'power_conduit_2'));
    expect(modWarnings(ok.ex!, ok.L, mt, ok.name)).toEqual([]);
  });

  it('an empty mount, a block no socket faces and a special with no hopper each give their reason', () => {
    const s = built(line([['mod_coil', 1, -3], ['mod_arc', 1, -4], ['mod_prism', 1, -7]]));
    expect(s.tip(s.at('mod_mount', 0, -5))).toContain('Sockets filled 0 of 1 Nothing on a socket: it only passes power');
    expect(s.tip(s.at('mod_prism', 1, -7))).toContain('does nothing: no mount socket faces it');
    expect(s.tip(s.at('mod_arc', 1, -4))).toContain('does nothing: no Arc Salt hopper touches it or is piped to it');
    expect(s.tip(s.at('mod_mount', 0, -4))).toContain('No effect: its modifier does nothing here');
    const warn = modWarnings(s.ex!, s.L, mt, s.name);
    expect(warn).toContain(`${s.name(s.at('mod_arc', 1, -4))} does nothing: no Arc Salt hopper touches it or is piped to it`);
    expect(warn).toContain(`${s.name(s.at('mod_prism', 1, -7))} does nothing: no mount socket faces it`);
    expect(warn).toContain('Mount has nothing on a socket: it only passes power');
    expect(text(modsPanelHtml(s.ctx, s.name))).toContain('1 gun changed · 1 of 3 mounts working');
  });

  it('every reason has its words', () => {
    for (const idle of ['noSocket', 'wrongKind', 'noHopper', 'noPower', 'noGuns'] as ModIdle[]) {
      expect(idleWords({ part: 0, kind: 'arc', mount: -1, idle, hoppers: [] } as ModBlockInfo, mt).length).toBeGreaterThan(8);
    }
    for (const off of ['mount', 'hopper', 'power'] as FxOff[]) expect(OFF[off].length).toBeGreaterThan(8);
  });
});

describe('weapon modifiers: ships without them, and the guide', () => {
  it('a ship with no modifier parts gains no rows and no panel block', () => {
    const s = built(dev('ports-gunship'));
    expect(s.ex).toBeUndefined();
    for (let i = 0; i < s.ctx.parts!.length; i++) expect(modTipHtml(i, s.ctx)).toBe('');
    expect(modsPanelHtml(s.ctx, s.name)).toBe('');
  });

  it('the guide names every recipe and line tier from the tuning', () => {
    const g = modGuide(catalog, mt).join(' ');
    expect(g).toContain('Coil + Prism = Pierce');
    expect(g).toContain('Chamber + Resonator = Wave');
    expect(g).toContain('tier I carries 2, tier II carries 3, tier III carries 4');
    expect(g).toContain('refilled when docked');
  });
});
