import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PRIVACY_URL, REFUNDS_URL, privacyLinkHtml, siteBase } from './legalLinks';

const src = (rel: string) => readFileSync(join(__dirname, '../..', rel), 'utf8');

describe('links to the privacy and refunds pages', () => {
  it("go to the website's /privacy and /refunds, on its address", () => {
    expect(siteBase({ VITE_SITE_URL: 'https://space.example/' })).toBe('https://space.example');
    expect(siteBase({ DEV: true })).toBe('http://localhost:5310');
    expect(siteBase({})).toBe('');
    expect(PRIVACY_URL.endsWith('/privacy')).toBe(true);
    expect(REFUNDS_URL.endsWith('/refunds')).toBe(true);
  });

  it('a link from a form opens in a new tab', () => {
    const a = privacyLinkHtml('https://space.example/privacy');
    expect(a).toContain('href="https://space.example/privacy"');
    expect(a).toContain('target="_blank"');
    expect(a).toContain('rel="noopener"');
    expect(a).toContain('>Privacy</a>');
  });

  it("both of the game's sign-up forms carry the Privacy link, and the donation page carries both with its line", () => {
    for (const file of ['ui/LoginUI.ts', 'ui/guest/guestBanner.ts']) expect(src(file), file).toContain('privacyLinkHtml()');
    const support = src('support/main.ts');
    expect(support).toContain('Donations are voluntary; refunds are discretionary.');
    expect(support).toContain('PRIVACY_URL');
    expect(support).toContain('REFUNDS_URL');
    expect(support).toContain("'Donations and refunds'");
  });
});
