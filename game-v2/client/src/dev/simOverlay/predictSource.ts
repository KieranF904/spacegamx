/**
 * The overlay's source with the prediction modes in (dev/predict): today's GameStateSource for the own ship's numbers,
 * plus per mode
 *   ST     every ship at the newest confirmed tick (the replica layer there: what the snapshots have told)
 *   PT     your ship at the prediction's tick; in C1 an AI ship where it's stepped ahead to; in C2/C3 every ship's PT
 *          at the tick it's drawn at (before the ease)
 *   drawn  where it is drawn this frame
 * and the PT/ST layer's counters (checks, misses, re-steps, touch re-steps, its CPU a tick) and the hit agreement of
 * your own shells (drawn strikes against told hits) as extra rows. Corrections: your own ship's (the base's) and every
 * PT re-step that moved a ship.
 */
import { AHEAD_BACK } from '@space-game/common';
import type { GameState } from '../../state/GameState';
import type { ShipClient } from '../../ships/ShipClient';
import type { PredictController } from '../predict/PredictController';
import { ptDrawTick } from '../../predict/modes';
import type { PtStStats } from '../../predict/ptst';
import type { GameStateSource } from './gameStateSource';
import type { CorrectionVector, OverlayCounters, OverlayShip, PoseXY, SimOverlaySource } from './types';

const WINDOW_MS = 3000;

/** Cumulative stats sampled over time: rates over the window */
class Deltas<T extends Record<string, number>> {
  private s: { t: number; v: T }[] = [];
  push(t: number, v: T): void {
    this.s.push({ t, v: { ...v } });
    while (this.s.length > 2 && this.s[1].t < t - WINDOW_MS) this.s.shift();
  }
  /** (newest - oldest) of a key, and the seconds between */
  delta(k: keyof T): { d: number; secs: number } {
    const a = this.s[0], b = this.s[this.s.length - 1];
    if (!a || a === b) return { d: 0, secs: 0 };
    return { d: b.v[k] - a.v[k], secs: (b.t - a.t) / 1000 };
  }
  rate(k: keyof T): number { const { d, secs } = this.delta(k); return secs > 0 ? d / secs : 0; }
  clear(): void { this.s = []; }
}

export class PredictSource implements SimOverlaySource {
  private readonly deltas = new Deltas<PtStStats & Record<string, number>>();
  private sampledAt = 0;
  private since = 0;

  constructor(private readonly base: GameStateSource, private readonly pc: PredictController, private readonly d: { state: GameState; shipClient: ShipClient }) {}

  camera() { return this.base.camera(); }

  ships(): OverlayShip[] {
    const out = this.base.ships();
    const s = this.d.state, reps = this.d.shipClient.replicas, mode = this.pc.mode.id, layer = this.pc.layer, ctx = this.pc.ctx;
    const c = s.serverTick, od = ctx.ownDraw();
    const pose = (b: { x: number; y: number; angle: number } | undefined | null): PoseXY | null => (b ? { x: b.x, y: b.y, angle: b.angle } : null);
    for (const sh of out) {
      // ST: the confirmed tick's state on the replica layer (the base's own-ship ghost is the pose ring's)
      const st = sh.own ? reps.ring.get(sh.id, c)?.body : reps.at(sh.id, c)?.body;
      sh.st = pose(st) ?? sh.st;
      if (sh.own) { sh.pt = pose(reps.ring.get(sh.id, s.predictedTick)?.body) ?? sh.pt; continue; }
      if ((mode === 'C2' || mode === 'C3') && layer.has(sh.id)) sh.pt = layer.ptPose(sh.id, ptDrawTick(ctx, sh.id, od));
      else if (mode === 'C1' && ctx.ai(sh.id)) sh.pt = pose(reps.ring.get(sh.id, Math.floor(Math.max(s.renderTickNow, od - AHEAD_BACK)))?.body);
      else sh.pt = null;
    }
    return out;
  }

  corrections(): CorrectionVector[] {
    const own = this.base.corrections();
    for (const k of this.pc.layer.takeCorrections()) own.push({ id: k.id, from: { x: k.from.x, y: k.from.y }, to: { x: k.to.x, y: k.to.y }, at: performance.now() });
    return own;
  }

