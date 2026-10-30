/**
 * Navigation markers: everything worth flying to in this system that's off
 * screen gets a chevron on the screen edge pointing at it, with its name and
 * distance. Stations, jump gates and rifts always; planets, stillstones and
 * derelict wrecks too (dimmer). N (or the Interface settings) toggles them.
 */

import { setStyle, setText } from './domWrite';
import { EntityType, StarSystemData, QuestTarget, planetPosition, cometPosition, lodestonePosition, lodestoneLabel, lodestoneStop, jumpTuning, type ShipTuning } from '@space-game/common';
import shipTuning from '../../../data/ships/tuning.json';
import type { GameState } from '../state/GameState';
import systemsData from '../../../data/systems.json';
import { routeStep } from '../ships/route';

type Kind = 'station' | 'gate' | 'rift' | 'planet' | 'wreck' | 'comet' | 'structure' | 'lodestone' | 'objective' | 'event' | 'party' | 'op';

const STYLE: Record<Kind, { color: string; icon: string; dim?: boolean }> = {
  station: { color: '#7dd3fc', icon: '◆' },
  gate: { color: '#a5f3a1', icon: '⬡' },
  rift: { color: '#d8a6ff', icon: '✺' },
  planet: { color: '#c8d2e0', icon: '●', dim: true },
  wreck: { color: '#ffd166', icon: '✕', dim: true },
  comet: { color: '#bfe6ff', icon: '☄', dim: true },
  structure: { color: '#e8c56a', icon: '◎', dim: true },
  lodestone: { color: '#a3c2cf', icon: '◈', dim: true },
  objective: { color: '#fbbf24', icon: '★' },
  event: { color: '#fb7185', icon: '✦' },
  party: { color: '#4ade80', icon: '◉' },
  op: { color: '#fde68a', icon: '◎' },
};

interface Target { kind: Kind; name: string; x: number; y: number; stop?: number }

const SYSTEMS = (systemsData as { systems: StarSystemData[] }).systems;
const MAX_MARKERS = 14;
const JUMP = jumpTuning(shipTuning as unknown as ShipTuning);

/** How long the list of places worth a marker is kept before it's built again (ms) */
const TARGETS_MS = 150;

export class NavMarkersUI {
  private root: HTMLDivElement;
  private pool: HTMLDivElement[] = [];
  enabled = true;

  constructor(
    private state: GameState,
    private worldToScreen: (x: number, y: number) => { x: number; y: number },
    private objective: () => QuestTarget | null = () => null,
    /** Raids and wrecks happening in this system */
    private events: () => { name: string; x: number; y: number }[] = () => [],
    /** Party members in this system */
    private party: () => { name: string; x: number; y: number }[] = () => [],
    /** Operation sites (beacons, the outpost, wrecks to scan) */
    private ops: () => { name: string; x: number; y: number }[] = () => [],
  ) {
    const style = document.createElement('style');
    style.textContent = `
      .nav-mk { position: absolute; left: 0; top: 0; display: flex; will-change: transform; align-items: center; gap: 5px;
        font: 600 11px 'Segoe UI', system-ui, sans-serif; letter-spacing: 0.5px; white-space: nowrap;
        text-shadow: 0 0 4px #000, 0 0 2px #000; pointer-events: none; }
      .nav-mk .arrow { display: inline-block; font-size: 13px; }
      .nav-mk .dist { opacity: 0.65; font-weight: 400; }`;
    document.head.appendChild(style);
    this.root = document.createElement('div');
    this.root.style.cssText = 'position: fixed; inset: 0; pointer-events: none; z-index: 80; overflow: hidden;';
    document.body.appendChild(this.root);
  }

