/**
 * The overlay's source from what exists today (Stage 1): GameState's reconcile statistics, the own-ship pose ring
 * (selfPoseAt), the replica layer (ShipClient.replicas.at) and the hit counters. Nothing here edits those; it only reads.
 * Where today's code has no such number (hash misses, true re-step counts) the member is left out and the overlay shows a dash.
 *
 * The prediction CPU is measured by wrapping GameState's shipPhysics / shipGuns hooks while the overlay is on (restored when it
 * is switched off). Stage 3 / Stage 4 sources replace this adapter, or add to it through the SimOverlaySource's optional members.
 */
import { EntityType, ReplicaMode } from '@space-game/common';
import type { GameState } from '../../state/GameState';
import type { ShipClient } from '../../ships/ShipClient';
import type { Renderer } from '../../rendering/Renderer';
import { RateCounter, ValueWindow, ReconcileWatcher } from './counters';
import type { CorrectionVector, OverlayCounters, OverlayShip, PoseXY, SimOverlaySource } from './types';

export interface GameStateSourceDeps {
  state: GameState;
  shipClient: ShipClient;
  renderer: Renderer;
}

export class GameStateSource implements SimOverlaySource {
  private readonly watch = new ReconcileWatcher();
  private readonly drawnHits = new RateCounter();
  private readonly realHits = new RateCounter();
  private readonly cpu = new ValueWindow(2000);
  private readonly frames = new ValueWindow(2000);
  private frameCpu = 0;
  private lastFound = -1;
  private lastRecords = -1;
  private pending: CorrectionVector[] = [];
  private lastFrameAt = 0;
  private unwrap: (() => void) | null = null;

  constructor(private readonly d: GameStateSourceDeps) {}

  /** Start timing prediction (wraps the state's own-ship step hook: its tick layer's whole step, and any re-steps) */
  attach(): void {
    if (this.unwrap) return;
    const s = this.d.state;
    const step = s.ownStep;
    const timed = <A extends unknown[], R>(f: (...a: A) => R) => (...a: A): R => { const t = performance.now(); try { return f(...a); } finally { this.frameCpu += performance.now() - t; } };
    const wstep = step ? timed(step) : null;
    s.ownStep = wstep;
    this.unwrap = () => {
      // (Only put back what is still ours: someone may have replaced the hook since)
      if (s.ownStep === wstep) s.ownStep = step;
    };
  }

  detach(): void { this.unwrap?.(); this.unwrap = null; }

  camera() {
    const r = this.d.renderer, v = r.getCameraView();
    return { x: v.x, y: v.y, zoom: r.getZoom(), angle: r.getCameraAngle(), width: v.width, height: v.height };
  }

  /** Once a frame, from the overlay's draw: take the frame's measurements */
  private sample(now: number): void {
    const s = this.d.state;
    const hit = this.watch.observe(now, s);
    if (hit) {
      const me = s.entities.get(s.playerId);
      // (The correction's direction isn't kept by GameState: drawn as the server-minus-prediction gap along the ship's last render error)
      if (me) this.pending.push({ id: me.id, from: { x: me.renderX, y: me.renderY }, to: { x: me.x, y: me.y }, at: now });
    }
    this.cpu.push(now, this.frameCpu);
    this.frameCpu = 0;
    if (this.lastFrameAt) this.frames.push(now, now - this.lastFrameAt);
    this.lastFrameAt = now;
    const sc = this.d.shipClient;
    const found = sc.selfHits?.stats?.found ?? 0, records = sc.hits?.stats?.records ?? 0;
    if (this.lastFound >= 0 && found > this.lastFound) this.drawnHits.add(now, found - this.lastFound);
    if (this.lastRecords >= 0 && records > this.lastRecords) this.realHits.add(now, records - this.lastRecords);
    this.lastFound = found; this.lastRecords = records;
  }

  ships(): OverlayShip[] {
    const s = this.d.state, now = performance.now();
    this.sample(now);
    const out: OverlayShip[] = [];
    const tick = Math.floor(s.getRawServerTick());
    // (Ship bodies too: drones and dummies; not debris)
    for (const type of [EntityType.Player, EntityType.Enemy, EntityType.NPC, EntityType.ShipBody]) {
      for (const e of s.entities.ofType(type)) {
        if (type === EntityType.ShipBody && this.d.shipClient.replicas.modeOf(e.id) === ReplicaMode.Drift) continue;
        const own = e.id === s.playerId;
        let st: PoseXY | null = null;
        if (own) {
          // (The pose the tick layer kept for the latest server tick: where the server had us while the prediction held)
          for (let k = 0; k < 12 && !st; k++) { const p = s.selfPoseAt(tick - k); if (p) st = { x: p.x, y: p.y, angle: p.angle }; }
        } else {
          const b = this.d.shipClient.replicas.at(e.id, tick)?.body;
          if (b) st = { x: b.x, y: b.y, angle: b.angle };
        }
        out.push({ id: e.id, own, pt: { x: e.x, y: e.y, angle: e.angle }, st, drawn: { x: e.renderX, y: e.renderY, angle: e.renderAngle } });
      }
    }
    return out;
  }

  corrections(): CorrectionVector[] {
    const p = this.pending;
    this.pending = [];
    return p;
  }

  counters(): Partial<OverlayCounters> {
    const now = performance.now(), s = this.d.state;
    const frame = this.frames.mean(now);
    return {
      correctionsPerSec: this.watch.corrections.perSec(now),
      restepsPerSec: this.watch.resteps.perSec(now),
      meanCorrection: this.watch.sizes.mean(now),
      maxCorrection: this.watch.sizes.max(now),
      predictionCpuMs: this.cpu.mean(now),
      drawnHitsPerSec: this.drawnHits.perSec(now),
      realHitsPerSec: this.realHits.perSec(now),
      // Estimate: a predicted input shows on the next frame; confirmed motion (others, or prediction off) waits a round trip
      inputToScreenMs: s.predictionEnabled ? frame : frame + s.ping,
    };
  }

  mode(): string { return this.d.state.predictionEnabled ? 'A (current: prediction on)' : 'B (prediction off)'; }
}

