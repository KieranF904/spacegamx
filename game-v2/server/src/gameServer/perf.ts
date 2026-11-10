/**
 * @contract server.gameserver.perf
 * owns:       tick time metrics
 * needs:      none
 * invariants: min, max, window max and a smoothed average follow every tick, per-tick counters reset (updatePerfMetrics) — server/src/gameServer/serverParts.test.ts
 * extend:      n/a
 */

export interface PerfMetrics {
  lastTickMs: number;
  avgTickMs: number;
  maxTickMs: number;
  minTickMs: number;
  collisionChecks: number;
  avgCollisionChecks: number;
  ticksProcessed: number;
  spatialQueries: number;
  entityCount: number;
  /** The slowest tick since the box's monitor last asked (liveStatus) */
  windowMaxMs: number;
}

export const perfMetrics: PerfMetrics = {
  lastTickMs: 0,
  avgTickMs: 0,
  maxTickMs: 0,
  minTickMs: Infinity,
  collisionChecks: 0,
  avgCollisionChecks: 0,
  ticksProcessed: 0,
  spatialQueries: 0,
  entityCount: 0,
  windowMaxMs: 0,
};
