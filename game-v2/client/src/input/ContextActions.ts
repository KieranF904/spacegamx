/**
 * The right-click menu in flight. A quick right-click (contextClick.ts: let
 * go within TAP_MS, barely moved) opens a menu of what can be done with
 * whatever's under the cursor; nothing happens until an option is chosen.
 * Holding the button is the mining laser and the right-hand guns, as ever.
 *   station     dock (H, or the autopilot flies there and docks) · fly to
 *   gate        travel through (X, asking first as X does for a system that
 *               outclasses you; or fly there and take it) · fly to
 *   rift        fly into it (it takes you) · fly to its edge
 *   planet/moon land (X, or fly there and go down) · fly to
 *   cave mouth,
 *   way in      enter (X, or fly there and go in) · fly to
 *   person      hail (X, or fly over and hail them) · fly to
 *   pilot       fly to (following them) · target · inspect · trade · invite
 *   hostile,
 *   boss        target · approach · mark for attack (a ping)
 *   derelict    target · approach
 *   civilian    fly to · target
 *   asteroid    approach to mine (then hold RMB)
 *   loot pod,
 *   your wreck  fly over it (the tractor pulls it in)
 *   open space  fly here · jump here (a drive fitted: why not, if it can't)
 *               · mark here (a ping)
 * Several things under the cursor: one section each. Every action is the
 * control the pilot has (the dock key, the interact key, the jump drive's
 * input, the target and ping messages), so the server's rules decide as they
 * always do.
 *
 * Any flight key, Esc or a left click calls a flight off; the menu's own
 * "Stop" does too.
 */

import { EntityType, planetPosition, moonOffset, pocketsFrom, pocketAt, stationInteractRadius, type StarSystemData, type PersonView, type PingKind } from '@space-game/common';
import type { GameState, InterpolatedEntity } from '../state/GameState';
import type { Autopilot, AutoDest } from '../ships/Autopilot';
import { ContextActionUI, type ScreenCircle } from '../ui/ContextActionUI';
import { ContextMenuUI, type MenuSection } from '../ui/ContextMenuUI';
import { shipKind } from '../ui/shipReadout';
import miningTable from '../../../data/mining.json';
import {
  RightClick, pickTargets, targetOptions, openSpaceOptions, orderStep, jumpStep, wrapAngle, km, MENU_LEAVE_PX,
  type ContextTarget, type ContextKind, type TargetFacts, type MenuOption, type DriveFacts,
} from './contextClick';

type JumpPhase = 'ready' | 'charging' | 'burn' | 'cooldown';

export interface ContextHost {
  state: GameState;
  systems: StarSystemData[];
  system(): StarSystemData | undefined;
  /** The cursor, screen px */
  cursor(): { x: number; y: number };
  screenToWorld(x: number, y: number): { x: number; y: number };
  worldToScreen(x: number, y: number): { x: number; y: number };
  zoom(): number;
  shipRadius(id: number): number;
  /** People out here (not at a station) */
  people(): PersonView[];
  /** Their talking range (People.ts TALK_RANGE) */
  talkRange: number;
  /** Flying, with nothing over the world (no window, map, menu or hangar) */
  enabled(): boolean;
  autopilot: Autopilot;
  flyTo(dest: AutoDest, note: string): void;
  /** The dock key; the station whose docking ring we're in */
  dock(): void;
  stationInRange(): string | null;
  /** The interact key (X), with its own checks */
  interact(): void;
  /** What X would take you down to from here (Game.planetBelow) */
  planetBelow(): string | null;
  /** Why a system's barred to you yet (a licence), or null */
  locked(system: string): { name: string; hint: string } | null;
  jumpPhase(): JumpPhase;
  jumpReach(): number;
  jumpMinRange: number;
  /** Seconds left on the drive's cooldown */
  jumpCool(): number;
  /** What's wrong with where the jump drops you (ShipClient.jumpDanger), while it charges */
  jumpDanger(): string | null;
  /** The locked target (TargetUI), and setting it (0: none) */
  targetId(): number;
  setTarget(id: number): void;
  /** Pin the info panel on a pilot */
  inspect(id: number): void;
  partyMate(id: number): boolean;
  invite(id: number): void;
  trade(id: number): void;
  ping(x: number, y: number, kind: PingKind, target?: number): void;
  /** Your wreck, if it lies in this system */
  wreck(): { x: number; y: number } | null;
  message(text: string, color?: string): void;
  sound(id: string): void;
}

