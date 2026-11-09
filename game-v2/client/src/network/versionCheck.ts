/**
 * Is this page older than the game servers? The lobby's /list says the newest protocol any server runs (`latest`); a client
 * on an older one can't talk to them (the server hangs up with 4002), so the join screen asks the pilot to reload to get
 * the new build (the frontend is served from the VPS, versioned: docs/ops/regions.md).
 */

import { PROTOCOL_VERSION } from '@space-game/common';

export interface LatestVersion { protocol: number; build?: string }

/** The query the server list is asked with: only servers this build can talk to */
export const LIST_QUERY = `?protocol=${PROTOCOL_VERSION}`;

/** True when the lobby reports a newer protocol than this client was built with */
export function needsReload(latest: unknown, own: number = PROTOCOL_VERSION): boolean {
  const p = (latest as LatestVersion | null | undefined)?.protocol;
  return typeof p === 'number' && Number.isFinite(p) && p > own;
}

/** The "New version available" bar; the button reloads the page (a fresh copy of the build from the VPS) */
export function reloadBar(): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'version-bar';
  bar.setAttribute('role', 'alert');
  bar.style.cssText = 'display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap;padding:8px 14px;margin-bottom:10px;'
    + 'background:#12324a;border:1px solid #4aa3df;border-radius:8px;color:#d8efff;font:600 14px system-ui,sans-serif';
  const text = document.createElement('span');
  text.textContent = 'New version available. Reload to keep playing.';
  const btn = document.createElement('button');
  btn.textContent = 'Reload';
  btn.style.cssText = 'padding:4px 14px;border-radius:6px;border:1px solid #4aa3df;background:#1d5a85;color:#fff;font:inherit;cursor:pointer';
  btn.addEventListener('click', () => window.location.reload());
  bar.append(text, btn);
  return bar;
}
