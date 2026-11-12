/**
 * @contract client.ui.join.support-links
 * owns:       the links of the banner along the top of the game (./topBanner.ts): "Support the game" (the donation page) and "Discord";
 *             the Discord invite's address (DISCORD_URL, the one place it is set) and the strip's CSS
 * needs:      ../escape
 * invariants: with no Discord address the Discord link is not in the page at all — client/src/ui/join/supportLinks.test.ts
 *             only an https address is ever linked, and it is escaped — client/src/ui/join/supportLinks.test.ts
 *             the support link always points at the donation page on this origin — client/src/ui/join/supportLinks.test.ts
 * extend:     a new link is one entry in supportLinksHtml
 */

import { esc } from '../escape';

/**
 * The Discord invite (https://discord.gg/...). Empty: the link is hidden everywhere. Not a secret: set it here.
 */
export const DISCORD_URL: string = 'https://discord.gg/vnuDN3aBd5';

/** The donation page (client/support.html), on the game's own origin so it knows who is signed in */
export const SUPPORT_PAGE = '/support.html';

/** An https address as it may be linked, or '' */
export function safeLink(url: string): string {
  const u = url.trim();
  if (!u) return '';
  try {
    return new URL(u).protocol === 'https:' ? u : '';
  } catch {
    return '';
  }
}

/** The strip's HTML. Both links open in a new tab, so the game page stays where it is */
export function supportLinksHtml(discordUrl: string = DISCORD_URL): string {
  const discord = safeLink(discordUrl);
  return `<nav class="support-links" aria-label="Community">
    <a class="support-link" href="${SUPPORT_PAGE}" target="_blank" rel="noopener">Support the game</a>
    ${discord ? `<a class="support-link" href="${esc(discord)}" target="_blank" rel="noopener noreferrer">Discord</a>` : ''}
  </nav>`;
}

/** The strip's styles (each screen adds them to its own style block) */
export const SUPPORT_LINKS_CSS = `
  .support-links { display: flex; justify-content: flex-end; gap: 18px; width: 100%; padding: 0 4px; font-family: 'Rajdhani', 'Arial', sans-serif; }
  .support-link { font-size: 13px; letter-spacing: 1.5px; text-transform: uppercase; text-decoration: none; color: var(--support-link, rgba(255, 215, 170, 0.62)); transition: color 0.15s; }
  .support-link:hover, .support-link:focus-visible { color: var(--support-link-hi, #ffd9a8); text-decoration: underline; }
`;
