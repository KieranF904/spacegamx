import { describe, it, expect } from 'vitest';
import { buildKeyAction } from './buildKeys';

const k = (code: string, o: { ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) =>
  buildKeyAction({ code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });

describe('buildKeyAction', () => {
  it('Ctrl+Z undoes, Ctrl+Y and Ctrl+Shift+Z redo (Cmd on a Mac too)', () => {
    expect(k('KeyZ', { ctrlKey: true })).toBe('undo');
    expect(k('KeyZ', { metaKey: true })).toBe('undo');
    expect(k('KeyY', { ctrlKey: true })).toBe('redo');
    expect(k('KeyZ', { ctrlKey: true, shiftKey: true })).toBe('redo');
  });
  it('M alone is symmetry', () => {
    expect(k('KeyM')).toBe('symmetry');
    expect(k('KeyM', { ctrlKey: true })).toBeNull();
  });
  it('plain Z or Y, and other keys, are left to the game', () => {
    expect(k('KeyZ')).toBeNull();
    expect(k('KeyY')).toBeNull();
    expect(k('KeyR', { ctrlKey: true })).toBeNull();
    expect(k('KeyZ', { ctrlKey: true, altKey: true })).toBeNull();
  });
});
