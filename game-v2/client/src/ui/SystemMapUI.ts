/**
 * @contract client.system-map
 * owns:       the map overlay shell: views, camera, input, hits and hover, the frame loop
 * needs:      systemMap/* modules (layers, galaxyView, marks, tooltip) through the MapHost interface, GameState; npm: @space-game/common
 * invariants: each frame rebuilds hits from the layers, in draw order — none pinned
 * extend:     a new system-view layer is one function in systemMap/layers*.ts, called from drawSystem; a new tooltip case goes in systemMap/tooltip.ts
 */
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

import { EntityType, StarSystemData, type ShipDerived } from '@space-game/common';
import { lodestoneLabel, lodestoneStop } from '@space-game/common';
import type { GameState } from '../state/GameState';
import { type AutoDest, type RouteView } from '../ships/Autopilot';
import type { PartyMemberView } from '@space-game/common';
import { settings } from '../settings/Settings';
import { boundKeyName } from '../input/keybindings';
import systemsFile from '../../../data/systems.json';
import { drawGalaxy, drawGalaxyPin, drawBodyGlyph } from './systemMap/galaxyView';
import { drawJump, landingDanger, drawYou, label, placeLabels, drawLabel } from './systemMap/marks';
import { updateTooltip, destRows, injectStyles } from './systemMap/tooltip';
import { drawRings, drawRegions, drawBelts, drawGravity, drawChargingRing, drawCentral, drawZones, drawPlanets, drawStructures, drawLodestones, drawPocketWays, drawNests, drawComets } from './systemMap/layersWorld';
import { drawGhosts, drawHostiles, drawFreighters, drawDerelicts, drawYourWreck, drawStations, drawGates, drawPilots } from './systemMap/layersTraffic';
import { drawBossLairs, drawRoute, drawPings } from './systemMap/layersGuides';
import { JUMP, SECTOR_COLORS, BODY_NAMES, seeded } from './systemMap/mapConsts';
import type { View, Camera, Fit, Hit } from './systemMap/types';
import { actionable } from './systemMap/types';
import type { MapHost, MapScene } from './systemMap/host';

export class SystemMapUI implements MapHost {
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
  canvas: HTMLCanvasElement;
  /** A layer over the canvas (the same box, under the bar, the hint and the tooltip) for overlays placed with toCanvas */
  readonly overlay: HTMLDivElement;
  private ctx: CanvasRenderingContext2D;
  tooltip: HTMLDivElement;
  private titleEl: HTMLDivElement;
  private subEl: HTMLDivElement;
  private hintEl: HTMLDivElement;
  private hintKey = '';
  private tabs: Record<View, HTMLButtonElement>;
  private visible = false;

  get isOpen(): boolean {
    return this.visible;
  }

