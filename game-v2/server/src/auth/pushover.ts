/**
 * Pushover notices to Kieran's phone when someone joins the live game server (that someone did, never who). The lobby sends its own for
 * registrations (server-browser/src/accounts/pushover.ts, the same rules).
 *
 * On in production when PUSHOVER_TOKEN and PUSHOVER_USER are set (deploy/vps/deploy.sh copies them from game-v2/.env
 * into /etc/spacegame/secrets.env); NOTIFY_EVENTS=0 turns it off. Anywhere else it's off unless NOTIFY_EVENTS=1, and then
 * the keys can come from game-v2/.env (the dev servers don't load it). Never throws, never makes the caller wait, never
 * logs the keys. A name is told at most once in JOIN_QUIET_MS (reconnects), and at most MAX_PER_HOUR notices go out in
 * an hour; the ones held back are counted into the next.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const JOIN_QUIET_MS = 30 * 60_000;
const MAX_PER_HOUR = 30;

interface Keys { token: string; user: string }

// (No `process` in the browser: proto mode bundles the server, and there it's off)
function keys(env: NodeJS.ProcessEnv = typeof process === 'undefined' ? {} : process.env): Keys | null {
  const want = env.NOTIFY_EVENTS ?? (env.NODE_ENV === 'production' ? '1' : '0');
  if (want !== '1') return null;
  let token = env.PUSHOVER_TOKEN, user = env.PUSHOVER_USER;
  if ((!token || !user) && env.NODE_ENV !== 'production') {
    try {
      const file = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../.env'), 'utf8');
      token ||= /^PUSHOVER_TOKEN=(.*)$/m.exec(file)?.[1]?.trim();
      user ||= /^PUSHOVER_USER=(.*)$/m.exec(file)?.[1]?.trim();
    } catch { /* no .env */ }
  }
  return token && user ? { token, user } : null;
}

export class Notifier {
  private lastJoin = new Map<string, number>();
  private sent: number[] = [];
  private held = 0;

  constructor(private readonly k: Keys | null = keys(), private readonly now: () => number = Date.now, private readonly post: (k: Keys, title: string, message: string) => Promise<unknown> = send) {}

  get on(): boolean {
    return this.k !== null;
  }

  /**
   * Someone joined: signed in or a guest, and how many are on now. The notice never says who (no name or other account
   * detail leaves for Pushover: the website's admin activity page says who is on); `name` only stops a reconnect from
   * being told twice
   */
  join(name: string, guest: boolean, online: number): void {
    if (!this.k) return;
    const t = this.now(), key = name.toLowerCase();
    if (t - (this.lastJoin.get(key) ?? -Infinity) < JOIN_QUIET_MS) return;
    this.lastJoin.set(key, t);
    if (this.lastJoin.size > 1000) for (const [n, at] of this.lastJoin) if (t - at >= JOIN_QUIET_MS) this.lastJoin.delete(n);
    this.notify('Space Game: pilot joined', `${guest ? 'A guest' : 'A pilot'} joined. ${online} online.`);
  }

  notify(title: string, message: string): void {
    if (!this.k) return;
    const t = this.now();
    this.sent = this.sent.filter((at) => t - at < 3_600_000);
    if (this.sent.length >= MAX_PER_HOUR) { this.held++; return; }
    this.sent.push(t);
    const more = this.held ? ` (+${this.held} more not sent this hour)` : '';
    this.held = 0;
    this.post(this.k, title, message + more).catch(() => { /* a notice is best effort */ });
  }
}

async function send(k: Keys, title: string, message: string): Promise<void> {
  await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: k.token, user: k.user, title, message }),
    signal: AbortSignal.timeout(10_000),
  });
}

/** The game server's notifier (keys read once, at start) */
export const notifier = new Notifier();
