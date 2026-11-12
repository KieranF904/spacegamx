// Checks the lab's rules against its example layouts. Run: node derive.check.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const CFG = require('./config.js');
const D = require('./derive.js');
const P = require('./presets.js');

const run = (rows, cfg = CFG) => D.derive(P.parse(rows), cfg);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} is not ${b}`);

// A Pip on a cell reactor: plain, fully powered
let o = run(['R1 Gp']);
near(o.guns[0].stats.dps, 18);
assert.deepEqual(o.guns[0].levels, {});

// Coil and Prism touching fuse into Pierce and give up their own effects; the shot's damage is moved, not added
o = run(['R1 C1 P1 Gp']);
assert.deepEqual(o.guns[0].levels, { pierce: 4 });
near(o.guns[0].stats.fracs.reduce((s, f) => s + f, 0), 1);
near(o.guns[0].stats.dps, 18);

// Apart, they give their two single properties
o = run(['R1 C1 -- P1 Gp']);
assert.deepEqual(o.guns[0].levels, { velocity: 4, split: 4 });

// One modifier, one gun: full effect. The same modifier over four guns: a quarter each
assert.equal(run(['R2 P1 Gp']).guns[0].levels.split, 4);
o = run(['.. .. Gp Gp', 'R2 P1 -- --', '.. .. Gp Gp']);
assert.equal(o.guns.length, 4);
for (const g of o.guns) { near(g.shares.split, 0.25); assert.equal(g.levels.split, 1); }

// The same tier 1 modifier does nothing for a Longbarrel; it takes a tier 3
assert.equal(run(['R2 P1 Gl']).guns[0].levels.split, 0);
assert.equal(run(['R2 P3 Gl']).guns[0].levels.split, 4);

// Rapid raises the draw and so thins its own share: a tier 1 resonator holds a Pip at level 2
o = run(['R1 N1 Gp']);
assert.equal(o.guns[0].levels.rapid, 2);
near(o.guns[0].wants, 4.2);

// A modifier on a stub off the line does nothing
o = run(['R1 -- Gp', '.. P1 ..']);
assert.deepEqual(o.guns[0].levels, {});
assert.deepEqual(o.mods[0].feeds, []);

// Three Pips on one cell reactor are throttled to what it supplies
o = run(['.. Gp ..', 'Gp R1 Gp']);
for (const g of o.guns) near(g.factor, 6 / 9);

// An unpowered gun does nothing
near(run(['Gp']).guns[0].stats.dps, 0);

// Every preset derives
for (const p of P.LIST) run(p.rows);

console.log('modifier lab rules: ok');
