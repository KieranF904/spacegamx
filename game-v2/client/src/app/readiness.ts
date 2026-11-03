/**
 * Is the world in sync yet? The loading screen (ui/LoadingScreen.ts, driven by app/loadingFlow.ts) stays up until
 * every signal here holds, so nothing half-built is seen when it lifts: the camera sliding onto your ship, rocks
 * jumping to their orbits when the clock is first set, ships popping in, rock detail switching on.
 *
 * Pure: the caller reads the game into a ReadinessProbe each frame and asks check(). Tested in readiness.test.ts.
 */

/** What the game looks like this frame (loadingFlow.ts reads it) */
export interface ReadinessProbe {
  /** Connected, and the server's welcome has given us a player id */
  joined: boolean;
  /** Our ship is in the world, its blueprint with it */
  ship: boolean;
  /** A pong has set the estimate of the server's tick (until then rock orbits, stations and other ships are worked out at the wrong tick) */
  clock: boolean;
  /** A snapshot is buffered and the render tick has reached it (interpolation has its data: nothing is drawn from before it) */
  view: boolean;
  /** Nothing waiting to be built: textures asked of the procedural worker (rock relief, stations, sun, planets), rock
   *  chunks, ship hulls in the hull worker, the hull atlas */
  built: boolean;
}

export type SignalKey = keyof ReadinessProbe;

/** The signals in the order they come in, each with the step the screen names while it's the one being waited on */
export const SIGNALS: readonly { key: SignalKey; step: string }[] = [
  { key: 'joined', step: 'Connecting' },
  { key: 'ship', step: 'Receiving the world' },
  { key: 'clock', step: 'Syncing with the server' },
  { key: 'view', step: 'Catching up' },
  { key: 'built', step: 'Building the sector' },
];

export interface ReadinessState {
  /** The first signal not met yet, as the screen says it ('Ready' once all are) */
  step: string;
  /** Signals met, 0..1 */
  progress: number;
  /** Lift the screen */
  done: boolean;
  /** Lifted by the timeout, not because everything came in */
  timedOut: boolean;
  /** What was still missing (for the log when the timeout lifts it) */
  missing: SignalKey[];
}

export interface ReadinessOptions {
  /** Lift the screen anyway after this long (ms) */
  timeoutMs?: number;
  /** All signals must hold for this many checks in a row (a texture asked for this frame shows as pending only next frame) */
  settleChecks?: number;
}

export class Readiness {
  readonly timeoutMs: number;
  readonly settleChecks: number;
  private startedAt = 0;
  private settled = 0;

  constructor(opts: ReadinessOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.settleChecks = Math.max(1, opts.settleChecks ?? 3);
  }

  /** Start waiting (a join, an arrival, a respawn) */
  begin(now: number): void {
    this.startedAt = now;
    this.settled = 0;
  }

  /** How long since begin (ms) */
  elapsed(now: number): number {
    return now - this.startedAt;
  }

  /** This frame's verdict */
  check(probe: ReadinessProbe, now: number): ReadinessState {
    const missing: SignalKey[] = [];
    for (const s of SIGNALS) if (!probe[s.key]) missing.push(s.key);
    const first = SIGNALS.find((s) => !probe[s.key]);
    const progress = (SIGNALS.length - missing.length) / SIGNALS.length;
    this.settled = missing.length ? 0 : this.settled + 1;
    if (this.settled >= this.settleChecks) return { step: 'Ready', progress: 1, done: true, timedOut: false, missing };
    if (now - this.startedAt >= this.timeoutMs) return { step: first?.step ?? 'Ready', progress, done: true, timedOut: missing.length > 0, missing };
    return { step: first?.step ?? 'Ready', progress, done: false, timedOut: false, missing };
  }
}
