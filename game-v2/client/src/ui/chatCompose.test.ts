import { describe, it, expect } from 'vitest';
import { ChatCompose } from './chatCompose';

describe('chat compose (tab to reply)', () => {
  it('Tab does nothing until someone sends you a private message (but never leaves the input)', () => {
    const c = new ChatCompose();
    expect(c.key('Tab', 0, 0)).toEqual({ handled: true, clear: false, blur: false });
    expect(c.isPrivate).toBe(false);
    expect(c.prefix()).toBe('');
    expect(c.submit('  hi  ')).toEqual({ type: 'chat', text: 'hi' });
  });

  it('Tab picks the last private sender as of the moment it is pressed', () => {
    const c = new ChatCompose();
    c.heard('Ash');
    c.heard('Bree');
    c.key('Tab', 0, 0);
    expect(c.prefix()).toBe('Reply to Bree:');
    // A new message after Tab doesn't move the reply...
    c.heard('Cole');
    expect(c.prefix()).toBe('Reply to Bree:');
    expect(c.submit('on my way')).toEqual({ type: 'whisper', to: 'Bree', text: 'on my way' });
    // ...sending returns to public chat
    expect(c.isPrivate).toBe(false);
    // ...and the next Tab takes whoever is last now
    c.key('Tab', 0, 0);
    expect(c.prefix()).toBe('Reply to Cole:');
    expect(c.lastSender).toBe('Cole');
  });

  it('Backspace at the very start cancels and clears the draft; elsewhere it is just a backspace', () => {
    const c = new ChatCompose();
    c.heard('Ash');
    c.key('Tab', 0, 0);
    expect(c.key('Backspace', 3, 3)).toEqual({ handled: false, clear: false, blur: false });
    // A selection from the start isn't "at the start"
    expect(c.key('Backspace', 0, 4).handled).toBe(false);
    expect(c.isPrivate).toBe(true);
    expect(c.key('Backspace', 0, 0)).toEqual({ handled: true, clear: true, blur: false });
    expect(c.isPrivate).toBe(false);
    expect(c.prefix()).toBe('');
    // In public chat Backspace at the start is untouched
    expect(c.key('Backspace', 0, 0).handled).toBe(false);
  });

  it('Esc at any point cancels and clears a private message; in public chat it leaves the input', () => {
    const c = new ChatCompose();
    c.startTo('Dax');
    expect(c.prefix()).toBe('To Dax:');
    expect(c.key('Escape', 5, 5)).toEqual({ handled: true, clear: true, blur: false });
    expect(c.isPrivate).toBe(false);
    expect(c.key('Escape', 0, 0)).toEqual({ handled: true, clear: false, blur: true });
  });

  it('an empty message sends nothing and keeps the mode; other keys pass through', () => {
    const c = new ChatCompose();
    c.startTo('Dax');
    expect(c.submit('   ')).toBeNull();
    expect(c.isPrivate).toBe(true);
    expect(c.key('a', 0, 0).handled).toBe(false);
    // Tab with a sender replaces a friend message with the reply
    c.heard('Eve');
    c.key('Tab', 2, 2);
    expect(c.prefix()).toBe('Reply to Eve:');
  });
});
