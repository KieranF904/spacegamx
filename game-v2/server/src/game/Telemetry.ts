/**
 * What new pilots run into, written down so we can see where the early game
 * loses them: every death (where, to what, in which band of the system, in
 * what ship) and each pilot's milestones the first time they happen (first
 * dock, mine, kill, refit, job and boss; levels 2-10; each system visited),
 * with minutes since they started.
 *
 * One JSON object per line, in data/telemetry/pilots.jsonl on a real server
 * (index.ts gives the writer; tests and the proto keep it off).
 */

/** Appends lines to wherever telemetry is kept (index.ts: a file; the browser proto has none) */
export type TelemetryWriter = (lines: string) => Promise<void>;

export interface TelemetryRecord {
  /** 'death', or the milestone's name */
  ev: string;
  /** Account (u:<id>) or guest name (g:<name>) */
  who: string;
  level: number;
  /** Minutes since this pilot's profile was made */
  minutes: number;
  [k: string]: unknown;
}

export class Telemetry {
  private queue: string[] = [];
  private writing = false;

  /** `write`: where lines go (null: record nothing) */
  constructor(private write: TelemetryWriter | null, private now: () => number = () => Date.now()) {}

  get enabled(): boolean {
    return !!this.write;
  }

  record(r: TelemetryRecord): void {
    if (!this.write) return;
    this.queue.push(JSON.stringify({ t: new Date(this.now()).toISOString(), ...r }));
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.write || this.writing) return;
    this.writing = true;
    try {
      while (this.queue.length) await this.write(this.queue.splice(0).join('\n') + '\n');
    } catch (e) {
      console.warn('[telemetry] write failed:', (e as Error).message);
      this.queue = [];
    } finally {
      this.writing = false;
    }
  }
}
