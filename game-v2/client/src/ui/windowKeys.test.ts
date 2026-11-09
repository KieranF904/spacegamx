import { describe, expect, it } from 'vitest';
import { windowKeepsKey } from './windowKit';

const at = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable }) as unknown as EventTarget;

describe('keys pressed in a window', () => {
  it('stay in a field being typed in', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) expect(windowKeepsKey({ code: 'KeyH', target: at(tag) })).toBe(true);
    expect(windowKeepsKey({ code: 'KeyM', target: at('DIV', true) })).toBe(true);
  });
  it('stay when they work the focused button (Space, Enter, arrows, Tab)', () => {
    for (const code of ['Space', 'Enter', 'ArrowLeft', 'Tab']) expect(windowKeepsKey({ code, target: at('BUTTON') })).toBe(true);
  });
  it('reach the game after a click on a tab or button (H leaves the station, M opens the map)', () => {
    for (const code of ['KeyH', 'KeyI', 'KeyM', 'KeyC', 'Digit1']) expect(windowKeepsKey({ code, target: at('BUTTON') })).toBe(false);
  });
});
