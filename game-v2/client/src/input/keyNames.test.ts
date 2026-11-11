import { describe, it, expect } from 'vitest';
import { fillKeyNames } from './keybindings';

describe('server text key slots', () => {
  it('fills {actionId} with the pilot binding, or the default key', () => {
    expect(fillKeyNames('New work in your log ({log})', {})).toBe('New work in your log (L)');
    expect(fillKeyNames('New work in your log ({log})', { log: 'KeyJ' })).toBe('New work in your log (J)');
    expect(fillKeyNames('Fly to the door and press {interact}.', { interact: 'Space' })).toBe('Fly to the door and press Space.');
  });
  it('leaves braces that name no action, and plain text, as sent', () => {
    expect(fillKeyNames('Scanning… {pct}%', {})).toBe('Scanning… {pct}%');
    expect(fillKeyNames('Level 5!', {})).toBe('Level 5!');
  });
});
