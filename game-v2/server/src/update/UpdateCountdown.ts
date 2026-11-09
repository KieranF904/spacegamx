/**
 * @contract server.update.countdown
 * owns:       the countdown to a scheduled server update: announcements at 15 / 5 / 1 minutes, the join block in the last minute, the save and clean exit at the time
 * needs:      an UpdateHost (clock, say, banner, exit); learns the schedule from the lobby's heartbeat answer
 * invariants: each of 15 / 5 / 1 minutes is announced once, a late schedule announces only what is still ahead — server/src/update/countdown.test.ts
 *             new sign-ins are refused from 1 minute before — server/src/update/countdown.test.ts
 *             at the time it exits once, through the host (which saves everyone first) — server/src/update/countdown.test.ts
 *             a schedule that is gone from the lobby's answer is a cancellation; a failed heartbeat changes nothing — server/src/update/countdown.test.ts
 * extend:     another warning is one more number in MILESTONES_MS
 */

export const MILESTONES_MS = [15 * 60_000, 5 * 60_000, 60_000];
/** From this long before the update, no new sign-ins */
export const JOIN_BLOCK_MS = 60_000;
/** How often the banner is sent again (so pilots who join mid-countdown see it) */
export const BANNER_EVERY_MS = 30_000;
/** The exit code the process manager restarts on (systemd Restart=always restarts on any; Fly's restart policy "always" too) */
export const UPDATE_EXIT_CODE = 75;
export const JOIN_REFUSED = 'The server is restarting for an update in under a minute. Try again in a minute.';

export interface UpdateHost {
  now(): number;
  /** A chat line for everyone online */
  say(text: string): void;
  /** The HUD banner for everyone online: `inMs` left, 0 to take it away */
  banner(inMs: number): void;
  /** Save everyone (lingering ships included) and exit with `code` */
  exit(code: number): void | Promise<void>;
  log?(text: string): void;
}

/** "15 min" / "1 min" / "30 s" */
export function span(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.max(1, Math.round(ms / 1000))} s`;
}

export class UpdateCountdown {
  private at: number | null = null;
  private said = new Set<number>();
  private lastBanner = 0;
  private exiting = false;

  constructor(private host: UpdateHost) {}

  /** Time to the update (null: none scheduled) */
  left(): number | null {
    return this.at === null ? null : this.at - this.host.now();
  }

  /**
   * The lobby's answer to a heartbeat: `{ inMs }` when an update is scheduled, nothing when not. (A heartbeat that failed is
   * not an answer: call nothing.) An update already due (inMs 0) is ignored: this server started after it, on the new build.
   */
  onLobby(update: { inMs: number } | null | undefined): void {
    if (this.exiting) return;
    const inMs = update && Number.isFinite(update.inMs) ? update.inMs : null;
    if (inMs === null || inMs <= 0) {
      if (this.at !== null) this.cancel();
      return;
    }
    const at = this.host.now() + inMs;
    // (Heartbeats repeat the same schedule with a little jitter: only a real change counts)
    if (this.at !== null && Math.abs(at - this.at) < 5_000) return;
    this.at = at;
    this.said.clear();
    // Announce where we are now: the milestones already passed count as said, the nearest one is said at once
    const passed = MILESTONES_MS.filter((m) => inMs <= m);
    for (const m of passed) this.said.add(m);
    this.host.say(`Server update in ${span(inMs)}. The server restarts, and you can rejoin straight after.`);
    this.sendBanner();
    this.host.log?.(`update scheduled in ${span(inMs)}`);
  }

  /** Once a second */
  tick(): void {
    if (this.at === null || this.exiting) return;
    const left = this.at - this.host.now();
    for (const m of MILESTONES_MS) {
      if (left <= m && !this.said.has(m)) {
        this.said.add(m);
        this.host.say(`Server update in ${span(m)}.${m === MILESTONES_MS[MILESTONES_MS.length - 1] ? ' New sign-ins are closed until it is back.' : ''}`);
        this.sendBanner();
      }
    }
    if (left <= 0) {
      this.exiting = true;
      this.host.banner(0.001);
      this.host.say('The server is restarting now. You can rejoin in a minute.');
      this.host.log?.('update time: saving and exiting');
      void Promise.resolve(this.host.exit(UPDATE_EXIT_CODE)).catch((e) => this.host.log?.(`update exit failed: ${String(e)}`));
      return;
    }
    if (this.host.now() - this.lastBanner >= BANNER_EVERY_MS) this.sendBanner();
  }

  /** The message every new sign-in is refused with (null: open) */
  joinRefusal(): string | null {
    if (this.exiting) return JOIN_REFUSED;
    const left = this.left();
    return left !== null && left <= JOIN_BLOCK_MS ? JOIN_REFUSED : null;
  }

  private cancel(): void {
    this.at = null;
    this.said.clear();
    this.host.say('The server update was cancelled.');
    this.host.banner(0);
    this.host.log?.('update cancelled');
  }

  private sendBanner(): void {
    this.lastBanner = this.host.now();
    if (this.at !== null) this.host.banner(Math.max(1, this.at - this.host.now()));
  }
}
