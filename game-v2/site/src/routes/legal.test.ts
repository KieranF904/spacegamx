import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { Ctx } from '../app.js';
import { Router } from '../http.js';
import { CONTACT_DISCORD, LEGAL_UPDATED, legalLinks, privacyPage, refundsPage } from '../views/legal.js';
import { layout, type PageCtx } from '../views/layout.js';
import { newsletterChoice, newsletterPrompt } from '../views/newsletter.js';
import { html } from '../html.js';
import { registerLegal } from './legal.js';
import type { RouteEnv } from './env.js';

const here = dirname(fileURLToPath(import.meta.url));
const page = { siteName: 'Space Game', user: null, csrf: 'c', path: '/privacy', live: null, origin: 'http://x' } as PageCtx;

/** The two routes, called as the app's router would */
function get(path: string): { status: number; body: string } | null {
  const router = new Router<Ctx>();
  let out: { status: number; body: string } | null = null;
  registerLegal({ router, page: (_c: Ctx, status: number, body: unknown) => { out = { status, body: String(body) }; } } as unknown as RouteEnv);
  const m = router.match('GET', path);
  if (!m || m === 'method') return null;
  void m.handler({ page: { ...page, path } } as unknown as Ctx, m.params);
  return out;
}

describe('the privacy page', () => {
  const r = get('/privacy')!;

  it('is served, signed in or not, and says when it was last updated', () => {
    expect(r.status).toBe(200);
    expect(r.body).toContain('<h1>Privacy</h1>');
    expect(r.body).toContain(`Last updated ${LEGAL_UPDATED}`);
    expect(LEGAL_UPDATED).toBe('12 November 2026');
  });

  it('says the things we promise, in these words', () => {
    for (const s of [
      "We don't keep your password. It is kept hashed: a hash can be used to verify your log in, but it can't be read by us or turned back into your password.",
      'We do not share your account data with third parties, and will not without your consent.',
      "Nothing you have agreed to here implies that consent: we haven't slipped it in anywhere.",
      'Admins and developers can view account data to run and develop the game.',
      'Private messages between you and an admin, if an admin writes to you in the game or you reply: these are kept in an admin message log that only admins can read.',
      'Your pilot name is public',
      'highscores',
      'Your email address is never shown to anyone.',
      'The email newsletter is only sent to you if you said yes.',
      'href="/account#newsletter"',
    ]) expect(r.body, s).toContain(s);
  });

  it('does not name the hashing method', () => {
    expect(r.body).not.toMatch(/pbkdf|sha-?512|bcrypt|scrypt|argon|salt|scrambl/i);
  });

  it('names the one outside service that sees anything, and what it gets', () => {
    expect(r.body).toContain('We receive only the amount and a reference');
    expect(r.body).toContain("We don't send PayPal your account details.");
    expect(r.body).toContain('One outside service is involved, and this is all it gets:');
    expect(r.body).not.toMatch(/Pushover|notification service/);
    expect((r.body.match(/<li><b>/g) ?? []).length).toBe(1);
    expect(r.body).not.toMatch(/Google/);
  });

  it('says how to ask about your data: the account page, or the Discord the game links', () => {
    expect(r.body).toContain('delete your account');
    expect(r.body).toContain(`href="${CONTACT_DISCORD}"`);
    const client = readFileSync(join(here, '../../../client/src/ui/join/supportLinks.ts'), 'utf8');
    expect(client).toContain(`DISCORD_URL: string = '${CONTACT_DISCORD}'`);
  });
});

describe('the donations and refunds page', () => {
  const r = get('/refunds')!;

  it('is served and says what the owner said, no more', () => {
    expect(r.status).toBe(200);
    expect(r.body).toContain('<h1>Donations and refunds</h1>');
    for (const s of [
      'Donations are voluntary gifts to support the project.',
      'They are not purchases',
      'there is no pay to win',
      'Refunds are at our discretion.',
      "we'll look at it",
      'donated $10 USD or more in total receive the contributor rank',
      'We may remove the rank for abuse or at our discretion, and we may also give it freely',
      'href="/account/donations"',
      `href="${CONTACT_DISCORD}"`,
    ]) expect(r.body, s).toContain(s);
    // (No promise of a refund, a time limit or a guarantee)
    expect(r.body).not.toMatch(/guarantee|within \d+ days|entitled|non-refundable/i);
  });

  it('the $10 it names is the line the lobby uses', () => {
    const routes = readFileSync(join(here, '../../../server-browser/src/donations/routes.ts'), 'utf8');
    expect(routes).toContain('export const CONTRIBUTOR_AT = 1000;');
  });
});

