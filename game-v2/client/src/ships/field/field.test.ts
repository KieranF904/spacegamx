/**
 * The client half of field fabrication: the copy of the server's field state and the progress worked out from the
 * predicted machine clock, the build overlay's plan diff, and the HUD's words for each way a machine can be stuck.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MACHINE_FAB, MACHINE_REF, parseBlueprint, validateBlueprint, partItemId, jobAt } from '@space-game/common';
import type { Blueprint, Charge, FieldJob, MachineBlock, MachineView, ShipTuning } from '@space-game/common';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../../../../common/src/ships/testData';
import { HANDLERS } from '../../app/serverMessages';
import { FieldClient, machineClock, machineJob, machineProgress } from './fieldState';
import { blockText, jobText, machineName, machineStatus } from './fieldText';
import { pickMessage, shortLine } from './FieldHud';
import { addPart, candidate, openDraft, partAtPoint, placementProblem, planChanged, planDiff, planTarget, removePart, targetErrors } from './plan';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const sparrow = (): Blueprint => parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8'));

const job = (over: Partial<FieldJob> = {}): FieldJob => ({
  id: 1, kind: 'build', uid: 9, item: 'part_pip', held: {}, need: 100, done: 0, attachNeed: 0, attachDone: 0, phase: 'make', packShare: 0, ...over,
});
const machine = (over: Partial<MachineView> = {}): MachineView => ({ kind: 'fabricator', tier: 1, uid: 4, on: true, drawing: true, ...over });
/** The own ship's predicted charge: only its machine counters matter here */
const chargeWith = (fab: number, ref = 0): Charge => ({ g: 0, b: [], e: { machEu: Float64Array.from([0, fab, ref]) } as unknown as Charge['e'] });

