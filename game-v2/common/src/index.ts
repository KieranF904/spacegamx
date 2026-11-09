// ECS Components
export * from './ecs/components.js';

// Data Schemas
export * from './data/schemas.js';

// Data-driven systems (definitions and registries)
export * from './data/index.js';

// Network Protocol
export * from './network/protocol.js';
export * from './network/inputFields.js';
export * from './network/inputCompactTables.js';
export * from './network/inputCompact.js';
export * from './network/ranges.js';
export * from './network/fxKinds.js';
export * from './network/hits.js';
export * from './network/ownTick.js';
export * from './network/cells.js';
export * from './network/crowd.js';
export * from './network/causes.js';
export * from './network/packed/tables.js';
export * from './network/packed/packedCodec.js';
export { BlockStore, derivedRow, ROW_BASE, type BlockRec } from './network/packed/blocks.js';
export * from './network/cursorState.js';
export * from './network/Transport.js';

// Networking utilities
export * from './network/stateHash.js';

// Constants
export * from './constants.js';

// Asteroid polygon & collision helpers (shared between server and client)
export * from './asteroid/polygon.js';
// Asteroid deterministic generation helpers
export * from './asteroid/generation.js';
// Asteroid orbit helpers
export * from './asteroid/orbit.js';
export * from './world/planets.js';
export * from './world/nests.js';
export * from './world/populations.js';
export * from './world/pockets.js';
export * from './world/contributorNotes.js';
export * from './world/gates.js';
export * from './world/denVents.js';


// Game systems
export * from './game/quests.js';
export * from './game/regions.js';
export * from './starfield.js';

// Modular ships (proto/modular-ships)
export * from './ships/index.js';

// Deterministic trigonometry (the same bits in every engine): math/detTrig.ts
export * from './math/detTrig.js';
// Deterministic randomness (hashInts, seededRng and mulberry32 come through ships/ and asteroid/): math/rng.ts
export { tickRng, hashUnit } from './math/rng.js';
// Plain maths for non-sim code (wrapPi already comes through ships/turret.js with the same loop): math/basic.ts
export { clamp, lerp, smoothstep, cloneJson } from './math/basic.js';

// Economy: items, stacks, recipes, player profiles
export * from './econ/index.js';
export * from './terrain.js';
// The tutorial: data shapes, saved progress, validator (tutorial/README.md)
export * from './tutorial/index.js';
// Decision inputs: bosses' bodies, the same on both sides (docs/design/decision-inputs.md)
export * from './bodies/index.js';
// Boss rules both sides share: windows, personal attacks, a lair boss's life (docs/bosses/rework-2026-11.md)
export * from './bosses/index.js';
// Scheduled waypoints: homing shells flown by the shared law on both sides (docs/design/awareness-model.md 6.3)
export * from './guidance/index.js';
// The sim foundation: one deterministic ship stepper, its events, inputs, timeline, state ring (sim/index.ts)
export * from './sim/index.js';
