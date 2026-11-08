/**
 * The weapon-kind hooks of the server features (ServerFeature.weapon), flattened once, on first use, into plain arrays
 * the bridge's gun step walks every tick (allocation-free; an empty loop when no feature has one). Each hook is paired
 * with its role's `applies` from the shared plan (common features: WeaponRole), so a role is declared in one place.
 */
import { getPlan, weaponRole, type WeaponInfo, type WeaponTuning } from '@space-game/common';
import type { ShipState } from '@space-game/common';
import type { WeaponBridge } from '../bridge/core.js';
import { SERVER_FEATURES } from './index.js';
import type { ServerWeaponHooks } from './types.js';

interface Compiled {
  fire: { applies(def: WeaponTuning | undefined): boolean; hook: NonNullable<ServerWeaponHooks['onFire']> }[];
  tick: NonNullable<ServerWeaponHooks['onTick']>[];
}

let compiled: Compiled | undefined;

function compile(): Compiled {
  const P = getPlan();
  const out: Compiled = { fire: [], tick: [] };
  // (In plan order, so which feature wins a gun is the same on every machine)
  const order = [...SERVER_FEATURES].sort((a, b) => (P.byId.get(a.id) ?? 99) - (P.byId.get(b.id) ?? 99));
  for (const f of order) {
    for (const [id, hooks] of Object.entries(f.weapon ?? {})) {
      const role = weaponRole(P, f.id, id);
      if (hooks.onFire) out.fire.push({ applies: role.applies, hook: hooks.onFire });
      if (hooks.onTick) out.tick.push(hooks.onTick);
    }
  }
  return out;
}

/** A held beam of this kind: the beam of the first role that claims it (undefined: the plain damaging beam) */
export function fireBeamHook(def: WeaponTuning | undefined): ((b: WeaponBridge, eid: number, ship: ShipState, w: WeaponInfo, def: WeaponTuning) => number) | undefined {
  const c = (compiled ??= compile());
  for (let i = 0; i < c.fire.length; i++) if (c.fire[i].applies(def)) return c.fire[i].hook;
  return undefined;
}

/** Every role's per-tick hook for a ship's guns */
export function tickWeaponHooks(b: WeaponBridge, eid: number, ship: ShipState, pose: { x: number; y: number; angle: number }, def: (w: WeaponInfo) => WeaponTuning): void {
  const c = (compiled ??= compile());
  for (let i = 0; i < c.tick.length; i++) c.tick[i](b, eid, ship, pose, def);
}

/** TESTS ONLY: forget the flattened hooks (after setPlanForTests) */
function resetWeaponHooksForTests(): void {
  compiled = undefined;
}
