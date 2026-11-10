/**
 * The world build view's aids and power flow overlay: reset drops every undo step (steps the live ship has made moot
 * must not come back), and the flow overlay says "as designed" when part of the working design is not built yet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import type { Blueprint, PlacedPart } from '@space-game/common';
import { testCatalog } from '../../../../common/src/ships/testData';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../../server/src/ships/createShipBridge';
import { FakeEl, installFakeDom, sink } from '../../fakeDom.testkit';
import { FieldAids, type FieldAidsHost } from './fieldAids';
import { addPart, noEdits, placementProblem, working, type BuildEdits, type WorkingDesign } from './plan';

vi.mock('../build/powerFlow', () => ({ powerFlow: () => ({ segments: [], marks: [], tints: [], ticks: 0, crosses: 0, short: 0 }) }));
import { FieldFlow } from './fieldFlow';

const catalog = testCatalog();
const part = (over: Partial<PlacedPart> & { uid: number }): PlacedPart => ({ piece: 'sq', fn: 'hull', material: 'alloy', x: 0, y: 0, rot: 0, flip: false, ...over });
const bp: Blueprint = { name: 't', catalogVersion: catalog.version, parts: [part({ uid: 0, fn: 'core' })] } as Blueprint;

describe('a step the live ship has since made moot falls away (the history is dropped when edits settle)', () => {
  it('reset empties both stacks: nothing to undo, nothing to redo', () => {
    let edits: BuildEdits = noEdits();
    const live = { bp, alive: [true], queued: new Set<number>() };
    const view = () => ({ live, w: working(live, edits) });
    const host: FieldAidsHost = {
      catalog, edits: () => edits, setEdits: (e) => { edits = e; }, changed: () => {}, say: () => {}, view,
      problemFor: (p) => placementProblem(catalog, view().w, p),
    };
    const aids = new FieldAids(host);
    aids.edit(() => addPart(edits, part({ uid: 1, x: 2 })));
    aids.edit(() => addPart(edits, part({ uid: 2, x: 3 })));
    aids.undo(); // one undone: there is something to redo too
    expect(aids.history.canUndo).toBe(true);
    expect(aids.history.canRedo).toBe(true);
    aids.reset(); // the edits settled into the live ship
    expect(aids.history.canUndo).toBe(false);
    expect(aids.history.canRedo).toBe(false);
  });
});

beforeEach(() => { installFakeDom(); });
afterEach(() => vi.unstubAllGlobals());

const bridge = createShipBridge(loadShipConfigCached(join(__dirname, '../../../../data')));

describe('it shows the working design as it would run once every planned part is built (labelled "as designed")', () => {
  it('the legend says "as designed" while some part is planned but not standing, and not once all stand', () => {
    const fx = new FieldFlow({ catalog: bridge.catalog, tuning: bridge.tuning });
    fx.on = true;
    const parent = Object.assign(new FakeEl('div'), { prepend: () => {} });
    fx.mount(parent as never);
    const legend = (fx as unknown as { legend: FakeEl }).legend;
    const design = bridge.library.get('hauler')!;
    const w = (standing: boolean[]): WorkingDesign => ({ bp: design, standing, marked: new Set(), liveIndex: [] } as unknown as WorkingDesign);
    const all = design.parts.map(() => true);
    fx.draw(sink(), () => [0, 0], 20, w(all), []);
    expect(legend.innerHTML).not.toMatch(/as designed/i);
    fx.draw(sink(), () => [0, 0], 20, w(all.map((s, i) => i !== 1)), []);
    expect(legend.innerHTML).toMatch(/as designed/i);
  });
});
