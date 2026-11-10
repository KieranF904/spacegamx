import { describe, it, expect } from 'vitest';
import type { Blueprint, PlacedPart } from '@space-game/common';
import { testCatalog } from '../../../../common/src/ships/testData';
import { FieldAids, editsOf, snapEdits, type FieldAidsHost } from './fieldAids';
import { addPart, noEdits, placementProblem, working, type BuildEdits } from './plan';

const catalog = testCatalog();
const part = (over: Partial<PlacedPart> & { uid: number }): PlacedPart => ({ piece: 'sq', fn: 'hull', material: 'alloy', x: 0, y: 0, rot: 0, flip: false, ...over });
const bp: Blueprint = { name: 't', catalogVersion: catalog.version, parts: [part({ uid: 0, fn: 'core' })] } as Blueprint;

function rig() {
  let edits: BuildEdits = noEdits();
  const said: string[] = [];
  const live = { bp, alive: [true], queued: new Set<number>() };
  const view = () => ({ live, w: working(live, edits) });
  const host: FieldAidsHost = {
    catalog,
    edits: () => edits,
    setEdits: (e) => { edits = e; },
    changed: () => {},
    say: (t) => { said.push(t); },
    view,
    problemFor: (p) => placementProblem(catalog, view().w, p),
  };
  const aids = new FieldAids(host);
  const place = (p: PlacedPart) => aids.edit(() => { addPart(edits, p); aids.placeMirror(p); });
  return { aids, place, said, get edits() { return edits; } };
}

describe('edits snapshots', () => {
  it('round-trip, sets and all', () => {
    const e: BuildEdits = { added: [part({ uid: 5, x: 3 })], dropped: new Set([2]), mark: new Set([3, 4]), unmark: new Set([7]) };
    expect(snapEdits(editsOf(snapEdits(e)))).toBe(snapEdits(e));
    expect(editsOf(snapEdits(e)).mark.has(4)).toBe(true);
  });
});

describe('FieldAids undo / redo', () => {
  it('undoes and redoes a placed part', () => {
    const r = rig();
    r.place(part({ uid: 1, x: 3, y: 0 }));
    expect(r.edits.added).toHaveLength(1);
    r.aids.undo();
    expect(r.edits.added).toHaveLength(0);
    r.aids.redo();
    expect(r.edits.added.map((p) => p.uid)).toEqual([1]);
  });

  it('a held drag of several parts is one step', () => {
    const r = rig();
    r.aids.beginDrag();
    r.place(part({ uid: 1, x: 3 })); r.place(part({ uid: 2, x: 4 })); r.place(part({ uid: 3, x: 5 }));
    r.aids.endDrag();
    expect(r.aids.history.size).toBe(1);
    r.aids.undo();
    expect(r.edits.added).toHaveLength(0);
  });

  it('says so with nothing to undo', () => {
    const r = rig();
    r.aids.undo();
    expect(r.said.at(-1)).toBe('Nothing to undo.');
  });
});

describe('FieldAids symmetry', () => {
  it('a placed part brings its mirror, and both undo as one step', () => {
    const r = rig();
    r.aids.toggleSymmetry();
    r.place(part({ uid: 1, x: -2, y: 0 }));
    expect(r.edits.added).toHaveLength(2);
    const [a, b] = r.edits.added;
    expect([a.x, b.x]).toEqual([-2, 2]);
    expect(b.flip).toBe(!a.flip);
    r.aids.undo();
    expect(r.edits.added).toHaveLength(0);
  });

  it('a part on the axis is placed once; with symmetry off nothing is mirrored', () => {
    const r = rig();
    r.aids.toggleSymmetry();
    r.place(part({ uid: 1, x: 0, y: -1 }));
    expect(r.edits.added).toHaveLength(1);
    const r2 = rig();
    r2.place(part({ uid: 1, x: -2 }));
    expect(r2.edits.added).toHaveLength(1);
  });

  it('a blocked mirror side keeps the original and says so', () => {
    const r = rig();
    r.edits.added.push(part({ uid: 9, x: 2, y: 0 }));
    r.aids.toggleSymmetry();
    r.place(part({ uid: 1, x: -2, y: 0 }));
    expect(r.edits.added.map((p) => p.uid).sort()).toEqual([1, 9]);
    expect(r.said.at(-1)).toMatch(/^Mirror side blocked/);
  });
});
