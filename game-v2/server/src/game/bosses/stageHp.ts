/**
 * A staged boss's HP by stage (bosses.json `stageHp`, docs/bosses/rework-2026-11.md 3.1): each stage's deciding parts
 * (common ships/stages.ts `deciding`) are rescaled so they sum to that stage's figure, keeping their shares (its core's
 * x2.5 counted, so apply after hardening). Parts that don't decide a stage (bones, cover that needn't be shot off) keep
 * the boss's `hp` scale. Set once at spawn; its recovery heals back to these.
 */
import { deciding, stageOf } from '@space-game/common';
import type { ShipBridge } from '../../ships/ShipBridge.js';

export function applyStageHp(ships: ShipBridge, eid: number, stageHp: readonly number[]): void {
  const ship = ships.get(eid);
  if (!ship) return;
  const cat = ships.catalog, sums = new Map<number, number>();
  ship.blueprint.parts.forEach((_, i) => {
    if (!deciding(cat, ship, i)) return;
    const st = stageOf(cat, ship, i);
    sums.set(st, (sums.get(st) ?? 0) + ship.maxHp[i]);
  });
  const hp = ship.maxHp.map((h, i) => {
    if (!deciding(cat, ship, i)) return h;
    const st = stageOf(cat, ship, i), want = stageHp[st - 1], sum = sums.get(st) ?? 0;
    return want > 0 && sum > 0 ? (h * want) / sum : h;
  });
  ships.setMaxHp(eid, hp);
}
