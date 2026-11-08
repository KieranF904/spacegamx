/**
 * @contract feature.common.barrel
 * owns:       the public face of part features: types, the generated FEATURES list and the plan API
 * needs:      registry.ts (generated), plan.ts, types.ts
 * invariants: the registry the barrel exports is the generated one, current —
 *             common/src/ships/features/registry.test.ts
 * extend:     export a new plan helper here when plan.ts gains one; features are never listed here
 */

/**
 * Part features: the public face (README.md). The list itself is registry.ts
 * (generated); the call sites in rebuild.ts / energy.ts / replica.ts use plan.ts.
 */

export type * from './types.js';
export { FEATURES } from './registry.js';
export {
  MAX_FEATURES, FLIGHT_PHASES, compilePlan, getPlan, setPlanForTests, featureBits, featureList, featureFacts, weaponRole,
  type FeaturePlan, type WireManifest, type DeriveHook, type LoadHook, type FlightEntry, type PlanInput, type PlanReplica, type PlanControl, type PlanWeaponRole,
} from './plan.js';
