/**
 * @contract client.gun-range.hud
 * owns:       the gun range's HUD: the banner (GUN RANGE · weapons fully powered), the hull bar of the target you last hit (else the nearest), the door prompt
 *             ("Press X to leave the range" in the door zone, common atRangeDoor) and the weapon picker (the weapons on
 *             offer with the hangar's icons, names, mount badges and class filter icons; the one flown highlighted; a click
 *             or Enter swaps it: gunRangeWeapon), in the left column where the side panel goes (the target is east: the
 *             aim stays clear); the job tracker and the quick bar put away while in
 * needs:      ./rangeState, ./pickerModel, common (atRangeDoor, Catalog, ShipTuning), ui/itemIcons, ships/modelCards
 *             (mountBadge), ships/hangar/filterIcons, ui/domWrite, ui/escape
 * invariants: nothing shows outside the range; the door prompt shows by the server's own door rule — client/src/ui/gunRange/rangeState.test.ts
 *             the picker sends only weapons on offer, and never the one already flown — client/src/ui/gunRange/gunRangeHud.test.ts
 * extend:     a new HUD piece is an element built in the constructor and drawn in update()
 *
 * Plain DOM, drawn only when something changed (domWrite; the picker's list only on a new state or filter). The picker
 * is keyboard driven too: its rows are buttons with one in the tab order (arrows, Home, End move; Enter or Space picks;
 * Esc hands the keyboard back to the ship), and the inventory key folds it in the range (app/keys.ts, gunRange/rangeKeys).
 */

import { atRangeDoor, type Catalog, type ClientMessage, type Economy, type GunRangeDef, type ShipTuning } from '@space-game/common';
import { itemIcon } from '../itemIcons';
import { mountBadge } from '../../ships/modelCards';
import { filterIcon } from '../../ships/hangar/filterIcons';
import { setHtml, setStyle, setText } from '../domWrite';
import { esc } from '../escape';
import { rangeState, rangeVersion } from './rangeState';
import { ALL_ROLES, filterRows, nextRow, pickerRows, rolesPresent, type PickerRow } from './pickerModel';

export interface GunRangeHudHost {
  send(m: ClientMessage): void;
  sound(id: string, volume?: number): void;
  readonly catalog: Catalog;
  readonly econ: Economy;
  readonly tuning: ShipTuning;
  /** The chamber of the system you are in (null: not a gun range) */
  chamber(): GunRangeDef | null;
  /** Your ship's drawn position (null: none) */
  me(): { x: number; y: number } | null;
  /** A ship's hull (live parts' HP against their most) and name, null when it isn't here */
  hull(id: number): { hp: number; max: number; name: string } | null;
  /** An action's bound key, for hints ("X") */
  keyName(action: string): string;
  /**
   * The HUD's left column (where the side panel goes: the picker takes it in here): under the pilot readout (`top`) down
   * to the chat box (`floor`); short of room it may lift over the readout, up to its top (`lift`)
   */
  column(): { left: number; top: number; lift: number; width: number; floor: number };
}

