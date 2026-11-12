/**
 * The email newsletter's consent, as the website asks for it (the lobby keeps the answer: server-browser/src/newsletter):
 *   - at sign-up: a yes/no choice with nothing picked, which the form can't be sent without (newsletterChoice)
 *   - once, for an account that was never asked: a small panel on whatever page they open (newsletterPrompt)
 *   - any time, on the account page (newsletterSetting)
 * The game's own sign-up forms ask the same question (client/src/ui/join/newsletterChoice.ts). Nothing is sent yet.
 */

import { html, raw, type SafeHtml } from '../html.js';
import { csrfField, type PageCtx } from './layout.js';

export const NEWSLETTER_QUESTION = 'Email newsletter: development news, updates, etc.';
export const NEWSLETTER_YES = 'Yes, sign me up';
export const NEWSLETTER_NO = 'No thanks';
/** Shown when the sign-up form is sent without a choice */
export const NEWSLETTER_MISSING = 'Choose yes or no for the newsletter';

/** A form's `newsletter` field as an answer: true, false, or null when neither was picked */
export function readChoice(v: unknown): boolean | null {
  return v === 'yes' ? true : v === 'no' ? false : null;
}

/**
 * The sign-up form's question: a radio group in a fieldset (one question with two answers, for a keyboard and a screen
 * reader). Nothing is picked unless the visitor picked it (`chosen`, when the form comes back with an error).
 */
export function newsletterChoice(chosen: boolean | null = null): SafeHtml {
  const option = (value: 'yes' | 'no', label: string, on: boolean) =>
    html`<label class="choice"><input type="radio" name="newsletter" value="${value}" required${on ? raw(' checked') : ''}> ${label}</label>`;
  return html`<fieldset class="newsletter-choice">
        <legend>${NEWSLETTER_QUESTION}</legend>
        ${option('yes', NEWSLETTER_YES, chosen === true)}
        ${option('no', NEWSLETTER_NO, chosen === false)}
        <p class="hint">Only sent if you say yes. <a href="/privacy" target="_blank" rel="noopener">Privacy</a></p>
      </fieldset>`;
}

/**
 * The one-time question for an account that was never asked. Two buttons, neither marked as the usual one; "Ask me
 * later" (or just carrying on) leaves them not asked, so it shows again on a later visit.
 */
export function newsletterPrompt(ctx: PageCtx): SafeHtml {
  return html`<aside class="notice notice-ok newsletter-prompt" aria-labelledby="nl-q"><div class="wrap">
  <form method="post" action="/account/newsletter/answer" class="inline-form">
    ${csrfField(ctx)}
    <input type="hidden" name="back" value="${ctx.path}">
    <span id="nl-q">${NEWSLETTER_QUESTION}</span>
    <button class="btn" type="submit" name="newsletter" value="yes">${NEWSLETTER_YES}</button>
    <button class="btn" type="submit" name="newsletter" value="no">${NEWSLETTER_NO}</button>
    <button class="btn btn-ghost" type="submit" formaction="/account/newsletter/later">Ask me later</button>
    <a href="/privacy">Privacy</a>
  </form>
</div></aside>`;
}

/** The account page's setting: what it is now, and one button to change it */
export function newsletterSetting(ctx: PageCtx, d: { newsletter: boolean; asked: boolean }, error?: string): SafeHtml {
  return html`<section class="panel" aria-labelledby="nl-h" id="newsletter">
      <div class="panel-head"><h2 id="nl-h">Email newsletter</h2></div>
      <p class="dim small">Development news and updates by email, sent when the game updates. You can change this any time.</p>
      <p>${d.newsletter ? html`<b>On</b>: you're signed up.` : d.asked ? html`<b>Off</b>: you're not signed up.` : html`<b>Off</b>: you haven't chosen yet.`}</p>
      <form method="post" action="/account/newsletter/set" class="stack">
        ${csrfField(ctx)}
        <input type="hidden" name="newsletter" value="${d.newsletter ? 'no' : 'yes'}">
        ${error ? html`<p class="form-error" role="alert">${error}</p>` : ''}
        <button class="btn" type="submit">${d.newsletter ? 'Turn off' : 'Turn on'}</button>
      </form>
    </section>`;
}

export interface NewsletterCounts { accounts: number; consented: number; declined: number; notAsked: number }

/** The admin panel's line: how many said yes, said no, or haven't been asked (no names, no addresses) */
export function newsletterCountsLine(c: NewsletterCounts | null): SafeHtml | '' {
  if (!c) return '';
  return html`<p class="dim" data-newsletter-counts>Email newsletter: <b>${c.consented}</b> signed up, <b>${c.declined}</b> said no, <b>${c.notAsked}</b> not asked yet (of ${c.accounts} accounts). Nothing is sent yet.</p>`;
}
