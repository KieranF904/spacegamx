import { describe, it, expect } from 'vitest';
import { bannerHtml, listHtml, readerHtml, sentHtml } from './InboxPanel';
import { esc } from '../escape';
import type { InboxMessage } from '../../network/inbox';

const EVIL = `<img src=x onerror="alert(1)"> & 'quoted'`;
const msg = (over: Partial<InboxMessage> = {}): InboxMessage => ({
  id: 1, from: 'brotherk3d', subject: 'Welcome', body: 'Hello pilot', important: true, createdAt: Date.UTC(2026, 10, 5, 12), readAt: null, ...over,
});

/** No tag but the ones the template wrote, and no raw quote from the text in an attribute */
function noInjectedMarkup(html: string): void {
  expect(html).not.toContain('<img');
  expect(html).not.toMatch(/onerror="/);
  expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;quoted&#39;');
}

describe('inbox rendering', () => {
  it('escapes every character that matters', () => {
    expect(esc(EVIL)).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;quoted&#39;');
  });

  it('lists messages, unread and important ones marked, the open one selected', () => {
    const html = listHtml([msg(), msg({ id: 2, subject: 'Old news', readAt: 5, important: false, from: 'system' })], 2);
    expect(html).toMatch(/class="inbox-row unread important" data-id="1"/);
    expect(html).toMatch(/class="inbox-row selected" data-id="2"/);
    expect(html).toContain('Space Game'); // ('system' shown as the game)
    expect(listHtml([], null)).toContain('No messages yet');
  });

  it('escapes a sender, subject and body everywhere they show', () => {
    const evil = msg({ from: EVIL, subject: EVIL, body: `${EVIL}\nline two` });
    for (const html of [listHtml([evil], 1), readerHtml(evil), bannerHtml([evil])]) noInjectedMarkup(html);
    expect(readerHtml(evil)).toContain('\nline two'); // (newlines kept: the reader shows them, pre-wrap)
    noInjectedMarkup(sentHtml([{ to: EVIL, from: 'a', subject: EVIL, body: '', important: true, createdAt: 0, recipients: 3, read: 1 }]));
  });

  it('only a numeric id reaches an attribute', () => {
    const odd = msg({ id: '1" onclick="x' as unknown as number });
    expect(listHtml([odd], null)).toContain('data-id="NaN"');
    expect(readerHtml(odd)).not.toContain('onclick');
  });

  it('the banner shows the newest unread important message, with how many more; none once read', () => {
    const list = [msg({ id: 3, subject: 'Newest' }), msg({ id: 2, subject: 'Older' }), msg({ id: 1, important: false })];
    const html = bannerHtml(list);
    expect(html).toContain('Newest');
    expect(html).toContain('+1 more');
    expect(html).toContain('data-id="3"');
    expect(html).toContain('Message from brotherk3d');
    expect(bannerHtml([msg({ readAt: 9 }), msg({ id: 2, important: false })])).toBe('');
  });

  it('the reader shows the message with a delete button; the sent list says who and how many read', () => {
    const html = readerHtml(msg({ body: 'Line one\nLine two' }));
    expect(html).toContain('Welcome');
    expect(html).toContain('inbox-delete');
    expect(readerHtml(null)).toContain('Pick a message');
    const sent = sentHtml([{ to: '*', from: 'brotherk3d', subject: 'Restart', body: '', important: true, createdAt: 0, recipients: 12, read: 5 }]);
    expect(sent).toContain('Everyone');
    expect(sent).toContain('5/12 read');
  });
});
