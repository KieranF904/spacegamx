import { describe, it, expect } from 'vitest';
import { DISCORD_URL, SUPPORT_PAGE, safeLink, supportLinksHtml } from './supportLinks';

describe('support links strip', () => {
  it('always links the donation page on this origin', () => {
    const html = supportLinksHtml('');
    expect(html).toContain(`href="${SUPPORT_PAGE}"`);
    expect(html).toContain('Support the game');
    expect(SUPPORT_PAGE.startsWith('/')).toBe(true);
  });

  it('with no Discord address the Discord link is not there at all', () => {
    for (const none of ['', '   ']) {
      const html = supportLinksHtml(none);
      expect(html).not.toContain('Discord');
      expect((html.match(/<a /g) ?? []).length).toBe(1);
    }
  });

  it('with an address it links Discord in a new tab', () => {
    const html = supportLinksHtml('https://discord.gg/abc123');
    expect(html).toContain('href="https://discord.gg/abc123"');
    expect(html).toContain('>Discord</a>');
    expect(html).toContain('rel="noopener noreferrer"');
    expect((html.match(/<a /g) ?? []).length).toBe(2);
  });

  it('only an https address is linked, and it is escaped', () => {
    for (const bad of ['javascript:alert(1)', 'http://discord.gg/abc', 'discord.gg/abc', 'data:text/html,x', '//discord.gg/abc']) {
      expect(safeLink(bad)).toBe('');
      expect(supportLinksHtml(bad)).not.toContain('Discord');
    }
    const html = supportLinksHtml('https://discord.gg/a"><script>x</script>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('a">');
  });

  it('the address set in the code is empty or a real https link', () => {
    expect(DISCORD_URL === '' || safeLink(DISCORD_URL) === DISCORD_URL).toBe(true);
    // (What the screens render by default follows it)
    expect(supportLinksHtml().includes('Discord')).toBe(DISCORD_URL !== '');
  });
});
