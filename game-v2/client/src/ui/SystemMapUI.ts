/**
 * Map (M key): a full-screen, zoomable, pannable map with two views.
 *
 *   Galaxy  every system at its galaxy position, sector regions, jump-gate
 *           links and rift routes, a detail card on hover. Click a system and
 *           the autopilot takes you there, gate by gate.
 *   System  the current system live: central body and gravity horizon, belt,
 *           stations with their orbits, gates, rifts, other ships (past your
 *           view too: the system's far ships and other pilots, FarShips) and
 *           you. Click a station, gate or wreck to fly there; right-click
 *           anywhere to fly to that point (the map's own: in flight a plain
 *           right-click fires, and with the menu modifier opens the action
 *           menu, ContextActions.ts). Ctrl-click warps (dev tool). Danger
 *           bands, belts, hostiles, your wreck and the jump drive's reach.
 *
 * You keep flying in the system view: the flight keys work as ever, the ship
 * faces the map cursor (Game reads aimWorld), holding left on empty space
 * fires, and the jump drive aims at the map cursor (locking on to whatever's
 * under it: jumpLock). So panning there is right- or middle-drag.
 *
 * Scroll zooms towards the cursor, drag pans, Esc or M closes.
 * Galaxy layout comes from the bundled systems.json; the system view mixes
 * that with live entities (stations orbit, ships move).
 */

import { EntityType, PlanetData, CometData, StructureData, StarSystemData, planetPosition, moonOffset, cometPosition, threatLevel, solarRingRadius, type ShipDerived, type SystemRegionData, type SystemZoneData, type HazardRules } from '@space-game/common';
import { lodestonePosition, lodestoneLabel, lodestoneStop, lodestoneSize, lodestoneLive, lodestoneFieldRadius, lodestoneChargeOf, lodestoneBoostOf, jumpTuning, type LodestoneData, type ShipTuning } from '@space-game/common';
import { nestPosition, pocketsFrom, type NestData } from '@space-game/common';
import factionsFile from '../../../data/factions.json';
import shipTuning from '../../../data/ships/tuning.json';
import { THREAT_COLOR, threatTag } from './threat';
import { drawStructure } from './mapStructures';
import { hazardRows } from './hazardSums';
import type { GameState } from '../state/GameState';
import { etaText, type AutoDest, type RouteView } from '../ships/Autopilot';
import type { PartyMemberView } from '@space-game/common';
import { huntedBoss } from '@space-game/common';
import { settings } from '../settings/Settings';
import { boundKeyName } from '../input/keybindings';
import systemsFile from '../../../data/systems.json';
import bossData from '../../../data/bosses.json';
import hazardData from '../../../data/hazards.json';

const HAZARD_RULES = hazardData as unknown as HazardRules;
const JUMP = jumpTuning(shipTuning as unknown as ShipTuning);
/** Lodestones and their fields */
const LODE_COLOR = '#a3c2cf';
/** A dead or shattered one (no field) */
const LODE_DEAD = '#7d8590';
/** Factions (nests' colours and names) */
const FACTIONS = (factionsFile as unknown as { factions: Record<string, { name: string; color: string }> }).factions;
/** Factions by index (a ghost's faction) */
const FACTION_LIST = Object.values(FACTIONS);
/** Danger bands: ring colour and word */
const REGION_STYLE: Record<SystemRegionData['danger'], { color: string; word: string }> = {
  safe: { color: '#5eead4', word: 'safe' }, contested: { color: '#fbbf24', word: 'contested' }, hostile: { color: '#f87171', word: 'hostile' },
};
/** How far round a landing point hostiles make a jump risky */
const LANDING_HOSTILE_RADIUS = 4000;

const BOSS_DEFS = (bossData as unknown as { bosses: Record<string, { name: string; system: string; level: number; lair: { x: number; y: number } }> }).bosses;
/** Where each boss lairs (one in a pocket is marked at its way in too, out in that system) */
const BOSS_LAIRS = Object.entries(BOSS_DEFS).flatMap(([id, b]) => {
  const e = (systemsFile as unknown as { systems: StarSystemData[] }).systems.find((s) => s.id === b.system)?.pocket?.entrance;
  return [{ id, ...b }, ...(e ? [{ id, ...b, system: e.system, lair: { x: e.x, y: e.y } }] : [])];
});
/** Danger 1..7: green to red */
const dangerColor = (d: number) => (d >= 6 ? '#f87171' : d >= 4 ? '#fbbf24' : d >= 2 ? '#a3e635' : '#86efac');

type View = 'galaxy' | 'system';
interface Camera { x: number; y: number; scale: number }
interface Fit { cx: number; cy: number; scale: number }

type Hit =
  | { kind: 'system'; sys: StarSystemData; sx: number; sy: number }
  | { kind: 'station'; name: string; x: number; y: number; sx: number; sy: number }
  | { kind: 'gate'; target: StarSystemData | undefined; x: number; y: number; sx: number; sy: number }
  | { kind: 'rift'; label: string; dest: StarSystemData | undefined; x: number; y: number; sx: number; sy: number }
  | { kind: 'ship'; id: number; name: string; x: number; y: number; sx: number; sy: number }
  | { kind: 'planet'; planet: PlanetData; x: number; y: number; sx: number; sy: number }
  /** A moon you can land on (a siege) */
  | { kind: 'moon'; name: string; surface: string; planet: PlanetData; radius: number; x: number; y: number; sx: number; sy: number }
  | { kind: 'wreck'; name: string; x: number; y: number; sx: number; sy: number }
  | { kind: 'freighter'; name: string; x: number; y: number; sx: number; sy: number }
  | { kind: 'comet'; comet: CometData; x: number; y: number; sx: number; sy: number }
  | { kind: 'structure'; structure: StructureData; x: number; y: number; sx: number; sy: number }
  /** A stillstone (its field charges the jump drive; a dead or shattered one's doesn't) */
  | { kind: 'lodestone'; lodestone: LodestoneData; x: number; y: number; sx: number; sy: number }
  /** A hostile nest (its packs launch from it) */
  | { kind: 'nest'; nest: NestData; x: number; y: number; sx: number; sy: number }
  /** A pocket's way in (a boss's nest: X there takes you in) */
  | { kind: 'wayin'; pocket: StarSystemData; x: number; y: number; sx: number; sy: number }
  /** A danger band's edge (or its name) */
  | { kind: 'region'; region: SystemRegionData; inner: number; sx: number; sy: number }
  | { kind: 'zone'; zone: SystemZoneData; sx: number; sy: number }
  | { kind: 'hostile'; name: string; rating: number; rank: number; calm: boolean; sx: number; sy: number }
  /** Your own wreck, kept for you a while */
  | { kind: 'beacon'; x: number; y: number; sx: number; sy: number };

/** Hits a left click acts on (elsewhere, left fires) */
const actionable = (h: Hit | null): h is Hit => !!h && h.kind !== 'region' && h.kind !== 'zone' && h.kind !== 'hostile';

/** A threat against your rating: fine up to it, risky to 1.5×, past that dangerous */
function outmatch(mine: number, theirs: number): { word: string; color: string } {
  if (!mine) return { word: '', color: '#8394ad' };
  return theirs <= mine ? { word: 'fine', color: '#86efac' } : theirs <= mine * 1.5 ? { word: 'risky', color: '#fbbf24' } : { word: 'dangerous', color: '#f87171' };
}

const PLANET_COLORS: Record<string, string> = {
  rocky: '#a39382', desert: '#d8b075', ice: '#cfe8ff', gas: '#e0b27a', lava: '#ff6a2a', ocean: '#4f8fe0', toxic: '#b6d24a',
};
const PLANET_KINDS: Record<string, string> = {
  rocky: 'Rocky world', desert: 'Desert world', ice: 'Ice world', gas: 'Gas giant', lava: 'Lava world', ocean: 'Ocean world', toxic: 'Toxic world',
};

