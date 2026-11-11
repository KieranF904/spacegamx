/**
 * @contract client.system-map.layers-guides
 * owns:       the system view's guide layers: boss lairs, the autopilot's route, pings, the lesson's spots (Jump here)
 * needs:      MapHost (autoRoute, autoTarget, pings, label), MapScene; npm: @space-game/common
 * invariants: drawn over the scenery and traffic, under your own ship — client/src/ui/systemMap/systemMapViews.test.ts
 * extend:     a new guide layer is one function here, called from SystemMapUI.drawSystem
 */

import { etaText } from '../../ships/Autopilot';
import { huntedBoss } from '@space-game/common';
import type { MapHost, MapScene } from './host';
import { guideMarks } from '../../state/guideMarks';
import { BOSS_DEFS, BOSS_LAIRS } from './mapConsts';

export function drawBossLairs(host: MapHost, sc: MapScene): void {
  const { ctx, sx, sy, time } = sc;
  // Boss lairs
  for (const b of BOSS_LAIRS) {
    if (b.system !== host.state.systemId) continue;
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
      ctx.fillText('WEEKLY HUNT · double XP and credits', x, y + 42);
    }
  }
}

export function drawRoute(host: MapHost, sc: MapScene): void {
  const { ctx, sx, sy, time, me } = sc;
  // The autopilot's route: flown stretches dashed, jumps solid, a lodestone it calls at, and the ETA at the end
  const route = me ? host.autoRoute?.() : null;
  const at = host.autoTarget?.();
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
    host.label(ctx, `ETA ${etaText(route.eta)}`, sx(end.x), sy(end.y) + 22, '#86efac', 6, sy(end.y));
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
}

export function drawPings(host: MapHost, sc: MapScene): void {
  const { ctx, sx, sy, time } = sc;
  // Pings
  for (const p of host.pings?.() ?? []) {
    const x = sx(p.x), y = sy(p.y);
    const k = (time * 1.4) % 1;
    ctx.strokeStyle = `rgba(253, 230, 138, ${1 - k})`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 6 + k * 18, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#fde68a';
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    host.label(ctx, p.name, x, y - 12, '#fde68a', 9, y);
  }
}

/** The lesson's spots (the training yard's exit): an amber dashed ring the size of the area that counts, with its words, like the one in flight */
export function drawGuideMarks(sc: MapScene): void {
  const { ctx, sx, sy, S, time } = sc;
  for (const m of guideMarks()) {
    const x = sx(m.x), y = sy(m.y), r = Math.max(14, m.radius * S);
    const pulse = 0.5 + 0.5 * Math.sin(time * 3);
    ctx.save();
    ctx.setLineDash([12, 8]);
    ctx.lineDashOffset = -time * 10;
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = `rgba(251, 191, 36, ${0.6 + pulse * 0.35})`;
    ctx.fillStyle = `rgba(251, 191, 36, ${0.06 + pulse * 0.05})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = 'rgba(251, 191, 36, 0.95)'; ctx.fill();
    ctx.restore();
    // (drawn here, not queued: the exit's name never gives way to another label)
    ctx.save();
    ctx.font = "700 12px 'Segoe UI', sans-serif";
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(5, 9, 18, 0.85)';
    ctx.fillStyle = '#fbbf24';
    ctx.strokeText(m.label.toUpperCase(), x + r + 6, y);
    ctx.fillText(m.label.toUpperCase(), x + r + 6, y);
    ctx.restore();
  }
}
