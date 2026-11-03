/**
 * What this client offers the server in its join (common network/hits.ts CAPS): confirmed and client-detected hits
 * (ships/hits/ConfirmedHits.ts clientCaps), and bit-packed frames with coalescing (common network/packed): both on in
 * dev builds; `?packed=0|1` and `?coalesce=0|1` switch them (remembered). The server takes what it allows (netCaps).
 */
import { CAPS, TICK_MS } from '@space-game/common';
import { clientCaps } from '../ships/hits/ConfirmedHits';

/** A switch from the address (remembered) or from storage; null: not set */
function flag(q: string, key: string): boolean | null {
  try {
    const v = new URLSearchParams(globalThis.location?.search ?? '').get(q);
    if (v === '0' || v === '1') { globalThis.localStorage?.setItem(key, v); return v === '1'; }
    const m = globalThis.localStorage?.getItem(key);
    if (m === '0' || m === '1') return m === '1';
  } catch { /* no storage: the default */ }
  return null;
}

export function netCaps(): number {
  const dev = !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV;
  const packed = flag('packed', 'sg.packed') ?? dev;
  const coalesce = packed && (flag('coalesce', 'sg.coalesce') ?? true);
  return clientCaps() | (packed ? CAPS.PACKED : 0) | (coalesce ? CAPS.COALESCE : 0);
}

/**
 * How much later frames may come with these caps in effect (coalescing: the server's netCaps says how many ticks they
 * may wait): the interpolation delay grows by as much (ms)
 */
export function coalesceDelayMs(caps: number, hold = 0): number {
  return (caps & (CAPS.PACKED | CAPS.COALESCE)) === (CAPS.PACKED | CAPS.COALESCE) ? Math.max(0, Math.min(30, hold)) * TICK_MS : 0;
}
