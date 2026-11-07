/**
 * The repair bank as the server last reported it (`repairBank`, docs/design/field-fabrication.md). One value for the
 * whole client: the message handler sets it, the station's bank tab (and anything else that wants it) reads it. Kept
 * here, not in the station window, because the window is loaded lazily and the first report arrives at login.
 */

import type { ServerRepairBankMessage } from '@space-game/common';

type Listener = (m: ServerRepairBankMessage) => void;

let current: ServerRepairBankMessage | null = null;
/** When it arrived (ms, our clock): "full in" counts down from here */
let at = 0;
const listeners = new Set<Listener>();

export function setBank(m: ServerRepairBankMessage, now = Date.now()): void {
  current = m;
  at = now;
  for (const fn of listeners) fn(m);
}

export function getBank(): { msg: ServerRepairBankMessage; at: number } | null {
  return current ? { msg: current, at } : null;
}

export function onBank(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
