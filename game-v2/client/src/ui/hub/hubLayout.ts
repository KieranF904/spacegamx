/**
 * Where the side panel (HubPanel) fits in the left column, with no DOM: it sits on top of the cargo panel, under the
 * pilot readout (and the party list), and shares the room between them with the cargo panel. The cargo panel always
 * keeps its least height; the hub takes what it wants of the rest. When the column is too short for even its least
 * (a short window, the chat box tall), the hub squeezes into what there is, or shows its tab bar alone; once the pilot
 * has opened a tab (`lift`), it lifts over the pilot readout instead (never the ship panel above that, never the
 * cargo panel). When not even its tab bar fits, it hides, unless the pilot called it up with its key.
 * All values are px, y measured from the top of the window.
 */

export interface HubColumn {
  /** Where the column ends: the cargo panel's bottom edge (just above the chat box) */
  floor: number;
  /** The least the cargo panel shrinks to, the whole box (0: it isn't on screen) */
  cargoMin: number;
  /** The highest the hub's top may be: the bottom of the pilot readout or the party list, whichever is lower, plus the gap */
  ceiling: number;
  /** The highest it may reach when it must lift: the pilot readout's top (it may cover the readout, not the ship panel) */
  lift: number;
  /** The space kept between panels */
  gap: number;
}

export interface HubWant {
  /** The tab bar and frame, without the body */
  chrome: number;
  /** The body's height as the pilot left it, and the least worth showing */
  body: number;
  minBody: number;
  folded: boolean;
  /** Called up with its key (P, C) while it would be hidden: shown whatever the room */
  summoned: boolean;
  /** The pilot opened a tab: it may cover the pilot readout to have its room */
  lift: boolean;
}

export interface HubPlace {
  hidden: boolean;
  /** The body's height (0: the tab bar only) */
  body: number;
  /** The whole panel's height */
  total: number;
  /** Over the pilot readout (drawn above it) */
  lifted: boolean;
  /** The cargo panel's ceiling (CargoPanelUI keeps `gap` below it), so the two never overlap */
  cargoCeiling: number;
}

/** A body shorter than this shows nothing useful: the tab bar alone instead */
export const HUB_BODY_FLOOR = 40;

export function hubLayout(c: HubColumn, w: HubWant): HubPlace {
  // The lowest the hub's bottom edge can sit while the cargo panel keeps its least
  const bottom = c.floor - c.cargoMin - (c.cargoMin > 0 ? c.gap : 0);
  const room = bottom - c.ceiling;
  const high = bottom - c.lift;
  const fit = (total: number, body: number): HubPlace => {
    const lifted = total > room;
    return { hidden: false, body, total, lifted, cargoCeiling: lifted ? bottom : c.ceiling + total };
  };
  // (Hidden: the cargo panel keeps its own gap below what's above, as it did before there was a side panel)
  const hidden: HubPlace = { hidden: true, body: 0, total: 0, lifted: false, cargoCeiling: c.ceiling - c.gap };
  if (w.folded) {
    if (w.chrome <= high || w.summoned) return fit(w.chrome, 0);
    return hidden;
  }
  const least = w.chrome + w.minBody;
  const want = w.chrome + Math.max(w.minBody, w.body);
  // Room enough under the readout
  if (room >= least) return fit(Math.min(want, room), Math.min(want, room) - w.chrome);
  // Opened: lift over the readout, up to what it wants
  if ((w.lift || w.summoned) && high >= least) { const t = Math.min(want, high); return fit(t, t - w.chrome); }
  // What there is under the readout (or over it, opened), or the tab bar alone
  const space = w.lift || w.summoned ? high : room;
  if (space >= w.chrome + HUB_BODY_FLOOR) return fit(space, space - w.chrome);
  if (high >= w.chrome) return fit(w.chrome, 0);
  if (w.summoned) return fit(least, w.minBody);
  return hidden;
}
