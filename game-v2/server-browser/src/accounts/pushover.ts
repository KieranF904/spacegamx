/**
 * Pushover notices to Kieran's phone when someone registers an account, never saying who (every sign-up, from the game or the website,
 * comes through here). The game server sends its own for joins (server/src/auth/pushover.ts, the same rules): on in
 * production when PUSHOVER_TOKEN and PUSHOVER_USER are set (deploy/vps/deploy.sh copies them into
 * /etc/spacegame/secrets.env), NOTIFY_EVENTS=0 turns it off; elsewhere off unless NOTIFY_EVENTS=1 (keys then from
 * game-v2/.env). Never throws, never makes the caller wait, never logs the keys; at most MAX_PER_HOUR an hour.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const MAX_PER_HOUR = 30;

interface Keys { token: string; user: string }

function keys(env = process.env): Keys | null {
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
  private sent: number[] = [];
  private held = 0;

  constructor(private readonly k: Keys | null = keys(), private readonly now: () => number = Date.now, private readonly post: (k: Keys, title: string, message: string) => Promise<unknown> = send) {}

  get on(): boolean {
    return this.k !== null;
  }

  /** A new account (that one was made, never whose: no name or other account detail leaves for Pushover) */
  registered(): void {
    this.notify('Space Game: new pilot', 'A new account was registered.');
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

/** The lobby's notifier (keys read once, at start) */
export const notifier = new Notifier();
