import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NEWSLETTER_MISSING, NEWSLETTER_NO, NEWSLETTER_QUESTION, NEWSLETTER_YES, newsletterChoiceHtml, readNewsletterChoice } from './newsletterChoice';
import { lobbyRegister } from '../../network/lobby';

const src = (rel: string) => readFileSync(join(__dirname, '../..', rel), 'utf8');

describe('newsletter choice at sign-up', () => {
  it('asks the question with two answers, and nothing is preselected', () => {
    const html = newsletterChoiceHtml();
    expect(html).toContain(`<legend>${NEWSLETTER_QUESTION}</legend>`);
    expect(html).toContain(NEWSLETTER_YES);
    expect(html).toContain(NEWSLETTER_NO);
    expect((html.match(/type="radio"/g) ?? []).length).toBe(2);
    expect((html.match(/ required/g) ?? []).length).toBe(2);
    expect(html).not.toMatch(/checked/);
    expect(newsletterChoiceHtml(null)).toBe(html);
    // (A radio group in a fieldset: one question for a keyboard and a screen reader)
    expect(html).toMatch(/^<fieldset class="newsletter-choice">/);
    expect((html.match(/name="newsletter"/g) ?? []).length).toBe(2);
  });

  it('drawn again after a choice, it keeps that choice and only that one', () => {
    expect(newsletterChoiceHtml(true)).toMatch(/value="yes" required checked/);
    expect(newsletterChoiceHtml(true)).not.toMatch(/value="no" required checked/);
    expect(newsletterChoiceHtml(false)).toMatch(/value="no" required checked/);
    expect(newsletterChoiceHtml(false)).not.toMatch(/value="yes" required checked/);
  });

  it('a form with no choice reads as no answer, never as yes or no', () => {
    expect(readNewsletterChoice('yes')).toBe(true);
    expect(readNewsletterChoice('no')).toBe(false);
    for (const none of [null, undefined, '', 'on', 'true', 'false', '1', true, false, 0]) expect(readNewsletterChoice(none)).toBeNull();
    expect(NEWSLETTER_MISSING).toBe('Choose yes or no for the newsletter');
  });

  it('an account is asked for with the yes or no as a real boolean', async () => {
    const calls: { url: string; body: any }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: { body: string }) => { calls.push({ url, body: JSON.parse(init.body) }); return { json: async () => ({ success: true, token: 't', username: 'a' }) }; }) as unknown as typeof fetch;
    try {
      await lobbyRegister('alice', 'a@example.com', 'password1', true);
      await lobbyRegister('bob', 'b@example.com', 'password1', false);
    } finally {
      globalThis.fetch = real;
    }
    expect(calls.map((c) => c.body)).toEqual([
      { username: 'alice', email: 'a@example.com', password: 'password1', newsletter: true },
      { username: 'bob', email: 'b@example.com', password: 'password1', newsletter: false },
    ]);
    expect(calls.every((c) => c.url.endsWith('/auth/register'))).toBe(true);
  });

  it('both sign-up forms in the game use this group and refuse to go on without a choice; nothing registers any other way', () => {
    const login = src('ui/LoginUI.ts'), guest = src('ui/guest/guestBanner.ts'), game = src('Game.ts');
    for (const file of [login, guest]) {
      expect(file).toContain('newsletterChoiceHtml(');
      expect(file).toContain('readNewsletterChoice(');
      expect(file).toContain('NEWSLETTER_MISSING');
    }
    // (Every account the game asks for goes through lobbyRegister, which takes the answer: no other register call)
    expect(game).not.toMatch(/lobbyAuth\('register'/);
    expect((game.match(/lobbyRegister\(/g) ?? []).length).toBe(2);
    // (No default anywhere: the forms never say which answer to start on)
    for (const file of [login, guest, game]) expect(file).not.toMatch(/NEWSLETTER_DEFAULT|newsletterChoiceHtml\((true|false)\)/);
  });
});
