/**
 * @contract client.ui.hub-tabs
 * owns:       the side panel tab contract: HubTab and what the panel gives each tab (context, id, label, key action)
 * needs:      nothing from the panel implementation; app/windows.ts registers tabs in order
 * invariants: the panel sizes, folds and places itself around its tabs — none pinned
 * extend:     a new tab is a module in ui/hub/tabs/ giving a HubTab and one register line in app/windows.ts; the
 *             panel names no tab
 */

/**
 * The side panel's tabs: each tab is its own module (ui/hub/tabs/) giving a HubTab, and app/windows.ts registers them
 * in order on the panel (HubPanel.register). The panel owns the tab bar, folding, sizing and placing; a tab only draws
 * its body. Adding a tab is a new module and one register line: nothing in the panel names a tab.
 */

/** What the panel gives each tab */
export interface HubTabContext {
  /** Draw the tab again if it's on show (put off while the pilot is typing in it), and refresh the tab bar's badges */
  invalidate(): void;
  /** Is this tab on show right now */
  shown(): boolean;
}

export interface HubTab {
  /** Stable id: the saved choice and HubPanel.open(id) */
  readonly id: string;
  /** The tab button's text (short: four share a 320px bar) */
  readonly label: string;
  /** Its full name (the button's tooltip and the body's accessible name) */
  readonly title: string;
  /** The keybinding action that opens it, for the tooltip's key hint (input/keybindings.ts ACTIONS) */
  readonly action?: string;
  /** The body fills the panel and scrolls itself (a list with a fixed header), instead of the panel scrolling it */
  readonly fill?: boolean;
  /** Redraw this often (ms) while on show (live numbers) */
  readonly live?: number;
  /** A count on the tab button (requests waiting); 0 shows none */
  badge?(): number;
  /** Called once, when registered */
  attach?(ctx: HubTabContext): void;
  /** Draw into the body: the tab was chosen, the panel unfolded, or it asked to be drawn again */
  render(body: HTMLElement): void;
  /** The tab left the screen (another tab, folded, hidden): stop any work it does while shown */
  hide?(): void;
}

/** An ordered set of tabs, ids unique */
export class HubTabs {
  private list: HubTab[] = [];

  add(tab: HubTab): void {
    if (this.list.some((t) => t.id === tab.id)) throw new Error(`hub tab ${tab.id} registered twice`);
    this.list.push(tab);
  }

  get(id: string): HubTab | undefined {
    return this.list.find((t) => t.id === id);
  }

  all(): readonly HubTab[] {
    return this.list;
  }

  ids(): string[] {
    return this.list.map((t) => t.id);
  }

  /** The tab `step` places along from `id`, wrapping (arrow keys on the tab bar) */
  step(id: string, step: number): string | undefined {
    const n = this.list.length;
    if (!n) return undefined;
    const i = Math.max(0, this.list.findIndex((t) => t.id === id));
    return this.list[(((i + step) % n) + n) % n].id;
  }
}