describe('field state copy', () => {
  it('applies fieldState and fieldDone', () => {
    const c = new FieldClient();
    expect(c.machine('fabricator')).toBeUndefined();
    c.applyState({ type: 'fieldState', tick: 5, machines: [machine({ job: job(), at: 0 }), machine({ kind: 'refiner', tier: 0, uid: -1, on: false })], recycle: [3, 4], short: { alloy_plate: 2 } });
    expect(c.machine('fabricator')?.job?.id).toBe(1);
    expect(c.machine('refiner')?.on).toBe(false);
    expect([...c.recycleUids()]).toEqual([3, 4]);
    expect(c.jobFor(9)?.m.kind).toBe('fabricator');
    expect(c.jobFor(8)).toBeUndefined();
    // (a newer message replaces the copy, and the recycling set with it)
    c.applyState({ type: 'fieldState', tick: 9, machines: [], recycle: [7] });
    expect(c.machine('fabricator')).toBeUndefined();
    expect([...c.recycleUids()]).toEqual([7]);
    const name = (id: string) => (id === 'part_pip' ? 'Pip' : id);
    expect(c.applyDone({ type: 'fieldDone', kind: 'fabricator', job: 1, item: 'part_pip', to: 'ship', uid: 9 }, name)).toBe('Pip built');
    expect(c.applyDone({ type: 'fieldDone', kind: 'fabricator', job: 2, item: 'part_pip', to: 'cargo' }, name)).toContain('hold');
    expect(c.applyDone({ type: 'fieldDone', kind: 'fabricator', job: 3, item: 'part_pip', to: 'machine' }, name)).toContain('waiting');
    expect(c.lastDone?.job).toBe(3);
    c.reset();
    expect(c.state).toBeNull();
  });

  it('handles the messages in the game', () => {
    expect(HANDLERS.fieldState).toBeTypeOf('function');
    expect(HANDLERS.fieldDone).toBeTypeOf('function');
    expect((HANDLERS as Record<string, unknown>).repairKit).toBeUndefined();
  });

  it('a powered job progresses with the predicted machEu, and not with the tick', () => {
    const m = machine({ job: job(), at: 40 });
    // Sent at machEu 40: 100 needed
    expect(machineProgress(m, { charge: chargeWith(40), tick: 0 })).toBe(0);
    expect(machineProgress(m, { charge: chargeWith(65), tick: 9999 })).toBeCloseTo(0.25);
    expect(machineProgress(m, { charge: chargeWith(140), tick: 0 })).toBe(1);
    expect(machineClock(m, { charge: chargeWith(65), tick: 3 })).toBe(65);
    // It is the same arithmetic the server steps: jobAt over the machEu it got
    expect(machineJob(m, { charge: chargeWith(65), tick: 0 })).toEqual(jobAt(m.job!, 40, 65));
    // The refiner reads its own counter
    const r = machine({ kind: 'refiner', job: job({ kind: 'refine', item: 'iron_plate', need: 50 }), at: 10 });
    expect(machineProgress(r, { charge: chargeWith(500, 35), tick: 0 })).toBeCloseTo(0.5);
    expect(MACHINE_FAB).toBe(1);
    expect(MACHINE_REF).toBe(2);
  });

  it('progress stalls on a power cut (the counter stops) and never runs backwards', () => {
    const m = machine({ job: job(), at: 40 });
    const a = machineProgress(m, { charge: chargeWith(60), tick: 0 });
    expect(machineProgress(m, { charge: chargeWith(60), tick: 100 })).toBe(a);
    // (a resync that put the counter behind the copy's reading)
    expect(machineProgress(m, { charge: chargeWith(10), tick: 0 })).toBe(0);
  });

  it('the core\'s job runs on the predicted tick, only while it is on and not stalled', () => {
    const m = machine({ tier: 0, uid: -1, job: job({ need: 600 }), at: 1000 });
    expect(machineProgress(m, { charge: chargeWith(0), tick: 1300 })).toBeCloseTo(0.5);
    expect(machineProgress({ ...m, on: false }, { charge: chargeWith(0), tick: 1300 })).toBe(0);
    expect(machineProgress({ ...m, blocked: 'cargo' }, { charge: chargeWith(0), tick: 1300 })).toBe(0);
  });

  it('build jobs run make then attach', () => {
    const m = machine({ job: job({ need: 60, attachNeed: 30 }), at: 0 });
    expect(machineProgress(m, { charge: chargeWith(60), tick: 0 })).toBeCloseTo(60 / 90);
    expect(machineJob(m, { charge: chargeWith(70), tick: 0 })?.phase).toBe('attach');
    expect(machineProgress(m, { charge: chargeWith(90), tick: 0 })).toBe(1);
  });
});

