/**
 * @contract client.ui.join.top-banner
 * owns:       the very narrow banner along the top of the game, always there (sign-in, join and in flight): "Support the
 *             game" and "Discord" in its middle, the game's address at its left, a link to the website in a new tab (out of the flow: the links stay centred)
 * needs:      ./supportLinks (the links and their look), ./legalLinks (siteBase: where the website is)
 * invariants: nothing is ever drawn over it (the top z-index of the page; HUD pieces at the top edge start below TOP_BANNER_H);
 *             one banner however often it is asked for; only its links take the pointer (a click anywhere else on it
 *             goes through to the game) — client/src/ui/join/topBanner.test.ts
 * extend:     a new link is one entry in supportLinks.ts supportLinksHtml
 */

import { SUPPORT_LINKS_CSS, supportLinksHtml } from './supportLinks';
import { siteBase } from './legalLinks';

/** The banner's height (px) */
export const TOP_BANNER_H = 18;
/** The game's address, written at the banner's left */
export const SITE_NAME = 'space.brotherk3d.com';

const CSS = `
.sg-topbar { position: fixed; top: 0; left: 0; right: 0; height: ${TOP_BANNER_H}px; z-index: 2147483000; display: flex; align-items: center; padding: 0 12px;
  background: rgba(6, 10, 20, 0.92); border-bottom: 1px solid rgba(125, 160, 210, 0.16); pointer-events: none; }
${SUPPORT_LINKS_CSS}
.sg-topbar .support-links { padding: 0; justify-content: center; }
/* (out of the flow, so the links stay in the middle whatever its width) */
.sg-topbar .sg-site { position: absolute; left: 12px; top: 0; line-height: ${TOP_BANNER_H}px; font: 600 11px/${TOP_BANNER_H}px 'Rajdhani', 'Arial', sans-serif; letter-spacing: 1.5px; color: rgba(190, 205, 225, 0.6); white-space: nowrap; text-decoration: none; pointer-events: auto; }
.sg-topbar a.sg-site:hover, .sg-topbar a.sg-site:focus-visible { color: #e6eefb; text-decoration: underline; }
@media (max-width: 520px) { .sg-topbar .sg-site { display: none; } }
.sg-topbar .support-link { pointer-events: auto; font-size: 11px; line-height: ${TOP_BANNER_H}px; }
`;

/** Put the banner on the page (once) */
export function mountTopBanner(doc: Document = document): HTMLElement {
  const had = doc.querySelector<HTMLElement>('.sg-topbar');
  if (had) return had;
  const style = doc.createElement('style');
  style.textContent = CSS;
  doc.head.appendChild(style);
  const bar = doc.createElement('div');
  bar.className = 'sg-topbar';
  // (the address opens the website in a new tab, so the game stays where it is)
  bar.innerHTML = `<a class="sg-site" href="${siteBase() || '/'}" target="_blank" rel="noopener">${SITE_NAME}</a>` + supportLinksHtml();
  // (a click on a link is the page's, not the guns')
  bar.addEventListener('mousedown', (e) => { if ((e.target as HTMLElement).closest('a')) e.stopPropagation(); });
  doc.body.appendChild(bar);
  return bar;
}