const STYLE = `
/* (In the range: the job tracker and the quick bar have nothing to do there; the picker takes the right column) */
body.in-gun-range .qt, body.in-gun-range .qb-bar { display: none !important; }
/* (the picker sits in the left column, where the side panel goes: the way to the target, east, stays clear for aiming) */
.gr-banner { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 860; pointer-events: none;
  display: flex; flex-direction: column; align-items: center; gap: 6px; font: 600 12px/1.2 'Segoe UI', system-ui, sans-serif; }
.gr-chip { padding: 5px 14px; border-radius: 999px; background: rgba(8, 18, 30, 0.86); border: 1px solid rgba(250, 204, 21, 0.55);
  color: #fde68a; letter-spacing: 1.4px; text-transform: uppercase; white-space: nowrap; }
.gr-chip b { color: #fff7d6; }
.gr-chip span { color: #a7f3d0; letter-spacing: 0.6px; }
.gr-target { width: 300px; padding: 5px 10px 7px; border-radius: 8px; background: rgba(8, 14, 26, 0.82); border: 1px solid rgba(248, 113, 113, 0.35); color: #fecaca; }
.gr-target .h { display: flex; justify-content: space-between; font-size: 11px; letter-spacing: 0.8px; margin-bottom: 4px; }
.gr-target .h b { color: #fff; font-weight: 700; letter-spacing: 0.4px; text-transform: none; }
.gr-target .bar { height: 7px; border-radius: 4px; background: rgba(255,255,255,0.08); overflow: hidden; }
.gr-target .bar i { display: block; height: 100%; width: 100%; background: linear-gradient(90deg, #ef4444, #f97316); transform-origin: left; }
.gr-door { position: fixed; left: 50%; bottom: 152px; transform: translateX(-50%); z-index: 900; pointer-events: none; display: none;
  padding: 8px 18px; border-radius: 999px; background: rgba(6, 22, 16, 0.9); border: 1px solid rgba(74, 222, 128, 0.7);
  color: #dcfce7; font: 15px 'Segoe UI', system-ui, sans-serif; letter-spacing: 0.4px; }
.gr-door kbd, .gr-pick .k kbd { display: inline-block; min-width: 18px; padding: 0 5px; margin: 0 3px; border-radius: 4px; border: 1px solid currentColor;
  font: 700 12px/18px 'Segoe UI', sans-serif; text-align: center; }
.gr-pick { position: fixed; left: 16px; top: 390px; width: 320px; z-index: 852; display: none; flex-direction: column; max-height: calc(100vh - 560px);
  border-radius: 10px; background: rgba(8, 14, 26, 0.97); border: 1px solid rgba(140, 170, 220, 0.22); color: #c9d4e5;
  font: 12px 'Segoe UI', system-ui, sans-serif; box-shadow: 0 8px 26px rgba(0,0,0,0.45); }
.gr-pick .hd { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 8px 10px; }
.gr-pick .hd:focus-visible { outline: 2px solid #5fd4c4; outline-offset: -2px; border-radius: 10px; }
.gr-pick .hd .t { font: 700 10px/1 'Segoe UI', sans-serif; letter-spacing: 1.4px; color: #7dd3fc; text-transform: uppercase; }
.gr-pick .hd .cur { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #fff; font-weight: 600; }
.gr-pick .hd .f { color: #6b7a93; font-size: 11px; }
.gr-pick .bd { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; border-top: 1px solid rgba(140,170,220,0.14); }
.gr-pick.folded .bd { display: none; }
.gr-roles { display: flex; gap: 3px; padding: 7px 8px 6px; }
.gr-role { all: unset; box-sizing: border-box; cursor: pointer; flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 4px 2px 3px; border-radius: 6px; background: #0f1626; border: 1px solid #2a3a5a; color: #8c9bb3; font: 600 8.5px/10px 'Segoe UI', sans-serif; }
.gr-role .hp-ic { width: 15px; height: 15px; }
.gr-role:hover { border-color: #46608c; color: #e5ecf7; }
.gr-role[aria-checked="true"] { background: #24406b; border-color: #5fd4c4; color: #fff; }
.gr-role:focus-visible { outline: 2px solid #5fd4c4; outline-offset: 1px; }
.gr-list { position: relative; overflow-y: auto; min-height: 0; flex: 1; padding: 2px 6px 6px; display: flex; flex-direction: column; gap: 2px; }
.gr-row { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 2px 6px; border-radius: 7px; flex-shrink: 0;
  border: 1px solid transparent; background: rgba(255,255,255,0.02); }
.gr-row img { width: 26px; height: 26px; flex-shrink: 0; image-rendering: auto; }
.gr-row .tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.gr-row .l1 { display: flex; align-items: center; gap: 5px; min-width: 0; }
.gr-row .l1 b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #e5ecf7; font-weight: 600; }
.gr-row .l2 { display: flex; align-items: center; gap: 4px; color: #6b7a93; font-size: 10px; }
.gr-row .l2 .hp-ic { width: 11px; height: 11px; }
.gr-row:hover { border-color: #46608c; background: #131d33; }
.gr-row[aria-current="true"] { border-color: #facc15; background: rgba(250, 204, 21, 0.12); }
.gr-row[aria-current="true"] .l1 b { color: #fde68a; }
.gr-row:focus-visible { outline: 2px solid #5fd4c4; outline-offset: 0; }
.gr-pick .k { padding: 6px 10px 8px; color: #6b7a93; font-size: 10.5px; border-top: 1px solid rgba(140,170,220,0.1); }
`;

