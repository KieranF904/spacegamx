// The ports model (docs/design/energy-ports-2026-11.md): parts with in and out ports on their edges, power crossing only
// out → in over a shared edge, a synchronous offer/accept tick, weapons with buffers and power profiles, blasts. On top,
// the feed layer: tanks of materials joined by pipes (which cross power lines only through Passthroughs), Selectors that
// switch which tank a line draws from, and Combiners that put a material onto a power line. A gun or engine that takes
// feed has a feed buffer beside its energy buffer; the material in it reshapes its stats (a sidegrade: something better,
// something worse). Anything that holds material holds one kind at a time and takes no other until it's empty.
// Plain script: ports.html uses it as window.PM; ports-model.test.mjs and the evolver's ports_score.cjs load it in node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.PM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ================================================================ materials (the feed layer)
  // Each is for weapons or engines, and multiplies some of the stats of what it's in: shot (energy a shot), damage, dps,
  // cycle, discharge, rest, burn, threshold, steady for weapons; thrust, burn, boost, boostDrain for engines. A part may
  // override them (feedMods: an engine built for feed takes far more from it). No hazards: a broken tank or pipe just
  // stops the feed.
  const MATS = {
    overcharge: { name: 'Overcharge slurry', short: 'Overcharge', col: '#ff8a3d', on: 'weapon', mod: { damage: 1.3, dps: 1.3, discharge: 0.5, shot: 1.4, burn: 1.4 },
      say: 'Hits 30% harder and halves the discharge, but each shot costs 40% more power.' },
    coolant: { name: 'Coolant', short: 'Coolant', col: '#7fd8ff', on: 'weapon', mod: { discharge: 0.5, rest: 0.5, damage: 0.85, dps: 0.85 },
      say: 'Halves discharge and rest, so the gun needs less buffering in front, but hits 15% softer.' },
    damping: { name: 'Damping gel', short: 'Damping', col: '#b58cff', on: 'weapon', mod: { threshold: 0.5, steady: 0.5, cycle: 1.25 },
      say: 'Halves the threshold and steady a gun needs, so a weak or shared line can feed it, but it cycles 25% slower.' },
    flux: { name: 'Flux salts', short: 'Flux', col: '#ffd166', on: 'weapon', mod: { shot: 0.7, burn: 0.7, damage: 0.85, dps: 0.85 },
      say: 'Shots cost 30% less power but hit 15% softer: more shots from the same reactors.' },
    accelerant: { name: 'Accelerant', short: 'Accelerant', col: '#ff5fa2', on: 'weapon', mod: { cycle: 0.7, shot: 1.25, threshold: 1.5 },
      say: 'Fires 30% faster, but each shot costs 25% more and it needs a 50% stronger line.' },
    lens: { name: 'Lens fluid', short: 'Lens', col: '#9effa1', on: 'weapon', mod: { burn: 0.75, dps: 0.9, rest: 1.5 },
      say: 'Beams: burn 25% less while lit (longer bursts from the same buffer), 10% less damage, and rest half again as long.' },
    catalyst: { name: 'Catalyst', short: 'Catalyst', col: '#4ade80', on: 'engine', mod: { burn: 0.6, thrust: 0.85 },
      say: 'Engines use 40% less power for 15% less thrust: power freed for the guns.' },
    reaction: { name: 'Reaction mass', short: 'Reaction', col: '#e8e3d6', on: 'engine', mod: { thrust: 1.4 },
      say: '40% more thrust for the same power, but it goes fast.' },
    burstgel: { name: 'Burst gel', short: 'Burst gel', col: '#f5a83a', on: 'engine', mod: { boost: 1.5, boostDrain: 0.5, thrust: 0.9 },
      say: 'Boost half again as strong for half the extra draw; cruising 10% weaker.' },
  };
  const BOOST_DRAW = 2.2;          // (boosting draws × (1 + this × boostDrain), as the game's tuning)
  const MRATE = 30;                // (material moves at most this much a second across a link or from a network)

  // ================================================================ parts
  // Ports in the part's own frame, unrotated: N is the nose. [dir, side, cell, rate]: cell counts from the W end of a N or S
  // side and from the N end of a W or E side. feed: the part's feed points ([side, cell]), where pipes, tanks and feed
  // ports join (both sides of an edge must have one).
  const T = {}, ORDER = [];
  const CATS = ['Core and hull', 'Generators', 'Stores and conduits', 'Weapons', 'Engines and shields', 'Feed'];
  const COL = { core: '#e8e3d6', hull: '#4b5660', armor: '#6e7a84', gen: '#38bdf8', store: '#4ade80', cap: '#f5a83a', conduit: '#a7b4be',
    weapon: '#ef5f55', engine: '#3fb0e0', util: '#4fbfb2', pipe: '#a77bdc', feedgun: '#e2608f', feedengine: '#8fd3c9' };
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

  // Lines (conduit: true) hold a few ticks of power and, on a combined line, a little material: they carry it on to the next
  // line or to a gun that takes it. Stores with real holds (batteries, capacitors, banks) carry power only.
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
  //   burst      a beam whose ports are shut while it's lit: it lights only when full, burns its whole buffer, rests,
  //              then recharges. How fast it recharges is what its lines (and any store in front) decide
  //   threshold  it takes power only from lines rated at least this much together: one weak line gives it nothing
  //   steady     while charging, if what arrives in a tick falls below this rate the charge collapses (back to nothing)
  //   clip       a magazine: fires its rounds, then refills the whole clip before firing again
  // Feed: takes (the materials it accepts: none for most), feedUse (a shot, or a second while lit or thrusting), feedBuf
  // (its feed buffer), feedPort (its own feed input: {side, cell, required}); without one it takes material from a
  // combined line through its power ports.
  const gun = (o) => def(Object.assign({ cat: 3, kind: 'weapon', col: COL.weapon, passive: 0, buffer: 1, mass: 1.2, discharge: 0, rest: 0, threshold: 0, steady: 0, burst: false, takes: [] }, o));
  gun({ id: 'pip', name: 'Pip', lvl: 0, hp: 60, ports: [I('S', 20)], shot: 10, cycle: 0.5, damage: 28,
    say: 'The starter gun: takes power from anything, at any rate.' });
  gun({ id: 'glint', name: 'Glint', lvl: 9, hp: 60, ports: [I('S', 35)], shot: 28, cycle: 0.8, damage: 43, discharge: 0.3,
    say: 'A pulse laser: its port shuts for 0.3 s after each shot.' });
  gun({ id: 'hammer', name: 'Hammer', lvl: 6, w: 2, hp: 120, ports: [I('S', 70, 0)], shot: 70, cycle: 1.0, damage: 69, threshold: 45,
    say: 'A heavy cannon: it takes power only from lines rated at least 45, so one reactor gives it nothing.' });
  gun({ id: 'cutter', name: 'Cutter', lvl: 18, w: 2, hp: 130, ports: [I('S', 45, 0), I('S', 45, 1)], beam: true, burn: 90, bufferE: 180, dps: 150, passive: 5, rest: 1.5, burst: true,
    takes: ['lens', 'coolant'], feedUse: 1, feedBuf: 12,
    say: 'A burst beam: lights when full, burns its 180 in 2 s with its ports shut, rests 1.5 s, then recharges. Takes Lens fluid or Coolant on a combined line.' });
  gun({ id: 'longbarrel', name: 'Longbarrel', lvl: 20, w: 2, hp: 150, ports: [I('S', 55, 0), I('S', 55, 1)], shot: 220, cycle: 2.0, damage: 96, discharge: 1.0,
    takes: ['overcharge', 'coolant', 'flux'], feedUse: 1, feedBuf: 10,
    say: 'A long gun: its ports shut for 1 s after each shot, so a buffer behind it wins back that second. Takes Overcharge, Coolant or Flux on a combined line.' });
  gun({ id: 'spear', name: 'Spear', lvl: 28, w: 2, h: 2, hp: 240, ports: [I('S', 45, 0), I('S', 45, 1)], shot: 180, cycle: 2.0, buffer: 2, damage: 170, passive: 10, steady: 50,
    takes: ['damping', 'overcharge'], feedUse: 1.5, feedBuf: 15,
    say: 'A rail gun: while charging it needs at least 50 a second without a break, or the charge collapses. Takes Damping gel or Overcharge.' });
  gun({ id: 'bastion', name: 'Bastion', lvl: 30, w: 2, h: 2, hp: 300, ports: [I('S', 55, 0), I('S', 55, 1), I('W', 55, 1), I('E', 55, 1)], shot: 60, cycle: 0.25, buffer: 16, clip: true, damage: 28, passive: 15,
    say: 'A heavy repeater: a 16-round clip, refilled whole once empty, from four lines.' });
  gun({ id: 'lance', name: 'Lance', lvl: 32, w: 2, hp: 200, ports: [I('S', 150, 0), I('S', 150, 1)], beam: true, burn: 300, bufferE: 600, dps: 210, passive: 40, rest: 2, burst: true,
    takes: ['lens', 'coolant'], feedUse: 3, feedBuf: 30,
    say: 'The big burst beam: lights when full, burns its 600 in 2 s with its ports shut, rests 2 s, then recharges (it leaks 40 a second). Takes Lens fluid or Coolant.' });
  // The embedded superweapon: six lines of 60, from the back and both flanks, so the ship is built around it
  gun({ id: 'sunbreaker', name: 'Sunbreaker', lvl: 34, w: 3, h: 3, hp: 600, mass: 12, armour: 2, isNew: true,
    ports: [I('S', 60, 0), I('S', 60, 2), I('W', 60, 1), I('W', 60, 2), I('E', 60, 1), I('E', 60, 2)], shot: 600, cycle: 3.0, damage: 900, passive: 150, discharge: 1.0,
    takes: ['overcharge', 'coolant', 'damping'], feedUse: 4, feedBuf: 40,
    say: 'Six lines in at 60, from the back and both flanks: the ship is built around it. It leaks 150 a second (three lines to charge at all) and shuts for 1 s after each shot. Takes Overcharge, Coolant or Damping.' });
  // A gun with two inputs: power at its back left, its own feed port at its back right
  gun({ id: 'slurry_cannon', name: 'Slurry Cannon', lvl: 16, w: 2, hp: 140, col: COL.feedgun, isNew: true, ports: [I('S', 60, 0)], shot: 90, cycle: 1.5, damage: 110, threshold: 40,
    feedPort: { side: 'S', cell: 1, required: true }, takes: ['overcharge', 'accelerant', 'flux'], feedUse: 2, feedBuf: 20,
    say: 'Two inputs: power at its back left (lines rated 40 or more), feed at its back right, and it fires only with feed (2 a shell). Takes Overcharge, Accelerant or Flux.' });

  // Engines burn from a buffer that refills through their ports; empty, they run at intake ÷ burn. Boost multiplies thrust
  // (boost) and draws more (burn × (1 + 2.2 × boostDrain)). Shields draw a flat rate.
  const engine = (o) => def(Object.assign({ cat: 4, kind: 'engine', col: COL.engine, boost: 1, boostDrain: 0, takes: [] }, o));
  engine({ id: 'ion', name: 'Ion Drive', hp: 50, lvl: 0, ports: [I('N', 12)], burn: 9, buffer: 30, thrust: 2.26, rated: 34, boost: 2, boostDrain: 1,
    say: 'Full thrust burns 9 a second from a 30 buffer that refills at 12. Boosts to double thrust.' });
  engine({ id: 'plasma', name: 'Plasma Drive', w: 2, hp: 110, lvl: 16, ports: [I('N', 25, 0), I('N', 25, 1)], burn: 40, buffer: 120, thrust: 6.2, rated: 55, boost: 1.8, boostDrain: 0.8,
    takes: ['catalyst', 'reaction'], feedUse: 1, feedBuf: 20,
    say: 'Full thrust burns 40 a second; two lines of 25 refill it. Takes Catalyst or Reaction mass on a combined line.' });
  // Built for the feed layer: on power alone it barely pushes; fed, it is a strong engine that hardly touches the power
  engine({ id: 'reaction_thruster', name: 'Reaction Thruster', hp: 60, lvl: 12, isNew: true, col: COL.feedengine, ports: [I('N', 6)], burn: 4, buffer: 12, thrust: 1.0, rated: 60,
    feedPort: { side: 'W', cell: 0, required: false }, takes: ['reaction', 'catalyst', 'burstgel'], feedUse: 1.2, feedBuf: 20,
    feedMods: { reaction: { thrust: 5 }, catalyst: { burn: 0.25, thrust: 2.5 }, burstgel: { thrust: 2.2, boost: 2.5 } },
    say: 'Built for feed: on power alone it pushes 1.0 for 4 a second; on Reaction mass 5.0 for the same 4 (1.2 feed a second). Feed point on its left.' });
  def({ id: 'deflector', name: 'Deflector', cat: 4, kind: 'util', hp: 56, col: COL.util, lvl: 11, ports: [I('S', 16)], e: 16, say: 'Draws 16 a second while shields are on.' });

  // The feed layer. Tanks hold one material; touching tanks of it join. Pipes join anything with a feed point, any side;
  // they cross a power line only through a Passthrough. A Selector passes one of its two inputs (the pilot switches). A
  // Combiner takes power at its back and material on its side and gives one combined line.
  for (const [mid, m] of Object.entries(MATS))
    def({ id: 'tank_' + mid, name: 'Tank: ' + m.short, cat: 5, kind: 'tank', fluid: mid, fill: 120, hp: 55, mass: 1.5, col: m.col, lvl: m.on === 'engine' ? 10 : 14, isNew: true, feed: ALL4,
      say: `Holds 120 ${m.name.toLowerCase()} for the feed lines touching it. ${m.say}` });
  def({ id: 'pipe', name: 'Feed pipe', cat: 5, kind: 'pipe', hp: 30, mass: 0.8, col: COL.pipe, lvl: 10, isNew: true, feed: ALL4,
    say: 'Carries feed between whatever touches it, any side. It can\'t cross a power line: use a Passthrough there.' });
  def({ id: 'passthrough', name: 'Passthrough', cat: 5, kind: 'store', conduit: true, hold: 10, hp: 45, mass: 0.8, col: COL.pipe, lvl: 10, isNew: true,
    ports: [I('S', 200), O('N', 200)], feed: [['E', 0], ['W', 0]],
    say: 'A power line (back to front) with a feed pipe crossing it (side to side): where the two networks cross.' });
  def({ id: 'combiner', name: 'Combiner', cat: 5, kind: 'store', conduit: true, combiner: true, hold: 10, hp: 140, mass: 1.5, col: COL.pipe, lvl: 10, isNew: true,
    ports: [I('S', 150), O('N', 150)], feed: [['W', 0]], matCap: 4,
    say: 'Power in at the back, feed on the left, one combined line out the front. Lines carry the material on (one kind at a time); batteries and capacitors don\'t, so put the Combiner after them. Tough, and it holds no charge.' });
  def({ id: 'selector', name: 'Selector', cat: 5, kind: 'selector', hp: 60, mass: 1, col: COL.pipe, lvl: 25, isNew: true, feed: [['W', 0], ['E', 0], ['N', 0]],
    say: 'Two feed inputs (its sides) and one output (its front): it passes one input at a time. Switch feeds flips it; what\'s already down the line runs out first.' });

  // Credits, armour (against the pen of what hits it) and a gun's pen (against the enemy's armour): first guesses, for the
  // evolver's budget and hit runs; the lab shows them but its tick doesn't use them
  const COST = { core: 0, hull: 9, armor: 18, cell_reactor: 35, twin_reactor: 60, isotope: 70, fusion: 500, overclock: 700, stellarator: 1400,
    conduit: 10, corner: 10, cell_battery: 40, joiner: 90, splitter: 90, capacitor: 60, surge_cell: 120, drive_cell: 80, flux_coil: 300, heavy_bank: 400, cap_array: 600,
    pip: 21, glint: 100, hammer: 110, cutter: 170, longbarrel: 300, spear: 600, bastion: 900, lance: 1200, sunbreaker: 2500, slurry_cannon: 260,
    ion: 21, plasma: 210, reaction_thruster: 90, deflector: 140, pipe: 8, passthrough: 30, combiner: 120, selector: 200 };
  const ARMOUR = { armor: 2, isotope: 2, fusion: 2, heavy_bank: 2, stellarator: 2, spear: 2, bastion: 2, combiner: 2 };
  const PEN = { pip: 1, glint: 1, hammer: 2, cutter: 2, longbarrel: 3, spear: 4, bastion: 3, lance: 4, sunbreaker: 5, slurry_cannon: 2 };
  for (const id of ORDER) {
    const t = T[id];
    t.cost ??= COST[id] ?? (t.kind === 'tank' ? 40 : 0); t.armour ??= ARMOUR[id] ?? 1; if (t.kind === 'weapon') t.pen ??= PEN[id] ?? 1;
    t.intake = t.ports.filter((p) => p.dir === 'in').reduce((s, p) => s + p.rate, 0);
    t.produce = t.ports.filter((p) => p.dir === 'out').reduce((s, p) => s + p.rate, 0);
    if (t.kind === 'weapon' && !t.beam) t.damage = t.damage || 1;
    if (t.feedPort) t.feed = [{ side: t.feedPort.side, cell: t.feedPort.cell }];
    t.takes ??= [];
    if (t.takes.length) { t.feedUse ??= 1; t.feedBuf ??= 10 * t.feedUse; }
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
  /** Every feed point of a placed part in world terms (a Selector's: index 0 and 1 its inputs, 2 its output) */
  function feedsOf(p) { return T[p.type].feed.map((q, i) => Object.assign({ local: q, i }, edgeOf(p, q.side, q.cell))); }

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
      if (t.kind === 'selector') p.sel ??= 0;
      p.mat ??= null; p.matAmt ??= 0; p.cd ??= 0; p.on ??= false; p.flash ??= 0; p.emaIn ??= 0; p.emaOut ??= 0; p.emaWaste ??= 0; p.emaD ??= 0; p.sat ??= 1; p.rate ??= 0;
      p.thrustNow ??= 0; p.latched ??= false; p.closed ??= 0; p.collapsed ??= 0;
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
    // Feed networks: parts joined where both sides of an edge have a feed point. Touching tanks of different materials
    // don't join (a pipe between them does). A Selector joins nothing: each of its points belongs to the network beyond it
    const parent = new Map();
    const find = (p) => { while (parent.get(p) !== p) { parent.set(p, parent.get(parent.get(p))); p = parent.get(p); } return p; };
    for (const p of alive) if (p.feeds.length && T[p.type].kind !== 'selector') parent.set(p, p);
    for (const a of alive) for (const fa of a.feeds) {
      fa.joined = null;
      const b = fa.nx >= 0 && fa.ny >= 0 && fa.nx < GW && fa.ny < GH ? occ[key(fa.nx, fa.ny)] : null;
      if (!b || b === a || !b.feeds.length) continue;
      if (!b.feeds.some((q) => q.x === fa.nx && q.y === fa.ny && q.side === OPP[fa.side])) continue;
      const ta = T[a.type], tb = T[b.type];
      if (ta.kind === 'tank' && tb.kind === 'tank' && ta.fluid !== tb.fluid) continue;
      fa.joined = b;
      if (ta.kind === 'selector' || tb.kind === 'selector') continue;
      const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb);
    }
    const nets = new Map(), feedNets = [];
    for (const p of parent.keys()) {
      const r = find(p);
      if (!nets.has(r)) { const n = { parts: [], tanks: [], users: [], selectors: [] }; nets.set(r, n); feedNets.push(n); }
      const n = nets.get(r); n.parts.push(p); p.feedNet = n;
      const t = T[p.type];
      if (t.kind === 'tank') n.tanks.push(p); else if (t.combiner || t.feedPort) n.users.push(p);
    }
    const by = (k) => alive.filter((p) => T[p.type].kind === k);
    const selectors = by('selector');
    for (const s of selectors) {
      s.ins = [0, 1].map((i) => { const j = s.feeds[i].joined; return j && j.feedNet ? j.feedNet : null; });
      const o = s.feeds[2].joined; s.outNet = o && o.feedNet ? o.feedNet : null;
      if (s.outNet) s.outNet.selectors.push(s);
    }
    const consumers = [...by('weapon'), ...by('engine'), ...by('util')], stores = by('store');
    return { GW, GH, occ, key, alive, links, opens, clashes, feedNets, selectors, gens: by('gen'), stores, weapons: by('weapon'), engines: by('engine'), utils: by('util'),
      tanks: by('tank'), consumers, takers: [...stores, ...consumers], carriers: stores.filter((s) => T[s.type].conduit) };
  }

  // ================================================================ feed
  /** What a feed network holds: {material: units}, and the total */
  function netStock(n) { const s = {}; let total = 0; if (n) for (const t of n.tanks) { const f = T[t.type].fluid; s[f] = (s[f] || 0) + t.fill; total += t.fill; } return { s, total }; }
  /** What a network can give right now: its own tanks' material (the most plentiful, if it mixes kinds), or, with no tank
   * of its own, what the Selector feeding it passes. {mat, net (whose tanks), amt} or null */
  function supply(n, depth = 0) {
    if (!n || depth > 6) return null;
    const { s } = netStock(n);
    const top = Object.entries(s).filter(([, v]) => v > 1e-6).sort((a, b) => b[1] - a[1])[0];
    if (top) return { mat: top[0], net: n, amt: top[1] };
    for (const sel of n.selectors) { const r = supply(sel.ins[sel.sel], depth + 1); if (r) return r; }
    return null;
  }
  /** Take up to u of material m from a network's tanks of it, in proportion. Returns what it got */
  function drawMat(n, m, u) {
    const tanks = n.tanks.filter((t) => T[t.type].fluid === m && t.fill > 0), have = tanks.reduce((a, t) => a + t.fill, 0);
    if (have <= 1e-9 || u <= 0) return 0;
    const k = Math.min(1, u / have); for (const t of tanks) t.fill -= t.fill * k;
    return Math.min(u, have);
  }
  /** May part p take material m into its material buffer now? (one kind at a time; a gun or engine only what it takes) */
  function accepts(p, m) {
    const t = T[p.type];
    if (p.matAmt > 1e-9 && p.mat !== m) return false;
    if (t.kind === 'weapon' || t.kind === 'engine') return t.takes.includes(m);
    return true;
  }
  const matCap = (p) => { const t = T[p.type]; return t.kind === 'weapon' || t.kind === 'engine' ? t.feedBuf || 0 : t.combiner ? t.matCap : t.conduit ? 2 : 0; };
  /** A part's stats with its material applied, if it holds enough for its next use: the part type itself otherwise */
  const EFF = new Map();
  function eff(p) {
    const t = T[p.type];
    if (!t.takes.length || !p.mat || p.matAmt < (t.feedUse || 1) * (t.beam || t.kind === 'engine' ? 1 / 60 : 1) - 1e-9 || !t.takes.includes(p.mat)) return t;
    const k = t.id + '|' + p.mat;
    if (!EFF.has(k)) {
      const o = Object.assign({}, t), mods = Object.assign({}, MATS[p.mat].mod, (t.feedMods || {})[p.mat] || {});
      for (const [s, v] of Object.entries(mods)) if (typeof t[s] === 'number') o[s] = t[s] * v;
      o.fed = p.mat; EFF.set(k, o);
    }
    return EFF.get(k);
  }
  /** Empty every gun's, engine's and line's material (the Purge button): whatever comes next can come in at once */
  function purge(L) { for (const p of L.alive) { p.matAmt = 0; p.mat = null; } }
  /** Flip every Selector to its other input (the Switch feeds button) */
  function switchFeeds(L) { for (const s of L.selectors) s.sel = 1 - s.sel; }

  // ================================================================ the tick
  const DEF_DT = 1 / 60, DT = DEF_DT, TAU = 1.5;
  function waterfill(wants, supplyAmt) {
    const out = new Array(wants.length).fill(0);
    const idx = wants.map((_, i) => i).filter((i) => wants[i] > 1e-12).sort((a, b) => wants[a] - wants[b]);
    let left = Math.max(0, supplyAmt), k = idx.length;
    for (const i of idx) { const g = Math.min(wants[i], left / k); out[i] = g; left -= g; k--; }
    return out;
  }
  const capOf = (t) => (t.beam ? t.bufferE : t.shot * t.buffer);
  /** How much a taker will accept this tick: its space, or nothing while its ports are shut (discharge, rest, a lit burst beam) */
  function spaceOf(p) {
    const t = T[p.type];
    if (t.kind === 'store') return t.hold - p.held;
    const E = eff(p);
    if (p.closed > 0 || (t.burst && p.on)) return 0;
    return t.kind === 'weapon' ? capOf(E) - p.stored : t.kind === 'engine' ? t.buffer - p.stored : t.e - p.stored;
  }
  /** Damage a second at full supply (no feed): the cycle, or the time to charge a shot after the ports reopen, whichever is
   * longer. A burst beam: lit for buffer ÷ burn, then the rest, then the recharge at its lines' full rate */
  function fullDps(t) {
    if (t.beam && t.burst) { const on = t.bufferE / t.burn, re = t.bufferE / Math.max(1e-9, t.intake - t.passive); return t.dps * on / (on + (t.rest || 0) + re); }
    if (t.beam) return t.dps;
    return t.damage / Math.max(t.cycle, (t.discharge || 0) + t.shot / Math.max(1e-9, t.intake - t.passive));
  }

  /** Material moves: from each network into the Combiners and feed ports on it, then along combined lines (line to line,
   * and line into a gun or engine that takes it). One kind at a time everywhere: a part holding one kind refuses another */
  function moveMaterial(L, DT) {
    const step = MRATE * DT;
    for (const p of L.alive) {
      const t = T[p.type];
      if (!(t.combiner || t.feedPort) || !p.feedNet) continue;
      const room = matCap(p) - p.matAmt; if (room <= 1e-9) continue;
      const sup = supply(p.feedNet); if (!sup || !accepts(p, sup.mat)) { p.feedRefused = sup ? sup.mat : null; continue; }
      p.feedRefused = null;
      const got = drawMat(sup.net, sup.mat, Math.min(room, step)); if (got > 0) { p.mat = sup.mat; p.matAmt += got; }
    }
    for (const l of L.links) {
      l.matBlocked = false;
      const a = l.from; if (!T[a.type].conduit || a.matAmt <= 1e-9) continue;
      const b = l.to, tb = T[b.type];
      const carries = tb.conduit || ((tb.kind === 'weapon' || tb.kind === 'engine') && !tb.feedPort && tb.takes.length);
      if (!carries || !accepts(b, a.mat)) { l.matBlocked = true; continue; }
      const mv = Math.min(a.matAmt / Math.max(1, a.outL.length), matCap(b) - b.matAmt, step);
      if (mv > 1e-9) { b.mat = a.mat; b.matAmt += mv; a.matAmt -= mv; if (a.matAmt <= 1e-9) { a.matAmt = 0; } }
    }
  }

  /** One tick of dt seconds (default 1/60; the evolver uses 1/20, the most a 10-held conduit's 200 a second allows).
   * ctrl: {fire, thrust, boost, util}. Returns this tick's totals (E/s). Mutates part state and link.send */
  function tick(L, ctrl, ticks, dt) {
    const DT = dt || DEF_DT;
    const ema = (cur, v) => cur + (v - cur) * Math.max(DT / TAU, 1 / (ticks + 1));
    const emaSlow = (cur, v) => cur + (v - cur) * (DT / 5);
    // 1. Offer: generators the cap on every link; stores what they hold, water-filled over their out links
    for (const l of L.links) l.offer = 0;
    for (const g of L.gens) for (const l of g.outL) l.offer = l.cap * DT;
    for (const s of L.stores) { const outs = s.outL; if (!outs.length) continue; if (outs.length === 1) { outs[0].offer = Math.min(outs[0].cap * DT, s.held); continue; } const a = waterfill(outs.map((l) => l.cap * DT), s.held); outs.forEach((l, i) => { l.offer = a[i]; }); }
    // 2. Accept: each taker up to the space left, water-filled over its in links. A gun with a threshold takes nothing
    // unless the lines offering it power are rated at least that much together (a link's rating: the lower of its two ports)
    for (const l of L.links) l.send = 0;
    for (const p of L.takers) {
      const ins = p.inL; if (!ins.length) continue;
      const E = eff(p);
      let space = Math.max(0, spaceOf(p));
      if (E.threshold && ins.reduce((s, l) => s + (l.offer > 1e-12 ? l.cap : 0), 0) < E.threshold - 1e-9) space = 0;
      if (ins.length === 1) { ins[0].send = Math.min(ins[0].offer, space); continue; }
      const a = waterfill(ins.map((l) => l.offer), space);
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
    moveMaterial(L, DT);
    // 4. Consumers act, each with its material's stats while it holds enough for its next use
    let dmg = 0, thrust = 0, shortW = 0, shortE = 0, shortU = 0;
    for (const p of L.weapons) {
      const t = T[p.type]; let d = 0; p.shotMat = null;
      p.cd = Math.max(0, p.cd - DT); p.flash = Math.max(0, p.flash - DT); p.collapsed = Math.max(0, p.collapsed - DT);
      const wasClosed = p.closed > 0; p.closed = Math.max(0, p.closed - DT);
      const E = eff(p), fed = E !== t, need = t.feedPort && t.feedPort.required;
      // (Steady: a charge in progress collapses when less than the steady rate arrived this tick)
      if (E.steady && !wasClosed && p.stored > 1e-9 && p.stored < capOf(E) - t.passive * DT * 2 - 1e-9 && p.inNow < E.steady * DT * 0.98) { p.stored = 0; p.collapsed = 0.4; }
      if (t.beam) {
        const burn = E.burn * DT;
        const light = t.burst ? E.bufferE - t.passive * DT * 2 - 1e-6 : 0.5 * E.bufferE - 1e-9;
        if (!ctrl.fire) p.on = false; else if (!p.on && p.closed <= 0 && p.stored >= light && (!need || fed)) p.on = true;
        if (p.on && p.stored >= burn - 1e-9 && (!need || fed)) {
          p.stored -= burn; d = E.dps * DT;
          if (fed) { p.matAmt = Math.max(0, p.matAmt - t.feedUse * DT); p.shotMat = p.mat; }
        } else if (p.on) { p.on = false; if (E.rest) p.closed = E.rest; }
      } else {
        if (t.clip && p.latched && p.stored >= capOf(E) - 1e-9) p.latched = false;
        if (ctrl.fire && p.cd <= 1e-9 && p.stored >= E.shot - 1e-9 && !(t.clip && p.latched) && (!need || fed)) {
          p.stored -= E.shot; p.cd = E.cycle; d = E.damage; p.flash = 0.1;
          if (fed) { p.matAmt = Math.max(0, p.matAmt - t.feedUse); p.shotMat = p.mat; p.lastMat = p.mat; } else p.lastMat = null;
          if (E.discharge) p.closed = E.discharge;
          if (t.clip && p.stored < E.shot - 1e-9) p.latched = true;
        }
      }
      if (p.matAmt <= 1e-9) { p.matAmt = 0; p.mat = null; }
      // (The passive drain after firing: a full buffer fires before it leaks)
      p.stored = Math.max(0, p.stored - t.passive * DT);
      p.dNow = d; p.emaD = emaSlow(p.emaD, d / DT); dmg += d;
      p.rate = p.emaD / fullDps(t);
      if (ctrl.fire) shortW += Math.max(0, t.intake * DT - p.inNow);
    }
    for (const p of L.engines) {
      const t = T[p.type], E = eff(p), fed = E !== t; let frac = 1;
      const boost = !!ctrl.boost, mul = boost ? E.boost : 1, burnRate = E.burn * (boost ? 1 + BOOST_DRAW * E.boostDrain : 1);
      if (ctrl.thrust) {
        const need = burnRate * DT, use = Math.min(p.stored, need); p.stored -= use; frac = need > 0 ? use / need : 1;
        shortE += Math.max(0, Math.min(t.intake, burnRate) * DT - p.inNow);
        if (fed) p.matAmt = Math.max(0, p.matAmt - t.feedUse * DT);
      }
      if (p.matAmt <= 1e-9) { p.matAmt = 0; p.mat = null; }
      p.sat = ctrl.thrust ? frac : 1; p.thrustNow = ctrl.thrust ? E.thrust * mul * frac : 0; p.burnNow = ctrl.thrust ? burnRate : 0; thrust += p.thrustNow;
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
  /** A generator's blast, or a charged store's (0.6 × held); anything else just breaks. Feed parts have no hazards */
  function blastOf(p) {
    const t = T[p.type];
    if (t.kind === 'gen' && t.blast) return Object.assign({ kind: 'blast' }, t.blast);
    if (t.kind === 'store' && !t.conduit && p.held > 1) return { kind: 'blast', r: Math.min(4.5, 1.5 + p.held / 300), dmg: 0.6 * p.held };
    return null;
  }
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
        q.hp = (q.hp ?? T[q.type].hp) - b.dmg * (1 - d / b.r);
        if (q.hp <= 0) kill(q, from);
      }
    }
    return gone;
  }

  return { T, ORDER, CATS, COL, MATS, FLUIDS: MATS, SIDES, SIDE_V, OPP, DT, dims, rectCells, placeCell, placeSide, portsOf, feedsOf, build, tick, waterfill, capOf, fullDps,
    blastOf, destroy, netStock, supply, drawMat, accepts, eff, purge, switchFeeds, matCap };
});
