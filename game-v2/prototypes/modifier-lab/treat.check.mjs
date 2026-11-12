// Checks for treat.js on the real ports model: node treat.check.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PM = require('./ports-model.js'), MLT = require('./treat.js');
let uid = 1, fails = 0;
const R = (type, x, y, rot, flip) => ({ uid: uid++, type, rot: rot || 0, flip: !!flip, cells: PM.rectCells(type, x, y, rot || 0) });
function run(parts, secs, tune) {
  const tn = Object.assign({}, MLT.TUNE, tune), L = PM.build(parts, 16, 12);
  MLT.clear(parts); MLT.link(L, tn);
  for (let i = 0; i < secs * 60; i++) { MLT.before(L); PM.tick(L, { fire: true, thrust: false, boost: false, util: true }, i); MLT.after(L, tn); }
  return { L, tn, gun: (n) => L.weapons[n], lv: (n) => MLT.strengths(L.weapons[n]) };
}
function ok(name, cond, detail) { if (!cond) fails++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); }
const near = (v, want) => Math.abs((v || 0) - want) < 0.06;
const sh = (w) => JSON.stringify(Object.fromEntries(Object.entries(w.share || {}).map(([k, v]) => [k, +v.toFixed(2)])));

{ // A Pip on a reactor through a Mount with a Coil in its socket: everything it takes is treated
  const r = run([R('cell_reactor', 7, 6), R('mount1', 7, 5), R('mod_coil', 8, 5), R('pip', 7, 4)], 20);
  ok('pip + mount + coil is full velocity', r.lv(0).velocity > 0.97, sh(r.gun(0)) + ` rate ${r.gun(0).rate.toFixed(2)}`);
}
{ // The socket is on one side only: a Coil on the other side does nothing until the mount is flipped
  const a = run([R('cell_reactor', 7, 6), R('mount1', 7, 5), R('mod_coil', 6, 5), R('pip', 7, 4)], 8);
  ok('a coil on the blank side does nothing', !a.lv(0).velocity && a.L.blocks[0].host === null, sh(a.gun(0)));
  const b = run([R('cell_reactor', 7, 6), R('mount1', 7, 5, 0, true), R('mod_coil', 6, 5), R('pip', 7, 4)], 20);
  ok('a flipped mount takes it on the other side', b.lv(0).velocity > 0.97, sh(b.gun(0)));
}
{ // One Mount shared by two Pips through a Splitter: about half each
  const r = run([R('cell_reactor', 7, 8), R('cell_reactor', 8, 8), R('joiner', 7, 7), R('mount1', 7, 6), R('mod_coil', 8, 6), R('splitter', 7, 5), R('pip', 7, 4), R('pip', 8, 4)], 90);
  ok('a shared mount gives each pip about half', near(r.lv(0).velocity, 0.6) && near(r.lv(1).velocity, 0.6), sh(r.gun(0)) + sh(r.gun(1)));
}
{ // Stacked mounts add up, and a Double mount gets more from the same two Coils
  const a = run([R('cell_reactor', 7, 8), R('mount1', 7, 7), R('mod_coil', 8, 7), R('mount1', 7, 6), R('mod_coil', 8, 6), R('pip', 7, 5)], 2);
  const b = run([R('cell_reactor', 7, 8), R('mount2', 7, 6), R('mod_coil', 8, 6), R('mod_coil', 8, 7), R('pip', 7, 5)], 2);
  const sum = (r) => r.L.mounts.reduce((s, m) => s + m.treat, 0);
  ok('two stacked mounts treat 48, a double 60', sum(a) === 48 && sum(b) === 60, `${sum(a)} ${sum(b)}`);
  const c = run([R('cell_reactor', 7, 9), R('cell_reactor', 8, 9), R('joiner', 7, 8), R('mount1', 7, 7), R('mod_coil', 8, 7), R('mount1', 7, 6), R('mod_coil', 8, 6), R('splitter', 7, 5), R('pip', 7, 4), R('pip', 8, 4)], 90);
  ok('two stacked mounts carry two pips to full velocity', c.lv(0).velocity > 0.97 && c.lv(1).velocity > 0.97, sh(c.gun(0)) + sh(c.gun(1)));
}
{ // A mount takes one kind: the first socket decides, another kind beside it does nothing
  const r = run([R('cell_reactor', 7, 8), R('mount2', 7, 6), R('mod_coil', 8, 6), R('mod_chamber', 8, 7), R('pip', 7, 5)], 20);
  const m = r.L.mounts[0];
  ok('a mixed double mount uses only its first kind', m.comp === 'coil' && m.n === 1 && m.treat === 30 && r.L.blocks.filter((b) => b.bad).length === 1 && !r.lv(0).explosive, sh(r.gun(0)));
}
{ // Recipes: a Double mount holding a Coil and a Prism gives Pierce, an effect of its own, and gives up the singles
  const r = run([R('cell_reactor', 7, 8), R('mount2', 7, 6), R('mod_coil', 8, 6), R('mod_prism', 8, 7), R('pip', 7, 5)], 20);
  ok('coil + prism in a double mount fuse to pierce only', r.lv(0).pierce > 0.97 && !r.lv(0).velocity && !r.lv(0).split && r.L.mounts[0].treat === 60, sh(r.gun(0)));
  const s1 = run([R('cell_reactor', 7, 7), R('mount1', 7, 6), R('mod_coil', 8, 6), R('mount1', 7, 5), R('mod_prism', 8, 5), R('pip', 7, 4)], 20);
  ok('single mounts never fuse', !s1.lv(0).pierce && s1.lv(0).velocity > 0.97 && s1.lv(0).split > 0.97, sh(s1.gun(0)));
  const t3 = run([R('cell_reactor', 7, 9), R('mount3', 7, 6), R('mod_coil', 8, 6), R('mod_coil', 8, 7), R('mod_prism', 8, 8), R('pip', 7, 5)], 20);
  ok('a triple mount fuses two coils and a prism at its full amount', t3.L.mounts[0].fused && t3.L.mounts[0].treat === 120 && t3.lv(0).pierce > 0.97, sh(t3.gun(0)));
  const w = run([R('cell_reactor', 7, 8), R('mount2', 7, 6), R('mod_chamber', 8, 6), R('mod_resonator', 8, 7), R('pip', 7, 5)], 20);
  ok('chamber + resonator in a double mount fuse to wave only', w.lv(0).wave > 0.97 && !w.lv(0).explosive && !w.lv(0).rapid, sh(w.gun(0)));
  ok('every recipe has a property and a shape', MLT.RECIPES.every((q) => MLT.PROPS[q.prop] && q.parts.every((k) => MLT.COMPS[k])));
}
{ // A conduit between them keeps them single
  const r = run([R('cell_reactor', 7, 8), R('mount1', 7, 7), R('mod_coil', 8, 7), R('conduit', 7, 6), R('mount1', 7, 5), R('mod_prism', 8, 5), R('pip', 7, 4)], 20);
  ok('a conduit between keeps them single', r.lv(0).velocity > 0.97 && r.lv(0).split > 0.97 && !r.lv(0).pierce, sh(r.gun(0)));
}
{ // Any mount carries a Hammer's line; stacked singles treat less of it than a Double mount
  const a = run([R('cell_reactor', 7, 8), R('cell_reactor', 8, 8), R('joiner', 7, 7), R('mount1', 7, 6), R('mod_resonator', 8, 6), R('mount1', 7, 5), R('mod_resonator', 8, 5), R('hammer', 7, 4)], 20);
  ok('stacked single mounts under a hammer treat about 83% of it', a.gun(0).rate > 0.5 && near(a.lv(0).rapid, 0.83), sh(a.gun(0)) + ` rate ${a.gun(0).rate.toFixed(2)}`);
  const b = run([R('cell_reactor', 7, 8), R('cell_reactor', 8, 8), R('joiner', 7, 7), R('mount2', 7, 5), R('mod_resonator', 8, 5), R('mod_resonator', 8, 6), R('hammer', 7, 4)], 20);
  ok('a double mount under a hammer is full rapid', b.gun(0).rate > 0.5 && b.lv(0).rapid > 0.97, sh(b.gun(0)) + ` rate ${b.gun(0).rate.toFixed(2)}`);
}
{ // Batteries and capacitors do not carry treatment: the mount goes after them
  const a = run([R('cell_reactor', 7, 8), R('mount1', 7, 7), R('mod_chamber', 8, 7), R('cell_battery', 7, 6), R('pip', 7, 5)], 30);
  ok('a mount before a battery reaches no gun', !a.lv(0).explosive && a.L.mods[0].jobs[0].reach.length === 0, sh(a.gun(0)));
  const b = run([R('cell_reactor', 7, 8), R('cell_battery', 7, 7), R('mount1', 7, 6), R('mod_chamber', 8, 6), R('pip', 7, 5)], 30);
  ok('a mount after a battery is full', b.lv(0).explosive > 0.97, sh(b.gun(0)));
  const c = run([R('cell_reactor', 7, 8), R('capacitor', 7, 7), R('mount1', 7, 6), R('mod_chamber', 8, 6), R('pip', 7, 5)], 30);
  ok('a mount after a capacitor is full', c.lv(0).explosive > 0.97, sh(c.gun(0)));
}
{ // By the end load: spare supply does not thin the effect
  const r = run([R('cell_reactor', 7, 8), R('cell_reactor', 8, 8), R('joiner', 7, 7), R('mount1', 7, 6), R('mod_coil', 8, 6), R('pip', 7, 5)], 30);
  ok('more supply than the gun uses changes nothing', r.lv(0).velocity > 0.97, sh(r.gun(0)) + ` load ${r.gun(0).load.toFixed(1)}`);
  ok('a mount never treats more than it can', r.L.mods.every((m) => m.jobs.every((j) => j.now <= j.treat + 1e-6)));
}
{ // Line tiers: a basic conduit carries two effects, a Conduit II three
  const line = (last) => [R('cell_reactor', 7, 10), R('mount1', 7, 9), R('mod_coil', 8, 9), R('conduit', 7, 8), R('mount1', 7, 7), R('mod_chamber', 8, 7), R('conduit', 7, 6), R('mount1', 7, 5), R('mod_prism', 8, 5), R(last, 7, 4), R('pip', 7, 3)];
  const a = run(line('conduit'), 30), b = run(line('conduit_t2'), 30);
  ok('a basic conduit drops the third effect', a.lv(0).velocity > 0.97 && a.lv(0).explosive > 0.97 && !a.lv(0).split, sh(a.gun(0)));
  ok('a Conduit II carries all three', b.lv(0).velocity > 0.97 && b.lv(0).explosive > 0.97 && b.lv(0).split > 0.97, sh(b.gun(0)));
  const c = run([R('cell_reactor', 7, 10), R('mount1', 7, 9), R('mod_coil', 8, 9), R('mount1', 7, 8), R('mod_chamber', 8, 8), R('mount1', 7, 7), R('mod_prism', 8, 7), R('pip', 7, 6)], 30);
  ok('stacked mounts with no conduit after carry all three', c.lv(0).split > 0.97 && c.lv(0).velocity > 0.97, sh(c.gun(0)));
  const lines = MLT.TUNE.lines.slice(); lines[1] = { fx: 2, cap: 10 };
  const d = run([R('cell_reactor', 7, 8), R('mount1', 7, 7), R('mod_coil', 8, 7), R('conduit', 7, 6), R('pip', 7, 5)], 30, { lines });
  ok('over its amount a line part cuts the effect to fit', near(d.lv(0).velocity, 0.5), sh(d.gun(0)));
}
{ // Shares stay within the whole
  const r = run([R('cell_reactor', 7, 9), R('mount2', 7, 7), R('mod_coil', 8, 7), R('mod_coil', 8, 8), R('mount1', 7, 6), R('mod_coil', 8, 6), R('conduit', 7, 5), R('pip', 7, 4)], 6);
  ok('a share never exceeds the whole', r.L.weapons.every((w) => Object.values(w.share).every((v) => v <= 1 + 1e-9)));
  const sp = MLT.spec('pip', r.lv(0), 1, r.tn);
  ok('spec is finite', Number.isFinite(sp.dps) && sp.speed > 420, `dps ${sp.dps.toFixed(1)} of ${sp.baseDps.toFixed(1)}`);
}
{ // A special modifier works only while its own input is fed
  const arc = (hop) => [R('cell_reactor', 7, 6), R('mount1', 7, 5), R('mod_arc', 8, 5), ...(hop ? [R(hop, 9, 5)] : []), R('pip', 7, 4)];
  const a = run(arc('hopper_arcsalt'), 20), tank = a.L.tanks[0];
  ok('an arc cell with a hopper is full chain', a.lv(0).chain > 0.97 && !a.L.blocks[0].dry, sh(a.gun(0)));
  ok('it uses the hopper', tank.fill < 60 - 10 && tank.fill > 60 - 30, `fill ${tank.fill.toFixed(1)}`);
  const b = run(arc(null), 10);
  ok('without a hopper it is dry and does nothing', !b.lv(0).chain && b.L.blocks[0].dry && b.gun(0).rate > 0.5, sh(b.gun(0)));
  const c = run(arc('hopper_pyre'), 10);
  ok('a hopper of something else leaves it dry', !c.lv(0).chain && c.L.blocks[0].dry && c.L.tanks[0].fill === 60, sh(c.gun(0)));
  const d = run(arc('hopper_arcsalt'), 90);
  ok('when the hopper runs out the effect stops', d.L.tanks[0].fill < 0.01 && !d.lv(0).chain && d.L.blocks[0].dry, sh(d.gun(0)) + ` fill ${d.L.tanks[0].fill.toFixed(2)}`);
}
{ // Two condensers in a double mount, one hopper between them only on one: half the treatment
  const base = () => [R('cell_reactor', 7, 8), R('cell_reactor', 8, 8), R('joiner', 7, 7), R('mount2', 7, 5), R('mod_condenser', 8, 5), R('mod_condenser', 8, 6), R('hammer', 7, 4)];
  const a = run([...base(), R('hopper_cryo', 9, 5), R('hopper_cryo', 9, 6)], 20), b = run([...base(), R('hopper_cryo', 9, 5)], 20);
  ok('two fed condensers treat a hammer', a.lv(0).heavy > 0.9 && a.L.mounts[0].ready === 2, sh(a.gun(0)));
  ok('one fed condenser of two treats half', b.L.mounts[0].ready === 1 && b.lv(0).heavy > 0.4 && b.lv(0).heavy < a.lv(0).heavy, sh(b.gun(0)));
}
{ // The Rail driver needs a power line of its own
  const rail = (fed) => [R('cell_reactor', 7, 6), R('mount1', 7, 5), R('mod_rail', 8, 5), ...(fed ? [R('cell_reactor', 9, 5, 3)] : []), R('pip', 7, 4)];
  const a = run(rail(true), 20), b = run(rail(false), 10);
  ok('a powered rail driver is full hyper', a.lv(0).hyper > 0.97, sh(a.gun(0)));
  ok('an unpowered one is dry', !b.lv(0).hyper && b.L.blocks[0].dry && b.gun(0).rate > 0.5, sh(b.gun(0)));
  const sp = MLT.spec('pip', a.lv(0), 1, a.tn), pl = MLT.spec('pip', {}, 1, a.tn);
  ok('hyper is faster and weaker', sp.speed > pl.speed * 3 && sp.damage < pl.damage, `speed ${sp.speed} of ${pl.speed}, damage ${sp.damage.toFixed(2)} of ${pl.damage.toFixed(2)}`);
}
{ // A special mixes with a basic one, and the basic one needs nothing
  const r = run([R('cell_reactor', 7, 8), R('mount1', 7, 7), R('mod_coil', 8, 7), R('conduit', 7, 6), R('mount1', 7, 5), R('mod_brand', 8, 5), R('pip', 7, 4)], 20);
  ok('a dry brander leaves the coil working', r.lv(0).velocity > 0.97 && !r.lv(0).burn, sh(r.gun(0)));
}
{ // No levels: every effect runs straight from plain to its full strength with the treated share
  const tn = MLT.TUNE, at = (st) => MLT.spec('pip', st, 1, tn), pl = at({});
  const half = at({ velocity: 0.5 }), full = at({ velocity: 1 });
  ok('half velocity is halfway to full', Math.abs(half.speed - (pl.speed + full.speed) / 2) < 1e-6 && Math.abs(half.range - (pl.range + full.range) / 2) < 1e-6, `${pl.speed} ${half.speed} ${full.speed}`);
  const a = at({ heavy: 0.3 }), b = at({ heavy: 0.31 });
  ok('a little more treated is a little more effect', b.damage > a.damage && b.damage - a.damage < 0.01 * pl.damage, `${a.damage.toFixed(3)} ${b.damage.toFixed(3)}`);
  const sp = at({ split: 0.4 }), sum = sp.shotDmg.reduce((x, y) => x + y, 0);
  ok('split shots add up to the whole', Math.abs(sum - sp.damage * sp.splitTotal) < 1e-9 && sp.shotDmg[1] > sp.shotDmg[0], sp.shotDmg.map((v) => v.toFixed(1)).join(' / '));
  const tiny = at({ chain: 0.02, bounce: 0.02, explosive: 0.02, pierce: 0.02, wave: 0.02, burn: 0.02, rapid: 0.02, hyper: 0.02 });
  ok('a trace of everything is close to plain', Math.abs(tiny.dps / pl.dps - 1) < 0.05 && tiny.fracs[0] > 0.97, `dps ${tiny.dps.toFixed(2)} of ${pl.dps.toFixed(2)}`);
}
console.log(fails ?`${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
