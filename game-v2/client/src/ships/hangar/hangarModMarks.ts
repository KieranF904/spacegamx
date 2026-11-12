/**
 * @contract client.hangar.mod-marks
 * owns:       the hangar's weapon modifier marks on its 2d canvas: sockets (filled, open, holding a dead block), a
 *             fused mount's diamond, a gun's effect pips, blocks that do nothing, line parts that drop effects; and
 *             the open sockets of a mount in hand
 * needs:      HangarHost (ctx, geoms, bp, derived, deps), ships/build/modMarks geometry, build/modExplain,
 *             @space-game/common (PlacedGeom, PlacedPart)
 * invariants: marks only draw, never change the design — client/src/ships/hangar/marksPure.test.ts
 * extend:     a new modifier mark is a ModMarkKind in build/modMarks.ts and its case in paint() here
 */

import type { PlacedGeom, PlacedPart } from '@space-game/common';
import { modsOf } from '../build/modExplain';
import { modMarks, socketMarks, type ModMark } from '../build/modMarks';
import type { HangarHost } from './host';

type Px = (x: number) => number;
const css = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const DARK = 'rgba(7, 11, 20, 0.85)';

function paint(host: HangarHost, m: ModMark, sx: Px, sy: Px, alpha: number): void {
  const ctx = host.ctx;
  const trace = (pts: ModMark['poly']) => { ctx.beginPath(); pts.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y)))); ctx.closePath(); };
  ctx.globalAlpha = alpha * (m.dim ? 0.4 : 1);
  ctx.lineWidth = 1;
  if (m.kind === 'open' || m.kind === 'dead') {
    // (An empty socket: a dark seat with a bright rim; a dead block's: the same in red)
    trace(m.poly);
    ctx.fillStyle = DARK; ctx.fill();
    ctx.strokeStyle = css(m.color); ctx.lineWidth = 1.5; ctx.stroke();
    return;
  }
  if (m.kind === 'pip') {
    // (Its frame, then the share of it the effect's strength fills, from the bottom)
    const [a, b, c, d] = m.poly, k = Math.max(0, Math.min(1, m.level ?? 1)), top = c[1] - (c[1] - b[1]) * k;
    trace(m.poly);
    ctx.fillStyle = DARK; ctx.fill();
    trace([[a[0], top], [b[0], top], c, d]);
    ctx.fillStyle = css(m.color); ctx.fill();
    trace(m.poly);
    ctx.strokeStyle = DARK; ctx.stroke();
    return;
  }
  trace(m.poly);
  ctx.fillStyle = css(m.color); ctx.fill();
  ctx.strokeStyle = DARK; ctx.stroke();
}

/** The design's modifier marks: what each socket holds, which mounts fused, what every gun's shots carry */
export function drawModMarks(host: HangarHost, sx: Px, sy: Px): void {
  const d = host.derived, mt = host.deps.tuning.modifiers;
  if (!d?.ports || !mt) return;
  const ex = modsOf(host.deps.catalog, host.deps.tuning, host.bp.parts, d);
  if (!ex) return;
  host.ctx.save();
  for (const m of modMarks(ex, d.ports, host.geoms, mt)) paint(host, m, sx, sy, 0.95);
  host.ctx.restore();
}

/** A mount in hand: where its sockets are */
export function drawHandModMarks(host: HangarHost, cand: PlacedPart, g: PlacedGeom, sx: Px, sy: Px): void {
  const marks = socketMarks(cand, g);
  if (!marks.length) return;
  host.ctx.save();
  for (const m of marks) paint(host, m, sx, sy, 1);
  host.ctx.restore();
}
