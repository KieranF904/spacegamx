/**
 * @contract client.ships.build-power-flow-view
 * owns:       drawing the power flow overlay (powerFlow.ts) onto a canvas (the hangar's animated layer) or a pixi Graphics (the
 *             world build view), through one small sink, plus the legend words both editors show
 * needs:      powerFlow.ts (the data), PlacedGeom outlines; npm: pixi.js (type only)
 * invariants: the layers are independent (the hangar's own overlay already draws the lines and port glyphs, so it asks for
 *             pulses and verdicts only) — client/src/ships/build/powerFlow.test.ts
 *             the animated canvas layer runs its frame loop only while it has something to show — none pinned
 * extend:     a new thing drawn is a FlowSink call in drawFlow(); a new target (another renderer) is one more FlowSink
 */

import type { Graphics } from 'pixi.js';
import type { PlacedGeom, Vec2 } from '@space-game/common';
import { PS_CLASH, PS_LINKED, PS_OPEN, PS_WASTE } from '@space-game/common';
import { portTriangle, pulsesOn, type PortMark, type PowerFlow } from './powerFlow';

/** Everything the overlay draws, in grid cells (widths too); each target maps to its own pixels */
export interface FlowSink {
  line(x0: number, y0: number, x1: number, y1: number, widthCells: number, color: number, alpha: number): void;
  dot(x: number, y: number, radiusCells: number, color: number, alpha: number): void;
  tri(pts: [Vec2, Vec2, Vec2], color: number, alpha: number, filled: boolean, widthCells: number): void;
  poly(pts: readonly Vec2[], fill: number, fillAlpha: number, line: number, lineAlpha: number, widthCells: number): void;
}

export interface FlowLayers { tints?: boolean; lines?: boolean; ports?: boolean; verdicts?: boolean; pulses?: boolean }
/** The key that toggles the overlay in both editors (the hangar also keeps E; in the world E is strafe) */
export const FLOW_KEY = 'KeyU';
export const ALL_LAYERS: Required<FlowLayers> = { tints: true, lines: true, ports: true, verdicts: true, pulses: true };

export const FLOW_COLORS = {
  out: 0xfbbf24, in: 0x60a5fa, bad: 0xef4444, waste: 0xfb923c, aug: 0xc084fc, ok: 0x4ade80, dead: 0x64748b, full: 0xfde68a, line: 0xf59e0b, short: 0xfb923c, pulse: 0xfff7d6,
} as const;

function portColor(m: PortMark): number {
  if (m.state === PS_LINKED) return m.dir === 1 ? FLOW_COLORS.out : FLOW_COLORS.in;
  if (m.state === PS_WASTE) return FLOW_COLORS.waste;
  if (m.state === PS_CLASH || m.state === PS_OPEN) return FLOW_COLORS.bad;
  return FLOW_COLORS.dead;
}

/** Draw the flow into `sink`. `geoms` are the design's parts (outlines for the tints, centres for touch links); `t` is seconds */
export function drawFlow(sink: FlowSink, flow: PowerFlow, geoms: readonly PlacedGeom[], layers: FlowLayers, t: number): void {
  if (layers.tints) {
    for (const k of flow.tints) {
      const g = geoms[k.part];
      if (!g) continue;
      const c = k.none ? FLOW_COLORS.bad : FLOW_COLORS.short;
      sink.poly(g.polygon, c, k.none ? 0.2 : 0.18, c, 0.95, 0.045);
    }
  }
  if (layers.lines) {
    for (const s of flow.segments) {
      let { x0, y0, x1, y1 } = s;
      if (s.touch) {
        const a = geoms[s.from]?.centroid, b = geoms[s.to]?.centroid;
        if (!a || !b) continue;
        [x0, y0, x1, y1] = [a[0], a[1], b[0], b[1]];
      }
      const w = s.live ? 0.04 + 0.11 * s.load : 0.035;
      sink.line(x0, y0, x1, y1, w + 0.05, 0x03050a, 0.85);
      sink.line(x0, y0, x1, y1, w, !s.live ? FLOW_COLORS.dead : s.aug ? FLOW_COLORS.aug : s.load > 0.98 ? FLOW_COLORS.full : FLOW_COLORS.line, s.live ? 0.95 : 0.55);
    }
  }
  if (layers.ports) for (const m of flow.marks) if (m.kind === 'port') portGlyph(sink, m);
  if (layers.pulses) {
    for (const s of flow.segments) for (const [x, y] of pulsesOn(s, t)) sink.dot(x, y, 0.045 + 0.04 * s.load, FLOW_COLORS.pulse, 0.95);
  }
  if (layers.verdicts) {
    for (const m of flow.marks) {
      if (m.kind === 'tick') tick(sink, m.x, m.y);
      else if (m.kind === 'cross') cross(sink, m.x, m.y);
    }
  }
}