/** How tall the picker would like to be (px): it lifts over the pilot readout for it where the column is short */
const WANT = 430;

const ROLE_LABEL: Record<string, string> = { direct: 'Direct', burst: 'Burst', beam: 'Beam', guided: 'Guided', area: 'Area', support: 'Support' };

export class GunRangeHud {
  private readonly banner: HTMLDivElement;
  private readonly chip: HTMLDivElement;
  private readonly target: HTMLDivElement;
  private readonly targetName: HTMLElement;
  private readonly targetPct: HTMLElement;
  private readonly targetBar: HTMLElement;
  /** Each target's hull share last frame (by its place in the list), and the one that last lost some or went down */
  private readonly seen = new Map<number, number>();
  private lastHit = -1;
  private readonly door: HTMLDivElement;
  private readonly pick: HTMLDivElement;
  private readonly head: HTMLButtonElement;
  private readonly headCur: HTMLElement;
  private readonly roles: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly keys: HTMLDivElement;
  private rows: PickerRow[] = [];
  private role = ALL_ROLES;
  private folded = false;
  /** What the picker was last drawn from (state version, filter, fold, the key names) */
  private drawn = '';
  private drawnWeapon = '';
  private shown = false;
  /** Frames to the next look at the left column (a layout read: a few times a second, not every frame) */
  private placeIn = 0;

  constructor(private readonly h: GunRangeHudHost) {
    if (!document.getElementById('gr-style')) {
      const s = document.createElement('style');
      s.id = 'gr-style';
      s.textContent = STYLE;
      document.head.appendChild(s);
    }
    this.banner = el('div', 'gr-banner');
    this.chip = el('div', 'gr-chip');
    this.target = el('div', 'gr-target');
    this.target.innerHTML = '<div class="h"><span><b></b></span><span></span></div><div class="bar"><i></i></div>';
    this.targetName = this.target.querySelector('b')!;
    this.targetPct = this.target.querySelector('.h > span:last-child')!;
    this.targetBar = this.target.querySelector('i')!;
    this.banner.append(this.chip, this.target);
    this.banner.dataset.hudAvoid = '1';

    this.door = el('div', 'gr-door');
    this.door.setAttribute('role', 'status');

    this.pick = el('div', 'gr-pick');
    this.pick.setAttribute('role', 'region');
    this.pick.setAttribute('aria-label', 'Gun range: weapon');
    this.pick.dataset.hudAvoid = '1';
    this.head = document.createElement('button');
    this.head.className = 'hd';
    this.head.innerHTML = '<span class="t">Weapon</span><span class="cur"></span><span class="f"></span>';
    this.headCur = this.head.querySelector('.cur')!;
    this.head.onclick = () => this.toggle();
    const body = el('div', 'bd');
    this.roles = el('div', 'gr-roles');
    this.roles.setAttribute('role', 'radiogroup');
    this.roles.setAttribute('aria-label', 'Weapon class');
    this.list = el('div', 'gr-list');
    this.list.setAttribute('role', 'list');
    this.list.setAttribute('aria-label', 'Weapons you can fit');
    this.keys = el('div', 'k');
    body.append(this.roles, this.list, this.keys);
    this.pick.append(this.head, body);
    this.pick.addEventListener('click', (e) => this.onClick(e));
    this.pick.addEventListener('keydown', (e) => this.onKey(e));

    document.body.append(this.banner, this.door, this.pick);
    this.banner.style.display = 'none';
  }

  /** Fold or open the picker (the inventory key in the range) */
  toggle(): void {
    this.folded = !this.folded;
    this.h.sound(this.folded ? 'ui_close' : 'ui_open', 0.4);
    this.drawn = '';
    this.placeIn = 0;
  }

