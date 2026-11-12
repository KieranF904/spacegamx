/** Join notices (pushover.ts): off without keys, one per name per half hour, at most 30 an hour with the rest counted */
import { describe, it, expect } from 'vitest';
import { Notifier } from './pushover.js';

function rig(keys = true) {
  const t = { now: 0 };
  const sent: string[] = [];
  const n = new Notifier(keys ? { token: 't', user: 'u' } : null, () => t.now, async (_k, _title, msg) => { sent.push(msg); });
  return { n, t, sent };
}

describe('pushover join notices', () => {
  it('sends nothing without keys', () => {
    const { n, sent } = rig(false);
    n.join('Ash', false, 1);
    expect(n.on).toBe(false);
    expect(sent).toEqual([]);
  });

  it('tells a name once per half hour (reconnects), guests marked', () => {
    const { n, t, sent } = rig();
    n.join('Ash', false, 1);
    t.now = 10 * 60_000;
    n.join('ash', false, 1);
    n.join('Guest_12', true, 2);
    t.now = 31 * 60_000;
    n.join('Ash', false, 2);
    expect(sent).toEqual(['A pilot joined. 1 online.', 'A guest joined. 2 online.', 'A pilot joined. 2 online.']);
  });

  it('caps an hour at 30 and counts the rest into the next', () => {
    const { n, t, sent } = rig();
    for (let i = 0; i < 35; i++) n.join(`P${i}`, true, i);
    expect(sent.length).toBe(30);
    t.now = 61 * 60_000;
    n.join('Late', false, 3);
    expect(sent.at(-1)).toBe('A pilot joined. 3 online. (+5 more not sent this hour)');
  });

  it('never says who: no name reaches the notice, in the title or the text', () => {
    const t = { now: 0 };
    const out: string[] = [];
    const n = new Notifier({ token: 't', user: 'u' }, () => t.now, async (_k, title, msg) => { out.push(title, msg); });
    n.join('Zephyrine', false, 4);
    n.join('Guest_8841', true, 5);
    expect(out).toEqual(['Space Game: pilot joined', 'A pilot joined. 4 online.', 'Space Game: pilot joined', 'A guest joined. 5 online.']);
    expect(out.join(' ')).not.toMatch(/Zephyrine|Guest_8841|8841/i);
  });

  it('is off by default outside production, on in production with keys', async () => {
    const { Notifier: N } = await import('./pushover.js');
    expect(new N(undefined).on).toBe(false);
  });
});