/** Something right-clickable, and how to do what it offers */
interface Target extends ContextTarget {
  /** Its section's kind word ("STATION") and accent */
  label: string;
  color: string;
  /** Distance is to its edge: this far in from its centre */
  edge: number;
  /** An entity's id (ships, rocks, pods) */
  eid?: number;
  /** Where it is now (null: it's gone); places that don't move have none */
  pos?(): { x: number; y: number } | null;
  /** "Fly to" stops this far from its centre (on our side of it) */
  stand: number;
  /** The main action, and what the autopilot will do there ("will dock") */
  note: string;
  /** Barred (a licence): why */
  lock?: string;
  siege?: boolean;
  /** The main action can be done from here, now */
  inRange(): boolean;
  act(): void;
  /** Where the autopilot goes for the main action */
  dest(): AutoDest;
  /** The autopilot does the main action itself on arrival (docking, going down to a planet, a rift taking you) */
  selfActing: boolean;
  /** A point destination that moves (a moon): where it is now */
  track?(): { x: number; y: number };
}

/** Gates: as the autopilot's own (route.ts), inside the server's 300 */
const GATE_REACH = 260;
/** Cursor slack round things, screen px */
const SLACK_PX = 14;
/** The menu's thing drifting this far across the screen (px: zooming, flying past) closes it */
const DRIFT_PX = 260;

const ROCK_NAMES: Record<string, string> = {
  asteroid_metal: 'Metal asteroid', asteroid_ice: 'Ice asteroid', asteroid_fuel: 'Volatile asteroid',
  asteroid_crystal: 'Crystal asteroid', asteroid_mega: 'Dense asteroid', comet: 'Comet',
};
const rockName = (e: InterpolatedEntity) => {
  const t = e.composition?.type;
  return (t && ((miningTable.types as Record<string, { name?: string }>)[t]?.name ?? ROCK_NAMES[t])) || 'Asteroid';
};

const PLACE: Partial<Record<ContextKind, { label: string; color: string }>> = {
  station: { label: 'Station', color: '#f0b54a' },
  gate: { label: 'Gate', color: '#7dd3fc' },
  rift: { label: 'Rift', color: '#c084fc' },
  cave: { label: 'Cave', color: '#a3e635' },
  pocket: { label: 'Way in', color: '#fb923c' },
  surface: { label: 'Planet', color: '#4dd0e1' },
  planet: { label: 'Planet', color: '#64748b' },
  person: { label: 'Contact', color: '#fde68a' },
};

/** The autopilot sent by the menu: to a target (null: a point in open space). `act`: do the main action on arrival */
interface AutoOrder { target: Target | null; dest: AutoDest; arrived: boolean; act: boolean; track?: () => { x: number; y: number } | null; arrive?: string }
interface JumpOrder { x: number; y: number; ticks: number; asked: number; charged: boolean }
/** The menu, while it's open: where it was opened, and what's in it */
interface Menu { at: { x: number; y: number }; world: { x: number; y: number }; targets: Target[]; anchor: { x: number; y: number }; refs: (Target | 'space' | 'order')[] }

export class ContextActions {
  private click = new RightClick();
  private ui = new ContextActionUI();
  private menuUI = new ContextMenuUI();
  private menu: Menu | null = null;
  private auto: AutoOrder | null = null;
  private jumpOrder: JumpOrder | null = null;
  /** A left press that closed the menu: no fire until it's let go */
  private swallowLeft = false;

  constructor(private host: ContextHost) {
    this.menuUI.onPick = (o, s) => this.pick(o, s);
    this.menuUI.onClose = () => { this.menu = null; this.ui.focus(null); };
  }

  /** The canvas: a click on it is ours to judge (it may close the menu, or be the guns) */
  attach(canvas: HTMLElement): void {
    this.menuUI.ignoreOutside = canvas;
  }

  /** A menu order is under way */
  get active(): boolean {
    return this.auto !== null || this.jumpOrder !== null;
  }

  /** The menu's open */
  get menuOpen(): boolean {
    return this.menu !== null;
  }

  /** A mouse button on the canvas (and its release anywhere; screen px; ms, when it happened: a slow frame doesn't make a click a hold) */
  mouse(button: number, down: boolean, x: number, y: number, t = performance.now()): void {
    if (button === 0) {
      if (down && this.menu) { this.closeMenu(); this.swallowLeft = true; }
      if (!down) this.swallowLeft = false;
      return;
    }
    if (button !== 2) return;
    if (down) {
      // (Another right-click: this menu's done; a tap opens the next where it lands)
      this.closeMenu();
      this.click.down(t, x, y);
      return;
    }
    const at = this.click.up(t, x, y);
    if (at && this.host.enabled()) this.openMenu(at.x, at.y);
  }

