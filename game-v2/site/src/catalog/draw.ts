/**
 * Draws a ship plan as an inline SVG, from the part list and the catalog's shape outlines (render.shapes).
 * The ship's nose is at the top, as in the hangar. Used by the Database and the ship gallery.
 */

import { esc, raw, SafeHtml } from '../html.js';
import type { PlanPart, RenderData } from './types.js';

const FALLBACK = '#24324d';
const hex = (c: string | undefined) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : FALLBACK);

/** The size a plan needs, in cells (null: nothing drawable) */
export function planBounds(plan: PlanPart[], render: RenderData): { w: number; h: number; x0: number; y0: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of plan) {
    const pts = render.shapes[p.piece]?.[p.rot + (p.flip ? 4 : 0)];
    if (!pts) continue;
    for (const pair of pts.split(' ')) {
      const [sx, sy] = pair.split(',');
      const x = p.x + Number(sx), y = p.y + Number(sy);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  return Number.isFinite(x0) ? { w: x1 - x0, h: y1 - y0, x0, y0 } : null;
}

export function drawPlan(plan: PlanPart[], render: RenderData, opts: { label: string; className?: string } = { label: 'Ship plan' }): SafeHtml {
  const b = planBounds(plan, render);
  if (!b) return raw('');
  const pad = 0.4;
  const polys = plan.map((p) => {
    const pts = render.shapes[p.piece]?.[p.rot + (p.flip ? 4 : 0)];
    if (!pts) return '';
    const isCore = p.fn === 'core';
    return `<polygon points="${esc(pts)}" transform="translate(${Number(p.x) - b.x0 + pad} ${Number(p.y) - b.y0 + pad})" fill="${hex(render.colors[p.fn])}"${isCore ? ' stroke="#f1f5fb" stroke-width="0.1"' : ''}/>`;
  }).join('');
  const w = b.w + pad * 2, h = b.h + pad * 2;
  return raw(`<svg class="plan ${esc(opts.className ?? '')}" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}" role="img" aria-label="${esc(opts.label)}" preserveAspectRatio="xMidYMid meet"><g stroke="rgba(190,210,240,0.5)" stroke-width="0.05" stroke-linejoin="round">${polys}</g></svg>`);
}