describe('HUD words', () => {
  it('has a plain line for each way a machine can be blocked', () => {
    const want: Record<MachineBlock, string> = {
      cargo: 'Output blocked: cargo full', materials: 'Short of materials', grade: 'Needs a better fabricator', idle: 'Idle',
    };
    for (const b of Object.keys(want) as MachineBlock[]) {
      expect(blockText(b)).toBe(want[b]);
      expect(machineStatus(machine({ blocked: b }), undefined, (i) => i)).toBe(want[b] === 'Idle' ? 'Idle' : want[b]);
    }
    expect(blockText('grade', 'refiner')).toBe('Needs a better refiner');
  });

  it('names the machine, its job and its switch', () => {
    const name = (i: string) => (i === 'part_pip' ? 'Pip' : i);
    expect(machineName(machine({ tier: 2 }))).toBe('Fabricator T2');
    expect(machineName(machine({ kind: 'refiner', tier: 0 }))).toBe('Core refiner');
    expect(jobText(job({ done: 45 }), name)).toBe('Building Pip 45%');
    expect(jobText(job({ phase: 'attach', need: 10, done: 10, attachNeed: 10, attachDone: 5 }), name)).toBe('Building Pip 75% (attaching)');
    expect(machineStatus(machine(), job({ kind: 'repair', done: 10 }), name)).toBe('Repairing Pip 10%');
    expect(machineStatus(machine({ on: false }), undefined, name)).toBe('Off');
    expect(machineStatus(machine({ on: false }), job({ done: 10 }), name)).toBe('Off · Building Pip 10%');
    // On with nothing to do and no reason given
    expect(machineStatus(machine(), undefined, name)).toBe('Idle');
    // A stall wins over the job it is holding
    expect(machineStatus(machine({ blocked: 'cargo' }), job(), name)).toBe('Output blocked: cargo full');
  });

  it('sends the pickers\' choices as machine messages', () => {
    expect(pickMessage('fabricator', 'prefer')).toEqual({ type: 'machine', kind: 'fabricator', packs: 'prefer' });
    expect(pickMessage('refiner', '')).toEqual({ type: 'machine', kind: 'refiner', recipe: null });
    expect(pickMessage('refiner', 'iron_plate')).toEqual({ type: 'machine', kind: 'refiner', recipe: 'iron_plate' });
  });

  it('lists what the plan is short of, briefly', () => {
    const n = (i: string) => i.replace('_', ' ');
    expect(shortLine(undefined, n)).toBe('');
    expect(shortLine({ alloy_plate: 4, copper_wire: 2 }, n)).toBe('Needs: 4 alloy plate, 2 copper wire');
    expect(shortLine({ a: 1, b: 1, c: 1, d: 1, e: 1 }, n)).toBe('Needs: 1 a, 1 b, 1 c, 1 d and 1 more');
  });
});