  /** The right fire held back this tick (a press still inside the tap window: it may be a click) */
  withholdingFire(t = performance.now()): boolean {
    return this.click.withholding(t) || this.menu !== null;
  }

  /** The left fire held back (the press that closed the menu) */
  withholdingLeft(): boolean {
    return this.swallowLeft || this.menu !== null;
  }

  /** Focus lost: the press is forgotten (no click comes of it), and the menu closes */
  resetPress(): void {
    this.click.reset();
    this.swallowLeft = false;
    this.closeMenu();
  }

  closeMenu(): void {
    if (!this.menu) return;
    this.menu = null;
    this.menuUI.close();
    this.ui.focus(null);
  }

  /** Call off whatever's under way (true if something was). `reason`: said, if anything was going */
  cancel(reason?: string): boolean {
    const had = this.active;
    if (this.auto) {
      this.auto = null;
      if (this.host.autopilot.active) this.host.autopilot.cancel(reason);
    } else if (this.host.autopilot.active && reason) {
      this.host.autopilot.cancel(reason);
    } else if (this.jumpOrder) {
      if (reason) this.host.message(reason, '#9fd8ff');
    }
    this.jumpOrder = null;
    return had;
  }

  /** The autopilot got there (Game's arrived hook) */
  arrived(): void {
    if (this.auto) this.auto.arrived = true;
  }

  /** Each frame: the menu, the order's progress, the marks */
  update(): void {
    const c = this.host.cursor();
    this.click.move(c.x, c.y);
    const targets = this.targets();
    // (The order goes on under the map, as the autopilot does)
    this.stepAuto(targets);
    if (!this.host.enabled()) {
      this.closeMenu();
      this.ui.hideAll();
      return;
    }
    this.stepMenu(c);
    this.drawOrder();
    this.drawJump();
  }

  /**
   * Each input tick, while a menu jump is on: where to point and how far (the
   * drive's input), and whether to hold the drive on. Null: no jump order
   * (the pilot's own controls).
   */
  flight(): { angle: number; dist: number; jump: boolean } | null {
    const o = this.jumpOrder;
    if (!o) return null;
    const state = this.host.state;
    const me = state.entities.get(state.playerId);
    if (!me) { this.jumpOrder = null; return null; }
    const angle = Math.atan2(o.y - me.y, o.x - me.x);
    const reach = this.host.jumpReach();
    const dist = Math.min(Math.hypot(o.x - me.x, o.y - me.y), reach || Infinity);
    const s = jumpStep({ phase: this.host.jumpPhase(), facingErr: wrapAngle(angle - me.angle), angVel: me.angVel ?? 0, ticks: o.ticks++, asked: o.asked, charged: o.charged });
    if (s.state === 'charging') o.charged = true;
    if (o.asked >= 0) o.asked++;
    else if (s.jump) o.asked = 0;
    if (s.state === 'fired') { this.jumpOrder = null; return null; }
    if (s.state === 'interrupted' || s.state === 'stuck') {
      this.jumpOrder = null;
      this.host.message(s.state === 'stuck' ? "Jump: couldn't line up on the mark" : 'Jump interrupted', '#f2d24b');
      return null;
    }
    return { angle, dist, jump: s.jump };
  }

  /** Where the jump mark is (the map's reticle and the gauge's aim follow it) */
  jumpMark(): { x: number; y: number } | null {
    return this.jumpOrder;
  }

  // ---------------------------------------------------------------------------
  // The menu
  // ---------------------------------------------------------------------------

  private openMenu(sx: number, sy: number): void {
    const world = this.host.screenToWorld(sx, sy);
    const slack = SLACK_PX / Math.max(1e-4, this.host.zoom());
    const targets = pickTargets(world, [...this.targets(), ...this.entityTargets(world, slack)], slack);
    const anchor = targets[0] ? this.host.worldToScreen(targets[0].x, targets[0].y) : { x: sx, y: sy };
    this.menu = { at: { x: sx, y: sy }, world, targets, anchor, refs: [] };
    const { sections, footer } = this.sections(this.menu);
    this.menuUI.open({ x: sx, y: sy }, sections, footer);
    this.host.sound('ui_click');
  }

