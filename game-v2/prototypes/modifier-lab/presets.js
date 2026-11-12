// The modifier lab's example layouts, drawn as rows of two-letter tokens:
//   R1 cell reactor, R2 core reactor, -- conduit, .. empty, Gp Gr Gh Gl guns (Pip, Rattler, Hammer, Longbarrel),
//   C coil, N resonator, X chamber, P prism, each followed by its tier (C1, P3).
// Plain script: window.MLP in the page, require() in node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.MLP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GUN = { p: 'pip', r: 'rattler', h: 'hammer', l: 'longbarrel' };
  const MOD = { C: 'coil', N: 'resonator', X: 'chamber', P: 'prism' };

  function parse(rows) {
    const parts = [];
    let id = 1;
    rows.forEach((row, y) => row.trim().split(/\s+/).forEach((tok, x) => {
      if (tok === '..') return;
      if (tok === '--') parts.push({ id: id++, x, y, type: 'conduit' });
      else if (tok[0] === 'R') parts.push({ id: id++, x, y, type: 'reactor', kind: tok[1] === '2' ? 'core' : 'cell' });
      else if (tok[0] === 'G') parts.push({ id: id++, x, y, type: 'gun', kind: GUN[tok[1]] });
      else if (MOD[tok[0]]) parts.push({ id: id++, x, y, type: 'mod', kind: MOD[tok[0]], tier: +tok[1] });
    }));
    return parts;
  }

  const LIST = [
    { id: 'side', name: 'Side by side', say: 'A bare Pip, a Pip with Rapid and Split, a piercing Pip and a bare Longbarrel.', rows: [
      '.. .. .. .. .. ..',
      '.. R1 Gp .. .. ..',
      '.. .. .. .. .. ..',
      '.. R1 N1 -- P1 Gp',
      '.. .. .. .. .. ..',
      '.. R1 C1 P1 Gp ..',
      '.. .. .. .. .. ..',
      '.. R2 -- Gl .. ..',
    ] },
    { id: 'meta', name: 'Pips on cells', say: 'Today\'s early meta: a gun right on top of each cell reactor.', rows: [
      '.. .. .. .. .. .. .. .. ..',
      '.. .. .. .. .. .. .. .. ..',
      '.. Gp .. Gp .. Gp .. Gp ..',
      '.. R1 .. R1 .. R1 .. R1 ..',
    ] },
    { id: 'shared', name: 'One prism, four Pips', say: 'One modifier feeding four guns: each gets a quarter of it.', rows: [
      '.. .. .. .. .. .. ..',
      '.. .. .. .. .. .. ..',
      '.. .. .. Gp Gp .. ..',
      '.. R2 P1 -- -- .. ..',
      '.. .. .. Gp Gp .. ..',
    ] },
    { id: 'worked-pip', name: 'A Pip with a lot behind it', say: 'One Pip carrying Rapid, Split, Explosive and Velocity from tier 2 parts.', rows: [
      '.. .. .. .. .. .. .. .. .. .. ..',
      '.. .. .. .. .. .. .. .. .. .. ..',
      '.. .. .. .. .. .. .. .. .. .. ..',
      '.. R2 N2 -- P2 -- X2 -- C2 Gp ..',
    ] },
    { id: 'worked-long', name: 'A piercing Longbarrel', say: 'The same Pierce as the piercing Pip, on a gun that draws eight times as much.', rows: [
      '.. .. .. .. .. .. ..',
      '.. .. .. .. .. .. ..',
      '.. .. .. .. .. .. ..',
      '.. R2 C3 P3 Gl .. ..',
      '.. .. R2 .. .. .. ..',
    ] },
    { id: 'empty', name: 'Empty grid', say: 'Start from nothing.', rows: [] },
  ];

  return { LIST, parse };
});
