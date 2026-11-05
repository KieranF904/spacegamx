/**
 * Counts the ore chunks a miner's laser throws: wraps LootPods.spawnChunk once per server and tells whoever listens for that
 * miner what the chunk holds. A measuring tap only: nothing about the chunk or the mining changes.
 */
import type { GameServer } from '../../GameServer.js';
import type { Bag } from './types.js';

type Listener = (items: Bag) => void;
const taps = new WeakMap<GameServer, Map<number, Listener>>();

/** Listen for the chunks `miner` (an entity id) breaks off; returns the stop function */
export function tapChunks(server: GameServer, miner: number, on: Listener): () => void {
  let map = taps.get(server);
  if (!map) {
    const m = (map = new Map<number, Listener>());
    taps.set(server, m);
    const pods = server.pods;
    const spawn = pods.spawnChunk.bind(pods);
    pods.spawnChunk = (systemNum, x, y, vx, vy, items, who) => {
      if (who !== undefined) m.get(who)?.({ ...items });
      return spawn(systemNum, x, y, vx, vy, items, who);
    };
  }
  map.set(miner, on);
  return () => { map!.delete(miner); };
}
