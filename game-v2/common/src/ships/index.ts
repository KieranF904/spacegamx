/**
 * Modular ships: shared, deterministic, engine-agnostic.
 *
 * Rules for everything in this folder: no imports from the client, renderer,
 * DOM or network layer; no Math.random (use rng.ts); no wall-clock time (use
 * the tick number); all state that changes during play is plain data.
 */

export * from './types.js';
export * from './geometry.js';
export * from './catalog.js';
export * from './grid.js';
export * from './collide.js';
export * from './tuning.js';
export * from './rng.js';
export * from './blueprint.js';
export * from './rebuild.js';
export * from './state.js';
export * from './stages.js';
// A custom enemy's destroyable pieces (blueprint part `group`)
export * from './groups.js';
export * from './flight.js';
export * from './jumpAim.js';
export * from './farRoute.js';
export * from './jumpFields.js';
export * from './shot.js';
export * from './turret.js';
export * from './physics.js';
export * from './replica.js';
export * from './launch.js';
export * from './grades.js';
export * from './rating.js';
export * from './damage.js';
// What a shell's hit does, worked out alike on both sides (docs/design/confirmed-hits.md B)
export * from './hitRules.js';
export * from './partStats.js';
export * from './describe.js';
export * from './guns.js';
export * from './energy.js';
export * from './circuits.js';
// The energy core (energy routing, P1: nothing in the game runs it yet)
export * from './power/index.js';
export * from './features/support/support.js';
export * from './pulse.js';
export * from './hazards.js';
export * from './warmth.js';
export * from './wires.js';
export * from './migrate.js';
export * from './mounting.js';
export * from './features/strafer/strafer.js';
export * from './features/tow/tow.js';
export * from './features/flash/flash.js';
export * from './features/weaponry/weaponry.js';
export * from './load.js';
export * from './flightInputs.js';
export * from './features/index.js';
export * from './rangeRig.js';
// Debris worked out alike on both sides (deterministic trig, push-only knocks): ships/debris.ts
export * from './debris.js';
// ...and its life after its spawn (crumbling), for a client running it (CAPS.DEBRIS): ships/debrisLife.ts
export * from './debrisLife.js';
export * from './contact.js';
