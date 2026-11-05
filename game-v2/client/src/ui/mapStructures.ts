/**
 * Built structures on the system map. A solar ring (the Helios Array) is drawn as it looks in flight
 * (rendering/solarRing.ts), to scale and at the angle it has turned to: a navy band of collector arrays with a sunlit
 * inner edge, the truss as a silver line, gold hubs every tenth segment, and its Halden arc in slate with a greyseam
 * line. Its segments show once they're a few pixels long. Anything else keeps the plain gold dashes.
 */
import type { StructureData } from '@space-game/common';
import { solarRingAngle, SOLAR_RING } from '../rendering/solarRingGeometry';

export function drawStructure(ctx: CanvasRenderingContext2D, st: StructureData, ox: number, oy: number, S: number, tick: number): void {
  if (st.kind !== 'solar_ring') {
    ctx.strokeStyle = 'rgba(232, 197, 106, 0.75)';
    ctx.lineWidth = Math.max(2, 140 * S);
    ctx.setLineDash([Math.max(2, 200 * S), Math.max(2, 120 * S)]);
    ctx.beginPath(); ctx.arc(ox, oy, st.radius * S, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  const R = st.radius, n = Math.max(12, st.segments), w = (Math.PI * 2) / n, turn = solarRingAngle(tick);
  const L = SOLAR_RING;
  const bandIn = R + L.rimIn, bandOut = R + L.chordIn;
  const arcLine = (r: number, a0 = 0, a1 = Math.PI * 2) => { ctx.beginPath(); ctx.arc(ox, oy, Math.max(0.5, r * S), a0, a1); ctx.stroke(); };
  ctx.save();
  // The collector arrays
  ctx.strokeStyle = 'rgba(38, 46, 118, 0.92)';
  ctx.lineWidth = Math.max(2, (bandOut - bandIn) * S);
  arcLine((bandIn + bandOut) / 2);
  // The Halden arc: slate, a greyseam line along it
  if (st.oldArc) {
    const a0 = (st.oldArc.from - 0.5) * w + turn, a1 = a0 + st.oldArc.count * w;
    ctx.strokeStyle = 'rgba(58, 64, 76, 0.97)';
    arcLine((bandIn + bandOut) / 2, a0, a1);
    ctx.strokeStyle = 'rgba(169, 207, 216, 0.6)';
    ctx.lineWidth = Math.max(0.75, 40 * S);
    arcLine((bandIn + bandOut) / 2, a0, a1);
  }
  // The segments, once they're a few pixels long
  if (w * R * S > 5) {
    ctx.strokeStyle = 'rgba(20, 24, 34, 0.75)';
    ctx.lineWidth = Math.max(0.75, 30 * S);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = (i - 0.5) * w + turn, c = Math.cos(a), s = Math.sin(a);
      ctx.moveTo(ox + c * bandIn * S, oy + s * bandIn * S);
      ctx.lineTo(ox + c * bandOut * S, oy + s * bandOut * S);
    }
    ctx.stroke();
  }
  // The sunlit inner edge, and the truss
  ctx.strokeStyle = 'rgba(255, 224, 160, 0.85)';
  ctx.lineWidth = Math.max(1, 60 * S);
  arcLine(bandIn);
  ctx.strokeStyle = 'rgba(170, 184, 204, 0.85)';
  const truss = (L.chordOut - L.chordIn) * S;
  if (truss > 4) {
    ctx.lineWidth = Math.max(1, 52 * S);
    arcLine(R + L.chordIn); arcLine(R + L.chordOut);
  } else {
    ctx.lineWidth = Math.max(1, truss);
    arcLine(R);
  }
  // The hubs: gold, every tenth segment
  const hub = Math.max(1.6, L.hub * S);
  for (let i = 0; i < n; i += 10) {
    const a = i * w + turn, x = ox + Math.cos(a) * R * S, y = oy + Math.sin(a) * R * S;
    ctx.fillStyle = '#d9b45a';
    ctx.beginPath(); ctx.arc(x, y, hub, 0, Math.PI * 2); ctx.fill();
    if (hub > 4) { ctx.fillStyle = '#2a303b'; ctx.beginPath(); ctx.arc(x, y, hub * 0.55, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}
