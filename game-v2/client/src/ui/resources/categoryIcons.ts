/**
 * @contract client.ui.resource-category-icons
 * owns:       the small line icons for the guide's four views (Resources, Rocks, Enemies, Systems) and the resource categories (All, Ore, Refined, Components, Packs, Ammo, Cut gems, Drops), as inline svg
 * needs:      nothing (pure strings; same 16x16 style as the hangar's filterIcons.ts)
 * invariants: every view id and every ResourceCategory has an icon, and all draw in currentColor only — client/src/ui/resources/categoryIcons.test.ts
 * extend:     a new view or category is one entry in ICONS below (the test lists what is missing)
 */

/** 16x16 thin-line glyph bodies (stroke and fill use currentColor; the wrapper sets stroke width and caps) */
const ICONS: Record<string, string> = {
  // views
  res: '<path d="M2.5 5.2L8 2.5l5.5 2.7v5.6L8 13.5l-5.5-2.7z"/><path d="M2.5 5.2L8 8l5.5-2.8M8 8v5.5"/>',
  rock: '<path d="M2.5 10l1.5-4.5 3-2.5 4 1 2.5 3.5-1 4.5-4.5 1.5z"/><path d="M4 5.5l3.5 2.5 4-1M7.5 8l.5 5"/>',
  enemy: '<path d="M8 2.5l5.5 10-5.5-2.5-5.5 2.5z"/><path d="M8 6.5v2.2"/>',
  sys: '<circle cx="8" cy="8" r="2.4" fill="currentColor"/><circle cx="8" cy="8" r="5.8" opacity=".55"/><circle cx="13" cy="5" r="1.1" fill="currentColor"/>',
  // resource categories
  all: '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
  ore: '<path d="M3 11l2-5 3-3.5 3.5 2.5 2 4.5-2 3.5H5.5z"/><path d="M5 6l3 2 3.5-1M8 8v5"/>',
  refined: '<path d="M2.5 11.5h11l-1.8-5h-7.4z"/><path d="M4.3 6.5L5.5 4h5l1.2 2.5"/>',
  component: '<circle cx="8" cy="8" r="2.2"/><path d="M8 2v2.2M8 11.8V14M2 8h2.2M11.8 8H14M3.8 3.8l1.5 1.5M10.7 10.7l1.5 1.5M3.8 12.2l1.5-1.5M10.7 5.3l1.5-1.5"/>',
  pack: '<path d="M2.5 5.5L8 2.5l5.5 3v5.5L8 13.5 2.5 11z"/><path d="M2.5 5.5L8 8.5l5.5-3M8 8.5v5M5.3 4l5.4 3"/>',
  ammo: '<rect x="2.5" y="5" width="11" height="8" rx="1"/><path d="M2.5 8h11M6.5 8v1.6h3V8M5 5V3.5h6V5"/>',
  gem: '<path d="M4.5 3h7l2.5 3.5L8 13.5 2 6.5z"/><path d="M2 6.5h12M6 3l2 3.5L10 3M8 6.5v7"/>',
  drop: '<path d="M8 2.2c2.6 3 4.2 5 4.2 7.1A4.2 4.2 0 0 1 8 13.5a4.2 4.2 0 0 1-4.2-4.2C3.8 7.2 5.4 5.2 8 2.2z"/><path d="M6 9.6a2 2 0 0 0 1.6 1.8" opacity=".7"/>',
};

/** Every id that has an icon (for the test) */
export function categoryIconIds(): string[] { return Object.keys(ICONS); }

/** The icon as an inline svg (decorative: the label next to it names the category); an unknown id draws a plain dot */
export function categoryIcon(id: string, size = 14): string {
  const body = ICONS[id] ?? '<circle cx="8" cy="8" r="2"/>';
  return `<svg class="rd-ic" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}
