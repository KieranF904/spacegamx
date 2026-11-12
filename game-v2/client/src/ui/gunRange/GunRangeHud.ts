/**
 * @contract client.gun-range.hud
 * owns:       the gun range's HUD: the banner (GUN RANGE · weapons fully powered), the hull bar of the target you last hit (else the nearest), the door prompt
 *             (in a door's zone, common rangeDoorAt: "Press X to leave the range" at the exit, "Press X to go through"
 *             with the room's name at a door to another room) and the weapon picker (the weapons on
 *             offer with the hangar's icons, names, mount badges and class filter icons; the one flown highlighted; a click
 *             or Enter swaps it: gunRangeWeapon; over the list the weapon modifiers on offer as chips, the ones on the
 *             ship lit: a click turns one, sent with the weapon flown), in the left column where the side panel goes (the target is east: the
 *             aim stays clear); in the picker, for a pilot
 *             the server sent library ships (admins), the Weapons / Ships tabs and the ships' list (a click flies that
 *             design as built: gunRangeShip; the modifier chips put away while one is flown); the job tracker and the
 *             quick bar put away while in
 * needs:      ./rangeState, ./pickerModel, common (rangeDoorAt, RANGE_EXIT, rangeGunModded, FX_MAX, Catalog, ShipTuning), ui/itemIcons, ships/modelCards
 *             (mountBadge), ships/hangar/filterIcons, ui/domWrite, ui/escape
 * invariants: nothing shows outside the range; the door prompt shows by the server's own door rule — client/src/ui/gunRange/rangeState.test.ts
 *             the prompt says where the door leads: the station at the exit, the room's name at any other; nothing in
 *             the HUD changes room (only the door does) — client/src/ui/gunRange/gunRangeHud.test.ts
 *             the picker sends only weapons on offer, and never the one already flown — client/src/ui/gunRange/gunRangeHud.test.ts
 *             a chip sends the weapon flown with the effects on offer it leaves on, and nothing for a gun that takes none — client/src/ui/gunRange/gunRangeHud.test.ts
 *             the Ships tab sends only a ship the server sent, never the one
 *             flown; a weapon picked while a library ship is flown is always sent (back to the cheat ship) — client/src/ui/gunRange/gunRangeHud.test.ts
 * extend:     a new HUD piece is an element built in the constructor and drawn in update()
 *
 * Plain DOM, drawn only when something changed (domWrite; the picker's list only on a new state or filter). The picker
 * is keyboard driven too: its rows are buttons with one in the tab order (arrows, Home, End move; Enter or Space picks;
 * Esc hands the keyboard back to the ship), and the inventory key folds it in the range (app/keys.ts, gunRange/rangeKeys).
 */

import { FX_MAX, RANGE_EXIT, rangeDoorAt, rangeGunModded, type Catalog, type ClientMessage, type Economy, type GunRangeRoomDef, type ShipTuning } from '@space-game/common';
import { itemIcon } from '../itemIcons';
import { mountBadge } from '../../ships/modelCards';
import { filterIcon } from '../../ships/hangar/filterIcons';
import { setHtml, setStyle, setText } from '../domWrite';
import { esc } from '../escape';
import { rangeState, rangeVersion } from './rangeState';
import { ALL_ROLES, filterRows, modRows, nextRow, pickerRows, pickerTabs, rolesPresent, shipGroups, toggleMod, type PickerRow, type PickerTab } from './pickerModel';

