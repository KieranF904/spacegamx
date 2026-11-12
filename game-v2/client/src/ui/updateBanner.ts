/**
 * The "server update in M:SS" banner along the top of the screen. The server sends how long is left (serverUpdate), the
 * banner counts down on this machine's own clock; 0 takes it away. Its own DOM, nothing else to wire.
 */

let el: HTMLDivElement | null = null;
let endsAt = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/** "4:05" for 245 000 ms (rounded up, so it never shows 0:00 before the end) */
export function formatLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** What the banner says for `ms` left */
export function bannerText(ms: number): string {
  return ms <= 0
    ? 'The server is restarting for an update. You can rejoin in a minute.'
    : `Server update in ${formatLeft(ms)}. The server restarts then; you can rejoin straight after.`;
}

function paint(): void {
  if (el) el.textContent = bannerText(endsAt - Date.now());
}

/** `inMs` until the restart; 0 (or less): the update was called off, or never was */
export function showServerUpdate(inMs: number): void {
  if (typeof document === 'undefined') return;
  if (!(inMs > 0)) {
    if (timer) clearInterval(timer);
    timer = null;
    el?.remove();
    el = null;
    return;
  }
  endsAt = Date.now() + inMs;
  if (!el) {
    el = document.createElement('div');
    el.setAttribute('role', 'status');
    el.style.cssText = 'position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:9000;max-width:92vw;padding:6px 16px;'
      + 'background:#7a4a00;color:#ffe9b0;font:600 13px system-ui,sans-serif;border:1px solid #fbbf24;border-top:0;'
      + 'border-radius:0 0 8px 8px;pointer-events:none;text-align:center';
    document.body.appendChild(el);
  }
  if (!timer) timer = setInterval(paint, 1000);
  paint();
}