  /** A world point in the open system view, as px in the canvas (and `overlay`), into `out`; false if it isn't showing */
  toCanvas(x: number, y: number, out: { x: number; y: number }): boolean {
    if (!this.visible || this.view !== 'system') return false;
    const cam = this.cam();
    out.x = (x - cam.x) * cam.scale + this.canvas.clientWidth / 2;
    out.y = (y - cam.y) * cam.scale + this.canvas.clientHeight / 2;
    return true;
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
  systems: StarSystemData[];
  byId: Map<string, StarSystemData>;
  /** The ghosts drawn this frame (reused) */
  ghostList: import('../state/Populations').PopGhost[] = [];
  sectorColor = new Map<string, string>();
  belt: { inner: number; outer: number } | null = null;
  private liveCentral: { type: string; radius?: number; hue?: number; diskHue?: number; beamHue?: number } | null = null;
  hover: Hit | null = null;
  hits: Hit[] = [];
  /** A press on the map: `pan` drags it; otherwise it's a click on `hit` (cancelled by moving) */
  private drag: { x: number; y: number; camX: number; camY: number; moved: boolean; button: number; pan: boolean; hit: Hit | null } | null = null;
  mouse = { x: 0, y: 0 };
  /** Last cursor position on the page (the map's cursor is worked out from it on opening) */
  private client: { x: number; y: number } | null = null;
  /** Left held on empty space in the system view: the guns fire */
  private fireHeld = false;
  /** The system view keeps your ship where it is on screen (opening from flight, C) until you pan */
  private follow: { x: number; y: number } | null = null;
  private bgStars: [number, number, number, number][] = [];
  private rafId: number | null = null;
  private t0 = performance.now();

  constructor(container: HTMLElement, public state: GameState) {
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
      <div class="gm-over"></div>
      <div class="gm-hint"></div>
      <div class="gm-tip"></div>`;
    // On the body, not the game's UI overlay: that layer ignores pointer events
    // and sits under the HUD
    document.body.appendChild(this.root);
    void container;
    this.canvas = this.root.querySelector('canvas')!;
    this.overlay = this.root.querySelector('.gm-over')!;
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

  cam(): Camera {
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
  beltDotsFor(key: string, seed: number, inner: number, outer: number, n: number): Float32Array {
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

  central() {
    return this.liveCentral ?? this.byId.get(this.state.systemId)?.centralBody ?? null;
  }

  // ---------------------------- Galaxy view ----------------------------

  drawGalaxy(ctx: CanvasRenderingContext2D, sx: (x: number) => number, sy: (y: number) => number, cam: Camera, time: number): void { return drawGalaxy(this, ctx, sx, sy, cam, time); }

  drawGalaxyPin(ctx: CanvasRenderingContext2D, x: number, y: number, time: number): void { return drawGalaxyPin(this, ctx, x, y, time); }

  drawBodyGlyph(ctx: CanvasRenderingContext2D, cb: { type: string; hue?: number; diskHue?: number; beamHue?: number }, starColor: string | undefined, x: number, y: number, r: number, time: number): void { return drawBodyGlyph(this, ctx, cb, starColor, x, y, r, time); }

  // ---------------------------- System view ----------------------------

  private drawSystem(ctx: CanvasRenderingContext2D, sx: (x: number) => number, sy: (y: number) => number, cam: Camera, time: number, w: number, h: number): void {
    const S = cam.scale;
    const sys = this.byId.get(this.state.systemId);
    const cb = this.central() ?? { type: 'sun' };
    // Names are placed after everything's drawn, so they can make way for each other (placeLabels)
    this.labelQueue = [];
    const sc: MapScene = { ctx, sx, sy, cam, S, w, h, time, ox: sx(0), oy: sy(0), sys, cb, ships: this.mapShips(), me: this.state.entities.get(this.state.playerId) };
    const { me } = sc;
    // Back to front: scenery, then traffic, then the guides over them
    drawRings(this, sc);
    drawRegions(this, sc);
    drawBelts(this, sc);
    drawGravity(this, sc);
    drawChargingRing(this, sc);
    drawCentral(this, sc);
    drawZones(this, sc);
    drawPlanets(this, sc);
    drawStructures(this, sc);
    drawLodestones(this, sc);
    drawPocketWays(this, sc);
    drawNests(this, sc);
    drawComets(this, sc);
    drawGhosts(this, sc);
    drawHostiles(this, sc);
    drawFreighters(this, sc);
    drawDerelicts(this, sc);
    drawYourWreck(this, sc);
    drawStations(this, sc);
    drawGates(this, sc);
    drawPilots(this, sc);
    drawBossLairs(this, sc);
    drawRoute(this, sc);
    drawPings(this, sc);
    // You: a pulsing beacon with your heading and velocity, drawn last so nothing covers it
    this.notesOverlay?.(ctx, sx, sy, S, w, h);
    if (me) this.drawJump(ctx, me, sx, sy, S, time);
    this.placeLabels(ctx, me ? { x: sx(me.renderX), y: sy(me.renderY) } : null);
    if (me) this.drawYou(ctx, me, sx(me.renderX), sy(me.renderY), time, w, h);
  }

  drawJump(ctx: CanvasRenderingContext2D, me: { renderX: number; renderY: number }, sx: (x: number) => number, sy: (y: number) => number, S: number, time: number): void { return drawJump(this, ctx, me, sx, sy, S, time); }

  /**
   * The system's pilotless ships as the map draws them: the ones the client
   * has (snapshot range), then the far ones (FarShips), with the far ones'
   * status in the same places of `data` (kind, faction, rank, rating, calm)
   */
  mapShips(): { id: number; name?: string; data?: number[]; renderX: number; renderY: number; renderAngle: number }[] {
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

  landingDanger(x: number, y: number): string | null { return landingDanger(this, x, y); }

  drawYou(ctx: CanvasRenderingContext2D, me: { renderAngle: number; vx: number; vy: number; renderX: number; renderY: number }, x: number, y: number, time: number, w: number, h: number): void { return drawYou(this, ctx, me, x, y, time, w, h); }

  /** Labels waiting to be placed (while drawing the system view), and measured text widths */
  labelQueue: { text: string; x: number; y: number; color: string; pri: number; my: number }[] | null = null;
  labelWidths = new Map<string, number>();

  label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, pri = 5, my = y): void { return label(this, ctx, text, x, y, color, pri, my); }

  placeLabels(ctx: CanvasRenderingContext2D, you: { x: number; y: number } | null): void { return placeLabels(this, ctx, you); }

  drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void { return drawLabel(this, ctx, text, x, y, color); }

  // ---------------------------- Tooltip ----------------------------

  updateTooltip(): void { return updateTooltip(this); }

  destRows(t: StarSystemData | undefined): string { return destRows(this, t); }

  injectStyles(): void { return injectStyles(this); }
}