describe('build overlay plan', () => {
  /** A cell beside the ship where a hull square can go */
  function freeSpot(d: ReturnType<typeof openDraft>) {
    const hand = { piece: 'sq', fn: 'hull', material: 'alloy', rot: 0 as const, flip: false, facing: 'auto' as const };
    for (let y = -6; y <= 6; y++) for (let x = -6; x <= 6; x++) {
      const p = candidate(catalog, d, hand, [x + 0.5, y + 0.5]);
      if (p && !placementProblem(catalog, d, p, tuning)) return p;
    }
    throw new Error('no free spot');
  }

  it('a new part is appended as a planned part and the target stays a valid design', () => {
    const live = sparrow();
    const d = openDraft(live, live.parts.map(() => false));
    expect(planDiff(d).changed).toBe(false);
    const p = freeSpot(d);
    addPart(d, p);
    const diff = planDiff(d);
    expect(diff.added.map((q) => q.uid)).toEqual([p.uid]);
    expect(diff.recycle).toEqual([]);
    const target = planTarget(d);
    // The standing parts keep their order and uids, the new one is last
    expect(target.parts.slice(0, live.parts.length)).toEqual(live.parts);
    expect(target.parts[target.parts.length - 1]).toEqual(p);
    expect(validateBlueprint(catalog, target, tuning, null, { mounting: false }).errors).toEqual([]);
    expect(targetErrors(catalog, tuning, d)).toEqual([]);
    expect(planChanged(d, new Set())).toBe(true);
  });

  it('refuses a part that would wall in a gun', () => {
    const live = sparrow();
    const d = openDraft(live, undefined);
    const gun = live.parts.find((q) => q.facing === 'N' && q.fn.startsWith('cannon'))!;
    expect(gun).toBeTruthy();
    const hand = { piece: 'sq', fn: 'hull', material: 'alloy', rot: 0 as const, flip: false, facing: 'auto' as const };
    const front = candidate(catalog, d, hand, [gun.x + 0.5, gun.y - 0.5])!;
    expect(placementProblem(catalog, d, front)).toBeNull();
    expect(placementProblem(catalog, d, front, tuning)).toMatch(/free|blocked/);
  });

  it('refuses a part that overlaps or joins nothing', () => {
    const live = sparrow();
    const d = openDraft(live, undefined);
    const core = live.parts.find((q) => q.fn === 'core')!;
    const over = candidate(catalog, d, { piece: 'sq', fn: 'hull', material: 'alloy', rot: 0, flip: false, facing: 'auto' }, [core.x + 0.5, core.y + 0.5])!;
    expect(placementProblem(catalog, d, over)).toBe('overlaps another part');
    const far = candidate(catalog, d, { piece: 'sq', fn: 'hull', material: 'alloy', rot: 0, flip: false, facing: 'auto' }, [40.5, 40.5])!;
    expect(placementProblem(catalog, d, far)).toBe("doesn't join anything");
  });

  it('taking out a standing part marks it for recycling, and what it cuts off goes with it', () => {
    const live = sparrow();
    const d = openDraft(live, undefined);
    const geoms = live.parts.map((q) => ({ q }));
    expect(geoms.length).toBeGreaterThan(2);
    const core = live.parts.findIndex((q) => q.fn === 'core');
    // The core stays
    expect(removePart(catalog, d, core).kind).toBe('none');
    // Take out each part in turn: the target is always a valid design, with the core
    for (let i = 0; i < live.parts.length; i++) {
      if (i === core) continue;
      const e = openDraft(live, undefined);
      const r = removePart(catalog, e, i);
      expect(r.kind).toBe('marked');
      expect(e.marked.has(live.parts[i].uid)).toBe(true);
      const diff = planDiff(e);
      expect(diff.recycle.sort()).toEqual([...e.marked].sort());
      expect(diff.added).toEqual([]);
      const target = planTarget(e);
      expect(target.parts.some((q) => q.fn === 'core')).toBe(true);
      expect(target.parts.length).toBe(live.parts.length - e.marked.size);
      expect(validateBlueprint(catalog, target, tuning, null, { mounting: false }).errors, `without #${live.parts[i].uid}`).toEqual([]);
      // Again: kept
      expect(removePart(catalog, e, i).kind).toBe('unmarked');
      expect(e.marked.has(live.parts[i].uid)).toBe(false);
    }
  });

  it('taking out a planned part drops it, and one placed this session just goes', () => {
    const live = sparrow();
    const ghost = live.parts.map((_, i) => i === live.parts.length - 1);
    const d = openDraft(live, ghost);
    const last = d.bp.parts.length - 1;
    const r = removePart(catalog, d, last);
    expect(r.kind).toBe('dropped');
    expect(planDiff(d).dropped).toEqual([live.parts[last].uid]);
    expect(planDiff(d).recycle).toEqual([]);
    expect(d.bp.parts.length).toBe(last);
    // A part placed and then taken out again leaves no trace
    const e = openDraft(live, undefined);
    const p = freeSpot(e);
    addPart(e, p);
    expect(removePart(catalog, e, e.bp.parts.length - 1).kind).toBe('dropped');
    expect(planDiff(e).changed).toBe(false);
  });

  it('a part can go where a part marked for recycling stands, and the server\'s queue opens marked', () => {
    const live = sparrow();
    const leaf = live.parts.findIndex((q, i) => q.fn !== 'core' && removePart(catalog, openDraft(live, undefined), i).kind === 'marked' && planDiff((() => { const e = openDraft(live, undefined); removePart(catalog, e, i); return e; })()).recycle.length === 1);
    expect(leaf).toBeGreaterThanOrEqual(0);
    const d = openDraft(live, undefined, [live.parts[leaf].uid, 999]);
    // (an unknown uid in the queue is ignored)
    expect([...d.marked]).toEqual([live.parts[leaf].uid]);
    expect(planChanged(d, new Set([live.parts[leaf].uid]))).toBe(false);
    expect(planChanged(d, new Set())).toBe(true);
    const g = partAtPoint(catalog, d, [live.parts[leaf].x + 0.5, live.parts[leaf].y + 0.5]);
    expect(g).toBeGreaterThanOrEqual(0);
    expect(partItemId(d.bp.parts[g])).toBeTypeOf('string');
  });
});