  /** Each frame while it's open: live distances and states; closed if what it's for is gone or far off */
  private stepMenu(cursor: { x: number; y: number }): void {
    const m = this.menu;
    if (!m) return;
    if (!this.menuUI.isOpen) { this.menu = null; this.ui.focus(null); return; }
    for (const t of m.targets) {
      if (!t.pos) continue;
      const p = t.pos();
      if (!p) { this.closeMenu(); return; }
      t.x = p.x; t.y = p.y;
    }
    // (Where it was opened, as it is on screen now: zooming or flying on moves it)
    const lead = m.targets[0] ?? null;
    const now = lead ? this.host.worldToScreen(lead.x, lead.y) : this.host.worldToScreen(m.world.x, m.world.y);
    const was = lead ? m.anchor : m.at;
    if (Math.hypot(now.x - was.x, now.y - was.y) > DRIFT_PX || this.menuUI.distanceFrom(cursor) > MENU_LEAVE_PX) { this.closeMenu(); return; }
    const { sections, footer } = this.sections(m);
    this.menuUI.refresh(sections, footer);
    const s = m.refs[this.menuUI.selectedSection];
    if (s && s !== 'order') {
      if (s === 'space') { const p = this.host.worldToScreen(m.world.x, m.world.y); this.ui.focus({ x: p.x, y: p.y, r: 12 }, '#7dd3fc'); }
      else this.ui.focus(this.circle(s), s.color);
    } else this.ui.focus(null);
  }

  private sections(m: Menu): { sections: MenuSection[]; footer: string } {
    const me = this.host.state.entities.get(this.host.state.playerId);
    const from = (x: number, y: number, edge = 0) => (me ? Math.max(0, Math.hypot(x - me.renderX, y - me.renderY) - edge) : 0);
    const sections: MenuSection[] = [];
    m.refs = [];
    for (const t of m.targets) {
      const facts: TargetFacts = {
        kind: t.kind, dist: from(t.x, t.y, t.edge), inRange: t.inRange(), lock: t.lock, siege: t.siege,
        targeted: t.eid !== undefined && this.host.targetId() === t.eid, partyMate: t.eid !== undefined && this.host.partyMate(t.eid),
      };
      sections.push({ title: t.name, kind: t.label, dist: me ? km(facts.dist) : '', color: t.color, options: targetOptions(facts) });
      m.refs.push(t);
    }
    if (!m.targets.length) {
      const dist = from(m.world.x, m.world.y);
      const reach = this.host.jumpReach();
      const drive: DriveFacts | null = reach > 0 ? { phase: this.host.jumpPhase(), reach, minRange: this.host.jumpMinRange, cool: this.host.jumpCool() } : null;
      sections.push({ title: 'Open space', kind: '', dist: me ? km(dist) : '', color: '#7dd3fc', options: openSpaceOptions(dist, drive) });
      m.refs.push('space');
    }
    // Something under way: it can be stopped from here too
    if (this.active || this.host.autopilot.active) {
      const what = this.jumpOrder ? 'Cancel jump' : 'Stop autopilot';
      sections.push({ title: this.jumpOrder ? 'Jump' : `Autopilot → ${this.host.autopilot.destination?.name ?? ''}`, kind: '', dist: '', color: '#86efac', options: [{ id: 'stop', icon: 'stop', label: what, hint: 'Esc' }] });
      m.refs.push('order');
    }
    return { sections, footer: '↑↓ Enter · 1–9 · Esc to close' };
  }

  /** An option was chosen */
  private pick(o: MenuOption, section: number): void {
    const m = this.menu;
    this.menu = null;
    this.ui.focus(null);
    if (!m) return;
    const ref = m.refs[section];
    if (!ref) return;
    if (ref === 'order' || o.id === 'stop') { this.cancel(this.jumpOrder ? 'Jump cancelled' : 'Autopilot off'); return; }
    if (ref === 'space') return this.space(o.id, m.world);
    const t = ref;
    switch (o.id) {
      case 'dock': case 'travel': case 'enter': case 'land': case 'talk': case 'flyInto':
        return this.actOn(t);
      case 'flyTo': return this.flyNear(t, t.stand, '');
      case 'approach': return this.flyNear(t, t.stand, 'Hold RMB to mine');
      case 'collect': case 'recover': return this.flyNear(t, 0, '');
      case 'target': if (t.eid !== undefined) this.host.setTarget(t.eid); return;
      case 'untarget': this.host.setTarget(0); return;
      case 'inspect': if (t.eid !== undefined) this.host.inspect(t.eid); return;
      case 'trade': if (t.eid !== undefined) { this.host.trade(t.eid); this.host.message(`Trade request sent to ${t.name}`, '#7dd3fc'); } return;
      case 'invite': if (t.eid !== undefined) { this.host.invite(t.eid); this.host.message(`Party invite sent to ${t.name}`, '#7dd3fc'); } return;
      case 'mark': this.host.ping(t.x, t.y, 'attack', t.eid); return;
    }
  }

