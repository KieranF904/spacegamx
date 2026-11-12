/** Registration notices (pushover.ts): off without keys, and never saying who registered */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Notifier } from './pushover.js';

describe('pushover registration notices', () => {
  it('sends nothing without keys', () => {
    const sent: string[] = [];
    const n = new Notifier(null, () => 0, async (_k, title, msg) => { sent.push(title, msg); });
    n.registered();
    expect(n.on).toBe(false);
    expect(sent).toEqual([]);
  });

  it('says an account was registered, and nothing about whose', () => {
    const sent: string[] = [];
    const n = new Notifier({ token: 't', user: 'u' }, () => 0, async (_k, title, msg) => { sent.push(title, msg); });
    n.registered();
    expect(sent).toEqual(['Space Game: new pilot', 'A new account was registered.']);
    // (It takes no name at all, and the accounts' routes give it none)
    expect(n.registered.length).toBe(0);
    const routes = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'routes.ts'), 'utf8');
    expect(routes).toContain('notifier.registered();');
    expect(routes).not.toMatch(/notifier\.\w+\([^)]*(user|name|email)/);
  });
});
