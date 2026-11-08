/**
 * @contract server.gameserver.perf
 * owns:       tick time metrics
 * needs:      none
 * invariants: behaviour is unchanged from the class it was split from — none pinned
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
