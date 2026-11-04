// ECS Components
export * from './ecs/components.js';

// Data Schemas
export * from './data/schemas.js';

// Data-driven systems (definitions and registries)
export * from './data/index.js';

// Network Protocol
export * from './network/protocol.js';
export * from './network/inputFields.js';
export * from './network/ranges.js';
export * from './network/fxKinds.js';
export * from './network/hits.js';
export * from './network/ownTick.js';
export * from './network/packed/tables.js';
export * from './network/packed/packedCodec.js';
export * from './network/cursorState.js';
export * from './network/Transport.js';

// Networking utilities
export * from './networking/index.js';
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
export * from './world/pockets.js';
export * from './world/contributorNotes.js';


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

// Economy: items, stacks, recipes, player profiles
export * from './econ/index.js';
export * from './terrain.js';
