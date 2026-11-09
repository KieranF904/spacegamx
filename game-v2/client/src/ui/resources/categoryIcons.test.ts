import { describe, it, expect } from 'vitest';
import { categoryIcon, categoryIconIds } from './categoryIcons';
import { CATEGORY_ORDER } from './resourceIndex';

describe('category icons', () => {
  it('cover every view and every resource category, and draw in currentColor only', () => {
    for (const id of ['res', 'rock', 'enemy', 'sys', 'all', ...CATEGORY_ORDER]) expect(categoryIconIds(), id).toContain(id);
    for (const id of categoryIconIds()) {
      const s = categoryIcon(id);
      expect(s, id).toContain('<svg');
      expect(s, id).not.toMatch(/#[0-9a-f]{3,6}|rgb/i);
    }
  });
});
