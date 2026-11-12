/**
 * The two plain-language pages: Privacy (/privacy) and Donations and refunds (/refunds). Fixed text, no visitor data.
 * Every statement here is one the code backs (docs/design/donations-2026-11.md and newsletter-consent-2026-11.md say
 * where): change the code and this text together.
 */

import { html, type SafeHtml } from '../html.js';
import { layout, type PageCtx } from './layout.js';

/** When either page's text last changed */
export const LEGAL_UPDATED = '12 November 2026';

/**
 * Where to ask about your data or a refund: the project's Discord (the same invite the game links, DISCORD_URL in
 * client/src/ui/join/supportLinks.ts; legal.test.ts checks they match). There is no contact email yet.
 */
export const CONTACT_DISCORD = 'https://discord.gg/vnuDN3aBd5';

export const PRIVACY_PATH = '/privacy';
export const REFUNDS_PATH = '/refunds';

/** The small links other pages carry (the footer, the sign-up form, the newsletter question) */
export function legalLinks(): SafeHtml {
  return html`<a href="${PRIVACY_PATH}">Privacy</a> · <a href="${REFUNDS_PATH}">Donations and refunds</a>`;
}

const contact = (): SafeHtml => html`<a href="${CONTACT_DISCORD}" rel="noopener noreferrer">our Discord</a>`;

export function privacyPage(ctx: PageCtx): SafeHtml {
  const body = html`
<section class="page-head wrap">
  <p class="eyebrow">The small print</p>
  <h1>Privacy</h1>
  <p class="lede">What we keep about you, who can see it, and what we do with it. Last updated ${LEGAL_UPDATED}.</p>
</section>
<section class="wrap block-tight prose">
  <h2>What we store</h2>
  <ul>
    <li>Your account: pilot name, email address, and a hash of your password, not the password itself (see below).</li>
    <li>Your game progress: your pilot, ships, items, stats and friends list.</li>
    <li>Messages in your in-game inbox.</li>
    <li>A recent log of what happens on each server, for running the game: sign-ins, joins, public chat lines and the like. Private messages are not in it.</li>
    <li>Private messages between you and an admin, if an admin writes to you in the game or you reply: these are kept in an admin message log that only admins can read.</li>
    <li>What you post on this website: comments, suggestions, shouts and shared ships.</li>
    <li>Notes you make with the contributor tools, if you have them.</li>
    <li>Donations you make while signed in: the amount, the date, its status and PayPal's reference. No card or PayPal account details.</li>
    <li>Whether you said yes or no to the email newsletter.</li>
  </ul>
  <p>We don't keep your IP address in our database. It is used for a short time to limit sign-in attempts, and our web server keeps ordinary access logs.</p>
  <p>You can play as a guest without an account. A guest has no email; the guest pilot is kept for a few days under a key in your browser.</p>
  <p>This site uses cookies only to keep you signed in and to protect its forms. There is no advertising and no tracking.</p>

  <h2>Passwords</h2>
  <p>We don't keep your password. It is kept hashed: a hash can be used to verify your log in, but it can't be read by us or turned back into your password.</p>

  <h2>What other people can see</h2>
  <p>Your pilot name is public: other players see it in the game, and it appears on the highscores and on your public pilot page here, with your level, ship and stats. Anything you post on the site is shown with your pilot name. Your email address is never shown to anyone.</p>

  <h2>Who can see your account</h2>
  <p>Admins and developers can view account data to run and develop the game.</p>

  <h2>Sharing</h2>
  <p>We do not share your account data with third parties, and will not without your consent. Nothing you have agreed to here implies that consent: we haven't slipped it in anywhere.</p>
  <p>One outside service is involved, and this is all it gets:</p>
  <ul>
    <li><b>PayPal</b> handles donations. You pay on PayPal's own form; we never see your card or PayPal login. We receive only the amount and a reference, and record the donation against your account. We don't send PayPal your account details.</li>
  </ul>

  <h2>The newsletter</h2>
  <p>The email newsletter is only sent to you if you said yes. You can turn it on or off any time on your <a href="/account#newsletter">account page</a>.</p>

  <h2>Your data</h2>
  <p>You can change your email and password, or delete your account and everything on it, on your <a href="/account">account page</a>. To ask what we hold about you, or for anything else, ask on ${contact()}.</p>
</section>`;
  return layout(ctx, { title: 'Privacy', body, description: `What ${ctx.siteName} keeps about you and who can see it.` });
}

export function refundsPage(ctx: PageCtx): SafeHtml {
  const body = html`
<section class="page-head wrap">
  <p class="eyebrow">The small print</p>
  <h1>Donations and refunds</h1>
  <p class="lede">Last updated ${LEGAL_UPDATED}.</p>
</section>
<section class="wrap block-tight prose">
  <h2>Donations</h2>
  <p>Donations are voluntary gifts to support the project. They are not purchases: nothing in the game is for sale, and there is no pay to win.</p>
  <p>A donation made while signed in is recorded against your account. You can see yours under <a href="/account/donations">your donations</a>. Payments are handled by PayPal: see <a href="${PRIVACY_PATH}">Privacy</a>.</p>

  <h2>Refunds</h2>
  <p>Refunds are at our discretion. If you think a donation was a mistake, ask on ${contact()} and we'll look at it.</p>

  <h2>The contributor rank</h2>
  <p>Accounts that have donated $10 USD or more in total receive the contributor rank: a set of tools for marking the world in game, making notes and suggestions, and seeing and giving feedback on other people's ideas. It gives no advantage in play.</p>
  <p>We may remove the rank for abuse or at our discretion, and we may also give it freely to people who haven't donated.</p>
</section>`;
  return layout(ctx, { title: 'Donations and refunds', body, description: `How donations to ${ctx.siteName} work, and refunds.` });
}