  /** Hidden (under the map, the hangar, the menu): nothing to place */
  private hidden = false;

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    setStyle(this.root, 'display', hidden ? 'none' : 'block');
  }

  /** Places a jump can lock on to in this system (name and position; `stop`: how far short to land, a stillstone's inside its field, off the stone) */
  snapTargets(): { name: string; x: number; y: number; stop?: number }[] {
    const obj = this.objectiveTarget();
    return [...(obj ? [obj] : []), ...this.ops(), ...this.events(), ...this.party(),
      ...this.targets().filter((t) => t.kind !== 'planet' && t.kind !== 'comet')];
  }

  /** Where the followed job wants you: here, or the way on (a gate, a rift, a planet) */
  objectiveTarget(): Target | null {
    const t = this.objective();
    if (!t) return null;
    const here = this.state.systemId;
    if (t.system === here) {
      if (t.station) {
        for (const e of this.state.entities.values()) {
          if (e.type === EntityType.Station && e.name === t.station) return { kind: 'objective', name: t.label, x: e.renderX, y: e.renderY };
        }
        return null;
      }
      if (t.x !== undefined && t.y !== undefined) return { kind: 'objective', name: t.label, x: t.x, y: t.y };
      return null; // the whole system: you're there
    }
    // The next step on the shortest route: a gate, a rift, down to a planet or up off one (route.ts)
    const me = this.state.entities.get(this.state.playerId);
    const step = routeStep(here, t.system, this.state.getRawServerTick(), me ? { x: me.renderX, y: me.renderY } : undefined);
    return step ? { kind: 'objective', name: `${t.label} · ${step.label}`, x: step.x, y: step.y } : null;
  }

  /** The places worth a marker, rebuilt every TARGETS_MS (they move slowly; scanning every entity each frame doesn't pay) */
  private targetCache: { at: number; system: string; list: Target[] } = { at: -1e9, system: '', list: [] };
  private targets(): Target[] {
    const now = performance.now();
    const c = this.targetCache;
    if (c.system === this.state.systemId && now - c.at < TARGETS_MS) return c.list;
    this.targetCache = { at: now, system: this.state.systemId, list: this.buildTargets() };
    return this.targetCache.list;
  }

  private buildTargets(): Target[] {
    const out: Target[] = [];
    const sys = SYSTEMS.find((s) => s.id === this.state.systemId);
    for (const e of this.state.entities.values()) {
      if (e.type === EntityType.Station) out.push({ kind: 'station', name: e.name ?? 'Station', x: e.renderX, y: e.renderY });
      // Wrecks only: freighters move, and are labelled where they fly
      else if (e.type === EntityType.ShipBody && e.name && e.data?.[0] === 1) out.push({ kind: 'wreck', name: e.name, x: e.renderX, y: e.renderY });
    }
    if (sys) {
      for (const g of sys.portals) {
        const to = SYSTEMS.find((s) => s.id === g.targetSystem);
        out.push({ kind: 'gate', name: `Gate · ${to?.name ?? g.targetSystem}`, x: g.position.x, y: g.position.y });
      }
      for (const r of sys.rifts ?? []) out.push({ kind: 'rift', name: r.label ?? 'Rift', x: r.position.x, y: r.position.y });
      for (const p of sys.planets ?? []) out.push({ kind: 'planet', name: p.name, ...planetPosition(p, this.state.getRawServerTick()) });
      for (const c of sys.comets ?? []) out.push({ kind: 'comet', name: c.name, ...cometPosition(c, this.state.getRawServerTick()) });
      for (const st of sys.structures ?? []) out.push({ kind: 'structure', name: st.name, x: 0, y: -st.radius });
      for (const l of sys.lodestones ?? []) out.push({ kind: 'lodestone', name: lodestoneLabel(l, JUMP), stop: lodestoneStop(l, JUMP), ...lodestonePosition(l, this.state.getRawServerTick()) });
    }
    return out;
  }

  private avoid: Box[] = [];
  private avoidAt = -1e9;

  update(): void {
    if (this.hidden) return;
    if (!this.enabled) { for (const el of this.pool) setStyle(el, 'display', 'none'); return; }
    const me = this.state.entities.get(this.state.playerId);
    if (!me) { for (const el of this.pool) setStyle(el, 'display', 'none'); return; }
    const W = window.innerWidth, H = window.innerHeight;
    const cx = W / 2, cy = H / 2;
    // Markers ride a rectangle inset from the edges, clear of the HUD panels
    const inset = { l: 30, r: 30, t: 30, b: 132 };
    const hud: Box[] = [
      { x0: 0, y0: 0, x1: 210, y1: 262 },                   // ship schematic
      { x0: W - 300, y0: 0, x1: W, y1: 222 },               // minimap / net stats
      { x0: cx - 300, y0: H - 140, x1: cx + 300, y1: H },   // hotbar + jump gauge
      { x0: 0, y0: H - 72, x1: 345, y1: H },                // chat
    ];
    // Panels that move or grow (the job tracker, the pilot readout): measured 4 times a second, not
    // every frame (reading layout every frame makes the browser lay the page out every frame)
    const now = performance.now();
    if (now - this.avoidAt > 250) {
      this.avoidAt = now;
      this.avoid = [];
      document.querySelectorAll<HTMLElement>('[data-hud-avoid]').forEach((el) => {
        if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return;
        const r = el.getBoundingClientRect();
        if (r.width && r.height) this.avoid.push({ x0: r.left - 6, y0: r.top - 6, x1: r.right + 6, y1: r.bottom + 6 });
      });
    }
    hud.push(...this.avoid);

    const obj = this.objectiveTarget();
    const evs: Target[] = [
      ...this.events().map((e) => ({ kind: 'event' as Kind, name: e.name, x: e.x, y: e.y })),
      ...this.ops().map((e) => ({ kind: 'op' as Kind, name: e.name, x: e.x, y: e.y })),
      ...this.party().map((e) => ({ kind: 'party' as Kind, name: e.name, x: e.x, y: e.y })),
    ];
    const list = [...(obj ? [obj] : []), ...evs, ...this.targets()]
      .map((t) => ({ ...t, d: Math.hypot(t.x - me.renderX, t.y - me.renderY), s: this.worldToScreen(t.x, t.y) }))
      .filter((t) => t.s.x < 0 || t.s.x > W || t.s.y < 0 || t.s.y > H) // on screen it's already visible
      .sort((a, b) => rank(a.kind) - rank(b.kind) || (STYLE[a.kind].dim ? 1 : 0) - (STYLE[b.kind].dim ? 1 : 0) || a.d - b.d)
      .slice(0, MAX_MARKERS);

    while (this.pool.length < list.length) {
      const el = document.createElement('div');
      el.className = 'nav-mk';
      el.innerHTML = '<span class="arrow">➤</span><span class="ic"></span><span class="nm"></span><span class="dist"></span>';
      this.root.appendChild(el);
      this.pool.push(el);
    }

    const placed: Box[] = [...hud];
    this.pool.forEach((el, i) => {
      const t = list[i];
      if (!t) { setStyle(el, 'display', 'none'); return; }
      const st = STYLE[t.kind];
      // Where the direction to the target leaves the inset rectangle
      const dx = t.s.x - cx, dy = t.s.y - cy;
      const kx = dx > 0 ? (W - inset.r - cx) / dx : dx < 0 ? (inset.l - cx) / dx : Infinity;
      const ky = dy > 0 ? (H - inset.b - cy) / dy : dy < 0 ? (inset.t - cy) / dy : Infinity;
      const k = Math.min(kx, ky);
      const onSide = kx < ky; // left/right edge: slide vertically; top/bottom: horizontally
      const bx = cx + dx * k, by = cy + dy * k;
      const dist = formatDist(t.d);
      const w = (t.name.length + dist.length) * 6.4 + 40, h = 17;
      // Slide along the edge until it overlaps neither another marker nor a HUD panel
      let spot: { x: number; y: number } | null = null;
      for (let n = 0; n < 60 && !spot; n++) {
        const off = (n % 2 ? 1 : -1) * Math.ceil(n / 2) * 19;
        const x = Math.max(inset.l + w / 2 - 20, Math.min(W - inset.r - w / 2 + 20, onSide ? bx : bx + off));
        const y = Math.max(inset.t, Math.min(H - inset.b, onSide ? by + off : by));
        const box = { x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 };
        if (!placed.some((o) => box.x0 < o.x1 && box.x1 > o.x0 && box.y0 < o.y1 && box.y1 > o.y0)) {
          placed.push(box);
          spot = { x, y };
        }
      }
      if (!spot) { setStyle(el, 'display', 'none'); return; }
      // (Only what changed is written: every write makes the browser restyle)
      setStyle(el, 'display', 'flex');
      setStyle(el, 'transform', `translate(${Math.round(spot.x)}px, ${Math.round(spot.y)}px) translate(-50%, -50%)`);
      setStyle(el, 'color', st.color);
      setStyle(el, 'opacity', st.dim ? '0.6' : '0.95');
      setStyle(el, 'flexDirection', dx > 0 ? 'row-reverse' : 'row');
      setStyle(el.children[0] as HTMLSpanElement, 'transform', `rotate(${Math.atan2(dy, dx).toFixed(2)}rad)`);
      setText(el.children[1], st.icon);
      setText(el.children[2], t.name);
      setText(el.children[3], dist);
    });
  }
}

interface Box { x0: number; y0: number; x1: number; y1: number }

/** Objectives first, then events, then everything else */
function rank(k: Kind): number {
  return k === 'objective' ? 0 : k === 'op' || k === 'party' ? 1 : k === 'event' ? 2 : 3;
}

function formatDist(d: number): string {
  return d >= 1000 ? `${(d / 1000).toFixed(d >= 10000 ? 0 : 1)}k` : `${Math.round(d)}`;
}
