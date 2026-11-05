/**
 * A night's tally (kills by pilot and by turret, objectives, turrets lost,
 * the bastion's hull) and dawn's look back at it: the score, a perfect night
 * (no turret lost, the bastion kept above rules.score.perfectHull) and the
 * streak of them, which adds to dawn's supplies.
 */

import type { NightSummary, Run, SiegeCtx, Tally } from './types.js';

export function freshTally(hullStart: number): Tally {
  return { kills: 0, byPilot: new Map(), byPad: new Map(), value: 0, objectives: 0, hullStart, turretsLost: 0, padsLost: [] };
}

/** What dawn's supplies come to with a streak of `streak` perfect nights (base × (1 + step × streak), capped) */
export function streakBonus(ctx: SiegeCtx, streak: number): number {
  const S = ctx.rules.score;
  return Math.min(S.streakMax, S.streakStep * streak);
}

/** Dawn: the night's score and summary (kept on the run, shown by day); the streak goes on or ends. `base`: dawn's supplies before the streak */
export function dawnSummary(ctx: SiegeCtx, run: Run, hull: number, base: number): NightSummary {
  const S = ctx.rules.score, T = run.tally;
  const perfect = T.turretsLost === 0 && hull >= S.perfectHull;
  run.streak = perfect ? run.streak + 1 : 0;
  const bonus = streakBonus(ctx, run.streak);
  const score = Math.round(T.value * S.perKill + T.objectives * S.objective + hull * S.hullKept + (perfect ? S.perfect : 0));
  const best = score > run.best;
  if (best) run.best = score;
  let mvp: NightSummary['mvp'];
  for (const [pad, kills] of T.byPad) {
    const t = run.turrets[pad];
    if (t && kills > (mvp?.kills ?? 0)) mvp = { label: ctx.turretName(ctx.rules.turrets[t.kind].label, t.mark), kills };
  }
  run.summary = {
    night: run.wave, kills: T.kills, turretKills: [...T.byPad.values()].reduce((a, b) => a + b, 0), ...(mvp ? { mvp } : {}),
    hullLost: Math.max(0, Math.round((T.hullStart - hull) * 100)), turretsLost: T.turretsLost, objectives: T.objectives,
    supplies: Math.round(base * (1 + bonus)), streakBonus: bonus, perfect, streak: run.streak, score, best, byPilot: T.byPilot,
  };
  return run.summary;
}
