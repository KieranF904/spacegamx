// Send a Pushover notification (dev progress updates).
//   node scripts/notify.mjs "Title" "Message"   (reads game-v2/.env itself when the variables are not already set)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Fill PUSHOVER_* from game-v2/.env when the environment lacks them (like node --env-file). Values are never printed.
if (!process.env.PUSHOVER_TOKEN || !process.env.PUSHOVER_USER) {
  try {
    for (const line of readFileSync(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  } catch { /* no .env: fall through to the not-set message */ }
}
const [, , title = 'Space Game', message = ''] = process.argv;
const token = process.env.PUSHOVER_TOKEN, user = process.env.PUSHOVER_USER;
if (!token || !user) { console.error('PUSHOVER_TOKEN / PUSHOVER_USER not set'); process.exit(1); }
const res = await fetch('https://api.pushover.net/1/messages.json', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token, user, title, message: message || title }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok || body.status !== 1) { console.error('Pushover failed', res.status, JSON.stringify(body)); process.exit(1); }
console.log('sent');