  private sample(now: number): void {
    if (this.since !== this.pc.switchedAt) { this.since = this.pc.switchedAt; this.deltas.clear(); }
    if (now - this.sampledAt < 200) return;
    this.sampledAt = now;
    const t = this.pc.tally.totals;
    this.deltas.push(now, { ...this.pc.layer.stats, agreed: t.agreed, drawnOnly: t.drawnOnly, toldOnly: t.toldOnly });
  }

  /** The numbers the overlay and the demo log read (also window.__simTools.read()) */
  read(): Record<string, number> {
    this.sample(performance.now());
    const r = (k: string) => this.deltas.rate(k);
    const ticks = this.deltas.delta('ticks').d;
    const hits = this.pc.tally.read(), strikes = this.pc.strikes.read(), gp = this.pc.drawGap.pilot.read(), ga = this.pc.drawGap.ai.read(), gb = this.pc.drawGap.boss.read();
    const checks = this.deltas.delta('checks').d, misses = this.deltas.delta('misses').d;
    return {
      ptShips: [...this.pc.layer.ring.ids()].length,
      checksPerSec: r('checks'),
      missesPerSec: r('misses'),
      matchPct: checks > 0 ? (100 * (checks - misses)) / checks : NaN,
      restepShipsPerSec: r('restepShips'),
      touchShipsPerSec: r('touchShips'),
      restepTicksPerSec: r('restepTicks'),
      correctionsPerSec: r('resteps'),
      restepMsPerTick: ticks > 0 ? this.deltas.delta('restepMs').d / ticks : 0,
      advanceMsPerTick: ticks > 0 ? this.deltas.delta('advanceMs').d / ticks : 0,
      contactsPerSec: r('contacts'),
      snapsPerSec: r('snaps'),
      ptLodOut: this.pc.prediction.world.lodOut,
      hitAgreementPct: 100 * hits.agreement,
      hitsAgreedPerSec: hits.agreed,
      hitsDrawnOnlyPerSec: hits.drawnOnly,
      hitsToldOnlyPerSec: hits.toldOnly,
      hitsOnShields: this.pc.tally.totals.shield,
      strikeGapMean: strikes.gapMean,
      strikeGapMax: strikes.gapMax,
      strikeOnTargetPct: strikes.onTargetPct,
      drawGapPilot: gp.gapMean,
      drawGapPilotOnPct: gp.onTargetPct,
      drawGapAi: ga.gapMean,
      drawGapAiOnPct: ga.onTargetPct,
      drawGapBoss: gb.gapMean,
      drawGapBossOnPct: gb.onTargetPct,
      ...this.kindRows(),
      correctionMean: this.deltas.delta('corrections').d > 0 ? this.deltas.delta('correctionDist').d / this.deltas.delta('corrections').d : 0,
    };
  }

  /** The PT timeline's other kinds (bodies, guides, moves: predict/ptKinds.ts), since the mode was switched */
  private kindRows(): Record<string, number> {
    const out: Record<string, number> = {}, secs = Math.max(1e-3, (performance.now() - this.pc.switchedAt) / 1000);
    for (const k of this.pc.world.kinds.all()) {
      if (k.name === 'ships') continue;
      const s = k.stats, n = k.name;
      out[`${n}MatchPct`] = s.checks > 0 ? (100 * s.matches) / s.checks : NaN;
      out[`${n}RestepsPerSec`] = s.restepThings / secs;
      out[`${n}CorrMean`] = s.corrections > 0 ? s.correctionDist / s.corrections : 0;
      out[`${n}AheadPct`] = s.ahead + s.late > 0 ? (100 * s.ahead) / (s.ahead + s.late) : NaN;
      out[`${n}LateTicks`] = s.late > 0 ? s.lateTicks / s.late : 0;
      out[`${n}WrongPerSec`] = s.wrong / secs;
      out[`${n}MsPerTick`] = s.ticks > 0 ? (s.advanceMs + s.restepMs) / s.ticks : 0;
    }
    return out;
  }

