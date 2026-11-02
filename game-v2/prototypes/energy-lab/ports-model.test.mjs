// node --test prototypes/energy-lab/ports-model.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PM = require('./ports-model.js');
const EXAMPLES = require('./ports-examples.js');

const GW = 16, GH = 12;
let uid = 1;
function place(list) {
  return list.map(([type, x, y, rot, flip]) => ({ uid: uid++, type, rot: rot || 0, flip: !!flip, cells: PM.rectCells(type, x, y, rot || 0) }));
}
function run(parts, ctrl, ticks, L = PM.build(parts, GW, GH)) {
  let F = null;
  for (let i = 0; i < ticks; i++) F = PM.tick(L, ctrl, i);
  return { L, F };
}
const FIRE = { fire: true, thrust: false, util: true }, ALL = { fire: true, thrust: true, util: true };
const byType = (L, type) => L.alive.filter((p) => p.type === type);

test('ports turn with the part', () => {
  const [r1] = place([['cell_reactor', 3, 3, 1]]);
  assert.deepEqual(PM.portsOf(r1).map((p) => [p.dir, p.side, p.nx, p.ny]), [['out', 'E', 4, 3]]);
  const [c] = place([['corner', 3, 3, 2, true]]); // in S, out E; flipped: out W; turned twice: in N, out E
  assert.deepEqual(PM.portsOf(c).map((p) => [p.dir, p.side]).sort(), [['in', 'N'], ['out', 'E']]);
  const [f] = place([['fusion', 4, 4, 1]]); // out N[0], N[1] → the E column, cells (5,4) and (5,5)
  assert.deepEqual(PM.portsOf(f).map((p) => [p.side, p.x, p.y]).sort(), [['E', 5, 4], ['E', 5, 5]]);
  const [f3] = place([['fusion', 10, 4, 3]]); // → the W column
  assert.deepEqual(PM.portsOf(f3).map((p) => [p.side, p.x, p.y]).sort(), [['W', 10, 4], ['W', 10, 5]]);
  const [j] = place([['joiner', 6, 6, 0, true]]); // out N[0] flipped → the right cell
  assert.deepEqual(PM.portsOf(j).filter((p) => p.dir === 'out').map((p) => [p.x, p.y]), [[7, 6]]);
});

test('every example links up with no clashes, and its guns are fed', () => {
  for (const ex of EXAMPLES) {
    const L = PM.build(place(ex.parts), GW, GH);
    assert.equal(L.clashes.length, 0, ex.name + ': clashes');
    for (const w of L.weapons) assert.ok(w.links.length > 0, `${ex.name}: ${w.type} has no feed`);
    for (const e of L.engines) assert.ok(e.links.length > 0, `${ex.name}: ${e.type} has no feed`);
  }
});

test('1: the core limits the starter to 60 in', () => {
  const { L, F } = run(place(EXAMPLES[0].parts), ALL, 60 * 40);
  const pips = byType(L, 'pip');
  assert.ok(F.made === 60);
  assert.ok(pips.every((p) => p.rate > 0.8 && p.rate <= 1.02), 'pips near full: ' + pips.map((p) => p.rate.toFixed(2)));
  assert.ok(F.weapons + F.engines <= 60.5, 'nothing over the core’s in ports');
});

test('2: a Hammer on a Joiner Bank fires at full rate on two reactors, half on one', () => {
  const parts = place(EXAMPLES[1].parts);
  const a = run(parts, FIRE, 60 * 40);
  const h = byType(a.L, 'hammer')[0];
  assert.ok(h.rate > 0.9, 'full on two: ' + h.rate.toFixed(2));
  const one = parts.filter((p) => !(p.type === 'cell_reactor' && p.cells[0][0] === 8 && p.cells[0][1] === 6));
  const b = run(one, FIRE, 60 * 90);
  const h2 = byType(b.L, 'hammer')[0];
  assert.ok(h2.rate > 0.35 && h2.rate < 0.6, 'about half on one: ' + h2.rate.toFixed(2));
});

test('3: the Joiner wastes 40 of the plant; Glints run full', () => {
  const { L, F } = run(place(EXAMPLES[2].parts), FIRE, 60 * 40);
  const fusion = byType(L, 'fusion')[0];
  assert.ok(Math.abs(fusion.emaWaste - 40) < 2, 'waste ' + fusion.emaWaste.toFixed(1));
  assert.ok(byType(L, 'glint').every((g) => g.rate > 0.9));
});

test('4: capacitors give an alpha, then the reactors set the pace', () => {
  const parts = place(EXAMPLES[3].parts);
  const L = PM.build(parts, GW, GH);
  for (const s of L.stores) s.held = PM.T[s.type].hold; // charged
  const lb = byType(L, 'longbarrel'), onCaps = lb.find((p) => p.cells[0][0] === 4), direct = lb.find((p) => p.cells[0][0] === 10);
  let shotsCaps = 0, shotsDirect = 0;
  for (let i = 0; i < 60 * 8; i++) { PM.tick(L, FIRE, i); if (onCaps.flash > 0.09) shotsCaps++; if (direct.flash > 0.09) shotsDirect++; }
  assert.ok(shotsCaps > shotsDirect, `alpha: ${shotsCaps} vs ${shotsDirect} shots in 8 s`);
});

