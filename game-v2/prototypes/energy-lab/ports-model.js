// The ports model (docs/design/energy-ports-2026-11.md): parts with in and out ports on their edges, power crossing only
// out → in over a shared edge, a synchronous offer/accept tick, weapons with buffers and a passive drain, blasts.
// Plain script: ports.html uses it as window.PM; ports-model.test.mjs loads it in node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.PM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ================================================================ parts
  // Ports in the part's own frame, unrotated: N is the nose. [dir, side, cell, rate]: cell counts from the W end of a N or S
  // side and from the N end of a W or E side.
  const T = {}, ORDER = [];
  const CATS = ['Core and hull', 'Generators', 'Stores and conduits', 'Weapons', 'Engines and shields'];
  const COL = { core: '#e8e3d6', hull: '#4b5660', armor: '#6e7a84', gen: '#38bdf8', store: '#4ade80', cap: '#f5a83a', conduit: '#a7b4be',
    weapon: '#ef5f55', engine: '#3fb0e0', util: '#4fbfb2' };
  function def(o) {
    o.w = o.w || 1; o.h = o.h || 1; o.ports = (o.ports || []).map(([dir, side, cell, rate]) => ({ dir, side, cell: cell || 0, rate }));
    if (o.mass === undefined) o.mass = o.w * o.h;
    T[o.id] = o; ORDER.push(o.id); return o;
  }
  const I = (side, rate, cell) => ['in', side, cell || 0, rate], O = (side, rate, cell) => ['out', side, cell || 0, rate];

  def({ id: 'core', name: 'Core', cat: 0, kind: 'store', w: 2, hold: 240, hp: 150, mass: 2, col: COL.core, lvl: 0,
    ports: [I('W', 60), I('E', 60), O('N', 150, 0), O('N', 150, 1), O('S', 150, 0), O('S', 150, 1)],
    say: 'Power in from the sides, out fore and aft: the free hub every ship has.' });
  def({ id: 'hull', name: 'Hull', cat: 0, kind: 'inert', hp: 75, col: COL.hull, lvl: 0, say: 'Carries no power.' });
  def({ id: 'armor', name: 'Armour', cat: 0, kind: 'inert', hp: 187, mass: 2.5, col: COL.armor, lvl: 0, say: 'Carries no power. Tough.' });

  def({ id: 'cell_reactor', name: 'Cell Reactor', cat: 1, kind: 'gen', hp: 50, blast: { r: 2.5, dmg: 120 }, mass: 1.5, col: COL.gen, lvl: 0, ports: [O('N', 30)],
    say: 'The starter: one line of 30. Fragile, and it takes its neighbours with it.' });
  def({ id: 'twin_reactor', name: 'Twin Reactor', cat: 1, kind: 'gen', hp: 50, blast: { r: 2.5, dmg: 140 }, mass: 1.5, col: COL.gen, lvl: 6, isNew: true, ports: [O('N', 18), O('S', 18)],
    say: 'Two lines, fore and aft, of 18 each. One blast for two chains.' });
  def({ id: 'isotope', name: 'Isotope Pile', cat: 1, kind: 'gen', hp: 150, mass: 2, col: COL.gen, lvl: 9, ports: [O('N', 15)],
    say: 'Weak, tough, and it never explodes.' });
  def({ id: 'fusion', name: 'Fusion Plant', cat: 1, kind: 'gen', w: 2, h: 2, hp: 300, blast: { r: 3.5, dmg: 260 }, mass: 8, col: COL.gen, lvl: 18, ports: [O('N', 60, 0), O('N', 60, 1)],
    say: 'Two strong lines of 60. Heavy and tough; a big blast.' });
  def({ id: 'overclock', name: 'Overclock Reactor', cat: 1, kind: 'gen', w: 2, hp: 80, blast: { r: 4, dmg: 350 }, mass: 2.5, col: COL.gen, lvl: 24, ports: [O('N', 55, 0), O('N', 55, 1)],
    say: 'The most power a cell, in two lines of 55. Fragile; the biggest blast.' });
  def({ id: 'stellarator', name: 'Stellarator', cat: 1, kind: 'gen', w: 2, h: 2, hp: 400, blast: { r: 4.5, dmg: 400 }, mass: 10, col: COL.gen, lvl: 36, isNew: true,
    ports: [O('N', 60, 0), O('N', 60, 1), O('S', 60, 0), O('S', 60, 1)], say: 'Four lines of 60: the end-game plant.' });

  def({ id: 'conduit', name: 'Conduit', cat: 2, kind: 'store', conduit: true, hold: 10, hp: 35, mass: 0.3, col: COL.conduit, lvl: 0, ports: [I('S', 200), O('N', 200)],
    say: 'A one-way line: in at the back, out at the front.' });
  def({ id: 'corner', name: 'Conduit, corner', cat: 2, kind: 'store', conduit: true, hold: 10, hp: 35, mass: 0.3, col: COL.conduit, lvl: 0, ports: [I('S', 200), O('E', 200)],
    say: 'A one-way line that turns right. Flip it (T) to turn left.' });
  def({ id: 'cell_battery', name: 'Cell Battery', cat: 2, kind: 'store', hold: 200, hp: 45, col: COL.store, lvl: 0, ports: [I('S', 40), O('N', 60)],
    say: 'Smooths one line: takes 40, gives up to 60, holds 200.' });
  def({ id: 'joiner', name: 'Joiner Bank', cat: 2, kind: 'store', w: 2, hold: 300, hp: 90, col: COL.store, lvl: 3, isNew: true, ports: [I('S', 40, 0), I('S', 40, 1), O('N', 90, 0)],
    say: 'Two lines in at 40 each, one out at 90. The first thing a mid gun needs.' });
  def({ id: 'splitter', name: 'Splitter Bank', cat: 2, kind: 'store', w: 2, hold: 300, hp: 90, col: COL.store, lvl: 5, isNew: true, ports: [I('S', 80, 0), O('N', 45, 0), O('N', 45, 1)],
    say: 'One line in at 80, two out at 45 each: two guns on one plant port.' });
  def({ id: 'capacitor', name: 'Capacitor', cat: 2, kind: 'store', hold: 160, hp: 30, col: COL.cap, lvl: 7, ports: [I('S', 40), O('N', 400)],
    say: 'Pays a big shot at once (400 a second), then 4 seconds to refill at 40.' });
  def({ id: 'drive_cell', name: 'Drive Cell', cat: 2, kind: 'store', hold: 320, hp: 45, col: COL.cap, lvl: 10, ports: [I('S', 60), O('N', 250)],
    say: 'The Capacitor for engines: a burst of 250 a second, then 5 seconds to refill.' });
  def({ id: 'flux_coil', name: 'Flux Coil', cat: 2, kind: 'store', w: 2, hold: 160, hp: 70, col: COL.cap, lvl: 20, isNew: true, ports: [I('S', 150, 0), I('S', 150, 1), O('N', 300, 0)],
    say: 'Joins two plant lines (150 each) into one fast one (300).' });
  def({ id: 'heavy_bank', name: 'Heavy Bank', cat: 2, kind: 'store', w: 2, h: 2, hold: 1200, hp: 280, mass: 6.4, col: COL.store, lvl: 20, ports: [I('S', 70, 0), I('S', 70, 1), O('N', 150, 0)],
    say: 'Endurance: fills between fights, carries a gun through one. Full, it is a bomb.' });
  def({ id: 'cap_array', name: 'Capacitor Array', cat: 2, kind: 'store', w: 2, h: 2, hold: 600, hp: 150, mass: 5, col: COL.cap, lvl: 26, isNew: true,
    ports: [I('S', 60, 0), I('S', 60, 1), I('W', 60, 0), I('W', 60, 1), I('E', 60, 0), I('E', 60, 1), O('N', 600, 0), O('N', 600, 1)],
    say: 'Six lines in at 60, two huge lines out at 600: the last stage before a superweapon.' });

  // Weapons: shot guns fire when the buffer holds a shot and the cycle is done; beams burn from the buffer while lit.
  // passive leaves the buffer every second whether or not it fires: below it the gun never charges.
  const gun = (o) => def(Object.assign({ cat: 3, kind: 'weapon', col: COL.weapon, passive: 0, buffer: 1, mass: 1.2 }, o));
  gun({ id: 'pip', name: 'Pip', lvl: 0, hp: 60, ports: [I('S', 20)], shot: 10, cycle: 0.5, damage: 28 });
  gun({ id: 'glint', name: 'Glint', lvl: 9, hp: 60, ports: [I('S', 35)], shot: 28, cycle: 0.8, damage: 43 });
  gun({ id: 'hammer', name: 'Hammer', lvl: 6, w: 2, hp: 120, ports: [I('S', 70, 0)], shot: 70, cycle: 1.0, damage: 69 });
  gun({ id: 'cutter', name: 'Cutter', lvl: 18, w: 2, hp: 130, ports: [I('S', 45, 0), I('S', 45, 1)], beam: true, burn: 90, bufferE: 180, dps: 150, passive: 5 });
  gun({ id: 'longbarrel', name: 'Longbarrel', lvl: 20, w: 2, hp: 150, ports: [I('S', 55, 0), I('S', 55, 1)], shot: 220, cycle: 2.0, damage: 96 });
  gun({ id: 'spear', name: 'Spear', lvl: 28, w: 2, h: 2, hp: 240, ports: [I('S', 45, 0), I('S', 45, 1)], shot: 180, cycle: 2.0, buffer: 2, damage: 170, passive: 10 });
  gun({ id: 'bastion', name: 'Bastion', lvl: 30, w: 2, h: 2, hp: 300, ports: [I('S', 55, 0), I('S', 55, 1), I('W', 55, 1), I('E', 55, 1)], shot: 60, cycle: 0.25, buffer: 16, clip: true, damage: 28, passive: 15 });
  gun({ id: 'lance', name: 'Lance', lvl: 32, w: 2, hp: 200, ports: [I('S', 150, 0), I('S', 150, 1)], beam: true, burn: 300, bufferE: 600, dps: 210, passive: 40 });
  // The embedded superweapon: six lines of 60, from the back and both flanks, so the ship is built around it. Its passive
  // drain (150) means it needs three of the six alive to charge at all, and all six to fire at its full rate.
  gun({ id: 'sunbreaker', name: 'Sunbreaker', lvl: 34, w: 3, h: 3, hp: 600, mass: 12, armour: 2, isNew: true,
    ports: [I('S', 60, 0), I('S', 60, 2), I('W', 60, 1), I('W', 60, 2), I('E', 60, 1), I('E', 60, 2)], shot: 600, cycle: 3.0, damage: 900, passive: 150,
    say: 'Six lines in at 60, from the back and both flanks: the ship is built around it. It leaks 150 a second, so it needs three lines alive to charge at all.' });

  // Engines burn from a buffer that refills through their ports; empty, they run at intake ÷ burn. Shields draw a flat rate.
  def({ id: 'ion', name: 'Ion Drive', cat: 4, kind: 'engine', hp: 50, col: COL.engine, lvl: 0, ports: [I('N', 12)], burn: 9, buffer: 30, thrust: 2.26, say: 'Full thrust burns 9 a second from a 30 buffer that refills at 12.' });
  def({ id: 'plasma', name: 'Plasma Drive', cat: 4, kind: 'engine', w: 2, hp: 110, col: COL.engine, lvl: 16, ports: [I('N', 25, 0), I('N', 25, 1)], burn: 40, buffer: 120, thrust: 6.2, say: 'Full thrust burns 40 a second; two lines of 25 refill it.' });
  def({ id: 'deflector', name: 'Deflector', cat: 4, kind: 'util', hp: 56, col: COL.util, lvl: 11, ports: [I('S', 16)], e: 16, say: 'Draws 16 a second while shields are on.' });

  // Credits, armour (against the pen of what hits it) and a gun's pen (against the enemy's armour): first guesses, for the
  // evolver's budget and hit runs; the lab shows them but its tick doesn't use them
  const COST = { core: 0, hull: 9, armor: 18, cell_reactor: 35, twin_reactor: 60, isotope: 70, fusion: 500, overclock: 700, stellarator: 1400,
    conduit: 10, corner: 10, cell_battery: 40, joiner: 90, splitter: 90, capacitor: 60, drive_cell: 80, flux_coil: 300, heavy_bank: 400, cap_array: 600,
    pip: 21, glint: 100, hammer: 110, cutter: 170, longbarrel: 300, spear: 600, bastion: 900, lance: 1200, sunbreaker: 2500, ion: 21, plasma: 210, deflector: 140 };
  const ARMOUR = { armor: 2, isotope: 2, fusion: 2, heavy_bank: 2, stellarator: 2, spear: 2, bastion: 2 };
  const PEN = { pip: 1, glint: 1, hammer: 2, cutter: 2, longbarrel: 3, spear: 4, bastion: 3, lance: 4, sunbreaker: 5 };
  for (const id of ORDER) {
    const t = T[id];
    t.cost ??= COST[id] ?? 0; t.armour ??= ARMOUR[id] ?? 1; if (t.kind === 'weapon') t.pen ??= PEN[id] ?? 1;
    t.intake = t.ports.filter((p) => p.dir === 'in').reduce((s, p) => s + p.rate, 0);
    t.produce = t.ports.filter((p) => p.dir === 'out').reduce((s, p) => s + p.rate, 0);
    if (t.kind === 'weapon' && !t.beam) t.damage = t.damage || 1;
  }

  // ================================================================ geometry
  const SIDES = ['N', 'E', 'S', 'W'], SIDE_V = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] }, OPP = { N: 'S', S: 'N', E: 'W', W: 'E' };
  /** The part's footprint: top-left (x, y), rotated r quarter turns clockwise (odd turns swap width and height) */
  function dims(t, r) { return r % 2 ? [t.h, t.w] : [t.w, t.h]; }
  function rectCells(type, x, y, r) { const [w, h] = dims(T[type], r || 0), c = []; for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) c.push([x + dx, y + dy]); return c; }
  /** A local cell (lx, ly) of a w×h part, flipped (mirrored W↔E) then turned r quarter turns clockwise, to its offset in the placed footprint */
  function placeCell(lx, ly, w, h, r, flip) {
    if (flip) lx = w - 1 - lx;
    let x = lx, y = ly, W = w, H = h;
    for (let i = 0; i < (r || 0); i++) { [x, y] = [H - 1 - y, x]; [W, H] = [H, W]; }
    return [x, y];
  }
  function placeSide(side, r, flip) {
    if (flip && (side === 'E' || side === 'W')) side = OPP[side];
    return SIDES[(SIDES.indexOf(side) + (r || 0)) % 4];
  }
  /** Every port of a placed part in world terms: {dir, rate, side, x, y (the port's cell), nx, ny (the cell across it), local} */
  function portsOf(p) {
    const t = T[p.type], [x0, y0] = p.cells[0];
    return t.ports.map((q) => {
      let lx, ly;
      if (q.side === 'N') { lx = q.cell; ly = 0; } else if (q.side === 'S') { lx = q.cell; ly = t.h - 1; } else if (q.side === 'W') { lx = 0; ly = q.cell; } else { lx = t.w - 1; ly = q.cell; }
      const [dx, dy] = placeCell(lx, ly, t.w, t.h, p.rot, p.flip), side = placeSide(q.side, p.rot, p.flip), [vx, vy] = SIDE_V[side];
      return { dir: q.dir, rate: q.rate, side, x: x0 + dx, y: y0 + dy, nx: x0 + dx + vx, ny: y0 + dy + vy, local: q };
    });
  }

  // ================================================================ the layout: links between facing ports
  function build(parts, GW, GH) {
    const key = (x, y) => y * GW + x;
    const occ = new Array(GW * GH).fill(null);
    const alive = parts.filter((p) => !p.dead);
    for (const p of alive) for (const [x, y] of p.cells) occ[key(x, y)] = p;
    const links = [], opens = [], clashes = [];
    for (const p of alive) {
      p.ports = portsOf(p); p.links = []; p.openIn = []; p.openOut = []; p.clash = [];
      let sx = 0, sy = 0; for (const [x, y] of p.cells) { sx += x + 0.5; sy += y + 0.5; } p.cx = sx / p.cells.length; p.cy = sy / p.cells.length;
      const t = T[p.type];
      if (t.kind === 'store' && p.held === undefined) p.held = 0;
      if (t.kind === 'weapon' && p.stored === undefined) p.stored = 0;
      if (t.kind === 'engine' && p.stored === undefined) p.stored = 0;
      if (t.kind === 'util' && p.stored === undefined) p.stored = 0;
      p.cd ??= 0; p.on ??= false; p.flash ??= 0; p.emaIn ??= 0; p.emaOut ??= 0; p.emaWaste ??= 0; p.emaD ??= 0; p.sat ??= 1; p.rate ??= 0; p.thrustNow ??= 0; p.latched ??= false;
    }
    for (const a of alive) for (const pa of a.ports) {
      const b = pa.nx >= 0 && pa.ny >= 0 && pa.nx < GW && pa.ny < GH ? occ[key(pa.nx, pa.ny)] : null;
      pa.faces = b; pa.link = null; pa.clash = false;
      if (!b || b === a) { (pa.dir === 'in' ? a.openIn : a.openOut).push(pa); opens.push({ part: a, port: pa }); continue; }
      const pb = b.ports.find((q) => q.x === pa.nx && q.y === pa.ny && q.side === OPP[pa.side]);
      if (!pb) { (pa.dir === 'in' ? a.openIn : a.openOut).push(pa); opens.push({ part: a, port: pa }); continue; }
      if (pb.dir === pa.dir) { pa.clash = true; a.clash.push(pa); if (a.uid < b.uid) clashes.push({ a, b, port: pa }); continue; }
      if (pa.dir === 'out') { const l = { from: a, to: b, pa, pb, cap: Math.min(pa.rate, pb.rate), ema: 0, send: 0 }; pa.link = l; pb.link = l; links.push(l); a.links.push(l); b.links.push(l); }
    }
    for (const p of alive) { p.outL = p.links.filter((l) => l.from === p); p.inL = p.links.filter((l) => l.to === p); }
    const by = (k) => alive.filter((p) => T[p.type].kind === k);
    const consumers = [...by('weapon'), ...by('engine'), ...by('util')], stores = by('store');
    return { GW, GH, occ, key, alive, links, opens, clashes, gens: by('gen'), stores, weapons: by('weapon'), engines: by('engine'), utils: by('util'),
      consumers, takers: [...stores, ...consumers] };
  }

  // ================================================================ the tick
  const DEF_DT = 1 / 60, DT = DEF_DT, TAU = 1.5;
  function waterfill(wants, supply) {
    const out = new Array(wants.length).fill(0);
    const idx = wants.map((_, i) => i).filter((i) => wants[i] > 1e-12).sort((a, b) => wants[a] - wants[b]);
    let left = Math.max(0, supply), k = idx.length;
    for (const i of idx) { const g = Math.min(wants[i], left / k); out[i] = g; left -= g; k--; }
    return out;
  }
  const capOf = (t) => (t.beam ? t.bufferE : t.shot * t.buffer);
  const spaceOf = (p) => { const t = T[p.type]; return t.kind === 'store' ? t.hold - p.held : t.kind === 'weapon' ? capOf(t) - p.stored : t.kind === 'engine' ? t.buffer - p.stored : t.e - p.stored; };
  const fullDps = (t) => (t.beam ? t.dps : t.damage / Math.max(t.cycle, t.shot / Math.max(1e-9, t.intake - t.passive)));

  /** One tick of dt seconds (default 1/60; the evolver uses 1/20, the most a 10-held conduit's 200 a second allows).
   * ctrl: {fire, thrust, util}. Returns this tick's totals (E/s). Mutates part state and link.send */
  function tick(L, ctrl, ticks, dt) {
    const DT = dt || DEF_DT;
    const ema = (cur, v) => cur + (v - cur) * Math.max(DT / TAU, 1 / (ticks + 1));
    const emaSlow = (cur, v) => cur + (v - cur) * (DT / 5);
    // 1. Offer: generators the cap on every link; stores what they hold, water-filled over their out links
    for (const l of L.links) l.offer = 0;
    for (const g of L.gens) for (const l of g.outL) l.offer = l.cap * DT;
    for (const s of L.stores) { const outs = s.outL; if (!outs.length) continue; if (outs.length === 1) { outs[0].offer = Math.min(outs[0].cap * DT, s.held); continue; } const a = waterfill(outs.map((l) => l.cap * DT), s.held); outs.forEach((l, i) => { l.offer = a[i]; }); }
    // 2. Accept: each taker up to the space left, water-filled over its in links
    for (const l of L.links) l.send = 0;
    for (const p of L.takers) {
      const ins = p.inL; if (!ins.length) continue;
      if (ins.length === 1) { ins[0].send = Math.min(ins[0].offer, Math.max(0, spaceOf(p))); continue; }
      const a = waterfill(ins.map((l) => l.offer), Math.max(0, spaceOf(p)));
      ins.forEach((l, i) => { l.send = a[i]; });
    }
    // 3. Apply
    let made = 0, wasted = 0, toStores = 0, toW = 0, toE = 0, toU = 0, fromStores = 0;
    for (const p of L.alive) { p.inNow = 0; p.outNow = 0; }
    for (const l of L.links) { l.from.outNow += l.send; l.to.inNow += l.send; }
    for (const g of L.gens) { const t = T[g.type]; made += t.produce * DT; wasted += t.produce * DT - g.outNow; g.emaWaste = ema(g.emaWaste, (t.produce * DT - g.outNow) / DT); }
    for (const s of L.stores) { s.held += s.inNow - s.outNow; fromStores += s.outNow; toStores += s.inNow; }
    for (const p of L.consumers) { const k = T[p.type].kind; p.stored += p.inNow; if (k === 'weapon') toW += p.inNow; else if (k === 'engine') toE += p.inNow; else toU += p.inNow; }
    for (const p of L.alive) { p.emaIn = ema(p.emaIn, p.inNow / DT); p.emaOut = ema(p.emaOut, p.outNow / DT); }
    for (const l of L.links) l.ema = ema(l.ema, l.send / DT);
    // 4. Consumers act
    let dmg = 0, thrust = 0, shortW = 0, shortE = 0, shortU = 0;
    for (const p of L.weapons) {
      const t = T[p.type]; let d = 0;
      p.cd = Math.max(0, p.cd - DT); p.flash = Math.max(0, p.flash - DT);
      if (t.beam) {
        const need = t.burn * DT;
        if (!ctrl.fire) p.on = false; else if (!p.on && p.stored >= 0.5 * t.bufferE - 1e-9) p.on = true;
        if (p.on && p.stored >= need - 1e-9) { p.stored -= need; d = t.dps * DT; } else p.on = false;
      } else if (t.clip) {
        // A magazine: fires its rounds, then latches until the whole clip is paid again
        if (p.latched && p.stored >= capOf(t) - 1e-9) p.latched = false;
        if (ctrl.fire && !p.latched && p.cd <= 1e-9 && p.stored >= t.shot - 1e-9) { p.stored -= t.shot; p.cd = t.cycle; d = t.damage; p.flash = 0.08; if (p.stored < t.shot - 1e-9) p.latched = true; }
      } else if (ctrl.fire && p.cd <= 1e-9 && p.stored >= t.shot - 1e-9) { p.stored -= t.shot; p.cd = t.cycle; d = t.damage; p.flash = 0.1; }
      // (The passive drain after firing: a full buffer fires before it leaks)
      p.stored = Math.max(0, p.stored - t.passive * DT);
      p.dNow = d; p.emaD = emaSlow(p.emaD, d / DT); dmg += d;
      p.rate = p.emaD / fullDps(t);
      if (ctrl.fire) shortW += Math.max(0, t.intake * DT - p.inNow);
    }
    for (const p of L.engines) {
      const t = T[p.type]; let frac = 1;
      if (ctrl.thrust) { const need = t.burn * DT, use = Math.min(p.stored, need); p.stored -= use; frac = use / need; shortE += Math.max(0, Math.min(t.intake, t.burn) * DT - p.inNow); }
      p.sat = ctrl.thrust ? frac : 1; p.thrustNow = ctrl.thrust ? t.thrust * frac : 0; thrust += p.thrustNow;
    }
    for (const p of L.utils) {
      const t = T[p.type];
      if (ctrl.util) { const need = t.e * DT, use = Math.min(p.stored, need); p.stored -= use; p.sat = use / need; shortU += need - use; } else p.sat = 1;
    }
    const per = (v) => v / DT;
    return { made: per(made), wasted: per(wasted), toStores: per(toStores), fromStores: per(fromStores), weapons: per(toW), engines: per(toE), utils: per(toU),
      dps: per(dmg), thrust, shortW: per(shortW), shortE: per(shortE), shortU: per(shortU) };
  }

  // ================================================================ damage: destroy a part and let its blast run
  /** A store's blast grows with its charge; a generator's is fixed; anything else just breaks */
  function blastOf(p) {
    const t = T[p.type];
    if (t.kind === 'gen' && t.blast) return t.blast;
    if (t.kind === 'store' && !t.conduit && p.held > 1) return { r: Math.min(4.5, 1.5 + p.held / 300), dmg: 0.6 * p.held };
    return null;
  }
  /** Kill part p (and chain). Returns the parts that went, in order, each with the blast that took it (null for the first) */
  function destroy(L, p) {
    const gone = [], queue = [];
    const kill = (q, by) => { if (q.dead) return; q.dead = true; q.hp = 0; gone.push({ part: q, by }); const b = blastOf(q); if (b) queue.push({ at: [q.cx, q.cy], b, from: q }); };
    kill(p, null);
    while (queue.length) {
      const { at, b, from } = queue.shift();
      for (const q of L.alive) {
        if (q.dead) continue;
        const d = Math.hypot(q.cx - at[0], q.cy - at[1]);
        if (d >= b.r) continue;
        q.hp = (q.hp ?? T[q.type].hp) - b.dmg * (1 - d / b.r);
        if (q.hp <= 0) kill(q, from);
      }
    }
    return gone;
  }

  return { T, ORDER, CATS, COL, SIDES, SIDE_V, OPP, DT, dims, rectCells, placeCell, placeSide, portsOf, build, tick, waterfill, capOf, fullDps, blastOf, destroy };
});
