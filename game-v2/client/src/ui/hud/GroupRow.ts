/**
 * @contract client.ui.group-row
 * owns:       the HUD's weapon group row: five small cells directly above the quick bar, one a group, each with its
 *             number, icons of the current ship's weapons in it, and an L / R badge when the left / right button fires
 *             it; a click sets the left button to that group, a right-click the right button (again: back to all)
 * needs:      @space-game/common (ship types), groupRowModel (what to show), GroupSelection.press (ships/weaponGroups/selection.ts, through `press`),
 *             itemIcons (a weapon's icon is its part item's), domWrite, windowKit showTip / hideTip
 * invariants: it shows exactly groupRowView() of the own ship and the selection, rebuilt only when groupRowKey changes;
 *             it holds no selection of its own — client/src/ui/hud/groupRowModel.test.ts
 * extend:     what a cell shows is groupRowModel's; nothing here names a weapon
 */

import type { Economy, ShipState } from '@space-game/common';
import { setStyle } from '../domWrite';
import { esc } from '../escape';
import { itemIcon } from '../itemIcons';
import { injectWindowStyles, showTip, hideTip } from '../windowKit';
import { ROW_ICONS, groupRowKey, groupRowView, groupTip, shipRowGuns, type GroupRowView, type RowGun } from './groupRowModel';

export interface GroupRowDeps {
  econ(): Economy;
  /** The packed selection (ships/weaponGroups.ts packGroupSel) */
  sel(): number;
  /** A cell was clicked: that button to group g, or back to all when it is on g (GroupSelection.press) */
  press(button: 'left' | 'right', g: number): void;
  fnName(fn: string): string;
}

const CSS = `
/* Directly above the quick bar (ui/QuickBar.ts: bottom 40px, 46px slots, 6px gaps), a cell over each slot */
.sggr { position: fixed; left: 50%; bottom: 90px; transform: translateX(-50%); display: none; gap: 6px; z-index: 870; }
.sggr-cell { position: relative; width: 46px; height: 24px; box-sizing: border-box; border-radius: 7px; background: rgba(8, 14, 26, 0.8);
  border: 1px solid rgba(120, 150, 200, 0.28); display: flex; align-items: center; gap: 1px; padding: 0 3px 0 4px; cursor: pointer;
  font: 700 11px 'Segoe UI', system-ui, sans-serif; color: #8394ad; transition: border-color .15s, background .15s; }
.sggr-cell:hover { border-color: rgba(125, 211, 252, 0.6); background: rgba(14, 24, 44, 0.9); }
.sggr-cell .num { min-width: 8px; }
.sggr-cell img { width: 14px; height: 14px; pointer-events: none; }
.sggr-cell .more { font-size: 9px; color: #8394ad; }
.sggr-cell.empty { opacity: 0.45; }
.sggr-cell.empty .num { color: #5b6b84; }
/* Fired by a button: lit; set to this very group: a bright edge */
.sggr-cell.on { color: #cfe0f5; border-color: rgba(125, 211, 252, 0.45); }
.sggr-cell.pick { opacity: 1; color: #fff; border-color: #7dd3fc; background: rgba(29, 94, 122, 0.55); }
.sggr-cell .bl, .sggr-cell .br { position: absolute; top: -7px; min-width: 11px; padding: 0 2px; border-radius: 5px; background: #0b1220;
  font: 700 8px 'Segoe UI', sans-serif; line-height: 11px; text-align: center; pointer-events: none; }
.sggr-cell .bl { left: -3px; border: 1px solid #7dd3fc; color: #7dd3fc; }
.sggr-cell .br { right: -3px; border: 1px solid #fbbf24; color: #fbbf24; }
/* A button on "all": its badges are quieter than a picked group's */
.sggr[data-left="0"] .bl, .sggr[data-right="0"] .br { opacity: 0.6; }
`;

export class GroupRow {
  private root: HTMLDivElement | null = null;
  private cells: HTMLDivElement[] = [];
  private ship: ShipState | null = null;
  private rebuilds = -1;
  private guns: RowGun[] = [];
  private view: GroupRowView | null = null;
  private shownKey = '';

  constructor(private deps: GroupRowDeps) {}

  private make(): HTMLDivElement {
    injectWindowStyles();
    const s = document.createElement('style');
    s.textContent = CSS;
    document.head.appendChild(s);
    const root = document.createElement('div');
    root.className = 'sggr';
    root.dataset.hudAvoid = '1';
    for (let i = 0; i < 5; i++) {
      const g = i + 1;
      const el = document.createElement('div');
      el.className = 'sggr-cell';
      el.dataset.group = String(g);
      // (The click is the row's, not the guns')
      el.addEventListener('mousedown', (e) => e.stopPropagation());
      el.addEventListener('click', () => this.deps.press('left', g));
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.deps.press('right', g); });
      el.addEventListener('mousemove', (e) => { const c = this.view?.cells[i]; if (c) showTip(esc(groupTip(c, this.deps.fnName)), e.clientX, e.clientY); });
      el.addEventListener('mouseleave', hideTip);
      root.appendChild(el);
      this.cells.push(el);
    }
    document.body.appendChild(root);
    return (this.root = root);
  }

  /** Each frame: the own ship (null: none) and whether the HUD shows. Cheap: the weapons are read again only when the ship is rebuilt */
  update(visible: boolean, ship: ShipState | null): void {
    if (ship !== this.ship || (ship && ship.rebuilds !== this.rebuilds)) {
      this.ship = ship;
      this.rebuilds = ship ? ship.rebuilds : -1;
      this.guns = ship && ship.kind === 'ship' ? shipRowGuns(ship) : [];
    }
    const on = visible && this.guns.length > 0;
    if (!on && !this.root) return;
    const root = this.root ?? this.make();
    setStyle(root, 'display', on ? 'flex' : 'none');
    if (!on) { hideTipIfOver(root); return; }
    const v = groupRowView(this.guns, this.deps.sel(), !!ship && ship.derived.miners.length > 0);
    this.view = v;
    const key = groupRowKey(v);
    if (key === this.shownKey) return;
    this.shownKey = key;
    root.dataset.left = String(v.left);
    root.dataset.right = String(v.right);
    const econ = this.deps.econ();
    v.cells.forEach((c, i) => {
      const el = this.cells[i];
      el.className = `sggr-cell${c.guns.length ? '' : ' empty'}${c.left || c.right ? ' on' : ''}${c.leftPicked || c.rightPicked ? ' pick' : ''}`;
      el.dataset.left = c.left ? '1' : '0';
      el.dataset.right = c.right ? '1' : '0';
      el.dataset.weapons = c.guns.map((x) => x.fn).join(' ');
      let html = `<span class="num">${c.g}</span>`;
      for (const x of c.guns.slice(0, ROW_ICONS)) html += `<img src="${itemIcon(econ, x.item)}" alt="">`;
      if (c.guns.length > ROW_ICONS) html += `<span class="more">+${c.guns.length - ROW_ICONS}</span>`;
      if (c.left) html += '<span class="bl">L</span>';
      if (c.right) html += '<span class="br">R</span>';
      el.innerHTML = html;
    });
  }
}

/** The tooltip goes with the row (a cell hidden under the pointer gets no mouseleave) */
function hideTipIfOver(root: HTMLElement): void {
  if (root.matches(':hover')) hideTip();
}
