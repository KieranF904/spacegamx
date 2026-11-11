/**
 * @contract client.ui.combat-lock
 * owns:       the "In combat 12 s" HUD badge: quitting while it shows leaves the ship in space (server combatLock message)
 * needs:      DOM (optional: with none every call does nothing)
 * invariants: the badge shows exactly while the server says the lock is on, counting down locally — client/src/ui/combatLock.test.ts
 * extend:     the text is `combatLabel`; the lock itself is the server's (gameServer/combatLock.ts)
 */

let endAt = 0;
let el: HTMLDivElement | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** The badge's words for `ms` left (empty: nothing shown), whole seconds rounded up */
export function combatLabel(ms: number): string {
  if (!(ms > 0)) return '';
  return `In combat ${Math.ceil(ms / 1000)} s: if you quit now, your ship stays in space`;
}

function paint(now: number): void {
  const text = combatLabel(endAt - now);
  if (!text) {
    if (timer !== null) { clearInterval(timer); timer = null; }
    if (el) el.style.display = 'none';
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.setAttribute('role', 'status');
    el.style.cssText = 'position:fixed;left:50%;top:72px;transform:translateX(-50%);z-index:1500;pointer-events:none;'
      + 'padding:4px 12px;border-radius:4px;font:600 13px system-ui,sans-serif;color:#ffd9d9;background:rgba(120,20,20,0.78);'
      + 'border:1px solid rgba(255,120,120,0.6);text-shadow:0 1px 2px #000;white-space:nowrap';
    document.body.appendChild(el);
  }
  el.style.display = '';
  if (el.textContent !== text) el.textContent = text;
}

/** Is the combat lock on now? */
export function inCombat(now: number = Date.now()): boolean { return endAt > now; }

/** The server's word: `leftMs` until quitting is safe again (0: now) */
export function setCombatLock(leftMs: number, now: number = Date.now()): void {
  endAt = leftMs > 0 ? now + leftMs : 0;
  if (typeof document === 'undefined') return;
  try {
    paint(now);
    if (endAt > 0 && timer === null) timer = setInterval(() => paint(Date.now()), 250);
  } catch {
    // (no DOM: the badge is only a nicety)
  }
}