  counters(): Partial<OverlayCounters> {
    const c = this.base.counters(), n = this.read();
    return {
      ...c,
      correctionsPerSec: (c.correctionsPerSec ?? 0) + n.restepShipsPerSec,
      restepsPerSec: (c.restepsPerSec ?? 0) + n.restepTicksPerSec,
      predictionCpuMs: c.predictionCpuMs,
      drawnHitsPerSec: n.hitsAgreedPerSec + n.hitsDrawnOnlyPerSec,
      realHitsPerSec: n.hitsAgreedPerSec + n.hitsToldOnlyPerSec,
      inputToScreenMs: this.pc.mode.id === 'B' ? (c.inputToScreenMs ?? 0) + this.d.state.interpDelayMs + this.d.state.ping / 2 : c.inputToScreenMs,
    };
  }

  mode(): string { return this.pc.mode.label; }

  extras(): Record<string, string | number> {
    const n = this.read(), f = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');
    const rows: Record<string, string | number> = {
      'drawn vs ST: pilots': Number.isFinite(n.drawGapPilotOnPct) ? `${f(n.drawGapPilot)} u, ${f(n.drawGapPilotOnPct, 0)} % on` : '-',
      'drawn vs ST: AI': Number.isFinite(n.drawGapAiOnPct) ? `${f(n.drawGapAi)} u, ${f(n.drawGapAiOnPct, 0)} % on` : '-',
      'strikes on target (own)': Number.isFinite(n.strikeOnTargetPct) ? `${f(n.strikeOnTargetPct, 0)} %` : '-',
      '  drawn vs ST gap': `${f(n.strikeGapMean)} u (max ${f(n.strikeGapMax, 0)})`,
      'hit agreement (own)': Number.isFinite(n.hitAgreementPct) ? `${f(n.hitAgreementPct, 0)} %` : '-',
      '  drawn+told / s': f(n.hitsAgreedPerSec),
      '  drawn only / s': f(n.hitsDrawnOnlyPerSec),
      '  told only / s': f(n.hitsToldOnlyPerSec),
      '  on shields (left out)': n.hitsOnShields,
    };
    const m = this.pc.mode.id;
    if (m === 'C2' || m === 'C3') {
      Object.assign(rows, {
        'PT ships': n.ptShips,
        'ST checks / s': f(n.checksPerSec),
        'ST match': Number.isFinite(n.matchPct) ? `${f(n.matchPct, 1)} %` : '-',
        'PT re-steps / s (ships)': f(n.restepShipsPerSec),
        '  of them touched (C3)': f(n.touchShipsPerSec),
        'PT re-step ticks / s': f(n.restepTicksPerSec, 0),
        'PT contacts / s': f(n.contactsPerSec),
        'PT correction mean': `${f(n.correctionMean)} u`,
        're-step CPU / tick': `${f(n.restepMsPerTick, 3)} ms`,
        'PT step CPU / tick': `${f(n.advanceMsPerTick, 3)} ms`,
        'ease (lerp)': `${this.pc.lerpMs} ms`,
        'drawn vs ST: bosses': Number.isFinite(n.drawGapBossOnPct) ? `${f(n.drawGapBoss)} u, ${f(n.drawGapBossOnPct, 0)} % on` : '-',
        'PT bosses: ST match': Number.isFinite(n.bodiesMatchPct) ? `${f(n.bodiesMatchPct, 0)} %, ${f(n.bodiesRestepsPerSec)} re-steps/s, corr ${f(n.bodiesCorrMean)} u` : '-',
        'PT shells+mobs: ST match': Number.isFinite(n.guidesMatchPct) ? `${f(n.guidesMatchPct, 0)} %, ${f(n.guidesRestepsPerSec)} re-steps/s, corr ${f(n.guidesCorrMean)} u` : '-',
        'PT boss moves: ST match': Number.isFinite(n.movesMatchPct) ? `${f(n.movesMatchPct, 0)} %, ${f(n.movesRestepsPerSec)} re-steps/s` : '-',
        '  looks+shells ahead': Number.isFinite(n.movesAheadPct) ? `${f(n.movesAheadPct, 0)} % (late ones ${f(n.movesLateTicks)} ticks), wrong ${f(n.movesWrongPerSec)}/s` : '-',
        'world kinds CPU / tick': `${f(n.bodiesMsPerTick + n.guidesMsPerTick + n.movesMsPerTick, 3)} ms`,
      });
    }
    return rows;
  }
}

