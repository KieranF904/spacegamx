/**
 * The sim foundation: one deterministic ship stepper for PT/ST prediction (and lockstep later). Plan and Stage 1
 * briefs: the sim-foundation plan. Contract files: state.ts, input.ts, events.ts, env.ts, phases.ts, timeline.ts (API),
 * ring.ts (API + hashed fields), headHash.ts (Stage 3 settled the Stage 1 contract notes into them). Implementation
 * files: step.ts (1A), guns.ts + b-shots.ts (1B), pulls.ts + ring/timeline internals + c-*.ts (1C), a-adapt.ts (1A's
 * caller adapters), d-sources.ts (1D's shared input sources).
 */
export * from './state.js';
export * from './input.js';
export * from './events.js';
export * from './env.js';
export * from './phases.js';
export * from './timeline.js';
export * from './ring.js';
export * from './headHash.js';
export * from './step.js';
export * from './guns.js';
export * from './pulls.js';
export * from './harness.js';
// Callers' adapters (SimShipView, simStructureOf, pilotInput) and the shared input sources
export * from './a-adapt.js';
export * from './d-sources.js';
// Replica states, contact pairs, pull sources
export * from './c-replicaState.js';
export * from './c-contactCache.js';
export * from './c-pulls.js';
// Pull fields: the pulls on pilots both ends work out in the step (game-wide C3, track B)
export * from './pullFields.js';
// The own ship's whole step on its client (Stage 3b) and its exact correction (ownSync)
export * from './ownStep.js';
