// The modifier lab's numbers: guns, reactors, modifier components, the recipes for combinations and the tunables of
// every property. All of it is a first guess meant to be changed: the page's Numbers panel edits a copy of this object.
// Nothing here is read by the game. Plain script: window.MLC in the page, require() in node (derive.check.mjs).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.MLC = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  return {
    // damage a shot, shots a second, shot speed and reach (px), energy a shot. draw = rate × shotEnergy.
    GUNS: {
      pip: { name: 'Pip', tier: 1, damage: 6, rate: 3, speed: 420, range: 520, shotEnergy: 1, cost: 150 },
      rattler: { name: 'Rattler', tier: 2, damage: 5, rate: 9, speed: 520, range: 480, shotEnergy: 1, cost: 800 },
      hammer: { name: 'Hammer', tier: 2, damage: 30, rate: 1.2, speed: 460, range: 600, shotEnergy: 7.5, cost: 900 },
      longbarrel: { name: 'Longbarrel', tier: 3, damage: 120, rate: 0.5, speed: 780, range: 900, shotEnergy: 48, cost: 4200 },
    },
    REACTORS: {
      cell: { name: 'Cell reactor', supply: 6, cost: 200 },
      core: { name: 'Core reactor', supply: 30, cost: 2600 },
    },
    CONDUIT: { cost: 20 },
    // The four components. Each gives one property on its own.
    MODS: {
      coil: { name: 'Coil', glyph: 'C', prop: 'velocity', col: '#7fd8ff' },
      resonator: { name: 'Resonator', glyph: 'N', prop: 'rapid', col: '#ffd166' },
      chamber: { name: 'Chamber', glyph: 'X', prop: 'explosive', col: '#ff8a3d' },
      prism: { name: 'Prism', glyph: 'P', prop: 'split', col: '#b58cff' },
    },
    // capacity: energy a second the component can treat. upkeep: energy a second it burns just being on the line.
    MOD_TIERS: [
      { tier: 1, capacity: 3, upkeep: 0.3, cost: 250 },
      { tier: 2, capacity: 9, upkeep: 0.8, cost: 1400 },
      { tier: 3, capacity: 27, upkeep: 2, cost: 7500 },
    ],
    // Two components touching each other fuse into one combination property.
    RECIPES: [
      { a: 'coil', b: 'prism', prop: 'pierce' },
      { a: 'prism', b: 'resonator', prop: 'bounce' },
      { a: 'chamber', b: 'resonator', prop: 'wave' },
    ],
    PROPS: {
      velocity: { name: 'Velocity', col: '#7fd8ff', say: 'Faster shots that reach further.' },
      rapid: { name: 'Rapid', col: '#ffd166', say: 'Fires faster, and draws more power for it.' },
      explosive: { name: 'Explosive', col: '#ff8a3d', say: 'Trades direct damage for a blast around the hit.' },
      split: { name: 'Split', col: '#b58cff', say: 'Each shot leaves as two or three smaller ones.' },
      pierce: { name: 'Pierce', col: '#8ef0c8', say: 'Spreads the shot through the cells behind the first.' },
      bounce: { name: 'Bounce', col: '#f58ad0', say: 'Shots come off walls instead of dying on them.' },
      wave: { name: 'Wave', col: '#9db4ff', say: 'A wide shot that hits everything across its front.' },
    },
    TUNE: {
      // Share of a gun's draw that must be treated to reach level 1, 2, 3, 4.
      thresholds: [0.25, 0.5, 0.75, 1],
      // A fused pair gives only its combination (false), or its two single properties as well (true).
      fusedKeepsSingles: false,
      // Every list below is indexed by level, 0 first.
      velocity: { speed: 0.2, range: 0.15 },
      rapid: { rate: 0.2, shotDamage: 1 },
      explosive: { direct: [1, 0.92, 0.86, 0.8, 0.75], blast: [0, 0.1, 0.17, 0.24, 0.32], radius: [0, 16, 22, 28, 34] },
      split: { count: [1, 2, 2, 3, 3], total: [1, 1.1, 1.2, 1.25, 1.35], spreadDeg: 6 },
      pierce: { fracs: [[1], [0.8, 0.2], [0.5, 0.3, 0.2], [0.42, 0.28, 0.18, 0.12], [0.36, 0.26, 0.18, 0.12, 0.08]] },
      bounce: { count: [0, 1, 2, 3, 4], keep: 0.75 },
      wave: { width: [1, 1.6, 2.2, 2.8, 3.5], perTarget: [1, 0.9, 0.85, 0.8, 0.78] },
    },
  };
});