  /** Once a frame. `hidden`: behind the menu, the map or the death screen */
  update(hidden: boolean): void {
    const st = rangeState(), def = st.in ? this.h.chamber() : null;
    const show = !!def && !hidden;
    if (show !== this.shown) {
      this.shown = show;
      document.body.classList.toggle('in-gun-range', show);
      setStyle(this.banner, 'display', show ? 'flex' : 'none');
      setStyle(this.pick, 'display', show ? 'flex' : 'none');
      if (!show) { setStyle(this.door, 'display', 'none'); this.seen.clear(); this.lastHit = -1; }
    }
    if (!show || !def) return;
    if (--this.placeIn <= 0) {
      this.placeIn = 15;
      // (Folded, it's just its head: under the readout. Open, it lifts over the readout where the column is short)
      const c = this.h.column(), top = this.folded ? c.top : Math.max(c.lift || c.top, Math.min(c.top, c.floor - WANT));
      setStyle(this.pick, 'left', `${Math.round(c.left)}px`);
      setStyle(this.pick, 'top', `${Math.round(top)}px`);
      setStyle(this.pick, 'width', `${Math.round(c.width)}px`);
      setStyle(this.pick, 'maxHeight', `${Math.max(160, Math.round(c.floor - top))}px`);
    }
    setHtml(this.chip, '<b>Gun range</b> · <span>weapons fully powered · ammo unlimited</span>');
    // The target's hull
    const me0 = this.h.me();
    let near = -1, nearD = Infinity;
    st.targets.forEach((t, i) => {
      const h = t.id >= 0 ? this.h.hull(t.id) : null, k = h && h.max > 0 ? h.hp / h.max : 0, was = this.seen.get(i);
      if (was !== undefined && k < was - 1e-4) this.lastHit = i;
      this.seen.set(i, k);
      const d = me0 ? Math.hypot(t.x - me0.x, t.y - me0.y) : 0;
      if (d < nearD) { nearD = d; near = i; }
    });
    const t = st.targets[this.lastHit >= 0 && this.lastHit < st.targets.length ? this.lastHit : near], hull = t && t.id >= 0 ? this.h.hull(t.id) : null;
    if (hull && hull.max > 0) {
      const k = Math.max(0, Math.min(1, hull.hp / hull.max));
      setText(this.targetName, t.label);
      setText(this.targetPct, `${Math.ceil(k * 100)}%`);
      setStyle(this.targetBar, 'transform', `scaleX(${k.toFixed(3)})`);
    } else {
      setText(this.targetName, `${t?.label ?? 'Target'} · down`);
      setText(this.targetPct, 'back in a moment');
      setStyle(this.targetBar, 'transform', 'scaleX(0)');
    }
    // The door: X takes you out within its reach (the server's rule, common atRangeDoor)
    const me = this.h.me(), atDoor = !!me && atRangeDoor(def, me.x, me.y);
    setStyle(this.door, 'display', atDoor ? 'block' : 'none');
    if (atDoor) setHtml(this.door, `Press <kbd>${esc(this.h.keyName('interact'))}</kbd> to leave the range${st.station ? ` · back to <b>${esc(st.station)}</b>` : ''}`);
    this.drawPicker();
  }

  // ------------------------------------------------------------ the picker