  private space(id: MenuOption['id'], at: { x: number; y: number }): void {
    const state = this.host.state;
    switch (id) {
      case 'flyHere': {
        const dest: AutoDest = { kind: 'point', system: state.systemId, x: at.x, y: at.y, name: 'the mark' };
        this.host.flyTo(dest, '');
        if (this.host.autopilot.active) this.auto = { target: null, dest, arrived: false, act: false };
        return;
      }
      case 'jumpHere': {
        // (Somewhere new: a flight under way is off)
        if (this.auto || this.host.autopilot.active) this.cancel();
        const me = state.entities.get(state.playerId);
        const d = me ? Math.hypot(at.x - me.renderX, at.y - me.renderY) : 0;
        this.jumpOrder = { x: at.x, y: at.y, ticks: 0, asked: -1, charged: false };
        this.host.message(`Jump: lining up → ${km(d)} · Esc or any flight key to cancel`, '#7dd3fc');
        return;
      }
      case 'mark': this.host.ping(at.x, at.y, 'here'); return;
    }
  }

  /** The main action: here and now, or the autopilot flies there and it's done on arrival */
  private actOn(t: Target): void {
    if (t.lock) { this.host.message(t.lock, '#f2d24b'); return; }
    if (t.inRange()) { t.act(); return; }
    const dest = t.dest();
    this.host.flyTo(dest, t.note);
    if (!this.host.autopilot.active) return;
    this.auto = { target: t, dest, arrived: false, act: true };
  }

  /** Fly to `stand` off its centre, on our side, following it if it moves; nothing done there */
  private flyNear(t: Target, stand: number, arrive: string): void {
    const at = () => {
      const p = t.pos ? t.pos() : { x: t.x, y: t.y };
      return p ? this.offset(p.x, p.y, stand) : null;
    };
    const p = at();
    if (!p) return;
    const dest: AutoDest = { kind: 'point', system: this.host.state.systemId, x: p.x, y: p.y, name: t.name };
    this.host.flyTo(dest, '');
    if (this.host.autopilot.active) this.auto = { target: t, dest, arrived: false, act: false, track: t.pos ? at : undefined, arrive };
  }

  /** The autopilot's order: keep a moving target's point on it, and act when it's due */
  private stepAuto(targets: Target[]): void {
    const o = this.auto;
    if (!o) return;
    const ap = this.host.autopilot;
    // (Still ours: the autopilot could have been sent somewhere else since)
    const ours = ap.active && ap.destination === o.dest;
    const t = o.target;
    if (!t) { if (!ours) this.auto = null; return; }
    // (The same thing this frame: moons and planets move)
    const now = targets.find((x) => x.key === t.key) ?? t;
    o.target = now;
    if (now.pos) {
      const p = now.pos();
      if (!p) {
        this.auto = null;
        if (ours) ap.cancel(now.kind === 'loot' || now.kind === 'wreck' ? `${now.name}: collected` : `${now.name}: gone`);
        return;
      }
      now.x = p.x; now.y = p.y;
    }
    if (!o.act) {
      if (o.track && o.dest.kind === 'point' && ours) { const p = o.track(); if (p) { o.dest.x = p.x; o.dest.y = p.y; } }
      if (!ours) {
        if (o.arrived && o.arrive) this.host.message(o.arrive, '#86efac');
        this.auto = null;
      }
      return;
    }
    if (now.track && o.dest.kind === 'point') { const p = now.track(); o.dest.x = p.x; o.dest.y = p.y; }
    const step = orderStep(now, { autopilot: ours, arrived: o.arrived, inRange: now.inRange() });
    if (step === 'wait') return;
    this.auto = null;
    if (step === 'act') {
      if (ours) ap.cancel();
      now.act();
    }
  }

  private drawOrder(): void {
    const o = this.auto;
    if (!o || !this.host.autopilot.active) { this.ui.target(null, ''); return; }
    const t = o.target;
    if (!t) {
      // A point in open space: a small ring there
      if (o.dest.kind === 'point') { const p = this.host.worldToScreen(o.dest.x, o.dest.y); this.ui.target({ x: p.x, y: p.y, r: 12 }, 'autopilot · Esc to cancel'); }
      return;
    }
    this.ui.target(this.circle(t), `${t.name} · ${o.act ? t.note : 'autopilot'}`);
  }

