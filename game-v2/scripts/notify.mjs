// Send a Pushover notification (dev progress updates).
//   node --env-file=.env scripts/notify.mjs "Title" "Message"
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