const SECTOR_COLORS = ['#5fd4c4', '#ffb547', '#9f8cff', '#f472b6', '#7dd3fc', '#86efac'];
const HAZARD_NAMES: Record<string, string> = {
  cold: 'Cold', radiation: 'Radiation', low_visibility: 'Low visibility', darkness: 'Darkness', gravitational_anomalies: 'Gravity well',
};
const BODY_NAMES: Record<string, string> = { sun: 'Star', black_hole: 'Black hole', pulsar: 'Pulsar', binary: 'Binary star', none: 'None' };

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToHue(hex: string): number {
  const v = parseInt(hex.replace('#', ''), 16);
  const r = ((v >> 16) & 255) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

function fmtDist(u: number): string {
  return u >= 1000 ? `${(u / 1000).toFixed(u >= 10000 ? 0 : 1)}k` : `${Math.round(u)}`;
}

function escapeHtml(t: string): string {
  return t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export class SystemMapUI {
  /** Map click-to-warp (dev tool): Game sends it to the server */
  public onWarp: ((systemId: string, x?: number, y?: number) => void) | null = null;
  /** Click a place: the autopilot flies there */
  public onFlyTo: ((dest: AutoDest) => void) | null = null;
  /** Where the autopilot is heading in this system (drawn as a route line) */
  public autoTarget: (() => { x: number; y: number } | null) | null = null;
  /** The autopilot's route through this system: fly and jump stretches, a lodestone call, its ETA */
  public autoRoute: (() => RouteView | null) | null = null;
  /** Your party (other members): green on both views */
  public party: (() => PartyMemberView[]) | null = null;
  /** Your ship's rating (threats are coloured against it) */
  public myRating: (() => number) | null = null;
  /** The ship you fly as built (for the hazard sums) */
  public myShip: (() => ShipDerived | null) | null = null;
  /** A system you can't enter yet: the licence it needs and how to get it (null: open to you) */
  public locked: ((systemId: string) => { name: string; hint: string } | null) | null = null;
  /** Live pings in this system, and a ping from the map (Shift + right-click) */
  public pings: (() => { name: string; x: number; y: number }[]) | null = null;
  public onPing: ((x: number, y: number) => void) | null = null;
  /** Your wreck while it's kept for you (until: ms timestamp) */
  public wreck?: () => { system: string; x: number; y: number; until: number } | null;
  /** The jump drive: lining up (key held, latched or spooling), its phase, how far it reaches */
  public jump: (() => { aiming: boolean; phase: string; reach: number }) | null = null;
  /** Where the jump is aimed this tick (Game sets it from the aim, after any lock-on) */
  public jumpAim: { angle: number; dist: number; label: string | null } | null = null;
  /** Contributor notes: drawn over the system view (ContributorPanel), world → screen by sx/sy at scale S */
  public notesOverlay: ((ctx: CanvasRenderingContext2D, sx: (x: number) => number, sy: (y: number) => number, S: number, w: number, h: number) => void) | null = null;
  /** Placing a contributor note: the system view's mouse goes to it (world points) instead of flying and firing */
  public placeHook: { down(x: number, y: number, button: number): void; move(x: number, y: number): void; up(x: number, y: number, button: number): void } | null = null;

  private root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tooltip: HTMLDivElement;
  private titleEl: HTMLDivElement;
  private subEl: HTMLDivElement;
  private hintEl: HTMLDivElement;
  private hintKey = '';
  private tabs: Record<View, HTMLButtonElement>;
  private visible = false;

  get isOpen(): boolean {
    return this.visible;
  }

  /** Opened or closed (the server sends the far ships while it's open: mapView) */
  onVisibleChange: ((open: boolean) => void) | null = null;

  /** Zoomed back in past flight's farthest zoom with your ship on the map: hand back to flight (at this scale) */
  onZoomIntoFlight: ((scale: number) => void) | null = null;
  /** The flight camera's farthest zoom (world → screen scale): the hand-over point */
  flightMinScale = 0.04;
  /** Opened by zooming out of flight (so zooming back in returns there) */
  private fromFlight = false;
  private view: View = 'system';
  private cams: Record<View, Camera | null> = { galaxy: null, system: null };
  private camSystemId = '';
  private systems: StarSystemData[];
  private byId: Map<string, StarSystemData>;
  /** The ghosts drawn this frame (reused) */
  private ghostList: import('../state/Populations').PopGhost[] = [];
  private sectorColor = new Map<string, string>();
  private belt: { inner: number; outer: number } | null = null;
  private liveCentral: { type: string; radius?: number; hue?: number; diskHue?: number; beamHue?: number } | null = null;
  private hover: Hit | null = null;
  private hits: Hit[] = [];
  /** A press on the map: `pan` drags it; otherwise it's a click on `hit` (cancelled by moving) */
  private drag: { x: number; y: number; camX: number; camY: number; moved: boolean; button: number; pan: boolean; hit: Hit | null } | null = null;
  private mouse = { x: 0, y: 0 };
  /** Last cursor position on the page (the map's cursor is worked out from it on opening) */
  private client: { x: number; y: number } | null = null;
  /** Left held on empty space in the system view: the guns fire */
  private fireHeld = false;
  /** The system view keeps your ship where it is on screen (opening from flight, C) until you pan */
  private follow: { x: number; y: number } | null = null;
  private bgStars: [number, number, number, number][] = [];
  private rafId: number | null = null;
  private t0 = performance.now();

  constructor(container: HTMLElement, private state: GameState) {
    // Planet surfaces aren't on the galaxy map (but you can be on one)
    const all = (systemsFile as unknown as { systems: StarSystemData[] }).systems;
    this.systems = all.filter((s) => !s.surface && !s.private && !s.pocket);
    this.byId = new Map(all.map((s) => [s.id, s]));
    [...new Set(this.systems.map((s) => s.sector ?? ''))].forEach((sec, i) => this.sectorColor.set(sec, SECTOR_COLORS[i % SECTOR_COLORS.length]));
    const r = seeded(7);
    for (let i = 0; i < 420; i++) this.bgStars.push([r(), r(), 0.4 + r() * 1.3, 0.15 + r() * 0.6]);

    this.injectStyles();
    this.root = document.createElement('div');
    this.root.id = 'galaxy-map';
    this.root.style.display = 'none';
    this.root.innerHTML = `
      <div class="gm-bar">
        <div class="gm-titles"><div class="gm-title"></div><div class="gm-sub"></div></div>
        <div class="gm-tabs"><button data-view="galaxy">Galaxy</button><button data-view="system">System</button></div>
        <div class="gm-tools">
          <button data-act="out" title="Zoom out">−</button>
          <button data-act="me" title="Centre on your ship (C)">⌖</button>
          <button data-act="fit" title="Fit view">⤢</button>
          <button data-act="in" title="Zoom in">+</button>
          <button data-act="close" class="gm-close" title="Close (Esc)">✕</button>
        </div>
      </div>
      <canvas></canvas>
      <div class="gm-hint"></div>
      <div class="gm-tip"></div>`;
    // On the body, not the game's UI overlay: that layer ignores pointer events
    // and sits under the HUD
    document.body.appendChild(this.root);
    void container;
    this.canvas = this.root.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.tooltip = this.root.querySelector('.gm-tip')!;
    this.titleEl = this.root.querySelector('.gm-title')!;
    this.subEl = this.root.querySelector('.gm-sub')!;
    this.hintEl = this.root.querySelector('.gm-hint')!;
    this.tabs = {
      galaxy: this.root.querySelector('[data-view="galaxy"]')!,
      system: this.root.querySelector('[data-view="system"]')!,
    };
    this.tabs.galaxy.onclick = () => this.setView('galaxy');
    this.tabs.system.onclick = () => this.setView('system');
    this.root.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) => {
      b.onclick = () => {
        const act = b.dataset.act;
        if (act === 'close') this.hide();
        else if (act === 'fit') this.fitView();
        else if (act === 'me') this.centreOnMe();
        else this.zoomAt(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2, act === 'in' ? 1.5 : 1 / 1.5);
      };
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.touchedAt = performance.now();
      const r = this.canvas.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    this.canvas.addEventListener('mousedown', (e) => {
      this.touchedAt = performance.now();
      const sys = this.view === 'system';
      if (sys && this.placeHook && e.button !== 1) {
        const w = this.eventWorld(e);
        this.placeHook.down(w.x, w.y, e.button);
        return;
      }
      if (e.button === 2 && sys && e.shiftKey && this.onPing) {
        const r = this.canvas.getBoundingClientRect();
        const cam = this.cam();
        this.onPing((e.clientX - r.left - this.canvas.clientWidth / 2) / cam.scale + cam.x, (e.clientY - r.top - this.canvas.clientHeight / 2) / cam.scale + cam.y);
        return;
      }
      if (e.button === 1) e.preventDefault(); // (no autoscroll)
      if (e.button > 2) return;
      const cam = this.cam();
      const press = { x: e.clientX, y: e.clientY, camX: cam.x, camY: cam.y, moved: false, button: e.button };
      if (!sys) {
        // Galaxy: left drags, a left click picks a system
        if (e.button === 0) this.drag = { ...press, pan: true, hit: null };
        return;
      }
      // System view: left on a marker is a click (on release), left on empty space fires;
      // right or middle drags (a right click without dragging flies to that point)
      if (e.button === 0) {
        if (actionable(this.hover)) this.drag = { ...press, pan: false, hit: this.hover };
        else if (!e.ctrlKey) this.fireHeld = true;
        return;
      }
      this.drag = { ...press, pan: true, hit: null };
    });
    window.addEventListener('mousemove', (e) => {
      this.client = { x: e.clientX, y: e.clientY };
      if (!this.visible) return;
      this.touchedAt = performance.now();
      const r = this.canvas.getBoundingClientRect();
      this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (this.placeHook && this.view === 'system') { const w = this.eventWorld(e); this.placeHook.move(w.x, w.y); }
      if (this.drag) {
        const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
        if (Math.hypot(dx, dy) > 4) this.drag.moved = true;
        if (this.drag.moved && this.drag.pan) {
          const cam = this.cam();
          cam.x = this.drag.camX - dx / cam.scale;
          cam.y = this.drag.camY - dy / cam.scale;
          this.follow = null;
        }
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fireHeld = false;
      if (this.visible && this.placeHook && this.view === 'system' && !this.drag) { const w = this.eventWorld(e); this.placeHook.up(w.x, w.y, e.button); return; }
      if (!this.visible || !this.drag || this.drag.button !== e.button) return;
      const { moved, button, pan, hit } = this.drag;
      this.drag = null;
      if (moved) return;
      if (button === 2) { if (this.view === 'system') this.flyToPoint(e); return; }
      if (button !== 0) return;
      const target = pan ? this.hover : hit;
      if (!target) return;
      if (e.ctrlKey && this.onWarp) this.warpTo(target);
      else this.flyTo(target);
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (this.visible) this.touchedAt = performance.now();
      if (this.visible && e.code === 'Escape') { this.hide(); e.stopPropagation(); }
      else if (this.visible && e.code === 'KeyC' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) this.centreOnMe();
    }, true);
    window.addEventListener('resize', () => this.visible && this.resize());
  }

  // ============================================
  // Data intake (from Game)
  // ============================================

  setSystemInfo(info: { name: string; sector?: string; centralBody: { type: string; radius?: number; hue?: number; diskHue?: number; beamHue?: number } }): void {
    this.liveCentral = info.centralBody;
  }

  setBelt(inner: number, outer: number): void {
    this.belt = { inner, outer };
  }

  // ============================================
  // Visibility
  // ============================================

  toggle(): void {
    if (this.visible) this.hide(); else this.show();
  }

  show(): void {
    if (!this.visible) this.onVisibleChange?.(true);
    this.visible = true;
    this.shownAt = performance.now();
    this.fromFlight = false;
    this.root.style.display = 'block';
    this.resize();
    this.setView(this.view);
    this.follow = null;
    // Where the cursor already is (it may not move before the ship wants aiming)
    if (this.client) {
      const r = this.canvas.getBoundingClientRect();
      this.mouse = { x: this.client.x - r.left, y: this.client.y - r.top };
    }
    this.startLoop();
  }

  /** Open the system view centred on your ship at the flight camera's scale (zooming out of flight) */
  showFromFlight(scale: number): void {
    this.view = 'system';
    this.show();
    this.fromFlight = true;
    const me = this.state.entities.get(this.state.playerId);
    this.setView('system');
    const cam = this.cam();
    if (me) { cam.x = me.renderX; cam.y = me.renderY; this.follow = { x: me.renderX, y: me.renderY }; }
    cam.scale = scale;
    // Fade in from the flight view
    this.root.style.transition = 'none';
    this.root.style.opacity = '0';
    requestAnimationFrame(() => { this.root.style.transition = 'opacity 0.25s'; this.root.style.opacity = '1'; });
  }

  hide(): void {
    if (this.visible) this.onVisibleChange?.(false);
    this.visible = false;
    this.root.style.display = 'none';
    this.tooltip.style.display = 'none';
    this.drag = null;
    this.fireHeld = false;
    this.follow = null;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** When it was opened (its fade-in runs a quarter of a second) */
  private shownAt = 0;

  /** Open and faded all the way in: nothing of the world shows behind it (Game stops drawing the world) */
  covers(): boolean {
    return this.visible && performance.now() - this.shownAt > 350;
  }

  // ============================================
  // Flying from the map (Game reads these each input tick)
  // ============================================

  /** The world point under the map cursor (system view only: null otherwise, so flight aims as usual) */
  aimWorld(): { x: number; y: number } | null {
    if (!this.visible || this.view !== 'system' || !this.client) return null;
    const cam = this.cam();
    return { x: (this.mouse.x - this.canvas.clientWidth / 2) / cam.scale + cam.x, y: (this.mouse.y - this.canvas.clientHeight / 2) / cam.scale + cam.y };
  }

  /** The world point under a mouse event (system view) */
  private eventWorld(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const cam = this.cam();
    return { x: (e.clientX - r.left - this.canvas.clientWidth / 2) / cam.scale + cam.x, y: (e.clientY - r.top - this.canvas.clientHeight / 2) / cam.scale + cam.y };
  }

  /** Left held on empty space in the system view */
  firing(): boolean {
    return this.visible && this.view === 'system' && this.fireHeld;
  }

  /** What a jump aimed from the map locks on to: the station, gate, rift, stillstone, wreck or ship under the cursor */
  jumpLock(): { name: string; x: number; y: number; stop?: number } | null {
    const h = this.visible && this.view === 'system' ? this.hover : null;
    if (!h) return null;
    if (h.kind === 'station' || h.kind === 'wreck' || h.kind === 'freighter') return { name: h.name, x: h.x, y: h.y };
    if (h.kind === 'ship') return { name: h.name, x: h.x, y: h.y };
    if (h.kind === 'gate') return { name: `gate to ${h.target?.name ?? '?'}`, x: h.x, y: h.y };
    if (h.kind === 'rift') return { name: h.label, x: h.x, y: h.y };
    if (h.kind === 'wayin') return { name: `way into ${h.pocket.pocket!.entrance.name}`, x: h.x, y: h.y };
    if (h.kind === 'beacon') return { name: 'your wreck', x: h.x, y: h.y };
    if (h.kind === 'lodestone') return { name: lodestoneLabel(h.lodestone, JUMP), x: h.x, y: h.y, stop: lodestoneStop(h.lodestone, JUMP) };
    return null;
  }

  destroy(): void {
    this.hide();
    this.root.remove();
  }

  // ============================================
  // Camera
  // ============================================

  private setView(v: View): void {
    this.view = v;
    this.tabs.galaxy.classList.toggle('on', v === 'galaxy');
    this.tabs.system.classList.toggle('on', v === 'system');
    if (v !== 'system') { this.fireHeld = false; this.follow = null; }
    // A new current system gets a freshly fitted system view
    if (v === 'system' && this.camSystemId !== this.state.systemId) {
      this.cams.system = null;
      this.camSystemId = this.state.systemId;
    }
    if (!this.cams[v]) this.fitView();
  }

  private cam(): Camera {
    if (!this.cams[this.view]) this.fitView();
    return this.cams[this.view]!;
  }

  private fit(): Fit {
    const w = this.canvas.clientWidth || 800, h = this.canvas.clientHeight || 600;
    if (this.view === 'galaxy') {
      const xs = this.systems.map((s) => s.position.x), ys = this.systems.map((s) => s.position.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const span = Math.max((maxX - minX) / w, (maxY - minY) / h);
      return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, scale: 0.72 / Math.max(span, 1e-6) };
    }
    const sys = this.byId.get(this.state.systemId);
    let ext = Math.max(this.belt?.outer ?? sys?.asteroidBelt?.outerRadius ?? 20000, 15000);
    for (const p of sys?.portals ?? []) ext = Math.max(ext, Math.hypot(p.position.x, p.position.y));
    for (const z of sys?.zones ?? []) ext = Math.max(ext, z.outer + (z.x !== undefined ? Math.hypot(z.x, z.y ?? 0) : 0));
    for (const b of sys?.asteroidBelt?.extra ?? []) ext = Math.max(ext, b.outerRadius);
    for (const g of sys?.regions ?? []) ext = Math.max(ext, g.outer);
    if (sys?.surface) ext = sys.surface.radius;
    if (sys?.pocket) ext = sys.pocket.radius;
    for (const e of this.state.entities.values()) if (e.type === EntityType.Station) ext = Math.max(ext, Math.hypot(e.x, e.y));
    ext *= 1.12;
    return { cx: 0, cy: 0, scale: Math.min(w, h) / (2 * ext) };
  }

  /** System view: centre on your ship, zoomed in enough to see what's around it. Galaxy view: centre on your system. */
  private centreOnMe(): void {
    const cam = this.cam();
    if (this.view === 'galaxy') {
      const sys = this.byId.get(this.state.systemId);
      if (sys) { cam.x = sys.position.x; cam.y = sys.position.y; }
      return;
    }
    const me = this.state.entities.get(this.state.playerId);
    if (!me) return;
    cam.x = me.renderX;
    cam.y = me.renderY;
    cam.scale = Math.max(cam.scale, this.fit().scale * 4);
    this.follow = { x: me.renderX, y: me.renderY };
  }

  private fitView(): void {
    const f = this.fit();
    this.cams[this.view] = { x: f.cx, y: f.cy, scale: f.scale };
  }

  private zoomAt(sx: number, sy: number, factor: number): void {
    const cam = this.cam();
    const base = this.fit().scale;
    const [minK, maxK] = this.view === 'galaxy' ? [0.35, 14] : [0.3, 60];
    // Zooming between views: out of a system into the galaxy, in from the galaxy to your system,
    // and back into flight when your ship is on screen
    if (this.view === 'system' && factor < 1 && cam.scale <= base * minK * 1.001) { this.setView('galaxy'); this.fitView(); return; }
    if (this.view === 'galaxy' && factor > 1 && cam.scale >= base * maxK * 0.999) { this.setView('system'); return; }
    if (this.view === 'system' && factor > 1 && cam.scale * factor > this.flightMinScale && (this.fromFlight || cam.scale > base)) {
      const me = this.state.entities.get(this.state.playerId);
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      const px = me ? (me.renderX - cam.x) * cam.scale + w / 2 : -1, py = me ? (me.renderY - cam.y) * cam.scale + h / 2 : -1;
      if (me && px > 0 && px < w && py > 0 && py < h && this.onZoomIntoFlight) {
        this.hide();
        this.onZoomIntoFlight(this.flightMinScale * 1.05);
        return;
      }
    }
    const next = Math.max(base * minK, Math.min(base * maxK, cam.scale * factor));
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    // Keep the world point under the cursor fixed
    const wx = cam.x + (sx - w / 2) / cam.scale, wy = cam.y + (sy - h / 2) / cam.scale;
    cam.scale = next;
    cam.x = wx - (sx - w / 2) / next;
    cam.y = wy - (sy - h / 2) / next;
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    this.canvas.height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
  }

  // ============================================
  // Autopilot
  // ============================================

  private flyTo(hit: Hit): void {
    const here = this.state.systemId;
    let dest: AutoDest | null = null;
    if (hit.kind === 'system') dest = { kind: 'system', system: hit.sys.id, name: hit.sys.name };
    else if (hit.kind === 'station') dest = { kind: 'station', system: here, name: hit.name };
    else if (hit.kind === 'gate' && hit.target) dest = { kind: 'gate', system: here, to: hit.target.id, name: `gate to ${hit.target.name}` };
    else if (hit.kind === 'ship') dest = { kind: 'player', id: hit.id, system: here, name: hit.name };
    else if (hit.kind === 'rift') dest = { kind: 'point', system: here, x: hit.x, y: hit.y, name: hit.label };
    else if (hit.kind === 'planet') dest = { kind: 'point', system: here, x: hit.x + hit.planet.radius * 1.4 + 600, y: hit.y, name: hit.planet.name };
    else if (hit.kind === 'moon') dest = { kind: 'point', system: here, x: hit.x + hit.radius + 500, y: hit.y, name: hit.name };
    else if (hit.kind === 'wreck' || hit.kind === 'freighter') dest = { kind: 'point', system: here, x: hit.x + 700, y: hit.y, name: hit.name };
    else if (hit.kind === 'beacon') dest = { kind: 'point', system: here, x: hit.x + 700, y: hit.y, name: 'your wreck' };
    else if (hit.kind === 'comet') dest = { kind: 'point', system: here, x: hit.x * 1.06, y: hit.y * 1.06, name: hit.comet.name };
    else if (hit.kind === 'structure') dest = { kind: 'point', system: here, x: 0, y: -hit.structure.radius - 900, name: hit.structure.name };
    else if (hit.kind === 'lodestone') dest = { kind: 'point', system: here, x: hit.x, y: hit.y, name: lodestoneLabel(hit.lodestone, JUMP) };
    else if (hit.kind === 'nest') dest = { kind: 'point', system: here, x: hit.x + 1200, y: hit.y, name: hit.nest.name };
    else if (hit.kind === 'wayin') dest = { kind: 'point', system: here, x: hit.x, y: hit.y, name: `way into ${hit.pocket.pocket!.entrance.name}` };
    if (!dest || !this.onFlyTo) return;
    if (dest.kind === 'system' && dest.system === here) return;
    this.onFlyTo(dest);
    this.hide();
  }

  /** Right-click in the system view: fly to that point */
  private flyToPoint(e: MouseEvent): void {
    if (!this.onFlyTo) return;
    const r = this.canvas.getBoundingClientRect();
    const cam = this.cam();
    const x = (e.clientX - r.left - this.canvas.clientWidth / 2) / cam.scale + cam.x;
    const y = (e.clientY - r.top - this.canvas.clientHeight / 2) / cam.scale + cam.y;
    this.onFlyTo({ kind: 'point', system: this.state.systemId, x, y, name: 'map point' });
    this.hide();
  }

  // ============================================
  // Warping (dev tool)
  // ============================================

  private warpTo(hit: Hit): void {
    const here = this.state.systemId;
    if (hit.kind === 'system') this.onWarp?.(hit.sys.id);
    else if (hit.kind === 'station') this.onWarp?.(here, hit.x + 900, hit.y);
    else if (hit.kind === 'gate') this.onWarp?.(here, hit.x + 500, hit.y);
    else if (hit.kind === 'rift') this.onWarp?.(here, hit.x + 450, hit.y);
    else if (hit.kind === 'planet') this.onWarp?.(here, hit.x + hit.planet.radius * 1.4 + 600, hit.y);
    else if (hit.kind === 'moon') this.onWarp?.(here, hit.x + hit.radius + 500, hit.y);
    else if (hit.kind === 'wreck' || hit.kind === 'freighter' || hit.kind === 'beacon') this.onWarp?.(here, hit.x + 700, hit.y);
    else if (hit.kind === 'comet') this.onWarp?.(here, hit.x * 1.06, hit.y * 1.06);
    else if (hit.kind === 'structure') this.onWarp?.(here, 0, -hit.structure.radius - 900);
    else if (hit.kind === 'lodestone') this.onWarp?.(here, hit.x + lodestoneStop(hit.lodestone, JUMP), hit.y);
    else if (hit.kind === 'nest') this.onWarp?.(here, hit.x + 1200, hit.y);
    else if (hit.kind === 'wayin') this.onWarp?.(here, hit.x, hit.y + hit.pocket.pocket!.entrance.radius * 0.5);
    else return;
    this.hide();
  }

  // ============================================
  // Rendering
  // ============================================

  /** Redrawn every this many frames while left alone (the quality tier: settings/quality.ts) */
  private redrawEvery = 1;
  private skipped = 0;
  /** When it was last moved, zoomed or pointed at (redrawn every frame for a moment after) */
  private touchedAt = 0;
  setRedrawEvery(n: number): void {
    this.redrawEvery = Math.max(1, n);
  }

  private startLoop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.skipped = this.redrawEvery;
    const loop = () => {
      if (!this.visible) return;
      if (++this.skipped >= this.redrawEvery || performance.now() - this.touchedAt < 400) {
        this.skipped = 0;
        this.draw();
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private draw(): void {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cam = this.cam();
    const time = (performance.now() - this.t0) / 1000;
    // Following your ship: the view moves as it does
    const me = this.view === 'system' && this.follow ? this.state.entities.get(this.state.playerId) : undefined;
    if (me && this.follow) {
      cam.x += me.renderX - this.follow.x;
      cam.y += me.renderY - this.follow.y;
      this.follow = { x: me.renderX, y: me.renderY };
    }

    // Deep space with a little parallax on the background stars: a few brightness groups, one fill each
    ctx.fillStyle = '#02040c';
    ctx.fillRect(0, 0, w, h);
    const par = this.view === 'galaxy' ? 0.00002 : 0.000004;
    const ox = -cam.x * cam.scale * par * 50, oy = -cam.y * cam.scale * par * 50;
    ctx.fillStyle = 'rgb(200, 215, 255)';
    for (const group of this.starGroups()) {
      ctx.globalAlpha = group.alpha;
      ctx.beginPath();
      for (const [u, v, size] of group.stars) ctx.rect(((u * w + ox) % w + w) % w, ((v * h + oy) % h + h) % h, size, size);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    const sx = (x: number) => (x - cam.x) * cam.scale + w / 2;
    const sy = (y: number) => (y - cam.y) * cam.scale + h / 2;
    this.hits = [];
    if (this.view === 'galaxy') this.drawGalaxy(ctx, sx, sy, cam, time);
    else this.drawSystem(ctx, sx, sy, cam, time, w, h);

    // Hover: nearest hit within reach of the cursor
    let best: Hit | null = null, bestD = 22;
    for (const hit of this.hits) {
      // (Band edges and zones give way to anything on them)
      const d = Math.hypot(hit.sx - this.mouse.x, hit.sy - this.mouse.y) + (hit.kind === 'region' || hit.kind === 'zone' ? 12 : 0);
      if (d < bestD) { best = hit; bestD = d; }
    }
    const panning = !!this.drag?.moved && this.drag.pan;
    this.hover = panning ? null : best;
    this.canvas.style.cursor = panning ? 'grabbing' : actionable(this.hover) ? 'pointer' : this.view === 'system' ? 'crosshair' : 'grab';
    this.updateTooltip();

    // Footer: what the mouse does here
    const jumpKey = boundKeyName('jump', settings.data.bindings), menuKey = boundKeyName('contextMenu', settings.data.bindings);
    const hintKey = `${this.view}|${jumpKey}|${menuKey}`;
    if (hintKey !== this.hintKey) {
      this.hintKey = hintKey;
      // (Right-click is the map's here: in flight it fires, and with the menu key held opens the action menu)
      this.hintEl.textContent = this.view === 'galaxy'
        ? 'Scroll to zoom · drag to pan · click a system to fly there (autopilot) · Esc to close'
        : `Your ship faces the cursor · hold left to fire · ${jumpKey} jumps there · click a marker or right-click a spot: autopilot · right-drag pans · Shift + right-click: ping · C follows your ship · in flight, ${menuKey} + right-click: action menu`;
    }

    // Header
    const sys = this.byId.get(this.state.systemId);
    if (this.view === 'galaxy') {
      this.titleEl.textContent = 'Galaxy map';
      this.subEl.textContent = `${this.systems.length} systems · you are in ${sys?.name ?? this.state.systemId}`;
    } else {
      this.titleEl.textContent = sys?.name ?? this.state.systemId;
      const threat = this.state.threats[this.state.systemId];
      this.subEl.textContent = `Danger ${sys?.danger ?? 1}/7${threat ? ` · threat ◆${threat}` : ''}${sys?.pvp ? (sys.pvp.mode === 'all' ? ' · PvP everywhere' : ' · PvP outside the station') : ''} · ${(sys?.sector ?? '').replace(/_/g, ' ') || 'unassigned sector'} · ${BODY_NAMES[this.central()?.type ?? 'sun'] ?? ''}`;
    }
  }

  /** The background stars by brightness (a handful of groups, so a frame sets a few styles, not one per star) */
  private starGroupsCache: { alpha: number; stars: [number, number, number][] }[] | null = null;
  private starGroups(): { alpha: number; stars: [number, number, number][] }[] {
    if (this.starGroupsCache) return this.starGroupsCache;
    const groups = new Map<number, [number, number, number][]>();
    for (const [u, v, size, a] of this.bgStars) {
      const k = Math.round(a * 8) / 8;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push([u, v, size]);
    }
    return (this.starGroupsCache = [...groups.entries()].map(([alpha, stars]) => ({ alpha, stars })));
  }

  /** Each belt's scattered rocks, worked out once per system: offsets from the centre (world units) and sizes */
  private beltDots = new Map<string, Float32Array>();
  private beltDotsFor(key: string, seed: number, inner: number, outer: number, n: number): Float32Array {
    let dots = this.beltDots.get(key);
    if (dots) return dots;
    const r = seeded(seed);
    dots = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, d = inner + (outer - inner) * r();
      dots[i * 3] = Math.cos(a) * d; dots[i * 3 + 1] = Math.sin(a) * d; dots[i * 3 + 2] = 0.6 + r() * 1.4;
    }
    this.beltDots.set(key, dots);
    return dots;
  }

  private central() {
    return this.liveCentral ?? this.byId.get(this.state.systemId)?.centralBody ?? null;
  }

  // ---------------------------- Galaxy view ----------------------------

  private drawGalaxy(ctx: CanvasRenderingContext2D, sx: (x: number) => number, sy: (y: number) => number, cam: Camera, time: number): void {
    const S = cam.scale;

    // Grid
    const step = niceStep(140 / S);
    ctx.strokeStyle = 'rgba(80, 110, 170, 0.08)';
    ctx.lineWidth = 1;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const x0 = Math.floor((cam.x - w / 2 / S) / step) * step, y0 = Math.floor((cam.y - h / 2 / S) / step) * step;
    for (let x = x0; x < cam.x + w / 2 / S; x += step) { ctx.beginPath(); ctx.moveTo(sx(x), 0); ctx.lineTo(sx(x), h); ctx.stroke(); }
    for (let y = y0; y < cam.y + h / 2 / S; y += step) { ctx.beginPath(); ctx.moveTo(0, sy(y)); ctx.lineTo(w, sy(y)); ctx.stroke(); }

    // Sector regions: a soft glow around each member system, the name over the group
    const sectors = new Map<string, StarSystemData[]>();
    for (const s of this.systems) sectors.set(s.sector ?? '', [...(sectors.get(s.sector ?? '') ?? []), s]);
    for (const [sector, list] of sectors) {
      const color = this.sectorColor.get(sector)!;
      for (const s of list) {
        const r = Math.max(70, 30000 * S);
        const g = ctx.createRadialGradient(sx(s.position.x), sy(s.position.y), 0, sx(s.position.x), sy(s.position.y), r);
        g.addColorStop(0, color + '30');
        g.addColorStop(1, color + '00');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(sx(s.position.x), sy(s.position.y), r, 0, Math.PI * 2); ctx.fill();
      }
      if (sector) {
        const cx = list.reduce((a, s) => a + s.position.x, 0) / list.length;
        const top = Math.min(...list.map((s) => s.position.y));
        ctx.fillStyle = color + 'aa';
        ctx.font = '600 12px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(sector.replace(/_/g, ' ').toUpperCase().split('').join(' '), sx(cx), sy(top) - Math.max(60, 26000 * S));
      }
    }

    // Jump-gate links: two-way solid with travelling pulses, one-way dashed with an arrow
    const pairs = new Map<string, { a: StarSystemData; b: StarSystemData; ab: boolean; ba: boolean }>();
    for (const s of this.systems) {
      for (const p of s.portals) {
        const t = this.byId.get(p.targetSystem);
        // (Gates to somewhere off the map, like your own station, aren't links)
        if (!t || t.private || t.surface) continue;
        const [a, b] = s.id < t.id ? [s, t] : [t, s];
        const key = `${a.id}|${b.id}`;
        const e = pairs.get(key) ?? { a, b, ab: false, ba: false };
        if (s === a) e.ab = true; else e.ba = true;
        pairs.set(key, e);
      }
    }
    for (const { a, b, ab, ba } of pairs.values()) {
      const ax = sx(a.position.x), ay = sy(a.position.y), bx = sx(b.position.x), by = sy(b.position.y);
      const two = ab && ba;
      ctx.strokeStyle = two ? 'rgba(140, 190, 255, 0.5)' : 'rgba(140, 190, 255, 0.35)';
      ctx.lineWidth = two ? 1.6 : 1.2;
      ctx.setLineDash(two ? [] : [6, 6]);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.setLineDash([]);
      const n = 3;
      for (let k = 0; k < n; k++) {
        const t = ((time * 0.12 + k / n) % 1);
        const [fx, fy, tx, ty] = !two && ba && !ab ? [bx, by, ax, ay] : [ax, ay, bx, by];
        ctx.fillStyle = 'rgba(170, 215, 255, 0.8)';
        ctx.beginPath(); ctx.arc(fx + (tx - fx) * t, fy + (ty - fy) * t, 1.6, 0, Math.PI * 2); ctx.fill();
      }
      if (!two) {
        const [fx, fy, tx, ty] = ab ? [ax, ay, bx, by] : [bx, by, ax, ay];
        const mx = (fx + tx) / 2, my = (fy + ty) / 2, ang = Math.atan2(ty - fy, tx - fx);
        ctx.fillStyle = 'rgba(140, 190, 255, 0.7)';
        ctx.beginPath();
        ctx.moveTo(mx + Math.cos(ang) * 7, my + Math.sin(ang) * 7);
        ctx.lineTo(mx + Math.cos(ang + 2.5) * 6, my + Math.sin(ang + 2.5) * 6);
        ctx.lineTo(mx + Math.cos(ang - 2.5) * 6, my + Math.sin(ang - 2.5) * 6);
        ctx.fill();
      }
    }

    // Rift routes: curved violet dots
    for (const s of this.systems) {
      for (const rift of s.rifts ?? []) {
        const t = this.byId.get(rift.destination.system);
        if (!t || t === s || t.private || t.surface) continue;
        const ax = sx(s.position.x), ay = sy(s.position.y), bx = sx(t.position.x), by = sy(t.position.y);
        const mx = (ax + bx) / 2, my = (ay + by) / 2, len = Math.hypot(bx - ax, by - ay);
        const cx = mx + ((ay - by) / len) * len * 0.22, cy = my + ((bx - ax) / len) * len * 0.22;
        ctx.strokeStyle = 'rgba(200, 120, 255, 0.55)';
        ctx.setLineDash([2, 6]);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cx, cy, bx, by); ctx.stroke();
        ctx.setLineDash([]);
        // vortex mark at the bend
        const vx = 0.25 * ax + 0.5 * cx + 0.25 * bx, vy = 0.25 * ay + 0.5 * cy + 0.25 * by;
        ctx.strokeStyle = 'rgba(220, 150, 255, 0.85)';
        ctx.lineWidth = 1.4;
        for (let k = 0; k < 2; k++) {
          ctx.beginPath(); ctx.arc(vx, vy, 4 + k * 3, time * 2 + k * 2, time * 2 + k * 2 + 4.2); ctx.stroke();
        }
      }
    }

    // Systems
    for (const s of this.systems) {
      const x = sx(s.position.x), y = sy(s.position.y);
      const here = s.id === this.state.systemId;
      const hovered = this.hover?.kind === 'system' && this.hover.sys === s;
      this.drawBodyGlyph(ctx, s.centralBody ?? { type: 'sun' }, s.starColor, x, y, 9, time);
      const lock = this.locked?.(s.id) ?? null;
      if (lock) drawPadlock(ctx, x + 13, y - 13);
      if (here) {
        const pulse = 0.5 + 0.5 * Math.sin(time * 3);
        ctx.strokeStyle = `rgba(74, 222, 128, ${0.5 + 0.4 * pulse})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, 18 + pulse * 3, 0, Math.PI * 2); ctx.stroke();
      }
      if (hovered) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, 23, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.textAlign = 'center';
      ctx.fillStyle = here ? '#86efac' : lock ? '#9aa6b8' : '#e5ecf7';
      ctx.font = `${here || hovered ? 700 : 600} 13px "Segoe UI", sans-serif`;
      ctx.fillText(s.name, x, y + 34);
      ctx.fillStyle = lock ? 'rgba(251, 191, 36, 0.85)' : 'rgba(160, 180, 210, 0.75)';
      ctx.font = '11px "Segoe UI", sans-serif';
      const info = here ? 'YOU ARE HERE' : lock ? `🔒 ${lock.name} needed` : `${s.stations.length ? `${s.stations.length} station${s.stations.length > 1 ? 's' : ''}` : 'no stations'}${s.hazards.length ? ` · ⚠ ${s.hazards.length}` : ''}`;
      ctx.fillText(info, x, y + 49);
      const d = s.danger ?? 1;
      ctx.fillStyle = dangerColor(d);
      ctx.font = '600 10px "Segoe UI", sans-serif';
      ctx.fillText(`${'●'.repeat(d)}${'○'.repeat(7 - d)}${s.pvp ? '  PVP' : ''}`, x, y + 63);
      // What its hostiles rate, against your ship
      const threat = this.state.threats[s.id];
      if (threat) {
        const mine = this.myRating?.() ?? 0;
        ctx.fillStyle = mine ? THREAT_COLOR[threatLevel(mine, threat)] : 'rgba(160, 180, 210, 0.75)';
        ctx.fillText(`◆ ${threat}`, x, y + 76);
      }
      if (here) this.drawGalaxyPin(ctx, x, y, time);
      this.hits.push({ kind: 'system', sys: s, sx: x, sy: y });
    }
    // Your party: a green pip and name beside each member's system
    const partyByStar = new Map<string, string[]>();
    for (const m of this.party?.() ?? []) if (m.system) partyByStar.set(m.system, [...(partyByStar.get(m.system) ?? []), m.name]);
    for (const [id, names] of partyByStar) {
      const sys = this.byId.get(id);
      if (!sys) continue;
      const x = sx(sys.position.x) + 14, y = sy(sys.position.y) - 14;
      ctx.fillStyle = '#4ade80';
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.font = '600 11px "Segoe UI", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#bbf7d0';
      ctx.fillText(names.join(', '), x + 7, y + 4);
    }
  }

  /** Galaxy view: a bobbing pin above your system holding your ship, pointing the way you face */
  private drawGalaxyPin(ctx: CanvasRenderingContext2D, x: number, y: number, time: number): void {
    const me = this.state.entities.get(this.state.playerId);
    const bob = Math.sin(time * 2.4) * 3;
    const py = y - 46 + bob;
    ctx.save();
    ctx.shadowColor = 'rgba(74, 222, 128, 0.8)';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#4ade80';
    ctx.beginPath();
    ctx.arc(x, py, 13, Math.PI * 0.85, Math.PI * 2.15);
    ctx.lineTo(x, py + 22);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#062012';
    ctx.beginPath(); ctx.arc(x, py, 9, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.translate(x, py);
    ctx.rotate(me?.renderAngle ?? -Math.PI / 2);
    ctx.fillStyle = '#86efac';
    ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, 4); ctx.lineTo(-2, 0); ctx.lineTo(-4, -4); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  /** Central body glyph: sun (glow in its colour), black hole (disk + horizon) or pulsar (sweeping beams). */
  private drawBodyGlyph(ctx: CanvasRenderingContext2D, cb: { type: string; hue?: number; diskHue?: number; beamHue?: number }, starColor: string | undefined, x: number, y: number, r: number, time: number): void {
    if (cb.type === 'black_hole') {
      const hue = cb.diskHue ?? 30;
      const g = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * 2.6);
      g.addColorStop(0, `hsla(${hue}, 95%, 65%, 0.95)`);
      g.addColorStop(0.45, `hsla(${hue}, 90%, 50%, 0.45)`);
      g.addColorStop(1, `hsla(${hue}, 90%, 40%, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r * 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `hsla(${hue + 20}, 100%, 85%, 0.95)`;
      ctx.lineWidth = Math.max(1.2, r * 0.18);
      ctx.beginPath(); ctx.arc(x, y, r * 0.95, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.arc(x, y, r * 0.8, 0, Math.PI * 2); ctx.fill();
      return;
    }
    if (cb.type === 'pulsar') {
      const hue = cb.beamHue ?? 190;
      const a = time * 1.4;
      for (const off of [0, Math.PI]) {
        const g = ctx.createLinearGradient(x, y, x + Math.cos(a + off) * r * 4, y + Math.sin(a + off) * r * 4);
        g.addColorStop(0, `hsla(${hue}, 90%, 75%, 0.9)`);
        g.addColorStop(1, `hsla(${hue}, 90%, 75%, 0)`);
        ctx.strokeStyle = g;
        ctx.lineWidth = Math.max(1.5, r * 0.3);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a + off) * r * 4, y + Math.sin(a + off) * r * 4); ctx.stroke();
      }
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 1.8);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.3, `hsla(${hue}, 90%, 80%, 0.7)`);
      g.addColorStop(1, `hsla(${hue}, 90%, 70%, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r * 1.8, 0, Math.PI * 2); ctx.fill();
      return;
    }
    if (cb.type === 'brown_dwarf') {
      // A dull banded ball in a faint smoulder
      const hue = cb.hue ?? 14;
      const g = ctx.createRadialGradient(x, y, r * 0.8, x, y, r * 2);
      g.addColorStop(0, `hsla(${hue}, 85%, 40%, 0.5)`);
      g.addColorStop(1, `hsla(${hue}, 85%, 30%, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r * 2, 0, Math.PI * 2); ctx.fill();
      ctx.save();
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.clip();
      for (let k = -3; k <= 3; k++) {
        ctx.fillStyle = `hsl(${hue + (k % 2 ? 10 : 0)}, 55%, ${k % 2 ? 36 : 24}%)`;
        ctx.fillRect(x - r, y + (k - 0.5) * (r / 3.5), r * 2, r / 3.5 + 0.5);
      }
      ctx.restore();
      return;
    }
    const hue = cb.hue ?? (starColor ? hexToHue(starColor) : 40);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.8);
    g.addColorStop(0, `hsla(${hue}, 100%, 92%, 1)`);
    g.addColorStop(0.3, `hsla(${hue}, 95%, 65%, 0.85)`);
    g.addColorStop(0.6, `hsla(${hue}, 90%, 55%, 0.25)`);
    g.addColorStop(1, `hsla(${hue}, 90%, 50%, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r * 2.8, 0, Math.PI * 2); ctx.fill();
  }

  // ---------------------------- System view ----------------------------

  private drawSystem(ctx: CanvasRenderingContext2D, sx: (x: number) => number, sy: (y: number) => number, cam: Camera, time: number, w: number, h: number): void {
    const S = cam.scale;
    const sys = this.byId.get(this.state.systemId);
    const cb = this.central() ?? { type: 'sun' };
    const ox = sx(0), oy = sy(0);
    // Names are placed after everything's drawn, so they can make way for each other (placeLabels)
    this.labelQueue = [];

    // Distance rings from the central body
    const step = niceStep(160 / S);
    const far = Math.hypot(Math.max(Math.abs(cam.x - w / 2 / S), Math.abs(cam.x + w / 2 / S)), Math.max(Math.abs(cam.y - h / 2 / S), Math.abs(cam.y + h / 2 / S)));
    ctx.lineWidth = 1;
    ctx.font = '10px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    for (let r = step; r < far && r / step < 200; r += step) {
      ctx.strokeStyle = 'rgba(90, 120, 180, 0.12)';
      ctx.beginPath(); ctx.arc(ox, oy, r * S, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(120, 150, 200, 0.4)';
      ctx.fillText(fmtDist(r), ox + r * S + 3, oy - 3);
    }

    // Danger bands: a faint wash per band, its edge a ring, name and danger under it
    const mdx = this.mouse.x - ox, mdy = this.mouse.y - oy, md = Math.hypot(mdx, mdy) || 1;
    (sys?.regions ?? []).forEach((g, i, list) => {
      const st = REGION_STYLE[g.danger] ?? REGION_STYLE.contested;
      const inner = i > 0 ? list[i - 1].outer : 0;
      ctx.save();
      ctx.globalAlpha = g.danger === 'safe' ? 0.025 : 0.035;
      ctx.fillStyle = st.color;
      ctx.beginPath();
      ctx.arc(ox, oy, g.outer * S, 0, Math.PI * 2);
      if (inner > 0) ctx.arc(ox, oy, inner * S, 0, Math.PI * 2, true);
      ctx.fill('evenodd');
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = st.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(ox, oy, g.outer * S, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      const ly = oy + g.outer * S + 14;
      this.label(ctx, `${g.name.toUpperCase()} · ${st.word.toUpperCase()}`, ox, ly, st.color, 3, oy + g.outer * S);
      this.hits.push({ kind: 'region', region: g, inner, sx: ox, sy: ly - 4 });
      // Hovering its edge anywhere round
      if (Math.abs(md - g.outer * S) < 8) this.hits.push({ kind: 'region', region: g, inner, sx: ox + (mdx / md) * g.outer * S, sy: oy + (mdy / md) * g.outer * S });
    });

    // Asteroid belts: a faint band with scattered rocks (the extra belts sparser)
    const belt = this.belt ?? (sys?.asteroidBelt ? { inner: sys.asteroidBelt.innerRadius, outer: sys.asteroidBelt.outerRadius } : null);
    const belts = [
      ...(belt ? [{ ...belt, dots: 450, alpha: 0.045 }] : []),
      ...(sys?.asteroidBelt?.extra ?? []).map((b) => ({ inner: b.innerRadius, outer: b.outerRadius, dots: Math.max(60, Math.round(b.count * 1.2)), alpha: 0.025 })),
    ];
    belts.forEach((b, k) => {
      ctx.fillStyle = `rgba(160, 150, 135, ${b.alpha})`;
      ctx.beginPath();
      ctx.arc(ox, oy, b.outer * S, 0, Math.PI * 2);
      ctx.arc(ox, oy, b.inner * S, 0, Math.PI * 2, true);
      ctx.fill();
      // (positions worked out once per system; all of a belt's rocks in one fill)
      const dots = this.beltDotsFor(`${this.state.systemId}:${k}:${b.inner}:${b.outer}`, hash(this.state.systemId) + k, b.inner, b.outer, b.dots);
      ctx.fillStyle = 'rgba(190, 180, 165, 0.45)';
      ctx.beginPath();
      for (let i = 0; i < dots.length; i += 3) {
        const px = ox + dots[i] * S, py = oy + dots[i + 1] * S;
        if (px < -5 || py < -5 || px > w + 5 || py > h + 5) continue;
        ctx.rect(px, py, dots[i + 2], dots[i + 2]);
      }
      ctx.fill();
    });

    // Gravity: the horizon, and where the pull out-muscles a starter ship
    const grav = (sys?.centralBody as any)?.gravity as { strength: number; horizon?: number } | undefined;
    if (grav) {
      const noReturn = Math.sqrt(grav.strength / 0.167);
      ctx.setLineDash([5, 6]);
      ctx.strokeStyle = 'rgba(255, 150, 60, 0.6)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(ox, oy, noReturn * S, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      this.label(ctx, 'pull exceeds starter thrust', ox, oy - noReturn * S - 6, 'rgba(255, 170, 90, 0.85)', 2, oy - noReturn * S);
      if (grav.horizon) {
        ctx.strokeStyle = 'rgba(255, 70, 70, 0.85)';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(ox, oy, grav.horizon * S, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // A star's charging ring: jump drives recharge faster and reach further inside it
    if (cb.type !== 'black_hole' && cb.type !== 'none') {
      const ring = solarRingRadius(cb.radius ?? sys?.starRadius ?? 1000) * S;
      ctx.save();
      ctx.strokeStyle = 'rgba(252, 211, 77, 0.45)';
      ctx.setLineDash([3, 7]);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(ox, oy, ring, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(252, 211, 77, 0.035)';
      ctx.beginPath(); ctx.arc(ox, oy, ring, 0, Math.PI * 2); ctx.fill();
      if (ring > 40) {
        this.label(ctx, '☀ JUMP CHARGING RING', ox, oy - ring - 6, 'rgba(252, 211, 77, 0.85)', 2, oy - ring);
      }
      ctx.restore();
    }

    // Central body (true size when zoomed in, a glyph when far out)
    const bodyR = Math.max(9, (cb.radius ?? sys?.starRadius ?? 1000) * S);
    if (sys?.surface) {
      // A planet's surface: the edge of the map (climb past it to orbit) and its city
      const s = sys.surface;
      ctx.save();
      ctx.strokeStyle = 'rgba(232, 244, 255, 0.45)';
      ctx.setLineDash([8, 8]);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(ox, oy, s.radius * S, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      this.label(ctx, 'Edge of the atmosphere: fly out to return to orbit', ox, oy - s.radius * S - 14, '#cfe6ff', 2);
      if (s.city) {
        const cx = sx(s.city.x), cy = sy(s.city.y);
        ctx.fillStyle = 'rgba(141, 147, 155, 0.35)';
        ctx.beginPath(); ctx.arc(cx, cy, Math.max(6, s.city.radius * S), 0, Math.PI * 2); ctx.fill();
        for (const p of s.city.pylons) {
          ctx.fillStyle = '#7dd3fc';
          ctx.beginPath(); ctx.arc(sx(s.city.x + p.x), sy(s.city.y + p.y), 4, 0, Math.PI * 2); ctx.fill();
        }
        this.label(ctx, s.city.name, cx, cy + Math.max(6, s.city.radius * S) + 14, '#e6edf6', 8);
      }
    } else if (sys?.pocket) {
      // A pocket: the edge of the map (fly past it to leave)
      ctx.save();
      ctx.strokeStyle = 'rgba(232, 244, 255, 0.45)';
      ctx.setLineDash([8, 8]);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(ox, oy, sys.pocket.radius * S, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      this.label(ctx, `Edge of ${sys.pocket.entrance.name}: fly out to leave`, ox, oy - sys.pocket.radius * S - 14, '#cfe6ff', 2);
    } else {
      this.drawBodyGlyph(ctx, cb, sys?.starColor, ox, oy, bodyR, time);
    }

    // Named rings (the Drift): a faint band, edges dashed, the name along the top.
    // A zone with a spot of its own (the Graveyard) is a disc there instead.
    for (const z of sys?.zones ?? []) {
      const col = z.color ?? '#c9a46a';
      const spot = z.x !== undefined && z.y !== undefined;
      const zx = spot ? sx(z.x!) : ox, zy = spot ? sy(z.y!) : oy;
      ctx.save();
      ctx.globalAlpha = spot ? 0.1 : 0.07;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(zx, zy, z.outer * S, 0, Math.PI * 2);
      if (z.inner > 0) ctx.arc(zx, zy, z.inner * S, 0, Math.PI * 2, true);
      ctx.fill('evenodd');
      ctx.globalAlpha = spot ? 0.55 : 0.35;
      ctx.strokeStyle = col;
      ctx.setLineDash([6, 8]);
      for (const r of [z.inner, z.outer]) if (r > 0) { ctx.beginPath(); ctx.arc(zx, zy, Math.max(spot ? 4 : 0, r * S), 0, Math.PI * 2); ctx.stroke(); }
      ctx.restore();
      if (spot) {
        const ly = zy - Math.max(4, z.outer * S) - 6;
        this.label(ctx, z.name, zx, ly, col, 4, zy);
        this.hits.push({ kind: 'zone', zone: z, sx: zx, sy: zy });
      } else {
        const mid = ((z.inner + z.outer) / 2) * S;
        this.label(ctx, z.name, ox, oy - mid, col, 3);
        this.hits.push({ kind: 'zone', zone: z, sx: ox, sy: oy - mid - 4 });
      }
    }

    // Planets on their orbits (with rings and moons at true size when zoomed in)
    for (const pl of sys?.planets ?? []) {
      const pos = planetPosition(pl, this.state.getRawServerTick());
      ctx.strokeStyle = 'rgba(200, 210, 225, 0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(ox, oy, pl.orbit.radius * S, 0, Math.PI * 2); ctx.stroke();
      const x = sx(pos.x), y = sy(pos.y);
      const pr = Math.max(4, pl.radius * S);
      const col = PLANET_COLORS[pl.kind] ?? '#cccccc';
      if (pl.rings) {
        ctx.strokeStyle = 'rgba(220, 205, 170, 0.35)';
        ctx.lineWidth = Math.max(1, (pl.rings.outer - pl.rings.inner) * pl.radius * S * 0.6);
        ctx.beginPath(); ctx.arc(x, y, Math.max(pr + 3, ((pl.rings.inner + pl.rings.outer) / 2) * pl.radius * S), 0, Math.PI * 2); ctx.stroke();
      }
      // Lit towards the centre: a two-tone disc
      const d = Math.hypot(pos.x, pos.y) || 1;
      const g = ctx.createRadialGradient(x - (pos.x / d) * pr * 0.5, y - (pos.y / d) * pr * 0.5, pr * 0.1, x, y, pr);
      g.addColorStop(0, col);
      g.addColorStop(1, 'rgba(10, 14, 24, 1)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, pr, 0, Math.PI * 2); ctx.fill();
      (pl.moons ?? []).forEach((m, i) => {
        const o = moonOffset(pl, i, this.state.getRawServerTick());
        const mx = sx(pos.x + o.x), my = sy(pos.y + o.y);
        ctx.fillStyle = m.surface ? 'rgba(253, 230, 138, 0.9)' : 'rgba(200, 200, 210, 0.7)';
        ctx.beginPath(); ctx.arc(mx, my, Math.max(m.surface ? 3 : 1.5, m.radius * S), 0, Math.PI * 2); ctx.fill();
        // Siege moons: named, with what their nights rate
        if (!m.surface) return;
        ctx.strokeStyle = 'rgba(253, 230, 138, 0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(mx, my, Math.max(6, m.radius * S + 3), 0, Math.PI * 2); ctx.stroke();
        const threat = this.state.threats[m.surface];
        this.label(ctx, `${m.name ?? 'Moon'} · siege${threat ? ` ◆${threat}` : ''}`, mx, my - 10, '#fde68a', 4, my);
        this.hits.push({ kind: 'moon', name: m.name ?? 'Moon', surface: m.surface, planet: pl, radius: m.radius, x: pos.x + o.x, y: pos.y + o.y, sx: mx, sy: my });
      });
      this.label(ctx, pl.name, x, y + pr + 14, '#c8d2e0', 5, y);
      this.hits.push({ kind: 'planet', planet: pl, x: pos.x, y: pos.y, sx: x, sy: y });
    }

    // Built structures (a ring about the star)
    for (const st of sys?.structures ?? []) {
      drawStructure(ctx, st, ox, oy, S, this.state.getRawServerTick());
      const lx = ox, ly = oy - st.radius * S;
      this.label(ctx, st.name, lx, ly - 10, '#f0d99a', 3, ly);
      this.hits.push({ kind: 'structure', structure: st, x: 0, y: -st.radius, sx: lx, sy: ly });
    }

    // Stillstones: the stone and its charging field (to scale; none round a dead or shattered one), a glyph and the name
    for (const l of sys?.lodestones ?? []) {
      const pos = lodestonePosition(l, this.state.getRawServerTick());
      const live = lodestoneLive(l), col = live ? LODE_COLOR : LODE_DEAD;
      const x = sx(pos.x), y = sy(pos.y), fr = lodestoneFieldRadius(l, JUMP) * S, br = lodestoneSize(l, JUMP) * S;
      ctx.save();
      if (fr > 3) {
        ctx.fillStyle = l.state === 'scarred' ? 'rgba(163, 194, 207, 0.05)' : 'rgba(163, 194, 207, 0.08)';
        ctx.beginPath(); ctx.arc(x, y, fr, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(163, 194, 207, 0.6)';
        ctx.setLineDash(l.state === 'scarred' ? [2, 6] : [3, 4]);
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(x, y, fr, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
      // The stone itself, once it's bigger than the glyph (a shattered one: a scatter of pieces)
      if (br > 7) {
        ctx.fillStyle = live ? 'rgba(120, 128, 138, 0.55)' : 'rgba(80, 84, 92, 0.5)';
        if (l.state === 'shattered') {
          for (let k = 0; k < 9; k++) { const a = k * 2.4, d = br * (0.45 + 0.4 * ((k * 7) % 5) / 5); ctx.beginPath(); ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, Math.max(1, br * 0.1), 0, Math.PI * 2); ctx.fill(); }
        } else { ctx.beginPath(); ctx.arc(x, y, br, 0, Math.PI * 2); ctx.fill(); }
      }
      // A diamond in a ring
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(x, y - 3.5); ctx.lineTo(x + 3.5, y); ctx.lineTo(x, y + 3.5); ctx.lineTo(x - 3.5, y); ctx.closePath(); ctx.fill();
      ctx.restore();
      this.label(ctx, lodestoneLabel(l, JUMP), x, y - Math.max(8, fr, br) - 6, col, 4, y);
      this.hits.push({ kind: 'lodestone', lodestone: l, x: pos.x, y: pos.y, sx: x, sy: y });
    }

    // Ways into pockets (a boss's nest): a ring round a dark mouth, and how to go in
    for (const pk of pocketsFrom([...this.byId.values()], this.state.systemId)) {
      const e = pk.pocket!.entrance, x = sx(e.x), y = sy(e.y), col = FACTIONS[e.look?.faction ?? '']?.color ?? '#fbbf24';
      ctx.save();
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, Math.max(8, e.radius * S), 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(10, 10, 14, 0.85)';
      ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      this.label(ctx, `Way into ${e.name} (${boundKeyName('interact', settings.data.bindings)})`, x, y - Math.max(8, e.radius * S) - 8, col, 6, y);
      this.hits.push({ kind: 'wayin', pocket: pk, x: e.x, y: e.y, sx: x, sy: y });
    }

    // Hostile nests: a triangle in a ring in their faction's colour, and the name (not a den's hidden posts)
    for (const n of sys?.nests ?? []) {
      if (n.hidden) continue;
      const pos = nestPosition(n, sys?.planets, this.state.getRawServerTick());
      const x = sx(pos.x), y = sy(pos.y), col = FACTIONS[n.faction]?.color ?? '#f87171';
      ctx.save();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 6.5, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x + 3.6, y + 2.6); ctx.lineTo(x - 3.6, y + 2.6); ctx.closePath(); ctx.fill();
      ctx.restore();
      this.label(ctx, n.name, x, y - 12, col, 4, y);
      this.hits.push({ kind: 'nest', nest: n, x: pos.x, y: pos.y, sx: x, sy: y });
    }

    // Comets: the orbit ellipse, the comet and a stub of tail pointing away from the star
    for (const c of sys?.comets ?? []) {
      const { a, e, argP } = c.orbit;
      ctx.save();
      ctx.translate(ox, oy);
      ctx.rotate(argP);
      ctx.strokeStyle = 'rgba(191, 230, 255, 0.18)';
      ctx.setLineDash([2, 6]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(-a * e * S, 0, a * S, a * Math.sqrt(1 - e * e) * S, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      const pos = cometPosition(c, this.state.getRawServerTick());
      const x = sx(pos.x), y = sy(pos.y);
      const d = Math.hypot(pos.x, pos.y) || 1;
      const tail = 14 + 40 * Math.min(1, 9000 / d);
      const grad = ctx.createLinearGradient(x, y, x + (pos.x / d) * tail, y + (pos.y / d) * tail);
      grad.addColorStop(0, 'rgba(191, 230, 255, 0.9)');
      grad.addColorStop(1, 'rgba(191, 230, 255, 0)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (pos.x / d) * tail, y + (pos.y / d) * tail); ctx.stroke();
      ctx.fillStyle = '#e8f6ff';
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      this.label(ctx, c.name, x, y - 10, '#cfeaff', 3, y);
      this.hits.push({ kind: 'comet', comet: c, x: pos.x, y: pos.y, sx: x, sy: y });
    }

    // The system's ships: those in snapshot range, and the rest from the map's own list (mapDots)
    const ships = this.mapShips();

    // Ghosts: the packs nobody's near (not simulated: worked out here from the populations, state/Populations.ts), as
    // hollow rings in their faction's colour, faint; they're real ships once a pilot comes near, where they're drawn
    const ghosts = this.state.populations.ghosts(this.state.systemId, this.byId.get(this.state.systemId), this.state.getRawServerTick(), this.ghostList);
    if (ghosts.length) {
      ctx.save();
      ctx.lineWidth = 1.2;
      for (const g of ghosts) {
        const x = sx(g.x), y = sy(g.y);
        if (x < -10 || y < -10 || x > w + 10 || y > h + 10) continue;
        ctx.strokeStyle = g.calm ? 'rgba(154, 163, 178, 0.5)' : FACTION_LIST[g.faction]?.color ?? '#ff5a4a';
        ctx.globalAlpha = g.calm ? 0.5 : 0.55;
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }

    // Hostile ships: red, elites amber, bosses orange and bigger; a calm passive pack
    // (data[9], nobody's provoked it) grey
    for (const e of ships) {
      if (e.data?.[0] !== 3) continue;
      const x = sx(e.renderX), y = sy(e.renderY);
      if (x < -10 || y < -10 || x > w + 10 || y > h + 10) continue;
      const rank = e.data?.[4] ?? 0, calm = e.data?.[9] === 1;
      ctx.fillStyle = calm ? '#9aa3b2' : rank === 2 ? '#fb923c' : rank === 1 ? '#ffc857' : '#ff5a4a';
      ctx.beginPath(); ctx.arc(x, y, rank === 2 ? 6 : rank === 1 ? 4.5 : 3, 0, Math.PI * 2); ctx.fill();
      if (!calm) { ctx.strokeStyle = 'rgba(255, 90, 74, 0.35)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, rank ? 8 : 6, 0, Math.PI * 2); ctx.stroke(); }
      this.hits.push({ kind: 'hostile', name: e.name ?? 'Hostile', rating: e.data?.[8] ?? 0, rank, calm, sx: x, sy: y });
    }

    // Civilian freighters (moving)
    for (const e of ships) {
      if (!e.name || e.data?.[0] !== 2) continue;
      const x = sx(e.renderX), y = sy(e.renderY);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(e.renderAngle);
      ctx.fillStyle = '#9fd8ff';
      ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, 4); ctx.lineTo(-4, -4); ctx.closePath(); ctx.fill();
      ctx.restore();
      this.label(ctx, e.name.replace(/^Freighter /, ''), x, y + 14, '#9fd8ff', 1, y);
      this.hits.push({ kind: 'freighter', name: e.name, x: e.renderX, y: e.renderY, sx: x, sy: y });
    }

    // Derelict wrecks (live: they can be shoved, and vanish when broken up)
    for (const e of ships) {
      if (!e.name || e.data?.[0] !== 1) continue;
      const x = sx(e.renderX), y = sy(e.renderY);
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5); ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5); ctx.stroke();
      this.label(ctx, e.name, x, y + 18, '#ffe2a0', 4, y);
      this.hits.push({ kind: 'wreck', name: e.name, x: e.renderX, y: e.renderY, sx: x, sy: y });
    }

    // Your wreck: a beacon with how long it's kept for you
    const wk = this.wreck?.();
    const wkLeft = wk && wk.system === this.state.systemId ? Math.ceil((wk.until - Date.now()) / 1000) : 0;
    if (wk && wkLeft > 0) {
      const x = sx(wk.x), y = sy(wk.y);
      const k = (time * 0.9) % 1;
      ctx.strokeStyle = `rgba(240, 171, 252, ${0.8 * (1 - k)})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 7 + k * 20, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#f0abfc';
      ctx.strokeStyle = '#2a0a2e';
      ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 7); ctx.lineTo(x - 6, y); ctx.closePath(); ctx.fill(); ctx.stroke();
      this.label(ctx, `⚑ Your wreck · ${Math.floor(wkLeft / 60)}:${String(wkLeft % 60).padStart(2, '0')}`, x, y - 14, '#f5c2ff', 9, y);
      this.hits.push({ kind: 'beacon', x: wk.x, y: wk.y, sx: x, sy: y });
    }

    // Station orbits and stations (live positions: they move)
    const me = this.state.entities.get(this.state.playerId);
    for (const e of this.state.entities.values()) {
      if (e.type !== EntityType.Station) continue;
      if (e.isDeterministic && e.semiMajorAxis) {
        ctx.strokeStyle = 'rgba(125, 211, 252, 0.22)';
        ctx.setLineDash([3, 5]);
        ctx.beginPath(); ctx.arc(ox, oy, e.semiMajorAxis * S, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
      const x = sx(e.renderX), y = sy(e.renderY);
      ctx.strokeStyle = '#7dd3fc';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#cfe9ff';
      ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + time * 0.3;
        ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * 7, y + Math.sin(a) * 7); ctx.lineTo(x + Math.cos(a) * 11, y + Math.sin(a) * 11); ctx.stroke();
      }
      this.label(ctx, e.name ?? 'Station', x, y + 22, '#cfe9ff', 7, y);
      this.hits.push({ kind: 'station', name: e.name ?? 'Station', x: e.renderX, y: e.renderY, sx: x, sy: y });
    }

    // Jump gates and rifts (static, from data)
    for (const p of sys?.portals ?? []) {
      const x = sx(p.position.x), y = sy(p.position.y);
      const target = this.byId.get(p.targetSystem);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI / 4);
      ctx.strokeStyle = '#b28cff';
      ctx.lineWidth = 2;
      ctx.strokeRect(-6, -6, 12, 12);
      ctx.restore();
      ctx.fillStyle = '#d9c4ff';
      ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      this.label(ctx, `→ ${target?.name ?? p.targetSystem}`, x, y + 22, '#d9c4ff', 6, y);
      this.hits.push({ kind: 'gate', target, x: p.position.x, y: p.position.y, sx: x, sy: y });
    }
    for (const rift of sys?.rifts ?? []) {
      const x = sx(rift.position.x), y = sy(rift.position.y);
      ctx.strokeStyle = `hsla(${rift.hue ?? 278}, 90%, 72%, 0.95)`;
      ctx.lineWidth = 1.8;
      for (let k = 0; k < 3; k++) {
        ctx.beginPath(); ctx.arc(x, y, 3 + k * 3.5, time * 2.5 + k * 2.1, time * 2.5 + k * 2.1 + 4); ctx.stroke();
      }
      const dest = this.byId.get(rift.destination.system);
      this.label(ctx, rift.label ?? `Rift → ${dest?.name ?? rift.destination.system}`, x, y + 24, '#e7c6ff', 6, y);
      this.hits.push({ kind: 'rift', label: rift.label ?? 'Rift', dest, x: rift.position.x, y: rift.position.y, sx: x, sy: y });
    }

    // Other pilots, near (entities) and far (FarShips: past your view; your party in green, with a ring)
    const party = new Set((this.party?.() ?? []).map((m) => m.eid));
    const pilots: { id: number; name?: string; renderX: number; renderY: number }[] = [];
    for (const e of this.state.entities.values()) if (e.type === EntityType.Player && e.id !== this.state.playerId) pilots.push(e);
    for (const f of this.state.farShips.list(this.state.systemId, this.state.getRawServerTick(), (id) => this.state.entities.has(id) || id === this.state.playerId)) if (f.kind === 4) pilots.push(f);
    for (const e of pilots) {
      const x = sx(e.renderX), y = sy(e.renderY);
      const mate = party.has(e.id);
      ctx.fillStyle = mate ? '#4ade80' : '#60a5fa';
      ctx.beginPath(); ctx.arc(x, y, mate ? 4.5 : 3.5, 0, Math.PI * 2); ctx.fill();
      if (mate) { ctx.strokeStyle = 'rgba(74, 222, 128, 0.7)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke(); }
      if (e.name) this.label(ctx, e.name, x, y - 9, mate ? '#bbf7d0' : '#93c5fd', mate ? 8 : 4, y);
      this.hits.push({ kind: 'ship', id: e.id, name: e.name ?? 'Pilot', x: e.renderX, y: e.renderY, sx: x, sy: y });
    }

    // You: a pulsing beacon with your heading and velocity, drawn last so nothing covers it
    // Boss lairs
    for (const b of BOSS_LAIRS) {
      if (b.system !== this.state.systemId) continue;
      const x = sx(b.lair.x), y = sy(b.lair.y);
      const pulse = 0.5 + 0.5 * Math.sin(time * 2.4);
      ctx.strokeStyle = `rgba(255, 140, 60, ${0.35 + 0.35 * pulse})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 11 + pulse * 3, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#ffb347';
      ctx.font = '700 14px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('☠', x, y + 5);
      ctx.font = '600 11px "Segoe UI", sans-serif';
      ctx.fillText(`${b.name} · lvl ${b.level}`, x, y + 28);
      if (huntedBoss(Date.now(), Object.keys(BOSS_DEFS)) === b.id) {
        ctx.fillStyle = '#fca5a5';
        ctx.fillText('HUNTED THIS WEEK · double rewards', x, y + 42);
      }
    }
    // The autopilot's route: flown stretches dashed, jumps solid, a lodestone it calls at, and the ETA at the end
    const route = me ? this.autoRoute?.() : null;
    const at = this.autoTarget?.();
    if (me && route?.legs.length) {
      ctx.save();
      ctx.lineWidth = 1.5;
      for (const leg of route.legs) {
        const jump = leg.mode === 'jump';
        ctx.strokeStyle = jump ? 'rgba(125, 211, 252, 0.9)' : 'rgba(134, 239, 172, 0.75)';
        ctx.setLineDash(jump ? [] : [6, 6]);
        ctx.lineDashOffset = -time * 20;
        ctx.beginPath(); ctx.moveTo(sx(leg.from.x), sy(leg.from.y)); ctx.lineTo(sx(leg.to.x), sy(leg.to.y)); ctx.stroke();
        if (jump) { ctx.fillStyle = 'rgba(125, 211, 252, 0.9)'; ctx.beginPath(); ctx.arc(sx(leg.to.x), sy(leg.to.y), 3, 0, Math.PI * 2); ctx.fill(); }
      }
      ctx.setLineDash([]);
      if (route.lodestone) {
        const x = sx(route.lodestone.x), y = sy(route.lodestone.y);
        ctx.strokeStyle = 'rgba(196, 181, 253, 0.95)';
        ctx.beginPath(); ctx.moveTo(x, y - 8); ctx.lineTo(x + 8, y); ctx.lineTo(x, y + 8); ctx.lineTo(x - 8, y); ctx.closePath(); ctx.stroke();
      }
      ctx.restore();
      const end = route.legs[route.legs.length - 1].to;
      this.label(ctx, `ETA ${etaText(route.eta)}`, sx(end.x), sy(end.y) + 22, '#86efac', 6, sy(end.y));
    } else if (me && at) {
      ctx.save();
      ctx.strokeStyle = 'rgba(134, 239, 172, 0.75)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 6]);
      ctx.lineDashOffset = -time * 20;
      ctx.beginPath(); ctx.moveTo(sx(me.renderX), sy(me.renderY)); ctx.lineTo(sx(at.x), sy(at.y)); ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = 'rgba(134, 239, 172, 0.9)';
      ctx.beginPath(); ctx.arc(sx(at.x), sy(at.y), 9, 0, Math.PI * 2); ctx.stroke();
    }
    // Pings
    for (const p of this.pings?.() ?? []) {
      const x = sx(p.x), y = sy(p.y);
      const k = (time * 1.4) % 1;
      ctx.strokeStyle = `rgba(253, 230, 138, ${1 - k})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 6 + k * 18, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#fde68a';
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      this.label(ctx, p.name, x, y - 12, '#fde68a', 9, y);
    }
    this.notesOverlay?.(ctx, sx, sy, S, w, h);
    if (me) this.drawJump(ctx, me, sx, sy, S, time);
    this.placeLabels(ctx, me ? { x: sx(me.renderX), y: sy(me.renderY) } : null);
    if (me) this.drawYou(ctx, me, sx(me.renderX), sy(me.renderY), time, w, h);
  }

  /** The jump drive: its reach round you, and while lining up, where you'd land (red if that's somewhere bad) */
  private drawJump(ctx: CanvasRenderingContext2D, me: { renderX: number; renderY: number }, sx: (x: number) => number, sy: (y: number) => number, S: number, time: number): void {
    const j = this.jump?.();
    if (!j || j.reach <= 0) return;
    const x = sx(me.renderX), y = sy(me.renderY);
    const ready = j.phase === 'ready' || j.phase === 'charging';
    const ring = j.reach * S;
    ctx.save();
    ctx.strokeStyle = ready ? `rgba(103, 232, 249, ${j.aiming ? 0.75 : 0.4})` : 'rgba(148, 163, 184, 0.25)';
    ctx.lineWidth = j.aiming ? 1.6 : 1.2;
    ctx.setLineDash([8, 6]);
    ctx.lineDashOffset = -time * 8;
    ctx.beginPath(); ctx.arc(x, y, ring, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    if (ring > 40) this.label(ctx, ready ? `JUMP RANGE ${fmtDist(j.reach)}` : 'JUMP DRIVE COOLING', x, y - ring - 6, ready ? '#a5f3fc' : '#94a3b8', 2, y - ring);
    const aim = this.jumpAim;
    if (!j.aiming || !aim) return;
    const d = Math.min(aim.dist, j.reach);
    const lx = me.renderX + Math.cos(aim.angle) * d, ly = me.renderY + Math.sin(aim.angle) * d;
    const danger = this.landingDanger(lx, ly);
    const col = danger ? '#f87171' : '#67e8f9';
    const px = sx(lx), py = sy(ly);
    ctx.save();
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([4, 5]);
    ctx.lineDashOffset = -time * 30;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(px, py); ctx.stroke();
    ctx.setLineDash([]);
    // The landing reticle
    const pulse = 0.5 + 0.5 * Math.sin(time * (j.phase === 'charging' ? 9 : 4));
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, py, 8 + pulse * 3, 0, Math.PI * 2); ctx.stroke();
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      ctx.beginPath(); ctx.moveTo(px + Math.cos(a) * 5, py + Math.sin(a) * 5); ctx.lineTo(px + Math.cos(a) * 15, py + Math.sin(a) * 15); ctx.stroke();
    }
    ctx.restore();
    const what = aim.label ? `→ ${aim.label}` : `jump ${fmtDist(d)}`;
    this.label(ctx, danger ? `${what} · ⚠ ${danger}` : what, px, py - 20, danger ? '#fca5a5' : '#cffafe', 10, py);
  }

  /**
   * The system's pilotless ships as the map draws them: the ones the client
   * has (snapshot range), then the far ones (FarShips), with the far ones'
   * status in the same places of `data` (kind, faction, rank, rating, calm)
   */
  private mapShips(): { id: number; name?: string; data?: number[]; renderX: number; renderY: number; renderAngle: number }[] {
    const out: { id: number; name?: string; data?: number[]; renderX: number; renderY: number; renderAngle: number }[] = [];
    for (const e of this.state.entities.values()) if (e.type === EntityType.ShipBody) out.push(e);
    const tick = this.state.getRawServerTick();
    for (const f of this.state.farShips.list(this.state.systemId, tick, (id) => this.state.entities.has(id))) {
      // (Other pilots are drawn with the near ones)
      if (f.kind === 4) continue;
      out.push({ id: f.id, name: f.name, renderX: f.renderX, renderY: f.renderY, renderAngle: Math.hypot(f.vx, f.vy) > 0.05 ? Math.atan2(f.vy, f.vx) : 0,
        data: [f.kind, 0, 0, f.faction, f.rank, 0, 0, 0, f.rating, f.calm ? 1 : 0] });
    }
    return out;
  }

  /** What's wrong with landing a jump here (null: nothing): a star's or black hole's hazard margin, the horizon, hostiles close by */
  private landingDanger(x: number, y: number): string | null {
    const sys = this.byId.get(this.state.systemId);
    const cb = this.central() ?? { type: 'sun' };
    const d = Math.hypot(x, y);
    if (!sys?.surface) {
      const r = cb.radius ?? sys?.starRadius ?? 0;
      const near = cb.type === 'black_hole' ? HAZARD_RULES.nearBlackHole : cb.type === 'none' ? undefined : HAZARD_RULES.nearStar;
      const horizon = ((sys?.centralBody as any)?.gravity as { horizon?: number } | undefined)?.horizon ?? 0;
      if (horizon && d < horizon) return 'inside the horizon';
      if (near && r > 0 && d < (near.margin !== undefined ? r + near.margin : (near.radii ?? 0) * r)) return cb.type === 'black_hole' ? 'in the well' : 'too close to the star';
    }
    let n = 0;
    for (const e of this.mapShips()) {
      if (e.data?.[0] !== 3 || e.data?.[9] === 1) continue;
      if (Math.hypot(e.renderX - x, e.renderY - y) < LANDING_HOSTILE_RADIUS) n++;
    }
    return n ? `${n} hostile${n > 1 ? 's' : ''} close by` : null;
  }

  private drawYou(ctx: CanvasRenderingContext2D, me: { renderAngle: number; vx: number; vy: number; renderX: number; renderY: number }, x: number, y: number, time: number, w: number, h: number): void {
    const m = 26;
    if (x < m || y < m || x > w - m || y > h - m) {
      // Off the map: an arrow on the edge pointing at you, with the distance from the view centre
      const cx = w / 2, cy = h / 2, dx = x - cx, dy = y - cy;
      const k = Math.min((cx - m) / Math.max(1e-6, Math.abs(dx)), (cy - m - 30) / Math.max(1e-6, Math.abs(dy)));
      const ex = cx + dx * k, ey = cy + dy * k;
      const cam = this.cam();
      const dist = Math.hypot(me.renderX - cam.x, me.renderY - cam.y);
      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(Math.atan2(dy, dx));
      ctx.fillStyle = '#4ade80';
      ctx.shadowColor = 'rgba(74, 222, 128, 0.9)';
      ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-8, 10); ctx.lineTo(-3, 0); ctx.lineTo(-8, -10); ctx.closePath(); ctx.fill();
      ctx.restore();
      this.label(ctx, `YOU · ${fmtDist(dist)} · press C`, ex - Math.sign(dx) * 40, ey + (dy > 0 ? -16 : 22), '#86efac');
      return;
    }
    // Sweeping pulse rings
    for (let k = 0; k < 2; k++) {
      const p = (time * 0.7 + k * 0.5) % 1;
      ctx.strokeStyle = `rgba(74, 222, 128, ${0.7 * (1 - p)})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 10 + p * 34, 0, Math.PI * 2); ctx.stroke();
    }
    // Crosshair brackets
    ctx.strokeStyle = 'rgba(134, 239, 172, 0.9)';
    ctx.lineWidth = 2;
    const r = 18, b = 6;
    for (const [sxn, syn] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(x + sxn * r, y + syn * (r - b)); ctx.lineTo(x + sxn * r, y + syn * r); ctx.lineTo(x + sxn * (r - b), y + syn * r);
      ctx.stroke();
    }
    // Velocity line, then the ship arrow with a dark outline so it reads on anything
    const sp = Math.hypot(me.vx, me.vy);
    if (sp > 0.2) {
      ctx.strokeStyle = 'rgba(74, 222, 128, 0.75)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (me.vx / sp) * Math.min(80, 20 + sp * 4), y + (me.vy / sp) * Math.min(80, 20 + sp * 4)); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(me.renderAngle);
    ctx.shadowColor = 'rgba(74, 222, 128, 0.9)';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#4ade80';
    ctx.strokeStyle = '#03140a';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(13, 0); ctx.lineTo(-9, 9); ctx.lineTo(-4, 0); ctx.lineTo(-9, -9); ctx.closePath();
    ctx.stroke(); ctx.fill();
    ctx.restore();
    ctx.font = '700 12px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(3, 20, 10, 0.75)';
    const tw = ctx.measureText('YOU').width + 12;
    ctx.fillRect(x - tw / 2, y - 44, tw, 17);
    ctx.fillStyle = '#86efac';
    ctx.fillText('YOU', x, y - 31);
  }

  /** Labels waiting to be placed (while drawing the system view), and measured text widths */
  private labelQueue: { text: string; x: number; y: number; color: string; pri: number; my: number }[] | null = null;
  private labelWidths = new Map<string, number>();

  /**
   * A name by a marker at height `my`. In the system view it's queued: the
   * more important names are placed first, a name that would overlap one
   * already placed tries the other side of its marker, and if that's taken
   * too it's left out (hovering the marker still names it in the tooltip).
   */
  private label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, pri = 5, my = y): void {
    if (this.labelQueue) { this.labelQueue.push({ text, x, y, color, pri, my }); return; }
    this.drawLabel(ctx, text, x, y, color);
  }

  private placeLabels(ctx: CanvasRenderingContext2D, you: { x: number; y: number } | null): void {
    const queue = this.labelQueue ?? [];
    this.labelQueue = null;
    ctx.font = '600 11px "Segoe UI", sans-serif';
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    // Your beacon and its YOU tag stay clear
    if (you) placed.push({ x0: you.x - 24, y0: you.y - 46, x1: you.x + 24, y1: you.y + 20 });
    const hover = this.hover;
    queue.sort((a, b) => b.pri - a.pri);
    for (const l of queue) {
      let w = this.labelWidths.get(l.text);
      if (w === undefined) { w = ctx.measureText(l.text).width; this.labelWidths.set(l.text, w); }
      const hovered = !!hover && Math.abs(hover.sx - l.x) < 1 && Math.abs(hover.sy - l.my) < 1;
      // Its usual spot, then mirrored to the other side of the marker
      for (const y of [l.y, 2 * l.my - l.y + 7]) {
        const box = { x0: l.x - w / 2 - 3, y0: y - 11, x1: l.x + w / 2 + 3, y1: y + 3 };
        if (!hovered && placed.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0)) continue;
        placed.push(box);
        this.drawLabel(ctx, l.text, l.x, y, l.color);
        break;
      }
    }
  }

  private drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
    ctx.font = '600 11px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(2, 4, 12, 0.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  // ---------------------------- Tooltip ----------------------------

  private updateTooltip(): void {
    const hit = this.hover;
    if (!hit || hit.kind === 'ship' && !hit.name) { this.tooltip.style.display = 'none'; return; }
    let html = '';
    if (hit.kind === 'system') {
      const s = hit.sys;
      const cb = s.centralBody?.type ?? 'sun';
      const links = s.portals.map((p) => this.byId.get(p.targetSystem)?.name ?? p.targetSystem);
      const rifts = (s.rifts ?? []).map((r) => this.byId.get(r.destination.system)?.name ?? r.destination.system);
      const here = s.id === this.state.systemId;
      html = `
        <div class="t-name">${escapeHtml(s.name)}</div>
        <div class="t-sub">${escapeHtml((s.sector ?? '').replace(/_/g, ' '))} · ${BODY_NAMES[cb] ?? cb}</div>
        <div class="t-desc">${escapeHtml(s.description)}</div>
        ${(() => { const l = this.locked?.(s.id); return l ? `<div class="t-row" style="color:#fbbf24"><b>🔒 Locked</b> ${escapeHtml(l.hint)}</div>` : ''; })()}
        ${s.hazards.length ? `<div class="t-row"><b>Hazards</b> ${s.hazards.map((h) => HAZARD_NAMES[h] ?? h).join(', ')}</div>` : ''}
        <div class="t-row"><b>Stations</b> ${s.stations.length || 'none'}</div>
        ${this.state.threats[s.id] ? `<div class="t-row"><b>Threat</b> ${threatTag(this.myRating?.() ?? 0, this.state.threats[s.id], '◆')}</div>` : ''}
        ${hazardRows(s.hazardRatings, this.myShip?.() ?? null)}
        ${s.planets?.length ? `<div class="t-row"><b>Planets</b> ${escapeHtml(s.planets.map((p) => p.name).join(', '))}</div>` : ''}
        ${s.derelicts?.length ? `<div class="t-row"><b>Wrecks</b> ${s.derelicts.length}</div>` : ''}
        <div class="t-row"><b>Gates to</b> ${links.length ? escapeHtml(links.join(', ')) : 'none'}</div>
        ${rifts.length ? `<div class="t-row"><b>Rift to</b> ${escapeHtml(rifts.join(', '))}</div>` : ''}
        <div class="t-act">${here ? 'You are here' : 'Click: autopilot there, gate by gate'}${this.onWarp ? ' · Ctrl-click: warp <span>(dev)</span>' : ''}</div>`;
    } else if (hit.kind === 'station') {
      html = `<div class="t-name">${escapeHtml(hit.name)}</div><div class="t-sub">Station · shipyard</div><div class="t-act">Click: autopilot there · Ctrl-click: warp <span>(dev)</span></div>`;
    } else if (hit.kind === 'gate') {
      html = `<div class="t-name">Jump gate</div><div class="t-sub">to ${escapeHtml(hit.target?.name ?? '?')}</div>${this.destRows(hit.target)}<div class="t-desc">Fly in and press ${escapeHtml(boundKeyName('interact', settings.data.bindings))} to jump.</div>${hazardRows(hit.target?.hazardRatings, this.myShip?.() ?? null)}<div class="t-act">Click: autopilot there · Ctrl-click: warp <span>(dev)</span></div>`;
    } else if (hit.kind === 'rift') {
      html = `<div class="t-name">${escapeHtml(hit.label)}</div><div class="t-sub">Rift to ${escapeHtml(hit.dest?.name ?? '?')}</div>${this.destRows(hit.dest)}<div class="t-desc">Fly into the vortex to be pulled through.</div><div class="t-act">Click: autopilot there · Ctrl-click: warp <span>(dev)</span></div>`;
    } else if (hit.kind === 'region') {
      const g = hit.region, st = REGION_STYLE[g.danger] ?? REGION_STYLE.contested;
      const threat = this.state.regionThreats?.[this.state.systemId]?.[g.id];
      html = `<div class="t-name">${escapeHtml(g.name)}</div><div class="t-sub" style="text-transform:none"><span style="color:${st.color}">${st.word}</span> · ${hit.inner ? `${fmtDist(hit.inner)} to ` : 'out to '}${fmtDist(g.outer)} from the centre</div>`
        + (g.description ? `<div class="t-desc">${escapeHtml(g.description)}</div>` : '')
        + (threat ? `<div class="t-row"><b>Threat</b> ${threatTag(this.myRating?.() ?? 0, threat, '◆')}</div>` : '');
    } else if (hit.kind === 'zone') {
      const z = hit.zone;
      html = `<div class="t-name" style="color:${z.color ?? '#e9f2ff'}">${escapeHtml(z.name)}</div><div class="t-sub" style="text-transform:none">${z.x !== undefined ? `${fmtDist(z.outer)} across the spot` : `${fmtDist(z.inner)} to ${fmtDist(z.outer)} from the centre`}</div>${z.description ? `<div class="t-desc">${escapeHtml(z.description)}</div>` : ''}`;
    } else if (hit.kind === 'hostile') {
      const sub = hit.calm ? 'Passive · leaves you be unless provoked' : hit.rank === 2 ? 'Boss' : hit.rank === 1 ? 'Elite hostile' : 'Hostile';
      html = `<div class="t-name">${escapeHtml(hit.name)}</div><div class="t-sub">${sub}</div>${hit.rating ? `<div class="t-row"><b>Rates</b> ${threatTag(this.myRating?.() ?? 0, hit.rating, '◆')}</div>` : ''}<div class="t-act">Hold left to fire (rough aim at this scale)</div>`;
    } else if (hit.kind === 'beacon') {
      html = `<div class="t-name">Your wreck</div><div class="t-sub">Kept for you a while</div><div class="t-desc">Fly back to it to recover what you lost.</div><div class="t-act">Click: autopilot there</div>`;
    } else if (hit.kind === 'moon') {
      const surf = this.byId.get(hit.surface);
      const b = surf?.surface?.bastion;
      html = `<div class="t-name">${escapeHtml(hit.name)}</div><div class="t-sub">Moon of ${escapeHtml(hit.planet.name)} · siege${b?.grade ? ` · Mk ${['', 'I', 'II', 'III', 'IV', 'V'][b.grade]} nights` : ''}</div>`
        + (surf?.description ? `<div class="t-desc">${escapeHtml(surf.description)}</div>` : '')
        + (this.state.threats[hit.surface] ? `<div class="t-row"><b>Threat</b> ${threatTag(this.myRating?.() ?? 0, this.state.threats[hit.surface], '◆')} <span style="color:#64748b">(night 3, solo)</span></div>` : '')
        + `<div class="t-act">Click: autopilot there, then X to descend · Ctrl-click: warp <span>(dev)</span></div>`;
    } else if (hit.kind === 'planet') {
      const pl = hit.planet;
      html = `<div class="t-name">${escapeHtml(pl.name)}</div><div class="t-sub">${PLANET_KINDS[pl.kind] ?? pl.kind}${pl.rings ? ' · rings' : ''}${pl.moons?.length ? ` · ${pl.moons.length} moon${pl.moons.length > 1 ? 's' : ''}` : ''}</div>${pl.description ? `<div class="t-desc">${escapeHtml(pl.description)}</div>` : ''}<div class="t-act">Click: autopilot into orbit · Ctrl-click: warp <span>(dev)</span></div>`;
    } else if (hit.kind === 'freighter') {
      html = `<div class="t-name">${escapeHtml(hit.name)}</div><div class="t-sub">Civilian hauler</div><div class="t-desc">Flies cargo between Sol's stations.</div><div class="t-act">Click: autopilot there · Ctrl-click: warp <span>(dev)</span></div>`;
    } else if (hit.kind === 'comet') {
      html = `<div class="t-name">${escapeHtml(hit.comet.name)}</div><div class="t-sub">Comet · ${Math.round(Math.hypot(hit.x, hit.y) / 1000)}k from the star</div>${hit.comet.description ? `<div class="t-desc">${escapeHtml(hit.comet.description)}</div>` : ''}<div class="t-act">Click: autopilot there · Ctrl-click: warp <span>(dev)</span></div>`;
    } else if (hit.kind === 'structure') {
      html = `<div class="t-name">${escapeHtml(hit.structure.name)}</div><div class="t-sub">Megastructure</div>${hit.structure.description ? `<div class="t-desc">${escapeHtml(hit.structure.description)}</div>` : ''}<div class="t-act">Click: autopilot there · Ctrl-click: warp <span>(dev)</span></div>`;
    } else if (hit.kind === 'lodestone') {
      const l = hit.lodestone;
      const camp = l.zone ? this.byId.get(this.state.systemId)?.zones?.find((z) => z.id === l.zone) : undefined;
      const live = lodestoneLive(l), size = fmtDist(lodestoneSize(l, JUMP) * 2);
      const sub = !live ? `${l.state === 'dead' ? 'Dead' : 'Shattered'}: no charging field · ${size} across`
        : `${l.state === 'scarred' ? 'Scarred · a weaker' : 'Jump-drive'} charging field · ${fmtDist(lodestoneFieldRadius(l, JUMP) * 2)} across`;
      html = `<div class="t-name" style="color:${live ? LODE_COLOR : LODE_DEAD}">◈ ${escapeHtml(lodestoneLabel(l, JUMP))}</div><div class="t-sub">${sub}${l.orbit ? ' · orbiting' : ''}</div>`
        + (l.description ? `<div class="t-desc">${escapeHtml(l.description)}</div>` : '')
        + (live ? `<div class="t-row"><b>Inside</b> the drive recharges ${+(1 + lodestoneChargeOf(l, JUMP)).toFixed(2)}× as fast</div>`
          + `<div class="t-row"><b>After</b> your next jump within ${Math.round(JUMP.lodestonePrimeTicks / 60)}s reaches ${Math.round((lodestoneBoostOf(l, JUMP) - 1) * 100)}% further</div>` : '')
        + (camp ? `<div class="t-row" style="color:#f87171"><b>Camped</b> hostiles wait here (${escapeHtml(camp.name)})</div>` : '')
        + `<div class="t-act">Click: autopilot there · aim a jump here to lock on · Ctrl-click: warp <span>(dev)</span></div>`;
    } else if (hit.kind === 'nest') {
      const n = hit.nest, f = FACTIONS[n.faction];
      const pl = n.around !== undefined ? this.byId.get(this.state.systemId)?.planets?.find((p) => p.id === n.around) : undefined;
      const round = pl ? (n.moon !== undefined ? `orbiting a moon of ${pl.name}` : `orbiting ${pl.name}`) : n.orbit.period ? 'orbiting the centre' : 'anchored';
      html = `<div class="t-name" style="color:${f?.color ?? '#f87171'}">▲ ${escapeHtml(n.name)}</div><div class="t-sub">${escapeHtml(f?.name ?? n.faction)} nest · ${escapeHtml(round)}</div>`
        + (n.description ? `<div class="t-desc">${escapeHtml(n.description)}</div>` : '')
        + `<div class="t-row">Its packs launch from here and roam round it; shoot them down and it sends more in time</div>`
        + `<div class="t-act">Click: autopilot there · Ctrl-click: warp <span>(dev)</span></div>`;
    } else if (hit.kind === 'wayin') {
      const pk = hit.pocket, e = pk.pocket!.entrance, f = e.look ? FACTIONS[e.look.faction] : undefined;
      html = `<div class="t-name" style="color:${f?.color ?? '#fbbf24'}">Way into ${escapeHtml(e.name)}</div><div class="t-sub">${escapeHtml(pk.name)}</div>`
        + `<div class="t-desc">${escapeHtml(pk.description)}</div>`
        + `<div class="t-row">Fly close and press <b>${escapeHtml(boundKeyName('interact', settings.data.bindings))}</b> to go in; fly out past its edge to come back here</div>`
        + `<div class="t-act">Click: autopilot there · aim a jump here to lock on · Ctrl-click: warp <span>(dev)</span></div>`;
    } else if (hit.kind === 'wreck') {
      html = `<div class="t-name">${escapeHtml(hit.name)}</div><div class="t-sub">Derelict hulk</div><div class="t-desc">Break its core for salvage credits.</div><div class="t-act">Click: autopilot there · Ctrl-click: warp <span>(dev)</span></div>`;
    } else {
      html = `<div class="t-name">${escapeHtml(hit.name)}</div><div class="t-sub">Pilot</div><div class="t-act">Click: autopilot alongside</div>`;
    }
    this.tooltip.innerHTML = html;
    this.tooltip.style.display = 'block';
    const w = this.canvas.clientWidth;
    const tw = this.tooltip.offsetWidth, th = this.tooltip.offsetHeight;
    const top = this.canvas.offsetTop;
    let x = hit.sx + 24, y = hit.sy + top - 20;
    if (x + tw > w - 10) x = hit.sx - tw - 24;
    if (y + th > window.innerHeight - 50) y = window.innerHeight - 50 - th;
    this.tooltip.style.left = `${x}px`;
    this.tooltip.style.top = `${Math.max(top + 8, y)}px`;
  }

  /** Tooltip rows for where a gate or rift goes: its threat against your ship, and a line about it */
  private destRows(t: StarSystemData | undefined): string {
    if (!t) return '';
    const threat = this.state.threats[t.id];
    const mine = this.myRating?.() ?? 0;
    let row = '';
    if (threat) {
      const o = outmatch(mine, threat);
      row = `<div class="t-row"><b>Threat</b> <span style="color:${o.color}">◆${Math.round(threat)}${mine ? ` vs your ◆${Math.round(mine)} · ${o.word}` : ''}</span></div>`;
    }
    const line = (t.description ?? '').split(/(?<=[.!?])\s/)[0];
    return row + (line ? `<div class="t-desc">${escapeHtml(line)}</div>` : '');
  }

  private injectStyles(): void {
    const style = document.createElement('style');
    style.textContent = `
      #galaxy-map { position: fixed; inset: 0; z-index: 2500; pointer-events: auto; background: #02040c; font-family: 'Segoe UI', system-ui, sans-serif; color: #cfd8e6; }
      #galaxy-map canvas { position: absolute; z-index: 1; left: 0; top: 52px; width: 100%; height: calc(100% - 52px - 30px); display: block; }
      #galaxy-map .gm-bar { position: absolute; z-index: 2; left: 0; right: 0; top: 0; height: 52px; display: flex; align-items: center; gap: 18px;
        padding: 0 16px; border-bottom: 1px solid rgba(100, 160, 255, 0.18); background: linear-gradient(180deg, rgba(20, 40, 80, 0.55), rgba(2, 4, 12, 0.9)); }
      #galaxy-map .gm-titles { min-width: 260px; }
      #galaxy-map .gm-title { font-size: 16px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: #9fd0ff; }
      #galaxy-map .gm-sub { font-size: 11px; color: #7f93b3; letter-spacing: 0.5px; text-transform: capitalize; }
      #galaxy-map .gm-tabs { display: flex; gap: 4px; margin: 0 auto; background: rgba(10, 20, 40, 0.7); padding: 3px; border-radius: 8px;
        border: 1px solid rgba(100, 160, 255, 0.2); }
      #galaxy-map .gm-tabs button { background: none; border: none; color: #8ea6c8; padding: 6px 18px; border-radius: 6px; cursor: pointer;
        font: 600 12px 'Segoe UI', sans-serif; letter-spacing: 1px; text-transform: uppercase; }
      #galaxy-map .gm-tabs button.on { background: rgba(80, 140, 230, 0.35); color: #e5f0ff; }
      #galaxy-map .gm-tools { display: flex; gap: 6px; }
      #galaxy-map .gm-tools button { width: 32px; height: 32px; border-radius: 6px; border: 1px solid rgba(100, 160, 255, 0.25);
        background: rgba(10, 20, 40, 0.8); color: #cfe0ff; font-size: 16px; cursor: pointer; }
      #galaxy-map .gm-tools button:hover { background: rgba(60, 100, 170, 0.5); }
      #galaxy-map .gm-tools .gm-close { color: #ff8a8a; margin-left: 8px; }
      #galaxy-map .gm-hint { position: absolute; z-index: 2; left: 0; right: 0; bottom: 0; height: 30px; line-height: 30px; text-align: center;
        font-size: 12px; color: #6f84a6; border-top: 1px solid rgba(100, 160, 255, 0.12); }
      #galaxy-map .gm-hint span, #galaxy-map .t-act span { color: #f2d24b; }
      #galaxy-map .gm-tip { position: absolute; z-index: 3; display: none; max-width: 300px; padding: 10px 12px; border-radius: 8px; pointer-events: none;
        background: rgba(8, 14, 28, 0.95); border: 1px solid rgba(120, 170, 255, 0.35); box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5); font-size: 12px; }
      #galaxy-map .t-name { font-size: 15px; font-weight: 700; color: #e9f2ff; }
      #galaxy-map .t-sub { color: #8ea6c8; text-transform: capitalize; margin-bottom: 6px; }
      #galaxy-map .t-desc { color: #b9c6db; margin-bottom: 6px; line-height: 1.35; }
      #galaxy-map .t-row { color: #b9c6db; margin: 2px 0; }
      #galaxy-map .t-row b { color: #8ea6c8; font-weight: 600; margin-right: 4px; }
      #galaxy-map .t-act { margin-top: 8px; color: #7dd3fc; font-weight: 600; }`;
    document.head.appendChild(style);
  }
}

/** A small padlock (locked systems on the galaxy map) */
function drawPadlock(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save();
  ctx.strokeStyle = '#fbbf24';
  ctx.fillStyle = 'rgba(30, 22, 6, 0.9)';
  ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.arc(x, y - 3, 3.6, Math.PI, 0); ctx.stroke();
  ctx.beginPath(); ctx.rect(x - 5, y - 3, 10, 8); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fbbf24';
  ctx.fillRect(x - 0.8, y, 1.6, 2.6);
  ctx.restore();
}