  private drawJump(): void {
    const o = this.jumpOrder;
    const me = this.host.state.entities.get(this.host.state.playerId);
    if (!o || !me) { this.ui.jump(null, null, '', '', false); return; }
    const reach = this.host.jumpReach();
    const want = Math.hypot(o.x - me.renderX, o.y - me.renderY);
    const go = Math.max(this.host.jumpMinRange, Math.min(want, reach));
    const a = Math.atan2(o.y - me.renderY, o.x - me.renderX);
    const short = want > reach + 1;
    const land = short ? this.host.worldToScreen(me.renderX + Math.cos(a) * go, me.renderY + Math.sin(a) * go) : null;
    const phase = this.host.jumpPhase();
    const charging = phase === 'charging';
    const danger = charging ? this.host.jumpDanger() : null;
    const what = charging ? 'JUMP CHARGING' : 'JUMP · LINING UP';
    const far = short ? `${km(go)} <span class="w">(max range, ${km(want)} to the mark)</span>` : km(go);
    const pill = `${what} → ${far}${danger ? ` · <span class="w">⚠ ${esc(danger)}</span>` : ''} · Esc to cancel`;
    this.ui.jump(this.host.worldToScreen(o.x, o.y), land, short ? 'jump mark (out of reach)' : `jump · ${km(go)}`, pill, !!danger);
  }

  private circle(t: Target): ScreenCircle {
    const p = this.host.worldToScreen(t.x, t.y);
    const r = t.eid !== undefined ? Math.max(t.edge, 20) : t.r;
    return { x: p.x, y: p.y, r: Math.max(16, r * this.host.zoom() + 8) };
  }

  /** A point `r` off (x, y), on our side of it */
  private offset(x: number, y: number, r: number): { x: number; y: number } {
    const me = this.host.state.entities.get(this.host.state.playerId);
    const a = me ? Math.atan2(me.renderY - y, me.renderX - x) : 0;
    return { x: x + Math.cos(a) * r, y: y + Math.sin(a) * r };
  }

  // ---------------------------------------------------------------------------
  // What's there
  // ---------------------------------------------------------------------------

  /** Ships, rocks, pods and your wreck near a point (only looked for on a click: there are many) */
  private entityTargets(at: { x: number; y: number }, slack: number): Target[] {
    const h = this.host, state = h.state;
    const out: Target[] = [];
    const live = (id: number) => () => { const e = state.entities.get(id); return e ? { x: e.renderX, y: e.renderY } : null; };
    const none = () => false, nop = () => {};
    const here = (): AutoDest => ({ kind: 'point', system: state.systemId, x: at.x, y: at.y, name: '' });
    for (const e of state.entities.values()) {
      if (e.id === state.playerId) continue;
      const ship = e.type === EntityType.ShipBody || e.type === EntityType.Player;
      const rock = e.type === EntityType.Asteroid;
      const pod = e.type === EntityType.DroppedItem;
      if (!ship && !rock && !pod) continue;
      const size = ship ? h.shipRadius(e.id) : rock ? e.data?.[0] ?? 30 : 20;
      const r = size + (ship ? 30 : rock ? 12 : 40);
      const dx = e.renderX - at.x, dy = e.renderY - at.y, reach = r + slack;
      // (A box first: most things are nowhere near)
      if (Math.abs(dx) > reach || Math.abs(dy) > reach || Math.hypot(dx, dy) > reach) continue;
      let kind: ContextKind, label: string, color: string, name: string;
      if (rock) { kind = 'rock'; label = e.composition?.stage ? 'Outlier' : 'Asteroid'; color = '#4dd0e1'; name = rockName(e); }
      else if (pod) { kind = 'loot'; label = 'Loot'; color = '#86efac'; name = 'Loot pod'; }
      else {
        const k = shipKind(e);
        const f = e.data?.[0];
        kind = e.type === EntityType.Player ? 'pilot' : f === 3 ? (e.data?.[4] === 2 ? 'boss' : 'hostile') : f === 2 ? 'civilian' : f === 1 ? 'derelict' : 'ship';
        label = kind === 'pilot' && h.partyMate(e.id) ? 'Party' : k.label.toLowerCase();
        color = kind === 'pilot' && h.partyMate(e.id) ? '#4ade80' : k.color;
        name = e.name ?? (kind === 'pilot' ? 'Pilot' : 'Unknown ship');
      }
      out.push({
        kind, key: `en:${e.id}`, eid: e.id, name, label, color, x: e.renderX, y: e.renderY, r, edge: ship ? 0 : size,
        pos: live(e.id), stand: ship ? size + 350 : rock ? size + 220 : 0,
        note: '', selfActing: false, inRange: none, act: nop, dest: here,
      });
    }
    const w = h.wreck();
    if (w && Math.hypot(w.x - at.x, w.y - at.y) <= 120 + slack) {
      out.push({
        kind: 'wreck', key: 'wreck', name: 'Your wreck', label: 'Wreck', color: '#fbbf24', x: w.x, y: w.y, r: 120, edge: 0,
        pos: () => h.wreck(), stand: 0, note: '', selfActing: false, inRange: none, act: nop, dest: here,
      });
    }
    return out;
  }

