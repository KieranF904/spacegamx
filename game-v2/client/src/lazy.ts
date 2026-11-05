/**
 * A screen or module split out of the main chunk (a dynamic import). `value` is
 * null until its chunk has arrived; `use` runs at once when it has, else when it
 * arrives. Game prefetches these after sign-in (Game.prefetchScreens), so the
 * first open doesn't wait on the network.
 */
export class Lazy<T> {
  /** Loaded (and built), or null while the chunk is on its way */
  value: T | null = null;
  private loading: Promise<T> | null = null;

  constructor(private readonly build: () => Promise<T>) {}

  /** Starts the load (once; a failed load is tried again next time) */
  load(): Promise<T> {
    this.loading ??= this.build().then(
      (v) => (this.value = v),
      (e) => { this.loading = null; throw e; },
    );
    return this.loading;
  }

  /** Runs fn on it: at once if loaded, else when it arrives */
  use(fn: (v: T) => void): void {
    if (this.value) fn(this.value);
    else this.load().then(fn, (e) => console.error('Lazy load failed:', e));
  }
}

/** Runs the loads one after another, each in idle time (so no frame waits on a chunk's parse) */
export async function prefetchIdle(loads: (() => Promise<unknown>)[]): Promise<void> {
  const idle = () => new Promise<void>((done) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => done(), { timeout: 2000 });
    else setTimeout(done, 50);
  });
  for (const load of loads) {
    await idle();
    try { await load(); } catch (e) { console.warn('Prefetch failed:', e); }
  }
}
