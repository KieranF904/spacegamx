/**
 * Part features: the public face (README.md). The list itself is registry.ts
 * (generated); the call sites in rebuild.ts / energy.ts / replica.ts use plan.ts.
 */

export type * from './types.js';
export { FEATURES } from './registry.js';
export {
  MAX_FEATURES, FLIGHT_PHASES, compilePlan, getPlan, featureBits, featureList, featureFacts,
  type FeaturePlan, type WireManifest, type DeriveHook, type LoadHook, type FlightEntry, type PlanInput, type PlanReplica,
} from './plan.js';