describe('links to both pages', () => {
  it('nothing else answers on those paths, and other paths are not theirs', () => {
    expect(get('/terms')).toBeNull();
    expect(get('/privacy/more')).toBeNull();
  });

  it('the footer of every page carries both', () => {
    const any = String(layout(page, { title: 'x', body: html`<p>x</p>` }));
    expect(any).toMatch(/<nav class="foot-nav"[\s\S]*<a href="\/privacy">Privacy<\/a><a href="\/refunds">Donations and refunds<\/a>/);
    expect(String(legalLinks())).toBe('<a href="/privacy">Privacy</a> · <a href="/refunds">Donations and refunds</a>');
  });

  it("the sign-up form's newsletter question and the one-time question link to Privacy", () => {
    expect(String(newsletterChoice())).toContain('<a href="/privacy" target="_blank" rel="noopener">Privacy</a>');
    expect(String(newsletterPrompt({ ...page, user: { id: 1, username: 'a', isAdmin: false } }))).toContain('<a href="/privacy">Privacy</a>');
  });
});

describe('what the pages say is what the code does', () => {
  const read = (rel: string) => readFileSync(join(here, '../../..', rel), 'utf8');

  it('passwords are kept only as a salted PBKDF2 hash (a random salt per account)', () => {
    expect(read('server-browser/src/accounts/utils.ts')).toMatch(/generateSalt\(\): string \{\s*return crypto\.randomBytes\(32\)/);
    const utils = read('server-browser/src/accounts/utils.ts');
    expect(utils).toMatch(/crypto\.pbkdf2\(password, salt, 100000, 64, 'sha512'/);
    expect(read('server-browser/schema.sql')).toMatch(/password_hash TEXT NOT NULL/);
    expect(read('server-browser/schema.sql')).not.toMatch(/^\s*password\s+TEXT/m);
  });

  it('PayPal is sent no account id', () => {
    expect(read('server-browser/src/donations/paypal.ts')).not.toMatch(/custom_id\s*=|customId/);
    expect(read('server-browser/src/donations/routes.ts')).not.toMatch(/customId/);
  });

  it('the phone notices carry no pilot name', () => {
    expect(read('server/src/auth/pushover.ts')).toContain("`${guest ? 'A guest' : 'A pilot'} joined. ${online} online.`");
    expect(read('server-browser/src/accounts/pushover.ts')).toContain("'A new account was registered.'");
    for (const file of ['server/src/auth/pushover.ts', 'server-browser/src/accounts/pushover.ts']) expect(read(file), file).not.toMatch(/notify\([^)]*\$\{name/);
  });

  it('nothing the site or the game loads comes from Google: the fonts are our own files, with their licences', () => {
    const files = ['site/src/views/layout.ts', 'site/src/security.ts', 'site/public/site.css', 'site/public/features.css', 'site/public/site.js', 'site/public/fonts/fonts.css',
      'client/index.html', 'client/support.html', 'client/browser.html', 'client/viewer.html', 'client/src/ui/LoginUI.ts', 'client/public/fonts/fonts.css',
      'deploy/vps/nginx-spacegame-game.conf', 'deploy/vps/nginx-spacegame-play.conf', 'deploy/vps/nginx-spacegame-site.conf'];
    for (const file of files) expect(read(file), file).not.toMatch(/googleapis|gstatic|fonts\.google/i);
    // (The site's own policy lets styles and fonts come from this site only)
    expect(read('site/src/security.ts')).toContain(`"style-src 'self'",`);
    expect(read('site/src/security.ts')).toContain(`"font-src 'self'",`);
    for (const [css, dir, prefix] of [['site/public/fonts/fonts.css', 'site/public/fonts', '/static/fonts/'], ['client/public/fonts/fonts.css', 'client/public/fonts', '/fonts/']]) {
      const urls = [...read(css).matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
      expect(urls.length).toBeGreaterThan(3);
      for (const u of urls) {
        expect(u.startsWith(prefix), u).toBe(true);
        expect(readFileSync(join(here, '../../..', dir, u.slice(prefix.length))).subarray(0, 4).toString(), u).toBe('wOF2');
      }
      expect(read(css)).toContain('font-display: swap');
    }
    for (const lic of ['site/public/fonts/OFL-ChakraPetch.txt', 'site/public/fonts/OFL-IBMPlexSans.txt', 'site/public/fonts/OFL-IBMPlexMono.txt', 'client/public/fonts/OFL-Orbitron.txt', 'client/public/fonts/OFL-Rajdhani.txt']) {
      expect(read(lic), lic).toMatch(/SIL OPEN FONT LICENSE/i);
    }
    expect(read('site/src/views/layout.ts')).toContain('href="/static/fonts/fonts.css');
    expect(read('client/src/ui/LoginUI.ts')).toContain("@import url('/fonts/fonts.css');");
  });

  it('no analytics or tracking script is loaded by the site or the game page', () => {
    for (const file of ['site/src/views/layout.ts', 'client/index.html', 'client/support.html']) {
      expect(read(file), file).not.toMatch(/google-analytics|googletagmanager|gtag\(|plausible|posthog|sentry|facebook\.net|hotjar/i);
    }
  });
});
