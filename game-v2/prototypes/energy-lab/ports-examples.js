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
      about: 'The Hammer takes 70 a second through one port. No generator gives that on one line, so a Joiner Bank takes two reactors in at 40 each and gives one line out at 90. Erase one reactor (X, then click it): the bank runs down its charge, then the Hammer fires at half rate.',
      parts: [R('hammer', 7, 4), R('joiner', 7, 5), R('cell_reactor', 7, 6), R('cell_reactor', 8, 6),
        R('core', 7, 8), R('cell_reactor', 6, 8, 1), R('ion', 7, 9), R('ion', 8, 9), R('hull', 7, 7), R('hull', 8, 7)],
    },
    {
      name: '3. Two Glints on one plant',
      about: 'A Fusion Plant gives two lines of 60. A Joiner Bank takes them (40 each, so 40 of the plant is wasted: hover the plant) and gives one line of 90 to a Splitter Bank, which gives 45 to each Glint. Swap the Joiner for a Flux Coil to stop the waste.',
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
      name: '5. Passive drain: a Spear and a Lance on reactors',
      about: 'The Spear leaks 10 a second whether it fires or not, so one reactor (30) fills it at 20 net: a 180 shot every 9 s. The Lance leaks 40: on one reactor it never charges at all. Place a second reactor under its other port and it lights for a second every 15.',
      parts: [R('spear', 3, 3), R('cell_reactor', 3, 5), R('lance', 9, 4), R('cell_reactor', 9, 5),
        R('core', 7, 8), R('cell_reactor', 6, 8, 1), R('cell_reactor', 9, 8, 3), R('ion', 7, 9), R('ion', 8, 9)],
    },
    {
      name: '6. A superweapon and its ship',
      about: 'A Lance burns 300 a second and leaks 40. Two Fusion Plants on the flanks (through conduits) and four reactors through two Joiner Banks fill a Capacitor Array (six lines in, 360) that gives the Lance two lines of 600. Nearly the whole ship is power. Break (B) the array and the Lance goes out at once; break one conduit and it loses a sixth of its feed: the six ports are its redundancy, and the array is the part to bury.',
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
  ];
});
