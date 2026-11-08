/** The env a shadow flies in, and the id its step names it by (Docking Clamps: ships/bridge/clamp.ts) */
import type { ReplicaEnv } from '@space-game/common';
import type { ReplicationCore } from './types.js';

/**
 * Docking Clamps (ships/bridge/clamp.ts): the env a pilot's shadow flies in, with the links (a leader is stepped as the
 * pair, an undock's push), and the id the step names it by (only under links: the server's env has no pulls)
 */
export function envOf(rep: ReplicationCore, eid: number): ReplicaEnv {
  const env = rep.host.env(eid), c = rep.ships.clamps;
  if (!c?.any) return env;
  let e = rep.clampEnvs.get(env);
  if (!e) rep.clampEnvs.set(env, (e = { ...env, clamp: c.source }));
  return e;
}
export function clampId(rep: ReplicationCore, eid: number): number {
  return rep.ships.clamps?.any ? eid : -1;
}
