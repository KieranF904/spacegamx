/**
 * @contract client.hangar.filter-icons
 * owns:       the small line icons on the hangar palette's filter tiles and pills, keyed by subcategory / toggle id
 * needs:      nothing (pure strings)
 * invariants: every id paletteFilters.subsOf can return has an icon — client/src/ships/hangar/filterIcons.test.ts
 *             icons draw in currentColor only, so the CSS's selected / unselected colours reach them — client/src/ships/hangar/filterIcons.test.ts
 * extend:     a new subcategory or toggle is one entry in ICONS below (the test lists the ids that need one)
 */

/** 16x16 thin-line glyph bodies (stroke and fill use currentColor; the wrapper sets stroke width and caps) */
const ICONS: Record<string, string> = {
  all: '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
  // weapons
  direct: '<path d="M2 8h7"/><circle cx="12" cy="8" r="1.8" fill="currentColor"/>',
  burst: '<path d="M2 4.5l3.5 1M2 8h4M2 11.5l3.5-1"/><path d="M9 5.5l4.5-1.2M9 8h5M9 10.5l4.5 1.2"/>',
  beam: '<path d="M1.5 8h13" stroke-width="3.4" opacity=".3"/><path d="M1.5 8h13"/>',
  guided: '<path d="M2 12c0-5 4-7 9-6"/><path d="M9.5 3.2L12.5 6l-3.2 2.4"/>',
  area: '<circle cx="8" cy="8" r="1.6" fill="currentColor"/><circle cx="8" cy="8" r="4.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2"/>',
  support: '<path d="M10.5 2.5a3 3 0 0 0-2.8 4L3 11.2a1.5 1.5 0 0 0 2.1 2.1L9.8 8.6a3 3 0 0 0 4-2.8l-1.9 1.9-1.7-.5-.5-1.7z"/>',
  // weapon toggles
  ammo: '<rect x="2.5" y="5" width="11" height="8" rx="1"/><path d="M2.5 8h11M6.5 8v1.6h3V8M5 5V3.5h6V5"/>',
  none: '<path d="M9 1.5L4 9h3.6L7 14.5 12 7H8.4z"/>',
  fixed: '<path d="M3 11.5V6l5-4 5 4v5.5z"/><path d="M8 11V5.5M5.8 7.5L8 5.3l2.2 2.2"/>',
  turret: '<circle cx="8" cy="9.5" r="2.6"/><path d="M8 7V2M6.6 2h2.8"/><path d="M2.5 8.5A5.8 5.8 0 0 1 4 4.8M13.5 8.5A5.8 5.8 0 0 0 12 4.8"/>',
  // structure
  hull: '<path d="M2.5 4.5h11v7h-11z"/><path d="M2.5 8h11M8 4.5v7"/>',
  armor: '<path d="M8 1.8l5 1.8v4c0 3-2 5-5 6.6-3-1.6-5-3.6-5-6.6v-4z"/>',
  cargo: '<path d="M2.5 5.2L8 2.5l5.5 2.7v5.6L8 13.5l-5.5-2.7z"/><path d="M2.5 5.2L8 8l5.5-2.8M8 8v5.5"/>',
  core: '<rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/><circle cx="8" cy="8" r="2.2"/>',
  // engines
  thrust: '<path d="M3 5.5h5l2.5 2.5L8 10.5H3z"/><path d="M12 6.5h2M12 9.5h2" opacity=".7"/>',
  jump: '<path d="M2.5 11l4-3-4-3M8 11l4-3-4-3"/><path d="M13.5 3v10"/>',
  steer: '<path d="M12.5 5.5A5 5 0 1 0 13 9"/><path d="M13.3 2.5v3.3H10"/>',
  // power
  make: '<circle cx="8" cy="8" r="5.5"/><path d="M8.8 4L6 8.6h2.6L7.4 12l3-5H7.8z"/>',
  store: '<rect x="3" y="5" width="9" height="6" rx="1"/><path d="M12 7v2M14 7.2v1.6M5.5 8h3"/>',
  link: '<circle cx="3.5" cy="8" r="1.6"/><circle cx="12.5" cy="4.5" r="1.6"/><circle cx="12.5" cy="11.5" r="1.6"/><path d="M5 8h2.5l3.5-3M7.5 8l3.5 3"/>',
  // shields
  wall: '<path d="M2 4v8M14 4v8M2 8h12"/><path d="M5 6v4M8 6v4M11 6v4" opacity=".6"/>',
  arc: '<path d="M2.5 11.5A6.5 6.5 0 0 1 13.5 11.5"/><path d="M5 12.5a4 4 0 0 1 6 0" opacity=".6"/>',
  shield: '<circle cx="8" cy="8" r="5.8" stroke-dasharray="2.4 1.6"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/>',
  plating: '<path d="M2.5 5h11M2.5 8h11M2.5 11h11"/><path d="M6 5v3M10 8v3"/>',
  // utility
  mine: '<path d="M3 13L9 7"/><path d="M5 3.5c3-1 6.5.5 8 3.5M3.5 5c-1 3 .5 6.5 3.5 8"/>',
  tools: '<path d="M10.5 2.5a3 3 0 0 0-2.8 4L3 11.2a1.5 1.5 0 0 0 2.1 2.1L9.8 8.6a3 3 0 0 0 4-2.8l-1.9 1.9-1.7-.5-.5-1.7z"/>',
  machines: '<circle cx="8" cy="8" r="2.2"/><path d="M8 2v2M8 12v2M2 8h2M12 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M3.8 12.2l1.4-1.4M10.8 5.2l1.4-1.4"/>',
};

/** Every id that has an icon (for the test) */
export function iconIds(): string[] { return Object.keys(ICONS); }

/** The icon as an inline svg (decorative: the label next to it names the filter); an unknown id draws a plain dot */
export function filterIcon(id: string, size = 16): string {
  const body = ICONS[id] ?? '<circle cx="8" cy="8" r="2"/>';
  return `<svg class="hp-ic" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}
