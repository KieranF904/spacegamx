/**
 * @contract client.systemMap.layersTraffic
 * owns:       the system view's moving layers: ghosts, hostiles, freighters, wrecks, stations, gates, rifts, other pilots
 * needs:      MapHost (state, hits, label, party, wreck), MapScene
 * invariants: layers push hits in draw order, so later ones win ties — none pinned
 * extend:     a new traffic layer is one function here, called from SystemMapUI.drawSystem
 */

import { EntityType } from '@space-game/common';
import type { MapHost, MapScene } from './host';
import { FACTION_LIST } from './mapConsts';

export function drawGhosts(host: MapHost, sc: MapScene): void {
  const { ctx, sx, sy, w, h, ships } = sc;
  // Ghosts: the packs nobody's near (not simulated: worked out here from the populations, state/Populations.ts), as
  // hollow rings in their faction's colour, faint; they're real ships once a pilot comes near, where they're drawn
  const ghosts = host.state.populations.ghosts(host.state.systemId, host.byId.get(host.state.systemId), host.state.getRawServerTick(), host.ghostList);
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
}

export function drawHostiles(host: MapHost, sc: MapScene): void {
  const { ctx, sx, sy, w, h, ships } = sc;
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
    host.hits.push({ kind: 'hostile', name: e.name ?? 'Hostile', rating: e.data?.[8] ?? 0, rank, calm, sx: x, sy: y });
  }
}

export function drawFreighters(host: MapHost, sc: MapScene): void {
  const { ctx, sx, sy, ships } = sc;
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
    host.label(ctx, e.name.replace(/^Freighter /, ''), x, y + 14, '#9fd8ff', 1, y);
    host.hits.push({ kind: 'freighter', name: e.name, x: e.renderX, y: e.renderY, sx: x, sy: y });
  }
}

export function drawDerelicts(host: MapHost, sc: MapScene): void {
  const { ctx, sx, sy, ships } = sc;
  // Derelict wrecks (live: they can be shoved, and vanish when broken up)
  for (const e of ships) {
    if (!e.name || e.data?.[0] !== 1) continue;
    const x = sx(e.renderX), y = sy(e.renderY);
    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5); ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5); ctx.stroke();
    host.label(ctx, e.name, x, y + 18, '#ffe2a0', 4, y);
    host.hits.push({ kind: 'wreck', name: e.name, x: e.renderX, y: e.renderY, sx: x, sy: y });
  }
}

export function drawYourWreck(host: MapHost, sc: MapScene): void {
  const { ctx, sx, sy, time } = sc;
  // Your wreck: a beacon with how long it's kept for you
  const wk = host.wreck?.();
  const wkLeft = wk && wk.system === host.state.systemId ? Math.ceil((wk.until - Date.now()) / 1000) : 0;
  if (wk && wkLeft > 0) {
    const x = sx(wk.x), y = sy(wk.y);
    const k = (time * 0.9) % 1;
    ctx.strokeStyle = `rgba(240, 171, 252, ${0.8 * (1 - k)})`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 7 + k * 20, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#f0abfc';
    ctx.strokeStyle = '#2a0a2e';
    ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 7); ctx.lineTo(x - 6, y); ctx.closePath(); ctx.fill(); ctx.stroke();
    host.label(ctx, `⚑ Your wreck · ${Math.floor(wkLeft / 60)}:${String(wkLeft % 60).padStart(2, '0')}`, x, y - 14, '#f5c2ff', 9, y);
    host.hits.push({ kind: 'beacon', x: wk.x, y: wk.y, sx: x, sy: y });
  }
}

export function drawStations(host: MapHost, sc: MapScene): void {
  const { ctx, sx, sy, S, time, ox, oy } = sc;
  // Station orbits and stations (live positions: they move)
  for (const e of host.state.entities.values()) {
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
    host.label(ctx, e.name ?? 'Station', x, y + 22, '#cfe9ff', 7, y);
    host.hits.push({ kind: 'station', name: e.name ?? 'Station', x: e.renderX, y: e.renderY, sx: x, sy: y });
  }
}

export function drawGates(host: MapHost, sc: MapScene): void {
  const { ctx, sx, sy, time, sys } = sc;
  // Jump gates and rifts (static, from data)
  for (const p of sys?.portals ?? []) {
    const x = sx(p.position.x), y = sy(p.position.y);
    const target = host.byId.get(p.targetSystem);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    ctx.strokeStyle = '#b28cff';
    ctx.lineWidth = 2;
    ctx.strokeRect(-6, -6, 12, 12);
    ctx.restore();
    ctx.fillStyle = '#d9c4ff';
    ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
    host.label(ctx, `→ ${target?.name ?? p.targetSystem}`, x, y + 22, '#d9c4ff', 6, y);
    host.hits.push({ kind: 'gate', target, x: p.position.x, y: p.position.y, sx: x, sy: y });
  }
  for (const rift of sys?.rifts ?? []) {
    const x = sx(rift.position.x), y = sy(rift.position.y);
    ctx.strokeStyle = `hsla(${rift.hue ?? 278}, 90%, 72%, 0.95)`;
    ctx.lineWidth = 1.8;
    for (let k = 0; k < 3; k++) {
      ctx.beginPath(); ctx.arc(x, y, 3 + k * 3.5, time * 2.5 + k * 2.1, time * 2.5 + k * 2.1 + 4); ctx.stroke();
    }
    const dest = host.byId.get(rift.destination.system);
    host.label(ctx, rift.label ?? `Rift → ${dest?.name ?? rift.destination.system}`, x, y + 24, '#e7c6ff', 6, y);
    host.hits.push({ kind: 'rift', label: rift.label ?? 'Rift', dest, x: rift.position.x, y: rift.position.y, sx: x, sy: y });
  }
}

export function drawPilots(host: MapHost, sc: MapScene): void {
  const { ctx, sx, sy } = sc;
  // Other pilots, near (entities) and far (FarShips: past your view; your party in green, with a ring)
  const party = new Set((host.party?.() ?? []).map((m) => m.eid));
  const pilots: { id: number; name?: string; renderX: number; renderY: number }[] = [];
  for (const e of host.state.entities.values()) if (e.type === EntityType.Player && e.id !== host.state.playerId) pilots.push(e);
  for (const f of host.state.farShips.list(host.state.systemId, host.state.getRawServerTick(), (id) => host.state.entities.has(id) || id === host.state.playerId)) if (f.kind === 4) pilots.push(f);
  for (const e of pilots) {
    const x = sx(e.renderX), y = sy(e.renderY);
    const mate = party.has(e.id);
    ctx.fillStyle = mate ? '#4ade80' : '#60a5fa';
    ctx.beginPath(); ctx.arc(x, y, mate ? 4.5 : 3.5, 0, Math.PI * 2); ctx.fill();
    if (mate) { ctx.strokeStyle = 'rgba(74, 222, 128, 0.7)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke(); }
    if (e.name) host.label(ctx, e.name, x, y - 9, mate ? '#bbf7d0' : '#93c5fd', mate ? 8 : 4, y);
    host.hits.push({ kind: 'ship', id: e.id, name: e.name ?? 'Pilot', x: e.renderX, y: e.renderY, sx: x, sy: y });
  }
}
