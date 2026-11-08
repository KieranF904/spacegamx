/**
 * The client half of field fabrication: the copy of the server's field state and the progress worked out from the
 * predicted machine clock, the build view's edits to the blueprint, and the HUD's words for each way a machine can be stuck.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Economy, MACHINE_FAB, MACHINE_REF, parseBlueprint, validateBlueprint, partItemId, jobAt } from '@space-game/common';
import type { Blueprint, Charge, FieldJob, MachineBlock, MachineView, ShipTuning } from '@space-game/common';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../../../../common/src/ships/testData';
import { HANDLERS } from '../../app/serverMessages';
import { FieldClient, machineClock, machineJob, machineProgress } from './fieldState';
import { blockText, jobText, machineName, machineStatus } from './fieldText';
import { pickMessage, refineChoices, shortLine } from './FieldHud';
import { addPart, candidate, hasEdits, noEdits, partAtPoint, placementProblem, planChanged, planTarget, removePart, settle, summary, targetErrors, working, type BuildEdits, type LiveDesign } from './plan';

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

describe('build view edits (the blueprint, missing parts and all)', () => {
  const hull = { piece: 'sq', fn: 'hull', material: 'alloy', rot: 0 as const, flip: false, facing: 'auto' as const };
  const liveOf = (bp: Blueprint, dead: number[] = [], queued: number[] = []): LiveDesign =>
    ({ bp, alive: bp.parts.map((p) => !dead.includes(p.uid)), queued: new Set(queued) });
  /** A cell beside the ship where a hull square can go */
  function freeSpot(live: LiveDesign, e: BuildEdits) {
    const w = working(live, e);
    for (let y = -6; y <= 6; y++) for (let x = -6; x <= 6; x++) {
      const p = candidate(catalog, live, w, hull, [x + 0.5, y + 0.5]);
      if (p && !placementProblem(catalog, w, p, tuning)) return p;
    }
    throw new Error('no free spot');
  }

  it('a new part is appended to the blueprint and the target stays a valid design', () => {
    const live = liveOf(sparrow());
    const e = noEdits();
    expect(planChanged(live, e)).toBe(false);
    const p = freeSpot(live, e);
    addPart(e, p);
    expect(summary(live, e)).toEqual({ added: 1, recycle: 0, dropped: 0 });
    const target = planTarget(working(live, e));
    // The live parts keep their order and uids, the new one is last
    expect(target.parts.slice(0, live.bp.parts.length)).toEqual(live.bp.parts);
    expect(target.parts[target.parts.length - 1]).toEqual(p);
    expect(validateBlueprint(catalog, target, tuning, null, { mounting: false }).errors).toEqual([]);
    expect(targetErrors(catalog, tuning, working(live, e))).toEqual([]);
    expect(planChanged(live, e)).toBe(true);
  });

  it('a part once saved falls out of the edits as the live ship shows it (no ghost left behind once built)', () => {
    const bp = sparrow();
    const e = noEdits();
    const p = freeSpot(liveOf(bp), e);
    addPart(e, p);
    // The server applied the save: the part is in the blueprint, missing
    const saved = { ...bp, parts: [...bp.parts, p] };
    const missing = liveOf(saved, [p.uid]);
    expect(settle(missing, e)).toBe(true);
    expect(hasEdits(e)).toBe(false);
    let w = working(missing, e);
    expect(w.standing[w.bp.parts.length - 1]).toBe(false);
    // Built: the same part, standing, from the live ship alone
    w = working(liveOf(saved), e);
    expect(w.standing[w.bp.parts.length - 1]).toBe(true);
  });

  it('refuses a part that would wall in a gun', () => {
    const live = liveOf(sparrow());
    const w = working(live, noEdits());
    const gun = live.bp.parts.find((q) => q.facing === 'N' && q.fn.startsWith('cannon'))!;
    expect(gun).toBeTruthy();
    const front = candidate(catalog, live, w, hull, [gun.x + 0.5, gun.y - 0.5])!;
    expect(placementProblem(catalog, w, front)).toBeNull();
    expect(placementProblem(catalog, w, front, tuning)).toMatch(/free|blocked/);
  });

  it('refuses a part that overlaps or joins nothing', () => {
    const live = liveOf(sparrow());
    const w = working(live, noEdits());
    const core = live.bp.parts.find((q) => q.fn === 'core')!;
    const over = candidate(catalog, live, w, hull, [core.x + 0.5, core.y + 0.5])!;
    expect(placementProblem(catalog, w, over)).toBe('overlaps another part');
    const far = candidate(catalog, live, w, hull, [40.5, 40.5])!;
    expect(placementProblem(catalog, w, far)).toBe("doesn't join anything");
  });

  it('taking out a standing part marks it for recycling, and what it cuts off goes with it', () => {
    const live = liveOf(sparrow());
    const parts = live.bp.parts;
    const core = parts.findIndex((q) => q.fn === 'core');
    // The core stays
    expect(removePart(catalog, live, noEdits(), core).kind).toBe('none');
    // Take out each part in turn: the target is always a valid design, with the core
    for (let i = 0; i < parts.length; i++) {
      if (i === core) continue;
      const e = noEdits();
      const r = removePart(catalog, live, e, i);
      expect(r.kind).toBe('marked');
      const w = working(live, e);
      expect(w.marked.has(parts[i].uid)).toBe(true);
      // (marked parts stay in the design, standing, until broken down)
      expect(w.bp.parts.length).toBe(parts.length);
      const target = planTarget(w);
      expect(target.parts.some((q) => q.fn === 'core')).toBe(true);
      expect(target.parts.length).toBe(parts.length - w.marked.size);
      expect(validateBlueprint(catalog, target, tuning, null, { mounting: false }).errors, `without #${parts[i].uid}`).toEqual([]);
      // Again: kept
      expect(removePart(catalog, live, e, i).kind).toBe('unmarked');
      expect(working(live, e).marked.has(parts[i].uid)).toBe(false);
    }
  });

  it('taking out a missing part (planned or shot off) drops it from the design; one placed this session just goes', () => {
    const bp = sparrow();
    const last = bp.parts.length - 1;
    const live = liveOf(bp, [bp.parts[last].uid]);
    const e = noEdits();
    expect(removePart(catalog, live, e, last).kind).toBe('dropped');
    expect([...e.dropped]).toEqual([bp.parts[last].uid]);
    expect(working(live, e).marked.size).toBe(0);
    expect(working(live, e).bp.parts.length).toBe(last);
    // A part placed and then taken out again leaves no trace
    const f = noEdits();
    const whole = liveOf(bp);
    addPart(f, freeSpot(whole, f));
    expect(removePart(catalog, whole, f, working(whole, f).bp.parts.length - 1).kind).toBe('dropped');
    expect(planChanged(whole, f)).toBe(false);
  });

  it("the server's queue opens marked; a part can't go where a part being recycled still stands", () => {
    const bp = sparrow();
    const leaf = bp.parts.findIndex((q, i) => { const e = noEdits(); return q.fn !== 'core' && removePart(catalog, liveOf(bp), e, i).kind === 'marked' && e.mark.size === 1; });
    expect(leaf).toBeGreaterThanOrEqual(0);
    const uid = bp.parts[leaf].uid;
    const live = liveOf(bp, [], [uid, 999]);
    const e = noEdits();
    // (an unknown uid in the queue is ignored)
    expect([...working(live, e).marked]).toEqual([uid]);
    expect(planChanged(live, e)).toBe(false);
    const w = working(live, e);
    const over = candidate(catalog, live, w, { ...hull }, [bp.parts[leaf].x + 0.5, bp.parts[leaf].y + 0.5])!;
    expect(placementProblem(catalog, w, over)).toMatch(/still being recycled/);
    // Kept after all: unmarked, and the save would take it off the queue
    expect(removePart(catalog, live, e, leaf).kind).toBe('unmarked');
    expect(planChanged(live, e)).toBe(true);
    expect(partItemId(working(live, e).bp.parts[partAtPoint(catalog, w, [bp.parts[leaf].x + 0.5, bp.parts[leaf].y + 0.5])])).toBeTypeOf('string');
  });
});