  /** The places here (and people to talk to), where they are now */
  private targets(): Target[] {
    const h = this.host, state = h.state;
    const here = state.systemId, sys = h.system();
    const me = state.entities.get(state.playerId);
    const out: Target[] = [];
    const near = (x: number, y: number, r: number) => !!me && Math.hypot(x - me.x, y - me.y) < r;
    const nameOf = (id: string) => h.systems.find((s) => s.id === id)?.name ?? id;
    const offset = (x: number, y: number, r: number) => this.offset(x, y, r);
    const place = (kind: ContextKind) => PLACE[kind]!;

    for (const e of state.entities.values()) {
      if (e.type !== EntityType.Station) continue;
      const name = e.name ?? 'Station';
      const r = stationInteractRadius(e.data?.[8] ?? 0, e.data?.[9] ?? 0);
      const id = e.id;
      out.push({
        // (Its docking ring: just inside its outer structure)
        kind: 'station', key: `st:${id}`, name, ...place('station'), x: e.renderX, y: e.renderY, r, edge: r, stand: r + 300,
        pos: () => { const s = state.entities.get(id); return s ? { x: s.renderX, y: s.renderY } : null; },
        note: 'will dock', selfActing: true,
        inRange: () => h.stationInRange() === name, act: () => h.dock(),
        dest: () => ({ kind: 'station', system: here, name }),
      });
    }
    for (const p of h.people()) {
      if (p.x === undefined || p.y === undefined) continue;
      const px = p.x, py = p.y;
      out.push({
        kind: 'person', key: `pp:${p.id}`, name: p.name, ...place('person'), x: px, y: py, r: 220, edge: 0, stand: 450,
        note: 'will hail them', selfActing: false,
        inRange: () => near(px, py, h.talkRange), act: () => h.interact(),
        dest: () => ({ kind: 'point', system: here, ...offset(px, py, 450), name: p.name }),
      });
    }
    if (!sys) return out;
    for (const g of sys.portals ?? []) {
      const to = nameOf(g.targetSystem), lock = h.locked(g.targetSystem);
      const gx = g.position.x, gy = g.position.y;
      out.push({
        kind: 'gate', key: `gt:${g.id}`, name: `Gate to ${to}`, ...place('gate'), x: gx, y: gy, r: 300, edge: 0, stand: 500,
        note: 'will take the gate', selfActing: false,
        lock: lock ? `${to}: ${lock.hint || `needs ${lock.name}`}` : undefined,
        inRange: () => near(gx, gy, GATE_REACH), act: () => h.interact(),
        dest: () => ({ kind: 'point', system: here, x: gx, y: gy, name: `gate to ${to}` }),
      });
    }
    for (const r of sys.rifts ?? []) {
      const name = r.label ?? `Rift to ${nameOf(r.destination.system)}`;
      out.push({
        kind: 'rift', key: `rf:${r.id}`, name, ...place('rift'), x: r.position.x, y: r.position.y, r: 600, edge: 200, stand: 900,
        note: 'into the rift', selfActing: true,
        inRange: () => false, act: () => {},
        dest: () => ({ kind: 'point', system: here, x: r.position.x, y: r.position.y, name }),
      });
    }
    // A pocket's way in (a boss's nest): X close by, or the autopilot's route in (route.ts presses X there)
    for (const s of pocketsFrom(h.systems, here)) {
      const e = s.pocket!.entrance;
      out.push({
        kind: 'pocket', key: `pk:${s.id}`, name: e.name, ...place('pocket'), x: e.x, y: e.y, r: e.radius, edge: e.radius, stand: e.radius + 300,
        note: 'will go in', selfActing: true,
        inRange: () => !!me && pocketAt(h.systems, here, me.renderX, me.renderY)?.id === s.id, act: () => h.interact(),
        dest: () => ({ kind: 'system', system: s.id, name: e.name }),
      });
    }
    const tick = state.getRawServerTick();
    const below = () => h.planetBelow();
    const surfaced = new Set<string>();
    for (const s of h.systems) {
      const sd = s.surface;
      if (!sd) continue;
      // A cave's mouth on this surface (X goes in)
      if (sd.under && sd.under.surface === here) {
        const u = sd.under, name = u.name ?? s.name;
        out.push({
          kind: 'cave', key: `cv:${s.id}`, name, ...place('cave'), x: u.x, y: u.y, r: u.radius, edge: u.radius, stand: u.radius + 300,
          note: 'will go in', selfActing: false,
          inRange: () => below() === name, act: () => h.interact(),
          dest: () => ({ kind: 'point', system: here, x: u.x, y: u.y, name }),
        });
        continue;
      }
      // A planet or moon below which there's a surface (as the server's: no arenas, no caves from orbit)
      if (sd.of !== here || sd.arena || sd.under) continue;
      const planet = sys.planets?.find((p) => p.id === sd.planet);
      if (!planet) continue;
      const moon = sd.moon !== undefined ? planet.moons?.[sd.moon] : undefined;
      if (sd.moon !== undefined && !moon) continue;
      surfaced.add(`${planet.id}:${sd.moon ?? -1}`);
      const pos = () => {
        const p = planetPosition(planet, state.getRawServerTick());
        const o = sd.moon !== undefined ? moonOffset(planet, sd.moon, state.getRawServerTick()) : { x: 0, y: 0 };
        return { x: p.x + o.x, y: p.y + o.y };
      };
      const at = (() => { const p = planetPosition(planet, tick), o = sd.moon !== undefined ? moonOffset(planet, sd.moon, tick) : { x: 0, y: 0 }; return { x: p.x + o.x, y: p.y + o.y }; })();
      const radius = moon ? moon.radius : planet.radius;
      // (As Game.planetBelow names it)
      const name = moon ? moon.name ?? 'the moon' : planet.name;
      // Siege moons aren't on any route (each party gets its own): fly beside it, then X
      const siege = !!sd.bastion;
      out.push({
        kind: 'surface', key: `sf:${s.id}`, name, ...place('surface'), label: moon ? 'Moon' : 'Planet', x: at.x, y: at.y, r: radius, edge: radius, stand: radius + 500,
        pos, siege, note: 'will land', selfActing: !siege,
        inRange: () => !!below()?.startsWith(name), act: () => h.interact(),
        dest: () => (siege ? { kind: 'point', system: here, ...offset(at.x, at.y, radius + 500), name } : { kind: 'system', system: s.id, name }),
        track: siege ? () => { const p = pos(); return offset(p.x, p.y, radius + 500); } : undefined,
      });
    }
    // Planets and moons with nowhere to go down: somewhere to fly to
    const none = () => false, nop = () => {};
    for (const planet of sys.planets ?? []) {
      const bodies: { moon?: number; radius: number; name: string }[] = [{ radius: planet.radius, name: planet.name }];
      (planet.moons ?? []).forEach((m, i) => bodies.push({ moon: i, radius: m.radius, name: m.name ?? `Moon of ${planet.name}` }));
      for (const b of bodies) {
        if (surfaced.has(`${planet.id}:${b.moon ?? -1}`)) continue;
        const pos = () => {
          const p = planetPosition(planet, state.getRawServerTick());
          const o = b.moon !== undefined ? moonOffset(planet, b.moon, state.getRawServerTick()) : { x: 0, y: 0 };
          return { x: p.x + o.x, y: p.y + o.y };
        };
        const p = pos();
        out.push({
          kind: 'planet', key: `pl:${planet.id}:${b.moon ?? -1}`, name: b.name, ...place('planet'), label: b.moon !== undefined ? 'Moon' : 'Planet',
          x: p.x, y: p.y, r: b.radius, edge: b.radius, stand: b.radius + 500, pos,
          note: '', selfActing: false, inRange: none, act: nop, dest: () => ({ kind: 'point', system: here, ...offset(p.x, p.y, b.radius + 500), name: b.name }),
        });
      }
    }
    return out;
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
