/**
 * Custom enemies' bodies (docs/enemies/custom-roster.md), in their roster.json order (an order's design). Adding one is
 * its module and a line here, in the roster's order.
 */
import roster from './roster.json' with { type: 'json' };
import { CENSER } from './censer.js';
import { MAW_LURKER } from './mawLurker.js';
import { HOOKBOAT } from './hookboat.js';
import { RIME_BELL } from './rimeBell.js';
import { SCRAP_CRAWLER } from './scrapCrawler.js';
import { RIVET_SOWER } from './rivetSower.js';
import { SLAG_RAY } from './slagRay.js';
import { CLINKER } from './clinker.js';
import { HELIOS_DRONE } from './heliosDrone.js';
import type { CustomDesign } from './types.js';

export const CUSTOM_DESIGNS: readonly CustomDesign[] = [CENSER, MAW_LURKER, HOOKBOAT, RIME_BELL, SCRAP_CRAWLER, RIVET_SOWER, SLAG_RAY, CLINKER, HELIOS_DRONE];
CUSTOM_DESIGNS.forEach((d, i) => { if (roster.designs[i]?.id !== d.id) throw new Error(`custom enemies: ${d.id} isn't roster.json's design ${i}`); });

/** A design's place (-1: not a custom enemy) */
export function customIndex(design: string): number {
  return CUSTOM_DESIGNS.findIndex((d) => d.id === design);
}

/** A design's destroyable pieces, in their order (a bit each) */
export function customGroups(design: string): readonly string[] {
  return roster.designs.find((r) => r.id === design)?.groups ?? [];
}

export * from './types.js';
export * from './order.js';
export * from './flight.js';
export { CENSER_WARN, CENSER_BURN } from './censer.js';
export { LURKER_WARN } from './mawLurker.js';
export { HOOK_WARN } from './hookboat.js';
export { BELL_WARN } from './rimeBell.js';
export { CRAWLER_PULL, CRAWLER_SNAP } from './scrapCrawler.js';
export { SOWER_AHEAD, SOWER_SOW, SOWER_LEAD } from './rivetSower.js';
export { RAY_PASS } from './slagRay.js';
export { CLINKER_WARN, CLINKER_SHELLS, CLINKER_GAP } from './clinker.js';
export { TORCH_TICKS } from './heliosDrone.js';
