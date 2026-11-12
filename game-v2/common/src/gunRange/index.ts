/**
 * @contract common.gun-range
 * owns:       the gun range's shared surface: the chamber layout, the cheat ship, its weapon modifiers and the options
 * needs:      layout, cheatShip, mods, options
 * invariants: the layout, the cheat ship and the options are pure and alike on both sides — common/src/gunRange/layout.test.ts
 * extend:     export a new gun range module here
 */
export * from './layout.js';
export * from './cheatShip.js';
export * from './mods.js';
export * from './options.js';