function portGlyph(sink: FlowSink, m: PortMark): void {
  const c = portColor(m), tri = portTriangle(m);
  sink.tri(tri, 0x03050a, 0.85, false, 0.09);
  if (m.dir === 1) sink.tri(tri, c, 1, true, 0.03);
  else sink.tri(tri, c, 1, false, 0.04);
  if (m.aug) sink.dot((tri[0][0] + tri[1][0] + tri[2][0]) / 3, (tri[0][1] + tri[1][1] + tri[2][1]) / 3, 0.04, FLOW_COLORS.aug, 1);
}

/** A green check where two ports meet correctly */
function tick(sink: FlowSink, x: number, y: number): void {
  const a: Vec2 = [x - 0.1, y], b: Vec2 = [x - 0.03, y + 0.08], c: Vec2 = [x + 0.12, y - 0.1];
  for (const [w, col, al] of [[0.1, 0x03050a, 0.85], [0.05, FLOW_COLORS.ok, 1]] as const) {
    sink.line(a[0], a[1], b[0], b[1], w, col, al);
    sink.line(b[0], b[1], c[0], c[1], w, col, al);
  }
}

/** A red cross on an out facing nothing or a wall, an in with no source, or a clash */
function cross(sink: FlowSink, x: number, y: number): void {
  const r = 0.1;
  for (const [w, col, al] of [[0.11, 0x03050a, 0.85], [0.055, FLOW_COLORS.bad, 1]] as const) {
    sink.line(x - r, y - r, x + r, y + r, w, col, al);
    sink.line(x + r, y - r, x - r, y + r, w, col, al);
  }
}

// ---------------------------------------------------------------- targets

const css = (c: number, a: number) => `rgba(${(c >> 16) & 255}, ${(c >> 8) & 255}, ${c & 255}, ${a})`;

export interface CanvasFlowView { px: number; cx: number; cy: number; w: number; h: number }

/** A sink for a 2d canvas whose transform is already the css-pixel one */
export function canvasSink(ctx: CanvasRenderingContext2D, v: CanvasFlowView): FlowSink {
  const sx = (x: number) => (x - v.cx) * v.px + v.w / 2, sy = (y: number) => (y - v.cy) * v.px + v.h / 2;
  const wid = (cells: number) => Math.max(1, cells * v.px);
  return {
    line(x0, y0, x1, y1, w, c, a) {
      ctx.strokeStyle = css(c, a); ctx.lineWidth = wid(w); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(sx(x0), sy(y0)); ctx.lineTo(sx(x1), sy(y1)); ctx.stroke();
    },
    dot(x, y, r, c, a) {
      ctx.fillStyle = css(c, a);
      ctx.beginPath(); ctx.arc(sx(x), sy(y), Math.max(1.5, r * v.px), 0, Math.PI * 2); ctx.fill();
    },
    tri(p, c, a, filled, w) {
      ctx.beginPath(); ctx.moveTo(sx(p[0][0]), sy(p[0][1])); ctx.lineTo(sx(p[1][0]), sy(p[1][1])); ctx.lineTo(sx(p[2][0]), sy(p[2][1])); ctx.closePath();
      if (filled) { ctx.fillStyle = css(c, a); ctx.fill(); } else { ctx.strokeStyle = css(c, a); ctx.lineWidth = wid(w); ctx.lineJoin = 'round'; ctx.stroke(); }
    },
    poly(pts, f, fa, l, la, w) {
      ctx.beginPath();
      pts.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
      ctx.closePath();
      ctx.fillStyle = css(f, fa); ctx.fill(); ctx.strokeStyle = css(l, la); ctx.lineWidth = wid(w); ctx.stroke();
    },
  };
}

