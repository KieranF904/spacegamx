/**
 * The footer buttons' icons: one for each button, all drawn in the button's own colour.
 */
import { describe, expect, it } from 'vitest';
import { footerIcon, footerIconIds } from './footerIcons';

describe('footer icons', () => {
  it('cover every footer button, and draw in currentColor only', () => {
    expect(footerIconIds().sort()).toEqual(['build', 'guide', 'jobs', 'map', 'settings', 'ship', 'social', 'station']);
    for (const id of footerIconIds()) {
      const s = footerIcon(id);
      expect(s, id).toContain('<svg');
      expect(s, id).toContain(`data-icon="${id}"`);
      expect(s, id).toContain('stroke="currentColor"');
      expect(s, id).not.toMatch(/#[0-9a-f]{3,6}|rgb/i);
    }
  });

  it('are distinct glyphs', () => {
    const bodies = footerIconIds().map((id) => footerIcon(id).replace(/data-icon="[a-z]+"/, ''));
    expect(new Set(bodies).size).toBe(bodies.length);
  });
});
