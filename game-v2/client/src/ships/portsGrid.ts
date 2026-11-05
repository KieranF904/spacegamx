/**
 * The hangar's ports tools, in one place so HangarUI only calls in (docs/areas/hangar-ui.md): the energy overlay
 * (portsOverlay.ts) with the load test it shows, the port under the mouse and its tooltip, the part in hand's ports, and
 * the POWER panel's load-test rows. The load tests run once per design (common power/portsLoadTest.ts, cached per
 * layout); the part in hand's ports are worked out once per position, turn and flip.
 */

import {
  PORTS_SCENARIOS, portsLoadTestCached, portsView, previewPorts,
  type Catalog, type PlacedGeom, type PlacedPart, type PortPreview, type PortsScenario, type ShipDerived, type Vec2,
} from '@space-game/common';
import { PortsOverlay, ghostHint, portNear, type OverlayView } from './portsOverlay';
import { SCENARIO_LABEL, loadRow, portTipHtml } from './portsReport';

export class PortsGrid {
  /** Which load test the overlay's flows, fills and shares come from */
  scenario: PortsScenario = 'both';
  private overlay = new PortsOverlay();
  /** The port under the mouse (an index into portsView's ports), -1 none */
  private hoverAt = -1;
  private ghostKey = '';
  private ghostFor: ShipDerived | null = null;
  private ghostVal: PortPreview[] = [];
  private occFor: readonly PlacedGeom[] | null = null;
  private occ = new Map<string, number>();

  /** A port is under the mouse (the part in hand isn't drawn then: a port sits on a part, so it couldn't go there) */
  get hovering(): boolean { return this.hoverAt >= 0; }
  /** The overlay's layer redraws so far (a check that moving the mouse doesn't redraw it) */
  get redraws(): number { return this.overlay.redraws; }

  /** Find the port under the mouse (grid units); null derived: the overlay is off */
  hover(d: ShipDerived | null, at: Vec2 | null): void {
    this.hoverAt = d?.ports && at ? portNear(portsView(d.ports), at[0], at[1]) : -1;
  }

  draw(ctx: CanvasRenderingContext2D, d: ShipDerived, geoms: readonly PlacedGeom[], v: OverlayView): void {
    this.overlay.draw(ctx, d, geoms, portsLoadTestCached(d, this.scenario), SCENARIO_LABEL[this.scenario], v);
    if (this.hoverAt >= 0) this.overlay.drawHover(ctx, d, geoms, this.hoverAt, v);
  }

  /** The port tooltip for the port under the mouse: a key (rebuilt only when it changes) and its html */
  tip(d: ShipDerived | null, name: (i: number) => string): { key: string; html: () => string } | null {
    if (this.hoverAt < 0 || !d?.ports) return null;
    const L = d.ports, k = this.hoverAt, s = this.scenario;
    return {
      key: `${k}:${s}`,
      html: () => {
        const r = portsLoadTestCached(d, s);
        return portTipHtml(portsView(L), k, { name, scenario: SCENARIO_LABEL[s], flow: r ? (l) => r.flow[l] : undefined });
      },
    };
  }

  /** The part in hand's ports and what they would meet (cached per design and position, turn, flip and facing) */
  preview(d: ShipDerived | null, geoms: readonly PlacedGeom[], cand: PlacedPart, g: PlacedGeom, catalog: Catalog): PortPreview[] {
    const key = `${cand.fn}|${cand.piece}|${cand.x}|${cand.y}|${cand.rot}|${cand.flip}|${cand.facing ?? ''}`;
    if (key === this.ghostKey && d === this.ghostFor) return this.ghostVal;
    this.ghostKey = key; this.ghostFor = d;
    const fn = catalog.functions.get(cand.fn);
    if (this.occFor !== geoms) {
      this.occFor = geoms; this.occ.clear();
      geoms.forEach((q, i) => { for (const c of q.cells) this.occ.set(`${c[0]},${c[1]}`, i); });
    }
    this.ghostVal = fn ? previewPorts(d?.ports, cand, fn, g.cells, (x, y) => this.occ.get(`${x},${y}`) ?? -1) : [];
    return this.ghostVal;
  }

