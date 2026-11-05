/**
 * The bundle's entry (engines.mjs builds it with esbuild, the data inlined from the virtual module `det:data`): runs the
 * scenario and hands the result over: in a browser it's POSTed back to engines.mjs's server, in Node it's left on
 * globalThis.__DET.
 */
import { runScenario, type DetData } from './scenario.js';
// @ts-ignore (esbuild's virtual module: data/ships, read by engines.mjs)
import data from 'det:data';

const ticks = Number((globalThis as { DET_TICKS?: number }).DET_TICKS) || 1200;
let result: unknown;
try {
  result = runScenario(data as DetData, ticks);
} catch (e) {
  result = { error: String((e as Error)?.stack ?? e) };
}
(globalThis as { __DET?: unknown }).__DET = result;
if (typeof window !== 'undefined' && typeof fetch === 'function') {
  void fetch('/result', { method: 'POST', body: JSON.stringify({ ua: navigator.userAgent, result }) });
}