export interface GunRangeHudHost {
  send(m: ClientMessage): void;
  sound(id: string, volume?: number): void;
  readonly catalog: Catalog;
  readonly econ: Economy;
  readonly tuning: ShipTuning;
  /** The room you are in, of the system you are in (null: not a gun range) */
  chamber(): GunRangeRoomDef | null;
  /** A room's name, by id (a door that leads to it says it) */
  roomName(id: string): string;
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
.gr-banner { position: fixed; top: 28px; left: 50%; transform: translateX(-50%); z-index: 860; pointer-events: none;
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
.gr-door[data-to]:not([data-to="exit"]) { background: rgba(8, 16, 34, 0.9); border-color: rgba(96, 165, 250, 0.75); color: #dbeafe; }
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
.gr-tabs { display: none; align-items: center; gap: 3px; padding: 7px 8px 0; flex-shrink: 0; }
.gr-tab { all: unset; box-sizing: border-box; cursor: pointer; flex: 1 1 0; min-width: 0; padding: 4px 6px; border-radius: 6px; text-align: center;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: #0f1626; border: 1px solid #2a3a5a; color: #8c9bb3; font: 600 11px/13px 'Segoe UI', sans-serif; }
.gr-tab:hover { border-color: #46608c; color: #e5ecf7; }
.gr-tab[aria-selected="true"] { background: #24406b; border-color: #5fd4c4; color: #fff; }
.gr-tab:focus-visible { outline: 2px solid #5fd4c4; outline-offset: 1px; }
.gr-tabs { padding-bottom: 6px; border-bottom: 1px solid rgba(140,170,220,0.1); }
.gr-group { flex-shrink: 0; padding: 8px 6px 3px; font: 700 9.5px/1 'Segoe UI', sans-serif; letter-spacing: 1.2px; text-transform: uppercase; color: #7dd3fc; }
.gr-row.gr-ship { padding: 5px 8px; }
.gr-mods { display: none; flex-direction: column; gap: 5px; padding: 7px 8px 6px; flex-shrink: 0; border-bottom: 1px solid rgba(140,170,220,0.1); }
.gr-mods .mh { display: flex; justify-content: space-between; font: 700 9.5px/1 'Segoe UI', sans-serif; letter-spacing: 1.2px; text-transform: uppercase; color: #7dd3fc; }
.gr-mods .mh span { color: #6b7a93; letter-spacing: 0.4px; text-transform: none; font-weight: 600; }
.gr-mods .mc { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 3px; }
.gr-mod { all: unset; box-sizing: border-box; cursor: pointer; min-width: 0; padding: 2px 3px 3px; border-radius: 6px; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  background: #0f1626; border: 1px solid #2a3a5a; color: color-mix(in srgb, var(--c) 60%, #8c9bb3); font: 600 10px/13px 'Segoe UI', sans-serif; }
.gr-mod:hover { border-color: #46608c; color: #e5ecf7; }
.gr-mod[aria-pressed="true"] { border-color: var(--c); color: #fff; background: color-mix(in srgb, var(--c) 30%, #0f1626); }
.gr-mod:disabled { cursor: default; opacity: 0.4; }
.gr-mod:disabled:hover { border-color: #2a3a5a; color: color-mix(in srgb, var(--c) 60%, #8c9bb3); }
.gr-mod:focus-visible { outline: 2px solid #5fd4c4; outline-offset: 1px; }
.gr-mods .mn { color: #6b7a93; font-size: 10.5px; }
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
const WANT = 500;

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
  private readonly tabs: HTMLDivElement;
  /** Which list shows: the weapons, or (a pilot sent library ships) the ships */
  private tab: PickerTab = 'weapons';
  private readonly mods: HTMLDivElement;
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
    this.tabs = el('div', 'gr-tabs');
    this.tabs.setAttribute('role', 'tablist');
    this.mods = el('div', 'gr-mods');
    this.mods.setAttribute('role', 'group');
    this.mods.setAttribute('aria-label', 'Weapon modifiers');
    this.list = el('div', 'gr-list');
    this.list.setAttribute('role', 'list');
    this.list.setAttribute('aria-label', 'Weapons you can fit');
    this.keys = el('div', 'k');
    body.append(this.tabs, this.mods, this.roles, this.list, this.keys);
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
    // The doors: X takes you through the one you are in reach of (the server's rule, common rangeDoorAt)
    const me = this.h.me(), door = me ? rangeDoorAt(def, me.x, me.y) : undefined;
    setStyle(this.door, 'display', door ? 'block' : 'none');
    if (door) {
      if (this.door.dataset.to !== door.to) this.door.dataset.to = door.to;
      setHtml(this.door, doorHint(this.h.keyName('interact'), door.to, door.to === RANGE_EXIT ? st.station : this.h.roomName(door.to)));
    }
    this.drawPicker();
  }

  // ------------------------------------------------------------ the picker

  private drawPicker(): void {
    const st = rangeState();
    const key = `${rangeVersion()}|${this.role}|${this.tab}|${this.folded}|${this.h.keyName('inventory')}`;
    if (key === this.drawn) return;
    this.drawn = key;
    this.rows = pickerRows(this.h.catalog, this.h.tuning, st.options);
    const roles = rolesPresent(this.rows);
    if (this.role !== ALL_ROLES && !roles.some((r) => r.id === this.role)) this.role = ALL_ROLES;
    const cur = this.rows.find((r) => r.fn === st.weapon);
    // (Ships: only a pilot the server sent some. Flying one, the head names it and no weapon row is the one flown)
    const tabs = pickerTabs(st.ships);
    if (!tabs.includes(this.tab)) this.tab = 'weapons';
    const onShips = this.tab === 'ships', flown = st.ship ? st.ships.find((s) => s.id === st.ship)?.name || st.ship : '';
    setText(this.head.querySelector('.t'), st.ship ? 'Ship' : 'Weapon');
    setText(this.headCur, st.ship ? flown : cur?.name ?? st.weapon);
    setText(this.head.querySelector('.f'), this.folded ? `▸ ${this.rows.length}` : '▾');
    this.head.setAttribute('aria-expanded', String(!this.folded));
    this.pick.classList.toggle('folded', this.folded);
    if (this.folded) return;
    const had = { ...(document.activeElement as HTMLElement | null)?.dataset }, focusFn = had.fn;
    // (A redraw keeps the list where it was scrolled; a new weapon, ship or tab is brought into view)
    const flying = `${st.weapon}|${st.ship}|${this.tab}`;
    const scroll = this.list.scrollTop, newWeapon = flying !== this.drawnWeapon;
    this.drawnWeapon = flying;
    // The Weapons / Ships tabs
    this.tabs.style.display = tabs.length ? 'flex' : 'none';
    this.tabs.innerHTML = tabs.map((t) => `<button class="gr-tab" role="tab" data-tab="${t}" aria-selected="${this.tab === t}">${t === 'ships' ? 'Ships' : 'Weapons'}</button>`).join('');
    // Class filter: All, then the classes on offer (the hangar palette's icons)
    const tile = (id: string, label: string) => `<button class="gr-role" role="radio" data-role="${id}" aria-checked="${this.role === id}" tabindex="${this.role === id ? 0 : -1}" title="${esc(label)}">${filterIcon(id, 15)}<span>${esc(label)}</span></button>`;
    const classes = !onShips && roles.length > 1;
    this.roles.innerHTML = classes ? tile(ALL_ROLES, 'All') + roles.map((r) => tile(r.id, r.label)).join('') : '';
    this.roles.style.display = classes ? 'flex' : 'none';
    // Weapon modifiers: the effects on offer, the ship's lit (all at full strength in here)
    // (A library ship flies as it is built: no chips while one is flown, or over the ships' list)
    const chips = onShips || st.ship ? [] : modRows(this.h.tuning.modifiers, st.modOptions, st.mods), takes = rangeGunModded(this.h.catalog, st.weapon);
    const lit = takes ? chips.filter((c) => c.on).length : 0, full = lit >= FX_MAX;
    const focusMod = (document.activeElement as HTMLElement | null)?.dataset?.mod;
    this.mods.style.display = chips.length ? 'flex' : 'none';
    this.mods.innerHTML = chips.length ? `<div class="mh">Modifiers<span>${takes ? `full strength · ${lit} on` : 'none on this gun'}</span></div><div class="mc">`
      + chips.map((c) => {
        const on = takes && c.on, off = !takes || (!c.on && full);
        return `<button class="gr-mod" data-mod="${esc(c.effect)}" aria-pressed="${on}" style="--c:${esc(c.color)}" title="${esc(c.say)}"${off ? ' disabled' : ''}>${esc(c.name)}</button>`;
      }).join('') + '</div>'
      + (takes ? (full ? '<div class="mn">A gun carries four at most: turn one off to try another</div>' : '')
        : '<div class="mn">Modifiers treat the energy of a shot: this gun fires on ammunition alone</div>') : '';
    if (focusMod) (this.mods.querySelector(`[data-mod="${CSS.escape(focusMod)}"]`) as HTMLElement | null)?.focus();
    this.list.setAttribute('aria-label', onShips ? 'Library ships' : 'Weapons you can fit');
    if (onShips) this.drawShips(st.ships, st.ship);
    const shown = onShips ? [] : filterRows(this.rows, this.role);
    const tabRow = shown.find((r) => !st.ship && r.fn === st.weapon) ?? shown[0];
    if (!onShips) this.list.innerHTML = shown.map((r) => {
      const on = !st.ship && r.fn === st.weapon;
      return `<button class="gr-row" role="listitem" data-fn="${esc(r.fn)}" aria-current="${on}" tabindex="${r === tabRow ? 0 : -1}"`
        + ` aria-label="${esc(`${r.name}, Mk ${r.grade}, ${ROLE_LABEL[r.role] ?? r.role}, ${r.side ? 'side mount' : r.mount}${on ? ', flying now' : ''}`)}">`
        + `<img src="${itemIcon(this.h.econ, r.item)}" alt="">`
        + `<span class="tx"><span class="l1"><b>${esc(r.name)}</b>${mountBadge(this.h.catalog, { fn: r.fn })}</span>`
        + `<span class="l2">${filterIcon(r.role, 11)}${esc(ROLE_LABEL[r.role] ?? r.role)} · Mk ${r.grade}${on ? ' · <span style="color:#fde68a">flying</span>' : ''}</span></span></button>`;
    }).join('') || '<div style="padding:8px; color:#6b7a93">No weapon of this class</div>';
    setHtml(this.keys, `${st.ship ? `Flying <b>${esc(flown)}</b> as built · pick a weapon to go back<br>` : ''}Click or <kbd>Enter</kbd> to fly it · <kbd>${esc(this.h.keyName('inventory'))}</kbd> folds this`);
    // (Keep the keyboard where it was across a redraw)
    this.list.scrollTop = scroll;
    for (const k of ['tab', 'ship'] as const) if (had[k]) (this.pick.querySelector(`[data-${k}="${CSS.escape(had[k]!)}"]`) as HTMLElement | null)?.focus();
    if (focusFn) (this.list.querySelector(`[data-fn="${CSS.escape(focusFn)}"]`) as HTMLElement | null)?.focus();
    else if (newWeapon) {
      const on = this.list.querySelector<HTMLElement>('[aria-current="true"]');
      if (on && (on.offsetTop < this.list.scrollTop || on.offsetTop + on.offsetHeight > this.list.scrollTop + this.list.clientHeight)) this.list.scrollTop = on.offsetTop - 6;
    }
  }

  /** The ships' list: each group's heading, then its ships (the one flown marked) */
  private drawShips(ships: readonly { id: string; name: string; group: string }[], flown: string): void {
    const groups = shipGroups(ships, flown), all = groups.flatMap((g) => g.rows), tabRow = all.find((r) => r.on) ?? all[0];
    this.list.innerHTML = groups.map((g) => `<div class="gr-group">${esc(g.group)}</div>` + g.rows.map((r) =>
      `<button class="gr-row gr-ship" role="listitem" data-ship="${esc(r.id)}" aria-current="${r.on}" tabindex="${r === tabRow ? 0 : -1}"`
      + ` aria-label="${esc(`${r.name}, ${g.group}${r.on ? ', flying now' : ''}`)}">`
      + `<span class="tx"><span class="l1"><b>${esc(r.name)}</b></span>`
      + `<span class="l2">${esc(r.id)}${r.on ? ' · <span style="color:#fde68a">flying</span>' : ''}</span></span></button>`).join('')).join('');
  }

  private choose(fn: string): void {
    const st = rangeState();
    // (Flying a library ship, any weapon on offer goes back to the cheat ship: the one it last carried too)
    if (!st.in || (fn === st.weapon && !st.ship) || !st.options.includes(fn)) return;
    this.h.send({ type: 'gunRangeWeapon', model: fn });
    this.h.sound('ui_click', 0.5);
  }

  /** Fly a library ship as built (only one the server sent: it sends them to admins alone, and refuses anyone else) */
  private chooseShip(id: string): void {
    const st = rangeState();
    if (!st.in || id === st.ship || !st.ships.some((s) => s.id === id)) return;
    this.h.send({ type: 'gunRangeShip', ship: id });
    this.h.sound('ui_click', 0.5);
  }

  /** Turn one modifier on the weapon flown (the server builds the ship again with the ones left on) */
  private chooseMod(effect: string): void {
    const st = rangeState();
    if (!st.in || st.ship || !rangeGunModded(this.h.catalog, st.weapon)) return;
    const mods = toggleMod(st.modOptions, st.mods, effect);
    if (!mods) return;
    this.h.send({ type: 'gunRangeWeapon', model: st.weapon, mods });
    this.h.sound('ui_click', 0.5);
  }

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const role = t.closest<HTMLElement>('[data-role]')?.dataset.role;
    if (role) { this.role = role; this.drawn = ''; this.h.sound('ui_click', 0.3); this.drawPicker(); return; }
    const tab = t.closest<HTMLElement>('[data-tab]')?.dataset.tab;
    if (tab) { this.tab = tab === 'ships' ? 'ships' : 'weapons'; this.drawn = ''; this.h.sound('ui_click', 0.3); this.drawPicker(); return; }
    const ship = t.closest<HTMLElement>('[data-ship]')?.dataset.ship;
    if (ship) this.chooseShip(ship);
    const fn = t.closest<HTMLElement>('[data-fn]')?.dataset.fn;
    if (fn) this.choose(fn);
    const mod = t.closest<HTMLElement>('[data-mod]')?.dataset.mod;
    if (mod) this.chooseMod(mod);
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

/**
 * The prompt at a door (html): the exit says the station it goes back to, a door to another room that room's name
 * (`name`: the station's or the room's; none known, the prompt goes without)
 */
export function doorHint(key: string, to: string, name: string): string {
  const k = `Press <kbd>${esc(key)}</kbd>`;
  if (to === RANGE_EXIT) return `${k} to leave the range${name ? ` · back to <b>${esc(name)}</b>` : ''}`;
  return `${k} to go through${name ? ` · <b>${esc(name)}</b>` : ''}`;
}

function el(tag: string, cls: string): HTMLDivElement {
  const e = document.createElement(tag) as HTMLDivElement;
  e.className = cls;
  return e;
}