  /** Draw the part in hand's ports; with `hint`, the words under it (what they would link to) */
  drawGhost(ctx: CanvasRenderingContext2D, d: ShipDerived | null, geoms: readonly PlacedGeom[], cand: PlacedPart, g: PlacedGeom, catalog: Catalog, v: OverlayView, hint: boolean, name: (i: number) => string): void {
    const pv = this.preview(d, geoms, cand, g, catalog);
    if (!pv.length) return;
    this.overlay.drawGhost(ctx, geoms, pv, v);
    const h = hint ? ghostHint(pv, name) : null;
    if (!h) return;
    const fs = 11, x = (g.bbox.minX - v.cx) * v.px + v.w / 2, y = (g.bbox.maxY - v.cy) * v.px + v.h / 2 + 18;
    ctx.font = `600 ${fs}px 'Segoe UI', sans-serif`;
    const tw = ctx.measureText(h.text).width + 10;
    ctx.fillStyle = 'rgba(7, 11, 20, 0.9)'; ctx.fillRect(x, y - 12, tw, 17);
    ctx.fillStyle = h.tone === 'ok' ? '#67e8f9' : h.tone === 'warn' ? '#fdba74' : '#fca5a5';
    ctx.fillText(h.text, x + 5, y);
  }
}

/**
 * The POWER panel's load test for a ports design: a row per scenario (firing while cruising, boosting, both) with how
 * long the ship keeps full power, what each kind of consumer then gets, and the stores. The row the overlay shows is
 * marked; a click on a row shows that one (data-scn), and the toggle (data-act="energy") shows or hides the overlay
 */
export function portsPanelHtml(d: ShipDerived, shown: PortsScenario, on: boolean, name: (i: number) => string): string {
  if (!d.ports) return '';
  const color = { ok: '#4ade80', warn: '#fbbf24', bad: '#f87171', dim: '#6b7a93' } as const;
  let html = `<div style="display:flex; align-items:center; margin:8px 0 3px; font-size:11px"><span style="color:#8ea0bd; letter-spacing:1px">LOAD TEST</span>`
    + `<button data-act="energy" style="margin-left:auto; background:${on ? '#24406b' : '#0f1626'}; color:#cfd8e6; border:1px solid ${on ? '#5fd4c4' : '#2a3a5a'}; border-radius:4px; padding:1px 7px; cursor:pointer; font-size:11px" title="The energy overlay on the grid (E): ports, links and their flow, stores, what runs short">${on ? 'On grid ✓' : 'Show on grid'}</button></div>`;
  for (const s of PORTS_SCENARIOS) {
    const r = portsLoadTestCached(d, s);
    if (!r) continue;
    const row = loadRow(r, name), sel = on && s === shown;
    html += `<div data-scn="${s}" style="cursor:pointer; padding:3px 5px; margin:1px 0; border-radius:4px; font-size:11px; border:1px solid ${sel ? '#5fd4c4' : 'transparent'}; background:${sel ? '#13223b' : 'transparent'}" title="The ship's own power tick run for ${r.seconds} s from full, every gun firing flat out${s === 'fire' ? ' while the engines cruise' : ''}${s !== 'fire' ? ' and the forward engines boosting' : ''}, against the same ship with unlimited power. Click to show it on the grid">`
      + `<div style="display:flex; gap:6px"><span style="color:#cfd8e6; white-space:nowrap">${row.label}</span><span style="margin-left:auto; text-align:right; color:${color[row.tone]}">${esc(row.text)}</span></div>`
      + `<div style="color:#6b7a93; text-align:right">${esc(row.stores)}</div></div>`;
  }
  return html;
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
