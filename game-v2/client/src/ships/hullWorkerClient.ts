/**
 * The hull worker (hullWorker.ts) as ShipRenderer uses it: a job in, its answer (or null: it failed, or there's no
 * worker) to a callback. If the worker can't start or breaks, every job answers null at once, and the renderer builds
 * on the main thread as it always did. `terminate()` ends it (jobs still out are dropped, their callbacks never called).
 */
import type { HullDone, HullJob } from './hullWire';

export class HullWorker {
  private w: Worker | null = null;
  private next = 1;
  private waiting = new Map<number, (d: HullDone | null) => void>();

  constructor() {
    try {
      this.w = new Worker(new URL('./hullWorker.ts', import.meta.url), { type: 'module' });
      this.w.onmessage = (e: MessageEvent<HullDone & { error?: string }>) => {
        const cb = this.waiting.get(e.data.id);
        this.waiting.delete(e.data.id);
        if (e.data.error) console.warn('[hull worker]', e.data.error);
        cb?.(e.data.error ? null : e.data);
      };
      this.w.onerror = (e) => { console.warn('[hull worker] failed', e.message); this.fail(); };
    } catch {
      this.w = null;
    }
  }

  /** Can it take jobs (false: build on the main thread) */
  get ok(): boolean {
    return this.w !== null;
  }

  /** Jobs out, not yet answered */
  get pending(): number {
    return this.waiting.size;
  }

  build(job: Omit<HullJob, 'id'>, done: (d: HullDone | null) => void): void {
    if (!this.w) { done(null); return; }
    const id = this.next++;
    this.waiting.set(id, done);
    this.w.postMessage({ ...job, id });
  }

  terminate(): void {
    this.w?.terminate();
    this.w = null;
    this.waiting.clear();
  }

  private fail(): void {
    this.w?.terminate();
    this.w = null;
    for (const cb of this.waiting.values()) cb(null);
    this.waiting.clear();
  }
}