describe("the refiner's recipe picker", () => {
  const dataFile = (f: string) => JSON.parse(readFileSync(join(SHIP_DATA_DIR, '..', f), 'utf-8'));
  const econ = new Economy(dataFile('items.json'), dataFile('recipes.json'), catalog, {});

  it('lists only recipes this refiner tier can run and the pilot has opened', () => {
    const core = refineChoices(econ, 0, 99);
    expect(core).toContain('alloy_plate');
    expect(core).not.toContain('steel_plate');
    expect(refineChoices(econ, 1, 99)).toContain('steel_plate');
    expect(refineChoices(econ, 1, 99)).not.toContain('titanium_plate');
    expect(refineChoices(econ, 3, 99)).toContain('neutronium_plate');
    // A recipe the pilot's level hasn't opened is left out, whatever the tier
    const gated = [...econ.recipes.refining.values()].find((r) => (r.level ?? 0) > 1 && refineChoices(econ, 3, 99).includes(r.id));
    if (gated) {
      expect(refineChoices(econ, 3, 99)).toContain(gated.id);
      expect(refineChoices(econ, 3, (gated.level ?? 0) - 1)).not.toContain(gated.id);
    }
    for (const id of refineChoices(econ, 2, 99)) expect(econ.recipes.refining.has(id)).toBe(true);
  });
});
