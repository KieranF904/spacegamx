/**
 * @contract client.ui.join.legal-links
 * owns:       where the website's Privacy and "Donations and refunds" pages are, as the game links them (the sign-up
 *             forms, the donation page), and the small Privacy link's HTML
 * needs:      nothing (the website's pages: site/src/views/legal.ts)
 * invariants: the links go to the website's /privacy and /refunds, on its address — client/src/ui/join/legalLinks.test.ts
 *             a link from a form opens in a new tab, so what was typed isn't lost — client/src/ui/join/legalLinks.test.ts
 * extend:     a new page is one constant here
 */

const env = (import.meta as { env?: { VITE_SITE_URL?: string; DEV?: boolean } }).env;

/**
 * The website's address, as the news feed works it out (ui/join/newsFeed.ts): VITE_SITE_URL, else the local site on
 * a dev client, else this origin (the live game is on the website's own address).
 */
export function siteBase(e: { VITE_SITE_URL?: string; DEV?: boolean } | undefined = env): string {
  return (e?.VITE_SITE_URL ?? (e?.DEV ? 'http://localhost:5310' : '')).replace(/\/+$/, '');
}

export const PRIVACY_URL = `${siteBase()}/privacy`;
export const REFUNDS_URL = `${siteBase()}/refunds`;

/** "Privacy", beside a sign-up form's newsletter question (a new tab: the form keeps what was typed) */
export function privacyLinkHtml(url: string = PRIVACY_URL): string {
  return `<a class="legal-link" href="${url}" target="_blank" rel="noopener">Privacy</a>`;
}

export const LEGAL_LINK_CSS = `
  .legal-link { font-size: 12px; color: rgba(255, 215, 170, 0.7); font-family: 'Rajdhani', 'Arial', sans-serif; letter-spacing: 0.5px; }
  .legal-link:hover, .legal-link:focus-visible { color: #ffd9a8; }
`;
