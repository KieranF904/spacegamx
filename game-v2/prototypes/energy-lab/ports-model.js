// The ports model (docs/design/energy-ports-2026-11.md): parts with in and out ports on their edges, power crossing only
// out → in over a shared edge, a synchronous offer/accept tick, weapons with buffers and power profiles, blasts. On top,
// the feed layer: tanks of consumables joined by pipes (which cross power lines only through passthrough conduits), and
// Combiners that join a feed and a power line into one flavoured line, so the guns downstream fire with its effect.
// Plain script: ports.html uses it as window.PM; ports-model.test.mjs and the evolver's ports_score.cjs load it in node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.PM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ================================================================ consumables (the feed layer)
  // Each changes the shots of the guns it reaches, at a strength 0..1 (its share of the gun's power, or its share of
  // the feed at a feed port). At full strength: dmg multiplies impact damage, pen adds to penetration, cycle multiplies
  // the gun's cycle; burn / splash / mark add damage of their own kind (a share of the impact), slow / disrupt take a
  // share off the enemy's fire while they last. hazard: what a hit tank (or a broken line carrying it) does: fire and
  // blast hurt everything in reach, arc hurts only power parts, freeze stops guns and engines in reach for s seconds.
  const FLUIDS = {
    incendiary: { name: 'Incendiary gel', short: 'Incendiary', col: '#ff7a3d', dmg: 0.8, burn: 0.6, hazard: { kind: 'fire', dmg: 90, r: 2 },
      say: 'Shots set parts burning (60% of the hit again, over time) but hit 20% softer. A hit tank or line starts a fire.' },
    cryo: { name: 'Cryo slurry', short: 'Cryo', col: '#7fd8ff', dmg: 0.9, slow: 0.25, hazard: { kind: 'freeze', s: 6, r: 1.8 },
      say: 'Shots slow the target (a quarter off its fire while it lasts) and hit 10% softer. A hit tank freezes the parts around it.' },
    ion: { name: 'Ion gas', short: 'Ion', col: '#b58cff', dmg: 0.85, cycle: 1.2, disrupt: 0.3, hazard: { kind: 'arc', dmg: 80, r: 2.2 },
      say: 'Shots disrupt the target\'s power (30% off its fire) but hit softer and fire 20% slower. A hit tank arcs into your own power parts.' },
    tungsten: { name: 'Tungsten dust', short: 'Tungsten', col: '#9aa4ad', pen: 2, cycle: 1.15, hazard: null, tankMass: 3,
      say: 'Shots go 2 deeper into armour, but the guns cycle 15% slower and its tanks are heavy. Safe to carry.' },
    shaped: { name: 'Shaped slurry', short: 'Shaped', col: '#ffd166', splash: 0.5, pen: -1, hazard: { kind: 'blast', dmg: 160, r: 2.5 },
      say: 'Shots splash (half the hit again on what\'s around it) but go 1 less deep. A hit tank is a bomb.' },
    tracer: { name: 'Tracer dust', short: 'Tracer', col: '#9effa1', dmg: 0.9, mark: 0.3, hazard: null,
      say: 'Shots mark the target (30% more from everyone else) and hit 10% softer. Safe to carry.' },
  };
  const FX_KEYS = ['burn', 'splash', 'mark', 'slow', 'disrupt'];

  // ================================================================ parts
  // Ports in the part's own frame, unrotated: N is the nose. [dir, side, cell, rate]: cell counts from the W end of a N or S
  // side and from the N end of a W or E side. feed: the part's feed points ([side, cell]), where pipes, tanks and feed
  // ports join (both sides of an edge must have one).
  const T = {}, ORDER = [];
  const CATS = ['Core and hull', 'Generators', 'Stores and conduits', 'Weapons', 'Engines and shields', 'Feed'];
  const COL = { core: '#e8e3d6', hull: '#4b5660', armor: '#6e7a84', gen: '#38bdf8', store: '#4ade80', cap: '#f5a83a', conduit: '#a7b4be',
    weapon: '#ef5f55', engine: '#3fb0e0', util: '#4fbfb2', pipe: '#a77bdc', feedgun: '#e2608f' };
  const ALL4 = [['N', 0], ['E', 0], ['S', 0], ['W', 0]];
  function def(o) {
    o.w = o.w || 1; o.h = o.h || 1; o.ports = (o.ports || []).map(([dir, side, cell, rate]) => ({ dir, side, cell: cell || 0, rate }));
    o.feed = (o.feed || []).map(([side, cell]) => ({ side, cell: cell || 0 }));
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

  def({ id: 'conduit', name: 'Conduit', cat: 2, kind: 'store', conduit: true, hold: 10, hp: 35, mass: 0.8, col: COL.conduit, lvl: 0, ports: [I('S', 200), O('N', 200)],
    say: 'A one-way line: in at the back, out at the front.' });
  def({ id: 'corner', name: 'Conduit, corner', cat: 2, kind: 'store', conduit: true, hold: 10, hp: 35, mass: 0.8, col: COL.conduit, lvl: 0, ports: [I('S', 200), O('E', 200)],
    say: 'A one-way line that turns right. Flip it (T) to turn left.' });
  def({ id: 'cell_battery', name: 'Cell Battery', cat: 2, kind: 'store', hold: 200, hp: 45, col: COL.store, lvl: 0, ports: [I('S', 40), O('N', 60)],
    say: 'Smooths one line: takes 40, gives up to 60, holds 200.' });
  def({ id: 'joiner', name: 'Joiner Bank', cat: 2, kind: 'store', w: 2, hold: 300, hp: 90, col: COL.store, lvl: 3, isNew: true, ports: [I('S', 40, 0), I('S', 40, 1), O('N', 90, 0)],
    say: 'Two lines in at 40 each, one out at 90. The first thing a mid gun needs.' });
  def({ id: 'splitter', name: 'Splitter Bank', cat: 2, kind: 'store', w: 2, hold: 300, hp: 90, col: COL.store, lvl: 5, isNew: true, ports: [I('S', 80, 0), O('N', 45, 0), O('N', 45, 1)],
    say: 'One line in at 80, two out at 45 each: two guns on one plant port.' });
  def({ id: 'capacitor', name: 'Capacitor', cat: 2, kind: 'store', hold: 160, hp: 30, col: COL.cap, lvl: 7, ports: [I('S', 40), O('N', 400)],
    say: 'Pays a big shot at once (400 a second), then 4 seconds to refill at 40. Fills while a gun\'s port is shut.' });
  def({ id: 'surge_cell', name: 'Surge Cell', cat: 2, kind: 'store', hold: 120, hp: 40, col: COL.cap, lvl: 12, isNew: true, ports: [I('S', 120), O('N', 300)],
    say: 'A fast buffer for a plant line: takes 120, gives 300, holds 120. Catches a whole line while a gun discharges.' });
  def({ id: 'drive_cell', name: 'Drive Cell', cat: 2, kind: 'store', hold: 320, hp: 45, col: COL.cap, lvl: 10, ports: [I('S', 60), O('N', 250)],
    say: 'The Capacitor for engines: a burst of 250 a second, then 5 seconds to refill.' });
  def({ id: 'flux_coil', name: 'Flux Coil', cat: 2, kind: 'store', w: 2, hold: 160, hp: 70, col: COL.cap, lvl: 20, isNew: true, ports: [I('S', 150, 0), I('S', 150, 1), O('N', 300, 0)],
    say: 'Joins two plant lines (150 each) into one fast one (300).' });
  def({ id: 'heavy_bank', name: 'Heavy Bank', cat: 2, kind: 'store', w: 2, h: 2, hold: 1200, hp: 280, mass: 6.4, col: COL.store, lvl: 20, ports: [I('S', 70, 0), I('S', 70, 1), O('N', 150, 0)],
    say: 'Endurance: fills between fights, carries a gun through one. Full, it is a bomb.' });
  def({ id: 'cap_array', name: 'Capacitor Array', cat: 2, kind: 'store', w: 2, h: 2, hold: 600, hp: 150, mass: 5, col: COL.cap, lvl: 26, isNew: true,
    ports: [I('S', 60, 0), I('S', 60, 1), I('W', 60, 0), I('W', 60, 1), I('E', 60, 0), I('E', 60, 1), O('N', 600, 0), O('N', 600, 1)],
    say: 'Six lines in at 60, two huge lines out at 600: the last stage before a superweapon.' });

  // Weapons. Shot guns fire when the buffer holds a shot and the cycle is done; beams burn from the buffer while lit.
  // Power profiles (how each wants its power; see the design doc):
  //   passive    leaves the buffer every second whether or not it fires: below it the gun never charges
  //   discharge  after each shot its ports are shut for this long: power arriving then is lost unless something holds it
  //   rest       a beam that burns out shuts its ports for this long before it takes power again
  //   threshold  it takes power only while its lines offer at least this much a second: one weak line gives it nothing
  //   steady     while charging, if what arrives in a tick falls below this rate the charge collapses (back to nothing)
  //   clip       a magazine: fires its rounds, then refills the whole clip before firing again
  //   feed       a feed port ([side, cell], use a shot or a second for beams, required): it fires with whatever it's fed
  const gun = (o) => def(Object.assign({ cat: 3, kind: 'weapon', col: COL.weapon, passive: 0, buffer: 1, mass: 1.2, discharge: 0, rest: 0, threshold: 0, steady: 0 }, o));
  gun({ id: 'pip', name: 'Pip', lvl: 0, hp: 60, ports: [I('S', 20)], shot: 10, cycle: 0.5, damage: 28,
    say: 'The starter gun: takes power from anything, at any rate.' });
  gun({ id: 'glint', name: 'Glint', lvl: 9, hp: 60, ports: [I('S', 35)], shot: 28, cycle: 0.8, damage: 43, discharge: 0.3,
    say: 'A pulse laser: its port shuts for 0.3 s after each shot.' });
  gun({ id: 'hammer', name: 'Hammer', lvl: 6, w: 2, hp: 120, ports: [I('S', 70, 0)], shot: 70, cycle: 1.0, damage: 69, threshold: 45,
    say: 'A heavy cannon: it takes power only from a line offering at least 45 a second, so one reactor gives it nothing.' });
  gun({ id: 'cutter', name: 'Cutter', lvl: 18, w: 2, hp: 130, ports: [I('S', 45, 0), I('S', 45, 1)], beam: true, burn: 90, bufferE: 180, dps: 150, passive: 5, rest: 1.5,
    say: 'A beam: burns 90 a second while lit; when it burns out, its ports shut for 1.5 s.' });
  gun({ id: 'longbarrel', name: 'Longbarrel', lvl: 20, w: 2, hp: 150, ports: [I('S', 55, 0), I('S', 55, 1)], shot: 220, cycle: 2.0, damage: 96, discharge: 1.0,
    say: 'A long gun: its ports shut for 1 s after each shot, so a buffer behind it wins back that second.' });
  gun({ id: 'spear', name: 'Spear', lvl: 28, w: 2, h: 2, hp: 240, ports: [I('S', 45, 0), I('S', 45, 1)], shot: 180, cycle: 2.0, buffer: 2, damage: 170, passive: 10, steady: 50,
    say: 'A rail gun: while charging it needs at least 50 a second without a break, or the charge collapses. Give it a line of its own.' });
  gun({ id: 'bastion', name: 'Bastion', lvl: 30, w: 2, h: 2, hp: 300, ports: [I('S', 55, 0), I('S', 55, 1), I('W', 55, 1), I('E', 55, 1)], shot: 60, cycle: 0.25, buffer: 16, clip: true, damage: 28, passive: 15,
    say: 'A heavy repeater: a 16-round clip, refilled whole once empty, from four lines.' });
  gun({ id: 'lance', name: 'Lance', lvl: 32, w: 2, hp: 200, ports: [I('S', 150, 0), I('S', 150, 1)], beam: true, burn: 300, bufferE: 600, dps: 210, passive: 40, rest: 2,
    say: 'The big beam: burns 300 a second, leaks 40, and rests 2 s when it burns out.' });
  // The embedded superweapon: six lines of 60, from the back and both flanks, so the ship is built around it
  gun({ id: 'sunbreaker', name: 'Sunbreaker', lvl: 34, w: 3, h: 3, hp: 600, mass: 12, armour: 2, isNew: true,
    ports: [I('S', 60, 0), I('S', 60, 2), I('W', 60, 1), I('W', 60, 2), I('E', 60, 1), I('E', 60, 2)], shot: 600, cycle: 3.0, damage: 900, passive: 150, discharge: 1.0,
    say: 'Six lines in at 60, from the back and both flanks: the ship is built around it. It leaks 150 a second (three lines to charge at all) and shuts for 1 s after each shot.' });
  // Feed guns: power and a feed, through separate ports. fxMul: how strongly they carry their feed's effect
  gun({ id: 'scorcher', name: 'Scorcher', lvl: 8, hp: 70, col: COL.feedgun, isNew: true, ports: [I('S', 30)], beam: true, burn: 30, bufferE: 60, dps: 45,
    feedPort: { side: 'W', cell: 0, use: 1.5, required: true }, fxMul: 1.5,
    say: 'A projector: a beam that needs power at its back and a feed on its left, and sprays whatever it\'s fed, its effect half again as strong.' });
  gun({ id: 'slurry_cannon', name: 'Slurry Cannon', lvl: 16, w: 2, hp: 140, col: COL.feedgun, isNew: true, ports: [I('S', 60, 0)], shot: 90, cycle: 1.5, damage: 110, threshold: 40,
    feedPort: { side: 'S', cell: 1, use: 3, required: true }, fxMul: 1.5,
    say: 'Fires shells packed with its feed (3 a shot, effect half again as strong). Power at its back left, feed at its back right; a line under 40 a second gives it nothing.' });

  // Engines burn from a buffer that refills through their ports; empty, they run at intake ÷ burn. Shields draw a flat rate.
  def({ id: 'ion', name: 'Ion Drive', cat: 4, kind: 'engine', hp: 50, col: COL.engine, lvl: 0, ports: [I('N', 12)], burn: 9, buffer: 30, thrust: 2.26, say: 'Full thrust burns 9 a second from a 30 buffer that refills at 12.' });
  def({ id: 'plasma', name: 'Plasma Drive', cat: 4, kind: 'engine', w: 2, hp: 110, col: COL.engine, lvl: 16, ports: [I('N', 25, 0), I('N', 25, 1)], burn: 40, buffer: 120, thrust: 6.2, say: 'Full thrust burns 40 a second; two lines of 25 refill it.' });
  def({ id: 'deflector', name: 'Deflector', cat: 4, kind: 'util', hp: 56, col: COL.util, lvl: 11, ports: [I('S', 16)], e: 16, say: 'Draws 16 a second while shields are on.' });

  // The feed layer. Tanks hold one consumable; touching tanks of it join. Pipes join anything with a feed point, any
  // side; they cross a power line only through a Passthrough. A Combiner joins a feed and a power line into one
  // flavoured line; a Scrubber takes the flavour off a line. Neither stores power (they hold a few ticks' worth).
  for (const [fid, f] of Object.entries(FLUIDS))
    def({ id: 'tank_' + fid, name: 'Tank: ' + f.short, cat: 5, kind: 'tank', fluid: fid, fill: 120, hp: 55, mass: f.tankMass || 1.5, col: f.col, lvl: 8, isNew: true, feed: ALL4,
      say: `Holds 120 ${f.name.toLowerCase()} for the feed lines touching it. ${f.say}` });
  def({ id: 'pipe', name: 'Feed pipe', cat: 5, kind: 'pipe', hp: 30, mass: 0.8, col: COL.pipe, lvl: 8, isNew: true, feed: ALL4,
    say: 'Carries feed between whatever touches it, any side. It can\'t cross a power line: use a Passthrough there.' });
  def({ id: 'passthrough', name: 'Passthrough', cat: 5, kind: 'store', conduit: true, hold: 10, hp: 45, mass: 0.5, col: COL.pipe, lvl: 8, isNew: true,
    ports: [I('S', 200), O('N', 200)], feed: [['E', 0], ['W', 0]],
    say: 'A power line (back to front) with a feed pipe crossing it (side to side): where the two networks cross.' });
  def({ id: 'combiner', name: 'Combiner', cat: 5, kind: 'store', conduit: true, combiner: true, hold: 10, hp: 140, mass: 1.5, col: COL.pipe, lvl: 10, isNew: true,
    ports: [I('S', 150), O('N', 150)], feed: [['W', 0]], feedPerE: 0.02,
    say: 'Power in at the back, feed on the left, one flavoured line out the front: every gun downstream fires with the feed. 1 feed for every 50 power. Tough, and it holds no charge.' });
  def({ id: 'scrubber', name: 'Scrubber', cat: 5, kind: 'store', conduit: true, scrub: true, hold: 10, hp: 50, mass: 0.5, col: COL.pipe, lvl: 10, isNew: true,
    ports: [I('S', 200), O('N', 200)],
    say: 'A power line that takes the flavour off: what leaves it is plain power. Keeps a branch clean.' });

  // Credits, armour (against the pen of what hits it) and a gun's pen (against the enemy's armour): first guesses, for the
  // evolver's budget and hit runs; the lab shows them but its tick doesn't use them
  const COST = { core: 0, hull: 9, armor: 18, cell_reactor: 35, twin_reactor: 60, isotope: 70, fusion: 500, overclock: 700, stellarator: 1400,
    conduit: 10, corner: 10, cell_battery: 40, joiner: 90, splitter: 90, capacitor: 60, surge_cell: 120, drive_cell: 80, flux_coil: 300, heavy_bank: 400, cap_array: 600,
    pip: 21, glint: 100, hammer: 110, cutter: 170, longbarrel: 300, spear: 600, bastion: 900, lance: 1200, sunbreaker: 2500, scorcher: 90, slurry_cannon: 260,
    ion: 21, plasma: 210, deflector: 140, pipe: 8, passthrough: 30, combiner: 120, scrubber: 40 };
  const ARMOUR = { armor: 2, isotope: 2, fusion: 2, heavy_bank: 2, stellarator: 2, spear: 2, bastion: 2, combiner: 2 };
  const PEN = { pip: 1, glint: 1, hammer: 2, cutter: 2, longbarrel: 3, spear: 4, bastion: 3, lance: 4, sunbreaker: 5, scorcher: 0, slurry_cannon: 2 };
  for (const id of ORDER) {
    const t = T[id];
    t.cost ??= COST[id] ?? (t.kind === 'tank' ? 40 : 0); t.armour ??= ARMOUR[id] ?? 1; if (t.kind === 'weapon') t.pen ??= PEN[id] ?? 1;
    t.intake = t.ports.filter((p) => p.dir === 'in').reduce((s, p) => s + p.rate, 0);
    t.produce = t.ports.filter((p) => p.dir === 'out').reduce((s, p) => s + p.rate, 0);
    if (t.kind === 'weapon' && !t.beam) t.damage = t.damage || 1;
    if (t.feedPort) t.feed = [{ side: t.feedPort.side, cell: t.feedPort.cell }];
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
  /** An edge point (side, cell) of a placed part in world terms: the cell it's on, its side, and the cell across it */
  function edgeOf(p, side, cell) {
    const t = T[p.type], [x0, y0] = p.cells[0];
    let lx, ly;
    if (side === 'N') { lx = cell; ly = 0; } else if (side === 'S') { lx = cell; ly = t.h - 1; } else if (side === 'W') { lx = 0; ly = cell; } else { lx = t.w - 1; ly = cell; }
    const [dx, dy] = placeCell(lx, ly, t.w, t.h, p.rot, p.flip), ws = placeSide(side, p.rot, p.flip), [vx, vy] = SIDE_V[ws];
    return { side: ws, x: x0 + dx, y: y0 + dy, nx: x0 + dx + vx, ny: y0 + dy + vy };
  }
  /** Every port of a placed part in world terms: {dir, rate, side, x, y (the port's cell), nx, ny (the cell across it), local} */
  function portsOf(p) { return T[p.type].ports.map((q) => Object.assign({ dir: q.dir, rate: q.rate, local: q }, edgeOf(p, q.side, q.cell))); }
  /** Every feed point of a placed part in world terms */
  function feedsOf(p) { return T[p.type].feed.map((q) => Object.assign({ local: q }, edgeOf(p, q.side, q.cell))); }

  // ================================================================ the layout: links between facing ports, feed networks
  function build(parts, GW, GH) {
    const key = (x, y) => y * GW + x;
    const occ = new Array(GW * GH).fill(null);
    const alive = parts.filter((p) => !p.dead);
    for (const p of alive) for (const [x, y] of p.cells) occ[key(x, y)] = p;
    const links = [], opens = [], clashes = [];
    for (const p of alive) {
      p.ports = portsOf(p); p.feeds = feedsOf(p); p.links = []; p.openIn = []; p.openOut = []; p.clash = [];
      let sx = 0, sy = 0; for (const [x, y] of p.cells) { sx += x + 0.5; sy += y + 0.5; } p.cx = sx / p.cells.length; p.cy = sy / p.cells.length;
      const t = T[p.type];
      if (t.kind === 'store' && p.held === undefined) p.held = 0;
      if ((t.kind === 'weapon' || t.kind === 'engine' || t.kind === 'util') && p.stored === undefined) p.stored = 0;
      if (t.kind === 'tank' && p.fill === undefined) p.fill = t.fill;
      p.flav ??= {}; p.cd ??= 0; p.on ??= false; p.flash ??= 0; p.emaIn ??= 0; p.emaOut ??= 0; p.emaWaste ??= 0; p.emaD ??= 0; p.sat ??= 1; p.rate ??= 0; p.thrustNow ??= 0;
      p.latched ??= false; p.closed ??= 0; p.frozen ??= 0; p.collapsed ??= 0; p.fx ??= null;
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
    // Feed networks: parts joined where both sides of an edge have a feed point. Tanks join only tanks of their own fluid
    // directly (a pipe between two tank types joins them, and mixes them)
    const net = new Map(), parent = new Map();
    const find = (p) => { while (parent.get(p) !== p) { parent.set(p, parent.get(parent.get(p))); p = parent.get(p); } return p; };
    for (const p of alive) if (p.feeds.length) parent.set(p, p);
    for (const a of alive) for (const fa of a.feeds) {
      fa.joined = null;
      const b = fa.nx >= 0 && fa.ny >= 0 && fa.nx < GW && fa.ny < GH ? occ[key(fa.nx, fa.ny)] : null;
      if (!b || b === a || !b.feeds.length) continue;
      if (!b.feeds.some((q) => q.x === fa.nx && q.y === fa.ny && q.side === OPP[fa.side])) continue;
      const ta = T[a.type], tb = T[b.type];
      if (ta.kind === 'tank' && tb.kind === 'tank' && ta.fluid !== tb.fluid) continue;
      fa.joined = b;
      const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb);
    }
    const feedNets = [];
    for (const p of parent.keys()) {
      const r = find(p);
      if (!net.has(r)) { const n = { parts: [], tanks: [], users: [] }; net.set(r, n); feedNets.push(n); }
      const n = net.get(r); n.parts.push(p); p.feedNet = n;
      const t = T[p.type];
      if (t.kind === 'tank') n.tanks.push(p); else if (t.combiner || t.feedPort) n.users.push(p);
    }
    const by = (k) => alive.filter((p) => T[p.type].kind === k);
    const consumers = [...by('weapon'), ...by('engine'), ...by('util')], stores = by('store');
    return { GW, GH, occ, key, alive, links, opens, clashes, feedNets, gens: by('gen'), stores, weapons: by('weapon'), engines: by('engine'), utils: by('util'),
      tanks: by('tank'), consumers, takers: [...stores, ...consumers] };
  }

  // ================================================================ feed
  /** What a feed network holds: {fluid: units}, and the total */
  function netStock(n) { const s = {}; let total = 0; for (const t of n.tanks) { const f = T[t.type].fluid; s[f] = (s[f] || 0) + t.fill; total += t.fill; } return { s, total }; }
  /** Take up to u units from a feed network, from every tank in proportion. Returns the mix taken {fluid: units} */
  function draw(n, u) {
    const { total } = netStock(n), got = {};
    if (!n || total <= 1e-9 || u <= 0) return got;
    const k = Math.min(1, u / total);
    for (const t of n.tanks) { const take = t.fill * k, f = T[t.type].fluid; t.fill -= take; got[f] = (got[f] || 0) + take; }
    return got;
  }
  const sumMix = (m) => Object.values(m).reduce((s, v) => s + v, 0);
  /** Mix flavour b (weight wb) into a (weight wa): shares of the result */
  function blend(a, wa, b, wb) {
    const out = {}, w = wa + wb; if (w <= 1e-12) return out;
    for (const [k, v] of Object.entries(a)) out[k] = (out[k] || 0) + v * wa / w;
    for (const [k, v] of Object.entries(b)) out[k] = (out[k] || 0) + v * wb / w;
    for (const k of Object.keys(out)) if (out[k] < 1e-4) delete out[k];
    return out;
  }
  /** A shot's effects from its flavour shares (each 0..1): damage and cycle multipliers, pen added, and the effect amounts */
  function effects(shares, fxMul) {
    const fx = { dmg: 1, cycle: 1, pen: 0, burn: 0, splash: 0, mark: 0, slow: 0, disrupt: 0 };
    for (const [f, s0] of Object.entries(shares || {})) {
      // (A share is at most 1; a feed gun's fxMul then strengthens it, half again for the Scorcher)
      const F = FLUIDS[f]; if (!F) continue; const s = Math.min(1, s0) * (fxMul || 1);
      if (F.dmg) fx.dmg *= 1 + (F.dmg - 1) * s; if (F.cycle) fx.cycle *= 1 + (F.cycle - 1) * s; if (F.pen) fx.pen += F.pen * s;
      for (const k of FX_KEYS) if (F[k]) fx[k] += F[k] * s;
    }
    return fx;
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
  /** How much a taker will accept this tick: its space, or nothing while its ports are shut (discharge, rest, frozen) */
  function spaceOf(p) {
    const t = T[p.type];
    if (t.kind === 'store') return t.hold - p.held;
    if (p.closed > 0 || p.frozen > 0) return 0;
    return t.kind === 'weapon' ? capOf(t) - p.stored : t.kind === 'engine' ? t.buffer - p.stored : t.e - p.stored;
  }
  /** Damage a second at full supply: the cycle, or the time to charge a shot after the ports reopen, whichever is longer */
  function fullDps(t) {
    if (t.beam) return t.dps;
    return t.damage / Math.max(t.cycle, (t.discharge || 0) + t.shot / Math.max(1e-9, t.intake - t.passive));
  }

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
    // 2. Accept: each taker up to the space left, water-filled over its in links. A gun with a threshold takes nothing
    // unless the lines offering it power are rated at least that much together (a link's rating: the lower of its two
    // ports): a reactor's 30 never qualifies for a 45 threshold, a Joiner's 90 or a Capacitor's 400 does
    for (const l of L.links) l.send = 0;
    for (const p of L.takers) {
      const ins = p.inL; if (!ins.length) continue;
      const t = T[p.type];
      let space = Math.max(0, spaceOf(p));
      if (t.threshold && ins.reduce((s, l) => s + (l.offer > 1e-12 ? l.cap : 0), 0) < t.threshold - 1e-9) space = 0;
      if (ins.length === 1) { ins[0].send = Math.min(ins[0].offer, space); continue; }
      const a = waterfill(ins.map((l) => l.offer), space);
      ins.forEach((l, i) => { l.send = a[i]; });
    }
    // 3. Apply, carrying flavour: what arrives brings its giver's flavour (as it was at the start of the tick)
    let made = 0, wasted = 0, toStores = 0, toW = 0, toE = 0, toU = 0, fromStores = 0;
    for (const p of L.alive) { p.inNow = 0; p.outNow = 0; p.inFlav = null; }
    for (const l of L.links) {
      l.from.outNow += l.send; l.to.inNow += l.send;
      if (l.send > 0 && l.from.flav && Object.keys(l.from.flav).length) { const f = l.from.flav; l.to.inFlav = l.to.inFlav || {}; for (const k in f) l.to.inFlav[k] = (l.to.inFlav[k] || 0) + f[k] * l.send; }
    }
    for (const g of L.gens) { const t = T[g.type]; made += t.produce * DT; wasted += t.produce * DT - g.outNow; g.emaWaste = ema(g.emaWaste, (t.produce * DT - g.outNow) / DT); }
    const mixIn = (p, keep) => {
      // (keep: energy staying in the part, carrying its own flavour; what arrives: p.inNow carrying p.inFlav (units of flavoured energy))
      let incoming = {}; if (p.inFlav && p.inNow > 0) for (const k in p.inFlav) incoming[k] = p.inFlav[k] / p.inNow;
      const t = T[p.type];
      if (t.scrub) incoming = {};
      if (t.combiner && p.inNow > 0) {
        // A Combiner flavours what passes through it with its feed network's mix, as far as the feed lasts
        const want = p.inNow * t.feedPerE, got = p.feedNet ? draw(p.feedNet, want) : {}, gotU = sumMix(got);
        if (gotU > 0) { const f = Math.min(1, gotU / want), mix = {}; for (const k in got) mix[k] = got[k] / gotU; incoming = blend(incoming, 1 - f, mix, f); }
        p.feedRate = gotU / DT;
      } else if (t.combiner) p.feedRate = 0;
      p.flav = blend(p.flav || {}, Math.max(0, keep), incoming, p.inNow);
    };
    for (const s of L.stores) { const keep = s.held - s.outNow; mixIn(s, keep); s.held += s.inNow - s.outNow; fromStores += s.outNow; toStores += s.inNow; }
    for (const p of L.consumers) { const k = T[p.type].kind; mixIn(p, p.stored); p.stored += p.inNow; if (k === 'weapon') toW += p.inNow; else if (k === 'engine') toE += p.inNow; else toU += p.inNow; }
    for (const p of L.alive) { p.emaIn = ema(p.emaIn, p.inNow / DT); p.emaOut = ema(p.emaOut, p.outNow / DT); }
    for (const l of L.links) l.ema = ema(l.ema, l.send / DT);
    // 4. Consumers act
    let dmg = 0, thrust = 0, shortW = 0, shortE = 0, shortU = 0;
    for (const p of L.weapons) {
      const t = T[p.type]; let d = 0; p.fx = null; p.feedShort = false;
      p.cd = Math.max(0, p.cd - DT); p.flash = Math.max(0, p.flash - DT); p.collapsed = Math.max(0, p.collapsed - DT);
      const wasClosed = p.closed > 0; p.closed = Math.max(0, p.closed - DT);
      if (p.frozen > 0) { p.frozen = Math.max(0, p.frozen - DT); p.on = false; p.dNow = 0; p.emaD = emaSlow(p.emaD, 0); p.rate = p.emaD / fullDps(t); continue; }
      // (Steady: a charge in progress collapses when less than the steady rate arrived this tick)
      if (t.steady && !wasClosed && p.stored > 1e-9 && p.stored < capOf(t) - t.passive * DT * 2 - 1e-9 && p.inNow < t.steady * DT * 0.98) { p.stored = 0; p.collapsed = 0.4; }
      // (A feed port: the shot's (or this tick's beam) feed, from the network at that port)
      const feedFor = (u) => {
        const fp = t.feedPort; if (!fp) return { ok: true, mix: {} };
        const n = p.feedNet, have = n ? netStock(n).total : 0;
        if (have < u - 1e-9) { p.feedShort = true; return { ok: !fp.required, mix: {} }; }
        const got = draw(n, u), gu = sumMix(got), mix = {}; for (const k in got) mix[k] = got[k] / gu; return { ok: true, mix };
      };
      const shotFx = (feedMix) => { const sh = Object.assign({}, p.flav || {}); for (const k in feedMix) sh[k] = Math.min(1, (sh[k] || 0) + feedMix[k]); p.shotMix = sh; return effects(sh, t.fxMul); };
      if (t.beam) {
        const need = t.burn * DT;
        if (!ctrl.fire) p.on = false; else if (!p.on && p.closed <= 0 && p.stored >= 0.5 * t.bufferE - 1e-9) p.on = true;
        if (p.on && p.stored >= need - 1e-9) {
          const fd = feedFor(t.feedPort ? t.feedPort.use * DT : 0);
          if (fd.ok) { p.stored -= need; p.fx = shotFx(fd.mix); d = t.dps * DT * p.fx.dmg; } else p.on = false;
        } else if (p.on) { p.on = false; if (t.rest) p.closed = t.rest; }
      } else {
        const ready = ctrl.fire && p.cd <= 1e-9 && p.stored >= t.shot - 1e-9 && !(t.clip && p.latched);
        if (t.clip && p.latched && p.stored >= capOf(t) - 1e-9) p.latched = false;
        if (ready) {
          const fd = feedFor(t.feedPort ? t.feedPort.use : 0);
          if (fd.ok) {
            p.fx = shotFx(fd.mix); p.stored -= t.shot; p.cd = t.cycle * p.fx.cycle; d = t.damage * p.fx.dmg; p.flash = 0.1;
            if (t.discharge) p.closed = t.discharge;
            if (t.clip && p.stored < t.shot - 1e-9) p.latched = true;
          }
        }
      }
      // (The passive drain after firing: a full buffer fires before it leaks)
      p.stored = Math.max(0, p.stored - t.passive * DT);
      p.dNow = d; p.emaD = emaSlow(p.emaD, d / DT); dmg += d;
      p.rate = p.emaD / fullDps(t);
      if (ctrl.fire) shortW += Math.max(0, t.intake * DT - p.inNow);
    }
    for (const p of L.engines) {
      const t = T[p.type]; let frac = 1;
      if (p.frozen > 0) { p.frozen = Math.max(0, p.frozen - DT); frac = 0; }
      else if (ctrl.thrust) { const need = t.burn * DT, use = Math.min(p.stored, need); p.stored -= use; frac = use / need; shortE += Math.max(0, Math.min(t.intake, t.burn) * DT - p.inNow); }
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

  // ================================================================ damage: destroy a part and let its blast or hazard run
  /** What a part does when it goes: a generator's blast; a store's charge (0.6 × held); a tank's hazard (by how full it
   * is); a pipe's or flavoured line's leak (a smaller share of its feed's hazard). {kind, r, dmg | s} or null */
  function blastOf(p) {
    const t = T[p.type];
    if (t.kind === 'gen' && t.blast) return Object.assign({ kind: 'blast' }, t.blast);
    if (t.kind === 'tank') { const h = FLUIDS[t.fluid].hazard, k = (p.fill ?? t.fill) / t.fill; return h && k > 0.05 ? scaleHazard(h, k) : null; }
    if (t.kind === 'pipe' && p.feedNet) { const { s, total } = netStock(p.feedNet); const top = Object.entries(s).sort((a, b) => b[1] - a[1])[0]; const h = top && FLUIDS[top[0]].hazard; return h && total > 1 ? scaleHazard(h, 0.35) : null; }
    if (t.kind === 'store') {
      const fl = Object.entries(p.flav || {}).sort((a, b) => b[1] - a[1])[0], h = fl && fl[1] > 0.2 && FLUIDS[fl[0]].hazard;
      if (!t.conduit && p.held > 1) return { kind: 'blast', r: Math.min(4.5, 1.5 + p.held / 300), dmg: 0.6 * p.held };
      if (h) return scaleHazard(h, 0.35 * fl[1]);
    }
    return null;
  }
  function scaleHazard(h, k) { const o = Object.assign({}, h); if (o.dmg) o.dmg *= k; if (o.s) o.s *= Math.max(0.3, k); o.r = Math.max(1.2, o.r * Math.sqrt(Math.max(0.3, k))); return o; }
  const isPower = (q) => { const k = T[q.type].kind; return k === 'gen' || k === 'store'; };
  /** Kill part p (and chain). Returns the parts that went, in order, each with what took it (null for the first) */
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
        if (b.kind === 'freeze') { const k = T[q.type].kind; if (k === 'weapon' || k === 'engine' || k === 'util') q.frozen = Math.max(q.frozen || 0, b.s); continue; }
        if (b.kind === 'arc' && !isPower(q)) continue;
        q.hp = (q.hp ?? T[q.type].hp) - b.dmg * (1 - d / b.r);
        if (q.hp <= 0) kill(q, from);
      }
    }
    return gone;
  }

  return { T, ORDER, CATS, COL, FLUIDS, FX_KEYS, SIDES, SIDE_V, OPP, DT, dims, rectCells, placeCell, placeSide, portsOf, feedsOf, build, tick, waterfill, capOf, fullDps,
    blastOf, destroy, netStock, draw, effects, blend };
});