  private drawPicker(): void {
    const st = rangeState();
    const key = `${rangeVersion()}|${this.role}|${this.folded}|${this.h.keyName('inventory')}`;
    if (key === this.drawn) return;
    this.drawn = key;
    this.rows = pickerRows(this.h.catalog, this.h.tuning, st.options);
    const roles = rolesPresent(this.rows);
    if (this.role !== ALL_ROLES && !roles.some((r) => r.id === this.role)) this.role = ALL_ROLES;
    const cur = this.rows.find((r) => r.fn === st.weapon);
    setText(this.headCur, cur?.name ?? st.weapon);
    setText(this.head.querySelector('.f'), this.folded ? `▸ ${this.rows.length}` : '▾');
    this.head.setAttribute('aria-expanded', String(!this.folded));
    this.pick.classList.toggle('folded', this.folded);
    if (this.folded) return;
    const focusFn = (document.activeElement as HTMLElement | null)?.dataset?.fn;
    // (A redraw keeps the list where it was scrolled; a new weapon is brought into view)
    const scroll = this.list.scrollTop, newWeapon = st.weapon !== this.drawnWeapon;
    this.drawnWeapon = st.weapon;
    // Class filter: All, then the classes on offer (the hangar palette's icons)
    const tile = (id: string, label: string) => `<button class="gr-role" role="radio" data-role="${id}" aria-checked="${this.role === id}" tabindex="${this.role === id ? 0 : -1}" title="${esc(label)}">${filterIcon(id, 15)}<span>${esc(label)}</span></button>`;
    this.roles.innerHTML = roles.length > 1 ? tile(ALL_ROLES, 'All') + roles.map((r) => tile(r.id, r.label)).join('') : '';
    this.roles.style.display = roles.length > 1 ? 'flex' : 'none';
    const shown = filterRows(this.rows, this.role);
    const tabRow = shown.find((r) => r.fn === st.weapon) ?? shown[0];
    this.list.innerHTML = shown.map((r) => {
      const on = r.fn === st.weapon;
      return `<button class="gr-row" role="listitem" data-fn="${esc(r.fn)}" aria-current="${on}" tabindex="${r === tabRow ? 0 : -1}"`
        + ` aria-label="${esc(`${r.name}, Mk ${r.grade}, ${ROLE_LABEL[r.role] ?? r.role}, ${r.side ? 'side mount' : r.mount}${on ? ', flying now' : ''}`)}">`
        + `<img src="${itemIcon(this.h.econ, r.item)}" alt="">`
        + `<span class="tx"><span class="l1"><b>${esc(r.name)}</b>${mountBadge(this.h.catalog, { fn: r.fn })}</span>`
        + `<span class="l2">${filterIcon(r.role, 11)}${esc(ROLE_LABEL[r.role] ?? r.role)} · Mk ${r.grade}${on ? ' · <span style="color:#fde68a">flying</span>' : ''}</span></span></button>`;
    }).join('') || '<div style="padding:8px; color:#6b7a93">No weapon of this class</div>';
    setHtml(this.keys, `Click or <kbd>Enter</kbd> to fly it · <kbd>${esc(this.h.keyName('inventory'))}</kbd> folds this`);
    // (Keep the keyboard where it was across a redraw)
    this.list.scrollTop = scroll;
    if (focusFn) (this.list.querySelector(`[data-fn="${CSS.escape(focusFn)}"]`) as HTMLElement | null)?.focus();
    else if (newWeapon) {
      const on = this.list.querySelector<HTMLElement>('[aria-current="true"]');
      if (on && (on.offsetTop < this.list.scrollTop || on.offsetTop + on.offsetHeight > this.list.scrollTop + this.list.clientHeight)) this.list.scrollTop = on.offsetTop - 6;
    }
  }

  private choose(fn: string): void {
    const st = rangeState();
    if (!st.in || fn === st.weapon || !st.options.includes(fn)) return;
    this.h.send({ type: 'gunRangeWeapon', model: fn });
    this.h.sound('ui_click', 0.5);
  }

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const role = t.closest<HTMLElement>('[data-role]')?.dataset.role;
    if (role) { this.role = role; this.drawn = ''; this.h.sound('ui_click', 0.3); this.drawPicker(); return; }
    const fn = t.closest<HTMLElement>('[data-fn]')?.dataset.fn;
    if (fn) this.choose(fn);
    // (A mouse click hands the keyboard straight back to the ship: Space must boost, not press the row again)
    if (e.detail > 0) t.closest<HTMLElement>('button')?.blur();
  }

  /** Arrows move through the list (or the class tiles); Esc hands the keyboard back. The keys used here never reach the ship */
  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    if (e.code === 'Escape') { t.blur(); e.stopPropagation(); e.preventDefault(); return; }
    if (e.code === 'Enter' || e.code === 'Space') { e.stopPropagation(); return; } // (the button's own click)
    const inRoles = !!t.closest('.gr-roles'), sel = inRoles ? '.gr-role' : '.gr-row';
    const items = [...(inRoles ? this.roles : this.list).querySelectorAll<HTMLElement>(sel)];
    const at = items.indexOf(t.closest(sel) as HTMLElement);
    if (at < 0) return;
    const code = inRoles ? ({ ArrowRight: 'ArrowDown', ArrowLeft: 'ArrowUp' } as Record<string, string>)[e.code] ?? e.code : e.code;
    const next = nextRow(code, at, items.length);
    if (next === null) return;
    e.stopPropagation();
    e.preventDefault();
    if (inRoles) { this.role = items[next].dataset.role!; this.drawn = ''; this.drawPicker(); (this.roles.querySelector(`[data-role="${this.role}"]`) as HTMLElement | null)?.focus(); return; }
    items.forEach((x, i) => (x.tabIndex = i === next ? 0 : -1));
    items[next].focus();
  }
}

function el(tag: string, cls: string): HTMLDivElement {
  const e = document.createElement(tag) as HTMLDivElement;
  e.className = cls;
  return e;
}
