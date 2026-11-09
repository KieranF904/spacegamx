/**
 * A guest's identity in this browser: a secret key and the name it flies under, kept in localStorage. Each join as a
 * guest sends the key (join.guestKey), and the server keeps the guest's pilot under it a while (server
 * game/pilots/guests.ts): a dropped socket, a restarted server or a reload brings back the same pilot, tutorial step and
 * all. The key is the guest's proof, never the name (anyone can type a name). No storage (a private window that refuses
 * it): a key for this page only, which still covers a reconnect.
 */

const KEY_ITEM = 'guestKey';
const NAME_ITEM = 'guestName';

let memo: { key: string; name: string | null } | null = null;

function newKey(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function load(): { key: string; name: string | null } {
  if (memo) return memo;
  let key: string | null = null, name: string | null = null;
  try {
    key = localStorage.getItem(KEY_ITEM);
    name = localStorage.getItem(NAME_ITEM);
  } catch { /* storage unavailable */ }
  if (!key || !/^[0-9a-f]{32,64}$/i.test(key)) {
    key = newKey();
    try { localStorage.setItem(KEY_ITEM, key); } catch { /* storage unavailable */ }
  }
  return (memo = { key, name });
}

/** This browser's guest key (made the first time) */
export function guestKey(): string {
  return load().key;
}

/** The name this browser's guest flew under last, else a new one (kept for next time) */
export function guestName(): string {
  const g = load();
  if (!g.name) {
    g.name = 'Guest_' + Math.floor(Math.random() * 10000);
    try { localStorage.setItem(NAME_ITEM, g.name); } catch { /* storage unavailable */ }
  }
  return g.name;
}