test('5: passive drain: the Spear fires slowly, the Lance never', () => {
  const { L } = run(place(EXAMPLES[4].parts), FIRE, 60 * 60);
  const spear = byType(L, 'spear')[0], lance = byType(L, 'lance')[0];
  assert.ok(spear.emaD > 5, 'spear fires: ' + spear.emaD.toFixed(1));
  assert.equal(lance.emaD, 0);
  assert.ok(lance.stored < 1, 'lance never charges: ' + lance.stored.toFixed(1));
});

test('6: the superweapon runs nearly all the time; two lines cut and it stutters; the array gone and it is out', () => {
  const parts = place(EXAMPLES[5].parts);
  const a = run(parts, FIRE, 60 * 60);
  const lance = byType(a.L, 'lance')[0];
  assert.ok(lance.rate > 0.9, 'lance duty ' + lance.rate.toFixed(2));
  const cut = parts.filter((p) => !(p.type === 'conduit' && p.cells[0][0] === 6));
  const b = run(cut, FIRE, 60 * 60);
  const r2 = byType(b.L, 'lance')[0].rate;
  assert.ok(r2 < 0.8 && r2 > 0.4, 'two lines cut: ' + r2.toFixed(2));
  const fresh = place(EXAMPLES[5].parts), L = PM.build(fresh, GW, GH);
  PM.destroy(L, byType(L, 'cap_array')[0]);
  const c = run(fresh, FIRE, 60 * 30, PM.build(fresh, GW, GH));
  assert.equal(byType(c.L, 'lance')[0].emaD, 0, 'no array, no lance');
});

test('7: engines on Drive Cells hold full thrust from charge', () => {
  const parts = place(EXAMPLES[6].parts);
  const L = PM.build(parts, GW, GH);
  for (const s of L.stores) s.held = PM.T[s.type].hold;
  let F; for (let i = 0; i < 60 * 10; i++) F = PM.tick(L, ALL, i);
  assert.ok(F.thrust > 4.4, 'full thrust ' + F.thrust.toFixed(2));
});

test('8: breaking one packed reactor takes the line with it', () => {
  const parts = place(EXAMPLES[7].parts);
  const L = PM.build(parts, GW, GH);
  const mid = byType(L, 'cell_reactor').find((p) => p.cells[0][0] === 7 && p.cells[0][1] === 5);
  const gone = PM.destroy(L, mid);
  assert.ok(gone.length >= 10, 'chain: ' + gone.length + ' parts');
  assert.ok(gone.some((g) => g.part.type === 'pip'));
});

test('a full Heavy Bank is a bomb; an empty one is harmless', () => {
  const [bank, hull] = place([['heavy_bank', 4, 4], ['hull', 6, 4]]);
  const L = PM.build([bank, hull], GW, GH);
  bank.held = 0; assert.equal(PM.blastOf(bank), null);
  bank.held = 1200; const b = PM.blastOf(bank); assert.ok(b.dmg === 720 && b.r === 4.5);
});

test('9: the Sunbreaker fires at full rate on six lines, slower on four, never on two', () => {
  const rateWith = (drop) => {
    // (Plants taken away, not blown up: a blast would cut more lines than the plant itself)
    let parts = place(EXAMPLES[8].parts);
    const plants = parts.filter((p) => p.type === 'fusion' && p.rot !== 0).slice(0, drop);
    parts = parts.filter((p) => !plants.includes(p));
    // (Damage over a minute after the first 20 s, against full rate: one shot every 6.7 s is too spiky for the smoothed rate)
    const L = PM.build(parts, GW, GH); let dealt = 0;
    for (let i = 0; i < 60 * 80; i++) { const F = PM.tick(L, FIRE, i); if (i >= 60 * 20) dealt += F.dps / 60; }
    return dealt / 60 / PM.fullDps(PM.T.sunbreaker);
  };
  const six = rateWith(0), four = rateWith(1), two = rateWith(2);
  assert.ok(six > 0.9, 'six lines ' + six.toFixed(2));
  assert.ok(four > 0.35 && four < 0.55, 'four lines ' + four.toFixed(2));
  assert.equal(two, 0, 'two lines: never');
});

test('a coarser step (1/20 s) gives the same steady rates', () => {
  for (const i of [1, 2, 5, 8]) {
    const fine = run(place(EXAMPLES[i].parts), FIRE, 60 * 40), L = PM.build(place(EXAMPLES[i].parts), GW, GH);
    let F; for (let k = 0; k < 20 * 40; k++) F = PM.tick(L, FIRE, k, 1 / 20);
    for (const w of L.weapons) {
      const f = fine.L.weapons.find((q) => q.type === w.type && q.cells[0][0] === w.cells[0][0]);
      assert.ok(Math.abs(w.rate - f.rate) < 0.12, `${EXAMPLES[i].name} ${w.type}: ${w.rate.toFixed(2)} vs ${f.rate.toFixed(2)}`);
    }
  }
});

test('9: breaking a flank plant blasts the conduits under the gun too, and it goes dark', () => {
  const parts = place(EXAMPLES[8].parts), L = PM.build(parts, GW, GH);
  const gone = PM.destroy(L, byType(L, 'fusion').find((p) => p.rot === 1));
  assert.ok(gone.some((g) => g.part.type === 'conduit'));
  const { L: L2 } = run(parts.filter((p) => !p.dead), FIRE, 60 * 30);
  assert.equal(byType(L2, 'sunbreaker')[0].emaD, 0);
});
