/**
 * @contract client.ui.footer-icons
 * owns:       the small line icons on the footer's shortcut buttons (Ship, Build, Jobs, Map, Station, Social, Guide,
 *             Settings), as inline svg
 * needs:      nothing (pure strings; the same 16x16 thin-line style as ui/resources/categoryIcons.ts)
 * invariants: every FooterIconId has an icon, and all draw in currentColor only (a button's colour is the icon's) —
 *             client/src/ui/hud/footerIcons.test.ts
 * extend:     a new footer button's icon is one entry in ICONS below, named by its FooterItem.icon (app/windows.ts)
 */

/** 16x16 thin-line glyph bodies (stroke and fill use currentColor; the wrapper sets stroke width and caps) */
const ICONS = {
  // a hull, nose up
  ship: '<path d="M8 1.8l3.2 7.4 2.3 3.3H2.5l2.3-3.3z"/><path d="M6.3 12.5v1.7M9.7 12.5v1.7M8 6v3"/>',
  // a spanner over a part's square
  build: '<path d="M10.2 2.3a3 3 0 0 0-2.6 4.3L2.6 11.6a1.3 1.3 0 0 0 1.8 1.8l5-5a3 3 0 0 0 4.3-2.6l-1.9 1.4-1.6-.5-.5-1.6z"/>',
  // a list with ticks
  jobs: '<rect x="3" y="2.5" width="10" height="11.5" rx="1.2"/><path d="M6 2.5V1.8h4v.7M5.3 6.3l.9.9 1.5-1.6M9.3 6.6h1.7M5.3 10.2l.9.9 1.5-1.6M9.3 10.5h1.7"/>',
  // a folded chart
  map: '<path d="M2 4l4-1.5 4 1.5 4-1.5v9.5L10 13.5 6 12 2 13.5z"/><path d="M6 2.5V12M10 4v9.5"/>',
  // a ring station
  station: '<circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="1.8"/><path d="M8 2.4v3.8M8 9.8v3.8M2.4 8h3.8M9.8 8h3.8"/>',
  // two pilots
  social: '<circle cx="6" cy="5.6" r="2.2"/><path d="M2 13.2c0-2.3 1.8-4 4-4s4 1.7 4 4"/><circle cx="11.3" cy="6.2" r="1.7"/><path d="M11.6 9.6c1.5.2 2.6 1.5 2.6 3.2"/>',
  // an open book
  guide: '<path d="M8 4.2C6.6 3.2 4.6 2.9 2.4 3.2v9c2.2-.3 4.2 0 5.6 1 1.4-1 3.4-1.3 5.6-1v-9c-2.2-.3-4.2 0-5.6 1z"/><path d="M8 4.2v9"/>',
  // a gear
  settings: '<circle cx="8" cy="8" r="2.1"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4L5 11M11 5l1.4-1.4"/><circle cx="8" cy="8" r="4.3"/>',
} as const;

export type FooterIconId = keyof typeof ICONS;

/** Every id that has an icon (for the test) */
export function footerIconIds(): FooterIconId[] { return Object.keys(ICONS) as FooterIconId[]; }

/** The icon as an inline svg (decorative: the label under it names the button) */
export function footerIcon(id: FooterIconId, size = 14): string {
  return `<svg class="sgft-ic" data-icon="${id}" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[id]}</svg>`;
}
