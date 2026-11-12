// The example layouts for the modifier lab (index.html). [type, x, y, rot, flip]: rot in quarter turns clockwise.
// Unrotated: generators give N (up the screen), stores, conduits and mounts take S and give N, guns take S. A mount's
// sockets are on its E side (W when flipped); a modifier block works in the cell against a socket.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.PM_EXAMPLES = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const R = (type, x, y, rot, flip) => [type, x, y, rot || 0, !!flip];
  const hull = (x0, y0, x1, y1) => { const o = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) o.push(R('hull', x, y)); return o; };
  return [
    {
      name: '1. A Coil plugged into a Pip’s line',
      about: 'Two Pips, a reactor each. The left line runs through a Mount with a Coil plugged into its socket. The Pip takes 20 a second and the Coil treats 24, so everything the Pip takes arrives treated: Velocity at full strength. The right Pip is plain. Erase the Coil and place a Prism or a Chamber in its cell to change what the Pip fires.',
      grid: [10, 8],
      parts: [R('pip', 3, 2), R('mount1', 3, 3), R('mod_coil', 4, 3), R('cell_reactor', 3, 4), R('pip', 6, 2), R('conduit', 6, 3), R('cell_reactor', 6, 4),
        R('hull', 4, 2), R('hull', 4, 4), ...hull(5, 2, 5, 4)],
    },
    {
      name: '2. One Coil shared by two Pips',
      about: 'Two reactors join into one line, through one Mount holding one Coil, then a Splitter feeds two Pips. Together the Pips take 40 a second and the Coil treats 24, so each gets 60% treated, and 60% of the Velocity effect. Erase one Pip and the other gets it all.',
      grid: [10, 9],
      parts: [R('pip', 4, 2), R('pip', 5, 2), R('splitter', 4, 3), R('mount1', 4, 4), R('mod_coil', 5, 4), R('joiner', 4, 5), R('cell_reactor', 4, 6), R('cell_reactor', 5, 6)],
    },
    {
      name: '3. Two Coils: stacked Mounts, or one Double mount',
      about: 'Each side feeds two Pips with two Coils. Left: two single Mounts stacked along the line, treating 24 each, 48 together. Right: one Double mount, where each Coil treats 30, 60 together. Both cover the 40 the Pips take, but the Double mount gets more from the same Coils and is the harder part to make.',
      grid: [12, 9],
      parts: [R('pip', 2, 1), R('pip', 3, 1), R('splitter', 2, 2), R('mount1', 2, 3), R('mod_coil', 3, 3), R('mount1', 2, 4), R('mod_coil', 3, 4), R('joiner', 2, 5), R('cell_reactor', 2, 6), R('cell_reactor', 3, 6),
        R('pip', 7, 1), R('pip', 8, 1), R('splitter', 7, 2), R('mount2', 7, 3), R('mod_coil', 8, 3), R('mod_coil', 8, 4), R('joiner', 7, 5), R('cell_reactor', 7, 6), R('cell_reactor', 8, 6), ...hull(4, 1, 6, 6)],
    },
    {
      name: '4. A Hammer: a Double mount, or stacked Mounts',
      about: 'A Hammer takes 70 a second; its two reactors deliver 57. Any mount carries that line: a bigger mount only gets more from each modifier. Left: a Double mount with two Resonators treats 60, all of what arrives: full Rapid. Right: two single Mounts stacked treat 48 of the 57: Rapid at 83%. One Resonator in one Mount would treat 24: Rapid at 41%.',
      grid: [12, 9],
      parts: [R('hammer', 2, 1), R('mount2', 2, 2), R('mod_resonator', 3, 2), R('mod_resonator', 3, 3), R('joiner', 2, 4), R('cell_reactor', 2, 5), R('cell_reactor', 3, 5),
        R('hammer', 7, 1), R('mount1', 7, 2), R('mod_resonator', 8, 2), R('mount1', 7, 3), R('mod_resonator', 8, 3), R('joiner', 7, 4), R('cell_reactor', 7, 5), R('cell_reactor', 8, 5), ...hull(4, 1, 6, 5)],
    },
    {
      name: '5. A recipe: Coil and Prism in a Double mount give Pierce',
      about: 'Left: a Double mount holding a Coil and a Prism. The two make a recipe, so the mount fuses them (the diamond on it): the Pip gets Pierce, an effect of its own, and neither Velocity nor Split. Right: the same two modifiers in single Mounts never fuse, so that Pip gets Velocity and Split. A Chamber with a Resonator in a Double mount gives Wave the same way.',
      grid: [11, 9],
      parts: [R('pip', 2, 2), R('mount2', 2, 3), R('mod_prism', 3, 3), R('mod_coil', 3, 4), R('cell_reactor', 2, 5), R('hull', 2, 6),
        R('pip', 6, 2), R('mount1', 6, 3), R('mod_prism', 7, 3), R('mount1', 6, 4), R('mod_coil', 7, 4), R('cell_reactor', 6, 5), R('hull', 6, 6), ...hull(4, 2, 5, 6), R('hull', 3, 2), R('hull', 3, 5), R('hull', 3, 6)],
    },
    {
      name: '6. After the store, never before it',
      about: 'Two Longbarrels, each charged by two reactors through two Capacitors, each line with a Mount and a Chamber (the left Mount of each pair is flipped so its socket faces out). Left: the Mounts sit before the Capacitors. Capacitors and batteries do not carry treatment, so nothing reaches the gun. Right: the Mounts sit after the Capacitors. The gun pulls in bursts, but the treatment is counted by what it uses on average, so the two Chambers cover most of it.',
      grid: [13, 9],
      parts: [R('longbarrel', 2, 2), R('capacitor', 2, 3), R('capacitor', 3, 3), R('mount1', 2, 4, 0, true), R('mod_chamber', 1, 4), R('mount1', 3, 4), R('mod_chamber', 4, 4), R('cell_reactor', 2, 5), R('cell_reactor', 3, 5),
        R('longbarrel', 8, 2), R('mount1', 8, 3, 0, true), R('mod_chamber', 7, 3), R('mount1', 9, 3), R('mod_chamber', 10, 3), R('capacitor', 8, 4), R('capacitor', 9, 4), R('cell_reactor', 8, 5), R('cell_reactor', 9, 5), ...hull(5, 2, 6, 5)],
    },
    {
      name: '7. A dressed Pip beside a plain Hammer',
      about: 'Left: one Pip behind three Mounts, each holding a different modifier and kept apart by Conduits so none fuse: Velocity, Explosive and Split, all at full strength. Every kind needs its own mount, its own block beside the line, and a longer line. Right: a plain Hammer, a bigger gun, on two reactors. Compare the damage and the cost of each under What the guns fire.',
      grid: [12, 11],
      parts: [R('pip', 3, 2), R('mount1', 3, 3), R('mod_prism', 4, 3), R('conduit', 3, 4), R('mount1', 3, 5), R('mod_chamber', 4, 5), R('conduit', 3, 6), R('mount1', 3, 7), R('mod_coil', 4, 7), R('cell_reactor', 3, 8),
        R('hammer', 7, 5), R('joiner', 7, 6), R('cell_reactor', 7, 7), R('cell_reactor', 8, 7), R('hull', 4, 4), R('hull', 4, 6), ...hull(5, 5, 6, 7)],
    },
    {
      name: '8. Arc cell: a special modifier and its hopper',
      about: 'The left Pip’s line runs through a Mount holding an Arc cell. A special modifier has an input of its own on the side away from the socket, and here a hopper of arc salt sits against it. While the hopper has salt the Pip’s shots get full Chain: each hit arcs on to four more targets nearby, each arc half the one before. Aim at the cluster on the range. The hopper holds 60 and this Pip uses about 1 a second; when it runs out the Arc cell goes dry and the Pip fires plain shots. Dock reloads it; Charge all does not. The right Pip is plain.',
      grid: [11, 8],
      parts: [R('pip', 3, 2), R('mount1', 3, 3), R('mod_arc', 4, 3), R('hopper_arcsalt', 5, 3), R('cell_reactor', 3, 4), R('pip', 8, 2), R('conduit', 8, 3), R('cell_reactor', 8, 4),
        R('hull', 4, 2), R('hull', 4, 4), ...hull(6, 2, 7, 4)],
    },
    {
      name: '9. Condensers under a Hammer',
      about: 'Left: a Hammer behind a Double mount holding two Condensers, each with a hopper of cryo fluid on its input. Heavy gives much more damage, but the shot flies slower, so it is harder to land on the moving target on the range. Right: a plain Hammer. Erase one hopper: each Condenser draws only from what is joined to its own input, so that one goes dry and the mount treats half as much.',
      grid: [13, 9],
      parts: [R('hammer', 2, 1), R('mount2', 2, 2), R('mod_condenser', 3, 2), R('mod_condenser', 3, 3), R('hopper_cryo', 4, 2), R('hopper_cryo', 4, 3), R('joiner', 2, 4), R('cell_reactor', 2, 5), R('cell_reactor', 3, 5),
        R('hammer', 8, 2), R('joiner', 8, 3), R('cell_reactor', 8, 4), R('cell_reactor', 9, 4), ...hull(5, 2, 7, 5)],
    },
    {
      name: '10. Rail driver: a power line of its own',
      about: 'The left Pip’s line runs through a Mount holding a Rail driver. It uses no material: its input is a power port, fed here by a second reactor turned to face it, and it burns half a unit of that power for each unit it treats. Full Hyper makes the shot three and a half times as fast and a fifth weaker, so it lands on the moving target almost at once. Erase the side reactor and the Rail driver goes dry. The right Pip is plain.',
      grid: [11, 8],
      parts: [R('pip', 3, 2), R('mount1', 3, 3), R('mod_rail', 4, 3), R('cell_reactor', 5, 3, 3), R('cell_reactor', 3, 4), R('pip', 8, 2), R('conduit', 8, 3), R('cell_reactor', 8, 4),
        R('hull', 4, 2), R('hull', 4, 4), ...hull(6, 2, 7, 4)],
    },
    {
      name: '11. A Brander and a Coil on one Pip',
      about: 'A special modifier mixes with the basic ones like any other. This Pip’s line has a Mount with a Coil, a Conduit, then a Mount with a Brander fed by a hopper of pyre gel: full Velocity and full Burn. What the shot hits keeps burning for three seconds (the red frame on the range). The Coil works whether or not the hopper has gel; only the Brander goes dry.',
      grid: [10, 10],
      parts: [R('pip', 3, 2), R('mount1', 3, 3), R('mod_brand', 4, 3), R('hopper_pyre', 5, 3), R('conduit', 3, 4), R('mount1', 3, 5), R('mod_coil', 4, 5), R('cell_reactor', 3, 6)],
    },
    {
      name: '12. Line tiers: how many effects a conduit carries',
      about: 'Both Pips sit behind three Mounts: a Coil, a Chamber and a Prism, kept apart by Conduits. The last Conduit before each gun has to carry all three effects. Left: a basic Conduit carries two, so it drops the last one put in, Split (the amber frame). Right: a Conduit II carries three. The earlier Conduits carry one and two effects, so basic ones do. Stack the mounts with no Conduit after the last and a basic line carries everything.',
      grid: [12, 11],
      parts: [R('pip', 2, 1), R('conduit', 2, 2), R('mount1', 2, 3), R('mod_prism', 3, 3), R('conduit', 2, 4), R('mount1', 2, 5), R('mod_chamber', 3, 5), R('conduit', 2, 6), R('mount1', 2, 7), R('mod_coil', 3, 7), R('cell_reactor', 2, 8),
        R('pip', 7, 1), R('conduit_t2', 7, 2), R('mount1', 7, 3), R('mod_prism', 8, 3), R('conduit', 7, 4), R('mount1', 7, 5), R('mod_chamber', 8, 5), R('conduit', 7, 6), R('mount1', 7, 7), R('mod_coil', 8, 7), R('cell_reactor', 7, 8), ...hull(4, 1, 5, 8)],
    },
    {
      name: '13. More supply does not thin the effect',
      about: 'Left: one Pip on two joined reactors, far more power than it uses, behind one Coil. The Coil treats 24 and the Pip uses 20, so Velocity is full: spare supply changes nothing. Right: the same Coil behind a Splitter to two Pips. They use 40 between them, so each gets 60%.',
      grid: [13, 9],
      parts: [R('pip', 2, 2), R('mount1', 2, 3), R('mod_coil', 3, 3), R('joiner', 2, 4), R('cell_reactor', 2, 5), R('cell_reactor', 3, 5),
        R('pip', 8, 1), R('pip', 9, 1), R('splitter', 8, 2), R('mount1', 8, 3), R('mod_coil', 9, 3), R('joiner', 8, 4), R('cell_reactor', 8, 5), R('cell_reactor', 9, 5), ...hull(4, 2, 6, 5)],
    },
  ];
});