/** A sink for a pixi Graphics in the world: `at` maps a grid point to the world, `cs` is world units a cell */
export function pixiSink(g: Graphics, at: (gx: number, gy: number) => [number, number], cs: number): FlowSink {
  return {
    line(x0, y0, x1, y1, w, c, a) {
      const A = at(x0, y0), B = at(x1, y1);
      g.moveTo(A[0], A[1]).lineTo(B[0], B[1]).stroke({ width: w * cs, color: c, alpha: a, cap: 'round' });
    },
    dot(x, y, r, c, a) { const P = at(x, y); g.circle(P[0], P[1], r * cs).fill({ color: c, alpha: a }); },
    tri(p, c, a, filled, w) {
      const flat: number[] = [];
      for (const [x, y] of p) { const P = at(x, y); flat.push(P[0], P[1]); }
      if (filled) g.poly(flat).fill({ color: c, alpha: a }); else g.poly(flat).stroke({ width: w * cs, color: c, alpha: a, join: 'round' });
    },
    poly(pts, f, fa, l, la, w) {
      const flat: number[] = [];
      for (const [x, y] of pts) { const P = at(x, y); flat.push(P[0], P[1]); }
      if (flat.length < 6) return;
      g.poly(flat).fill({ color: f, alpha: fa });
      g.poly(flat).stroke({ width: w * cs, color: l, alpha: la });
    },
  };
}

// ---------------------------------------------------------------- legend

/** The legend's lines. `asDesigned`: some parts are planned and not built yet (the flow is how the design runs once built) */
export function flowLegend(key: string, asDesigned: boolean): string[] {
  return [
    `POWER FLOW (${key})${asDesigned ? ' · as designed' : ''}`,
    'moving dots: power flowing, thicker = more',
    '▲ out · ▽ in · ✓ linked · ✗ nothing to meet',
    'amber tint: gets less power than it draws',
  ];
}

export function flowLegendHtml(key: string, asDesigned: boolean): string {
  const [head, ...rest] = flowLegend(key, asDesigned);
  return `<b style="color:#ffb547">${head}</b>` + rest.map((s) => `<div>${s.replace('✓', '<span style="color:#4ade80">✓</span>').replace('✗', '<span style="color:#ef4444">✗</span>')}</div>`).join('');
}

// ---------------------------------------------------------------- the hangar's animated layer

/** What the layer needs to draw a frame */
export interface FlowFrame { flow: PowerFlow; geoms: readonly PlacedGeom[]; view: CanvasFlowView & { dpr: number } }

/**
 * A canvas laid over the hangar's grid that animates the flow (moving pulses, ticks and crosses) with its own frame loop,
 * so the hangar itself isn't redrawn every frame. Call show() from the hangar's draw (the view or design moved) and hide()
 * when the overlay is off; the loop stops by itself when hidden.
 */
export class FlowCanvasLayer {
  readonly canvas: HTMLCanvasElement;
  private frame: FlowFrame | null = null;
  private raf = 0;

  constructor(parent: HTMLElement, private layers: FlowLayers = { pulses: true, verdicts: true }) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:absolute; left:0; top:0; width:100%; height:100%; display:block; pointer-events:none;';
    parent.appendChild(this.canvas);
  }

  show(f: FlowFrame): void {
    this.frame = f;
    const W = Math.round(f.view.w * f.view.dpr), H = Math.round(f.view.h * f.view.dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    this.paint();
    if (!this.raf && typeof requestAnimationFrame === 'function') this.raf = requestAnimationFrame(this.tick);
  }

  hide(): void {
    if (!this.frame) return;
    this.frame = null;
    this.clear();
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
  }

  dispose(): void { this.hide(); this.canvas.remove(); }

  private tick = (): void => {
    this.raf = 0;
    if (!this.frame) return;
    this.paint();
    this.raf = requestAnimationFrame(this.tick);
  };

  private clear(): void {
    const c = this.canvas.getContext('2d');
    if (!c) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private paint(): void {
    const f = this.frame, c = this.canvas.getContext('2d');
    if (!f || !c) return;
    c.setTransform(f.view.dpr, 0, 0, f.view.dpr, 0, 0);
    c.clearRect(0, 0, f.view.w, f.view.h);
    drawFlow(canvasSink(c, f.view), f.flow, f.geoms, this.layers, performance.now() / 1000);
  }
}
