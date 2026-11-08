import { describe, expect, it } from 'vitest';
import { COMP_TABS } from '../../ui/componentGuide';
import { subsOf } from '../paletteFilters';
import { filterIcon, iconIds } from './filterIcons';

describe('filter icons', () => {
  it('has an icon for every subcategory, All and the weapon toggles', () => {
    const need = new Set(['all', 'ammo', 'none', 'fixed', 'turret']);
    for (const t of COMP_TABS) for (const s of subsOf(t.id)) need.add(s.id);
    for (const id of need) expect(iconIds(), id).toContain(id);
  });
  it('draws in currentColor only', () => {
    for (const id of iconIds()) expect(filterIcon(id)).not.toMatch(/#[0-9a-f]{3}|rgb\(/i);
  });
});
