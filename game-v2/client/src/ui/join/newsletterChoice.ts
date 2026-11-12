/**
 * @contract client.ui.join.newsletter-choice
 * owns:       the newsletter question every sign-up form in the game asks (the sign-in screen's Create Account, a guest
 *             registering): its wording, the yes/no radio group's HTML, and reading the answer back from a form
 * needs:      nothing
 * invariants: nothing is chosen until the player chooses: no option is preselected — client/src/ui/join/newsletterChoice.test.ts
 *             a form with no choice reads as no answer (null), never as yes or no — client/src/ui/join/newsletterChoice.test.ts
 *             an account is only asked for with a real yes or no — client/src/ui/join/newsletterChoice.test.ts
 * extend:     a new sign-up form puts newsletterChoiceHtml() in its <form> and reads it with readNewsletterChoice()
 */
/**
 * A choice, not a default: the account can't be made until one is picked, so it is neither slipped past anyone nor
 * overlooked. The lobby records what was sent (server-browser/src/newsletter). The website's form asks the same
 * (site/src/views/newsletter.ts).
 */

export const NEWSLETTER_QUESTION = 'Email newsletter: development news, updates, etc.';
export const NEWSLETTER_YES = 'Yes, sign me up';
export const NEWSLETTER_NO = 'No thanks';
/** Shown when the form is sent without a choice */
export const NEWSLETTER_MISSING = 'Choose yes or no for the newsletter';
/** The radio group's field name, and its two values */
export const NEWSLETTER_FIELD = 'newsletter';

/**
 * The radio group: a fieldset with the question as its legend, so a keyboard and a screen reader get it as one
 * question with two answers. `chosen`: what the player had picked when the form is drawn again (null: nothing yet).
 * `required` makes the browser refuse to send the form without one; the forms check again themselves.
 */
export function newsletterChoiceHtml(chosen: boolean | null = null): string {
  const option = (value: 'yes' | 'no', label: string, on: boolean) =>
    `<label class="newsletter-option"><input type="radio" name="${NEWSLETTER_FIELD}" value="${value}" required${on ? ' checked' : ''}><span>${label}</span></label>`;
  return `<fieldset class="newsletter-choice">
    <legend>${NEWSLETTER_QUESTION}</legend>
    ${option('yes', NEWSLETTER_YES, chosen === true)}
    ${option('no', NEWSLETTER_NO, chosen === false)}
  </fieldset>`;
}

/** The answer in a form's data: true, false, or null when neither was picked */
export function readNewsletterChoice(value: unknown): boolean | null {
  return value === 'yes' ? true : value === 'no' ? false : null;
}

/** The group's styles (each screen adds them to its own style block, or sets them inline) */
export const NEWSLETTER_CHOICE_CSS = `
  .newsletter-choice { border: 0; padding: 0; margin: 0; min-width: 0; display: flex; flex-wrap: wrap; gap: 6px 16px; }
  .newsletter-choice legend { padding: 0; margin-bottom: 6px; font-size: 12px; line-height: 1.4; color: rgba(255, 220, 180, 0.8); font-family: 'Rajdhani', 'Arial', sans-serif; letter-spacing: 0.5px; }
  .newsletter-option { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; color: #fff; cursor: pointer; font-family: 'Rajdhani', 'Arial', sans-serif; }
  .newsletter-option input { width: 16px; height: 16px; margin: 0; padding: 0; accent-color: #ff9944; cursor: pointer; }
`;
