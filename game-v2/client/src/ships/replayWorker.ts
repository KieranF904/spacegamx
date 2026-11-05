/**
 * Runs the determinism check off the main thread. A replay spins up whole
 * GameServers, and bitecs component arrays are module globals, so it must not
 * share a module instance with the live proto game.
 */

import { runReplay, recordInputs } from '../../../server/src/ships/replay';
import type { ProtoServerOptions } from '../../../server/src/proto/createProtoServer';

interface Request {
  files: ProtoServerOptions['files'];
  ships: ProtoServerOptions['ships'];
  seed: number;
  ticks: number;
  runs: number;
}

self.onmessage = (e: MessageEvent<Request>) => {
  const { files, ships, seed, ticks, runs } = e.data;
  const inputs = recordInputs(seed, ticks);
  const hashes: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) {
    hashes.push(runReplay({ files, ships, inputs, dummy: ships.starter }).hash);
    (self as any).postMessage({ progress: i + 1, runs });
  }
  (self as any).postMessage({ done: true, hashes, ms: performance.now() - t0 });
};
