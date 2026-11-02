// The example layouts for ports.html (and ports-model.test.mjs). [type, x, y, rot, flip]: rot in quarter turns clockwise.
// Unrotated: generators give N (up the screen), stores take S and give N, guns take S, engines take N.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.PM_EXAMPLES = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const R = (type, x, y, rot, flip) => [type, x, y, rot || 0, !!flip];
  return [
    {
      name: '1. Starter: two reactors into the core',
      about: 'Each reactor gives one line of 30 into a core in port (60 each). The core gives fore to the Pips and aft to the Ion Drives. Turn Thrust on: 64 wanted, 60 arriving, so the core slowly empties and everything runs a little short. Add a third reactor and see that there is nowhere to plug it in.',
      parts: [R('core', 7, 6), R('cell_reactor', 6, 6, 1), R('cell_reactor', 9, 6, 3), R('pip', 7, 5), R('pip', 8, 5), R('ion', 7, 7), R('ion', 8, 7)],
    },
    {
      name: '2. A Hammer needs two reactors',
      about: 'The Hammer takes 70 a second through one port, and only from a line rated at least 45 (its threshold). A reactor’s line is 30, so a reactor against it gives it nothing at all. A Joiner Bank takes two reactors in at 40 each and gives one line out at 90. Erase one reactor (X, then click it): the bank still qualifies, so the Hammer keeps firing, at the 30 one reactor makes. Then try a reactor straight under the Hammer.',
      parts: [R('hammer', 7, 4), R('joiner', 7, 5), R('cell_reactor', 7, 6), R('cell_reactor', 8, 6),
        R('core', 7, 8), R('cell_reactor', 6, 8, 1), R('ion', 7, 9), R('ion', 8, 9), R('hull', 7, 7), R('hull', 8, 7)],
    },
    {
      name: '3. Two Glints on one plant',
      about: 'A Fusion Plant gives two lines of 60. A Joiner Bank takes them (40 each, so 40 of the plant is wasted: hover the plant) and gives one line of 90 to a Splitter Bank, which gives 45 to each Glint. Glints shut their port for 0.3 s after each shot, so they draw less than 45 and the banks fill: more waste. Swap the Joiner for a Flux Coil to stop the plant’s share of it.',
      parts: [R('glint', 7, 4), R('glint', 8, 4), R('splitter', 7, 5), R('joiner', 7, 6), R('fusion', 7, 7),
        R('core', 7, 9), R('cell_reactor', 6, 9, 1), R('ion', 7, 10), R('ion', 8, 10)],
    },
    {
      name: '4. Alpha: a Longbarrel on Capacitors',
      about: 'Left: two Capacitors under the Longbarrel, each fed by a reactor. Charged, they pay the 220 shot at once, so the first shots come at the full 2 s cycle; then the reactors set the pace (one every 3.7 s). Right: the same gun straight on its reactors, with no alpha. Set Fire to Bursts and compare: the capacitors refill in the gaps.',
      parts: [R('longbarrel', 4, 4), R('capacitor', 4, 5), R('capacitor', 5, 5), R('cell_reactor', 4, 6), R('cell_reactor', 5, 6),
        R('longbarrel', 10, 4), R('cell_reactor', 10, 5), R('cell_reactor', 11, 5),
        R('core', 7, 8), R('cell_reactor', 6, 8, 1), R('cell_reactor', 9, 8, 3), R('ion', 7, 9), R('ion', 8, 9)],
    },
    {
      name: '5. Passive drain and steady: a Spear and a Lance on reactors',
      about: 'The Spear leaks 10 a second and is steady: while charging it needs 50 a second without a break or the charge collapses. On two reactors (60) it fills at 50 net: a 180 shot every 3.6 s. Erase one reactor and it never fires: 30 is under its steady 50, so each charge collapses (it flashes). The Lance leaks 40: on one reactor it never charges at all.',
      parts: [R('spear', 3, 3), R('cell_reactor', 3, 5), R('cell_reactor', 4, 5), R('lance', 9, 4), R('cell_reactor', 9, 5),
        R('core', 7, 8), R('cell_reactor', 6, 8, 1), R('cell_reactor', 9, 8, 3), R('ion', 7, 9), R('ion', 8, 9)],
    },
    {
      name: '6. A superweapon and its ship',
      about: 'A Lance is a burst beam: it lights only when full, burns its 600 in 2 s with its ports shut, rests 2 s, then recharges (and leaks 40 a second all the while). Two Fusion Plants on the flanks and four reactors through two Joiner Banks fill a Capacitor Array (six lines in, 360) that pours 1,200 a second into it, so it recharges in about 2 s. The array refills far faster than the Lance needs, so cutting a line or two costs little: the six ports are its redundancy. Break (B) the array and the Lance goes out: that is the part to bury.',
      parts: [R('lance', 7, 3), R('cap_array', 7, 4),
        R('joiner', 6, 6, 0, true), R('joiner', 8, 6), R('cell_reactor', 6, 7), R('cell_reactor', 7, 7), R('cell_reactor', 8, 7), R('cell_reactor', 9, 7),
        R('fusion', 4, 4, 1), R('conduit', 6, 4, 1), R('conduit', 6, 5, 1),
        R('fusion', 10, 4, 3), R('conduit', 9, 4, 3), R('conduit', 9, 5, 3),
        R('core', 7, 8), R('cell_reactor', 6, 8, 1), R('cell_reactor', 9, 8, 3), R('ion', 7, 9), R('ion', 8, 9)],
    },
    {
      name: '7. Engines round a corner',
      about: 'The core gives aft into two Drive Cells (turned about, so they take from the front). Corner conduits carry their lines out to Ion Drives on the flanks, each turned to take from the inboard side. Drive Cells give 250 a second: engines on them keep full thrust from a charge while the reactors only feed 60.',
      parts: [R('core', 7, 6), R('cell_reactor', 6, 6, 1), R('cell_reactor', 9, 6, 3), R('pip', 7, 5), R('pip', 8, 5),
        R('drive_cell', 7, 7, 2), R('drive_cell', 8, 7, 2), R('corner', 7, 8, 2), R('corner', 8, 8, 2, true), R('ion', 6, 8, 1), R('ion', 9, 8, 3)],
    },
    {
      name: '8. Chain reaction',
      about: 'Six Pips, each on its own reactor, packed in a row. Choose Break (B) and click the middle reactor: its blast (120 at 2.5 cells) kills the reactors beside it, and theirs the next, and the Pips above them. Six guns for one hit. Spread them out, or wall them with armour, and try again.',
      parts: [R('pip', 5, 4), R('pip', 6, 4), R('pip', 7, 4), R('pip', 8, 4), R('pip', 9, 4), R('pip', 10, 4),
        R('cell_reactor', 5, 5), R('cell_reactor', 6, 5), R('cell_reactor', 7, 5), R('cell_reactor', 8, 5), R('cell_reactor', 9, 5), R('cell_reactor', 10, 5),
        R('core', 7, 7), R('cell_reactor', 6, 7, 1), R('cell_reactor', 9, 7, 3), R('ion', 7, 8), R('ion', 8, 8)],
    },
    {
      name: '9. Sunbreaker: a gun the ship is built around',
      about: 'The Sunbreaker takes six lines of 60: two from the back, two from each flank. Three Fusion Plants fill them, one on each side, so power comes from all round the gun. It leaks 150 a second, so with all six lines it fires every 3 s. Erase a flank plant (X) and it drops to one shot every 6.7 s; erase two and it never fires again. Now Repair all and Break (B) a flank plant instead: its blast also cuts the conduits under the gun, so one hit costs four lines and the gun goes dark. Cutting its lines is how you beat it, and keeping blasts away from them is how you protect it.',
      parts: [R('sunbreaker', 6, 2), R('fusion', 4, 3, 1), R('fusion', 9, 3, 3), R('fusion', 6, 6), R('conduit', 6, 5), R('corner', 7, 5), R('corner', 8, 5, 1, true),
        R('core', 6, 8), R('cell_reactor', 5, 8, 1), R('cell_reactor', 8, 8, 3), R('ion', 6, 9), R('ion', 7, 9)],
    },
    {
      name: '10. Feed: a Combiner flavours a line',
      about: 'Two Pips off the core. The left one’s line runs through a Combiner, whose feed point (left side) a pipe joins to an incendiary tank: every shot it fires burns (60% of the hit again, over time) but hits 20% softer. The right Pip is plain. Hover the Combiner to see the feed it uses (1 for every 50 power). Put a cryo tank on the same pipe: the feed mixes, and each effect is half as strong.',
      parts: [R('core', 7, 7), R('cell_reactor', 6, 7, 1), R('cell_reactor', 9, 7, 3), R('ion', 7, 8), R('ion', 8, 8),
        R('combiner', 7, 6), R('pipe', 6, 6), R('pipe', 5, 6), R('tank_incendiary', 4, 6), R('pip', 7, 5), R('conduit', 8, 6), R('pip', 8, 5)],
    },
    {
      name: '11. Crossing: a feed line through the power lines',
      about: 'The Scorcher needs power at its back and a feed on its side. Its cryo tank is on the far side of two power lines, so the pipe crosses them through Passthroughs: each carries power back to front and the feed side to side, in one cell. Replace a Passthrough with a plain Conduit and the feed stops there. Break (B) a Passthrough and both lines go.',
      parts: [R('core', 7, 8), R('cell_reactor', 6, 8, 1), R('cell_reactor', 9, 8, 3), R('ion', 7, 9), R('ion', 8, 9),
        R('conduit', 7, 7), R('passthrough', 7, 6), R('conduit', 7, 5), R('pip', 7, 4),
        R('conduit', 8, 7), R('passthrough', 8, 6), R('conduit', 8, 5), R('scorcher', 8, 4, 0, true),
        R('tank_cryo', 5, 6), R('pipe', 6, 6), R('pipe', 9, 6), R('pipe', 9, 5), R('pipe', 9, 4)],
    },
    {
      name: '12. Discharge: a Longbarrel straight on reactors, and one behind Surge Cells',
      about: 'A Longbarrel shuts its ports for 1 s after each shot. On the left, two reactors feed it directly: whatever they make in that second is wasted (watch them flash), so it fires every 4.7 s. On the right, Surge Cells sit between: they fill while the gun is shut and pour it in when it opens, so it fires every 3.7 s from the same two reactors.',
      parts: [R('longbarrel', 3, 3), R('cell_reactor', 3, 4), R('cell_reactor', 4, 4),
        R('longbarrel', 10, 3), R('surge_cell', 10, 4), R('surge_cell', 11, 4), R('cell_reactor', 10, 5), R('cell_reactor', 11, 5),
        R('core', 7, 7), R('cell_reactor', 6, 7, 1), R('cell_reactor', 9, 7, 3), R('ion', 7, 8), R('ion', 8, 8)],
    },
    {
      name: '13. Threshold: a Hammer on a reactor, and on a Joiner',
      about: 'A Hammer takes power only from lines rated at least 45 together. On the left a reactor (30) sits right under it: nothing, ever. On the right the same reactor and a second one go through a Joiner Bank, whose line is rated 90: it fires. Joining lines is what heavy guns are for.',
      parts: [R('hammer', 3, 4), R('cell_reactor', 3, 5),
        R('hammer', 10, 3), R('joiner', 10, 4), R('cell_reactor', 10, 5), R('cell_reactor', 11, 5),
        R('core', 7, 7), R('cell_reactor', 6, 7, 1), R('cell_reactor', 9, 7, 3), R('ion', 7, 8), R('ion', 8, 8)],
    },
    {
      name: '14. Two feeds: a Slurry Cannon',
      about: 'The Slurry Cannon has two inputs at its back: power on the left (from a line rated 40 or more: here a Cell Battery) and feed on the right, here tungsten tanks touching it directly. Each shell takes 3 feed and goes 3 deeper into armour (tungsten, half again as strong in this gun), but cycles slower. Swap the tanks for shaped slurry: splash instead, and a bomb behind the gun.',
      parts: [R('slurry_cannon', 7, 4), R('cell_battery', 7, 5), R('tank_tungsten', 8, 5), R('tank_tungsten', 8, 6), R('cell_reactor', 7, 6),
        R('core', 7, 8), R('cell_reactor', 6, 8, 1), R('cell_reactor', 9, 8, 3), R('ion', 7, 9), R('ion', 8, 9)],
    },
  ];
});
