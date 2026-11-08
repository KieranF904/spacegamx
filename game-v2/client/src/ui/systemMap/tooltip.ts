/**
 * @contract client.systemMap.tooltip
 * owns:       the map's hover tooltip and its stylesheet
 * needs:      MapHost (hover, tooltip, state, myRating), mapConsts, hazardSums
 * invariants: the tooltip shows the nearest hit's details — none pinned
 * extend:     a new hit kind is one case in updateTooltip
 */

import { StarSystemData } from '@space-game/common';
import { lodestoneLabel, lodestoneSize, lodestoneLive, lodestoneFieldRadius, lodestoneChargeOf, lodestoneBoostOf } from '@space-game/common';
import { threatTag } from '../threat';
import { hazardRows } from '../hazardSums';
import { settings } from '../../settings/Settings';
import { boundKeyName } from '../../input/keybindings';
import { esc } from '../escape';
import type { MapHost } from './host';
import { JUMP, LODE_COLOR, LODE_DEAD, FACTIONS, REGION_STYLE, outmatch, PLANET_KINDS, HAZARD_NAMES, BODY_NAMES, fmtDist } from './mapConsts';

export function updateTooltip(host: MapHost): void {
  const hit = host.hover;
  if (!hit || hit.kind === 'ship' && !hit.name) { host.tooltip.style.display = 'none'; return; }
  let html = '';
  if (hit.kind === 'system') {
    const s = hit.sys;
    const cb = s.centralBody?.type ?? 'sun';
    const links = s.portals.map((p) => host.byId.get(p.targetSystem)?.name ?? p.targetSystem);
    const rifts = (s.rifts ?? []).map((r) => host.byId.get(r.destination.system)?.name ?? r.destination.system);
    const here = s.id === host.state.systemId;
    html = `
      <div class="t-name">${esc(s.name)}</div>
      <div class="t-sub">${esc((s.sector ?? '').replace(/_/g, ' '))} · ${BODY_NAMES[cb] ?? cb}</div>
      <div class="t-desc">${esc(s.description)}</div>
      ${(() => { const l = host.locked?.(s.id); return l ? `<div class="t-row" style="color:#fbbf24"><b>🔒 Locked</b> ${esc(l.hint)}</div>` : ''; })()}
      ${s.hazards.length ? `<div class="t-row"><b>Hazards</b> ${s.hazards.map((h) => HAZARD_NAMES[h] ?? h).join(', ')}</div>` : ''}
      <div class="t-row"><b>Stations</b> ${s.stations.length || 'none'}</div>
      ${host.state.threats[s.id] ? `<div class="t-row"><b>Threat</b> ${threatTag(host.myRating?.() ?? 0, host.state.threats[s.id], '◆')}</div>` : ''}
      ${hazardRows(s.hazardRatings, host.myShip?.() ?? null)}
      ${s.planets?.length ? `<div class="t-row"><b>Planets</b> ${esc(s.planets.map((p) => p.name).join(', '))}</div>` : ''}
      ${s.derelicts?.length ? `<div class="t-row"><b>Wrecks</b> ${s.derelicts.length}</div>` : ''}
      <div class="t-row"><b>Gates to</b> ${links.length ? esc(links.join(', ')) : 'none'}</div>
      ${rifts.length ? `<div class="t-row"><b>Rift to</b> ${esc(rifts.join(', '))}</div>` : ''}
      <div class="t-act">${here ? 'You are here' : 'Click: autopilot there, gate by gate'}${host.onWarp ? ' · Ctrl-click: warp <span>(dev)</span>' : ''}</div>`;
  } else if (hit.kind === 'station') {
    html = `<div class="t-name">${esc(hit.name)}</div><div class="t-sub">Station · shipyard</div><div class="t-act">Click: autopilot there · Ctrl-click: warp <span>(dev)</span></div>`;
  } else if (hit.kind === 'gate') {
    html = `<div class="t-name">Jump gate</div><div class="t-sub">to ${esc(hit.target?.name ?? '?')}</div>${host.destRows(hit.target)}<div class="t-desc">Fly in and press ${esc(boundKeyName('interact', settings.data.bindings))} to jump.</div>${hazardRows(hit.target?.hazardRatings, host.myShip?.() ?? null)}<div class="t-act">Click: autopilot there · Ctrl-click: warp <span>(dev)</span></div>`;
  } else if (hit.kind === 'rift') {
    html = `<div class="t-name">${esc(hit.label)}</div><div class="t-sub">Rift to ${esc(hit.dest?.name ?? '?')}</div>${host.destRows(hit.dest)}<div class="t-desc">Fly into the vortex to be pulled through.</div><div class="t-act">Click: autopilot there · Ctrl-click: warp <span>(dev)</span></div>`;
  } else if (hit.kind === 'region') {
    const g = hit.region, st = REGION_STYLE[g.danger] ?? REGION_STYLE.contested;
    const threat = host.state.regionThreats?.[host.state.systemId]?.[g.id];
    html = `<div class="t-name">${esc(g.name)}</div><div class="t-sub" style="text-transform:none"><span style="color:${st.color}">${st.word}</span> · ${hit.inner ? `${fmtDist(hit.inner)} to ` : 'out to '}${fmtDist(g.outer)} from the centre</div>`
      + (g.description ? `<div class="t-desc">${esc(g.description)}</div>` : '')
      + (threat ? `<div class="t-row"><b>Threat</b> ${threatTag(host.myRating?.() ?? 0, threat, '◆')}</div>` : '');
  } else if (hit.kind === 'zone') {
    const z = hit.zone;
    html = `<div class="t-name" style="color:${z.color ?? '#e9f2ff'}">${esc(z.name)}</div><div class="t-sub" style="text-transform:none">${z.x !== undefined ? `${fmtDist(z.outer)} across the spot` : `${fmtDist(z.inner)} to ${fmtDist(z.outer)} from the centre`}</div>${z.description ? `<div class="t-desc">${esc(z.description)}</div>` : ''}`;
  } else if (hit.kind === 'hostile') {
    const sub = hit.calm ? 'Passive · leaves you be unless provoked' : hit.rank === 2 ? 'Boss' : hit.rank === 1 ? 'Elite hostile' : 'Hostile';
    html = `<div class="t-name">${esc(hit.name)}</div><div class="t-sub">${sub}</div>${hit.rating ? `<div class="t-row"><b>Rates</b> ${threatTag(host.myRating?.() ?? 0, hit.rating, '◆')}</div>` : ''}<div class="t-act">Hold left to fire (rough aim at host scale)</div>`;
  } else if (hit.kind === 'beacon') {
    html = `<div class="t-name">Your wreck</div><div class="t-sub">Kept for you a while</div><div class="t-desc">Fly back to it to recover what you lost.</div><div class="t-act">Click: autopilot there</div>`;
  } else if (hit.kind === 'moon') {
    const surf = host.byId.get(hit.surface);
    const b = surf?.surface?.bastion;
    html = `<div class="t-name">${esc(hit.name)}</div><div class="t-sub">Moon of ${esc(hit.planet.name)} · siege${b?.grade ? ` · Mk ${['', 'I', 'II', 'III', 'IV', 'V'][b.grade]} nights` : ''}</div>`
      + (surf?.description ? `<div class="t-desc">${esc(surf.description)}</div>` : '')
      + (host.state.threats[hit.surface] ? `<div class="t-row"><b>Threat</b> ${threatTag(host.myRating?.() ?? 0, host.state.threats[hit.surface], '◆')} <span style="color:#64748b">(night 3, solo)</span></div>` : '')
      + `<div class="t-act">Click: autopilot there, then X to descend · Ctrl-click: warp <span>(dev)</span></div>`;
  } else if (hit.kind === 'planet') {
    const pl = hit.planet;
    html = `<div class="t-name">${esc(pl.name)}</div><div class="t-sub">${PLANET_KINDS[pl.kind] ?? pl.kind}${pl.rings ? ' · rings' : ''}${pl.moons?.length ? ` · ${pl.moons.length} moon${pl.moons.length > 1 ? 's' : ''}` : ''}</div>${pl.description ? `<div class="t-desc">${esc(pl.description)}</div>` : ''}<div class="t-act">Click: autopilot into orbit · Ctrl-click: warp <span>(dev)</span></div>`;
  } else if (hit.kind === 'freighter') {
    html = `<div class="t-name">${esc(hit.name)}</div><div class="t-sub">Civilian hauler</div><div class="t-desc">Flies cargo between Sol's stations.</div><div class="t-act">Click: autopilot there · Ctrl-click: warp <span>(dev)</span></div>`;
  } else if (hit.kind === 'comet') {
    html = `<div class="t-name">${esc(hit.comet.name)}</div><div class="t-sub">Comet · ${Math.round(Math.hypot(hit.x, hit.y) / 1000)}k from the star</div>${hit.comet.description ? `<div class="t-desc">${esc(hit.comet.description)}</div>` : ''}<div class="t-act">Click: autopilot there · Ctrl-click: warp <span>(dev)</span></div>`;
  } else if (hit.kind === 'structure') {
    html = `<div class="t-name">${esc(hit.structure.name)}</div><div class="t-sub">Megastructure</div>${hit.structure.description ? `<div class="t-desc">${esc(hit.structure.description)}</div>` : ''}<div class="t-act">Click: autopilot there · Ctrl-click: warp <span>(dev)</span></div>`;
  } else if (hit.kind === 'lodestone') {
    const l = hit.lodestone;
    const camp = l.zone ? host.byId.get(host.state.systemId)?.zones?.find((z) => z.id === l.zone) : undefined;
    const live = lodestoneLive(l), size = fmtDist(lodestoneSize(l, JUMP) * 2);
    const sub = !live ? `${l.state === 'dead' ? 'Dead' : 'Shattered'}: no charging field · ${size} across`
      : `${l.state === 'scarred' ? 'Scarred · a weaker' : 'Jump-drive'} charging field · ${fmtDist(lodestoneFieldRadius(l, JUMP) * 2)} across`;
    html = `<div class="t-name" style="color:${live ? LODE_COLOR : LODE_DEAD}">◈ ${esc(lodestoneLabel(l, JUMP))}</div><div class="t-sub">${sub}${l.orbit ? ' · orbiting' : ''}</div>`
      + (l.description ? `<div class="t-desc">${esc(l.description)}</div>` : '')
      + (live ? `<div class="t-row"><b>Inside</b> the drive recharges ${+(1 + lodestoneChargeOf(l, JUMP)).toFixed(2)}× as fast</div>`
        + `<div class="t-row"><b>After</b> your next jump within ${Math.round(JUMP.lodestonePrimeTicks / 60)}s reaches ${Math.round((lodestoneBoostOf(l, JUMP) - 1) * 100)}% further</div>` : '')
      + (camp ? `<div class="t-row" style="color:#f87171"><b>Camped</b> hostiles wait here (${esc(camp.name)})</div>` : '')
      + `<div class="t-act">Click: autopilot there · aim a jump here to lock on · Ctrl-click: warp <span>(dev)</span></div>`;
  } else if (hit.kind === 'nest') {
    const n = hit.nest, f = FACTIONS[n.faction];
    const pl = n.around !== undefined ? host.byId.get(host.state.systemId)?.planets?.find((p) => p.id === n.around) : undefined;
    const round = pl ? (n.moon !== undefined ? `orbiting a moon of ${pl.name}` : `orbiting ${pl.name}`) : n.orbit.period ? 'orbiting the centre' : 'anchored';
    html = `<div class="t-name" style="color:${f?.color ?? '#f87171'}">▲ ${esc(n.name)}</div><div class="t-sub">${esc(f?.name ?? n.faction)} nest · ${esc(round)}</div>`
      + (n.description ? `<div class="t-desc">${esc(n.description)}</div>` : '')
      + `<div class="t-row">Its packs launch from here and roam round it; shoot them down and it sends more in time</div>`
      + `<div class="t-act">Click: autopilot there · Ctrl-click: warp <span>(dev)</span></div>`;
  } else if (hit.kind === 'wayin') {
    const pk = hit.pocket, e = pk.pocket!.entrance, f = e.look ? FACTIONS[e.look.faction] : undefined;
    html = `<div class="t-name" style="color:${f?.color ?? '#fbbf24'}">Way into ${esc(e.name)}</div><div class="t-sub">${esc(pk.name)}</div>`
      + `<div class="t-desc">${esc(pk.description)}</div>`
      + `<div class="t-row">Fly close and press <b>${esc(boundKeyName('interact', settings.data.bindings))}</b> to go in; fly out past its edge to come back here</div>`
      + `<div class="t-act">Click: autopilot there · aim a jump here to lock on · Ctrl-click: warp <span>(dev)</span></div>`;
  } else if (hit.kind === 'wreck') {
    html = `<div class="t-name">${esc(hit.name)}</div><div class="t-sub">Derelict hulk</div><div class="t-desc">Break its core for salvage credits.</div><div class="t-act">Click: autopilot there · Ctrl-click: warp <span>(dev)</span></div>`;
  } else {
    html = `<div class="t-name">${esc(hit.name)}</div><div class="t-sub">Pilot</div><div class="t-act">Click: autopilot alongside</div>`;
  }
  host.tooltip.innerHTML = html;
  host.tooltip.style.display = 'block';
  const w = host.canvas.clientWidth;
  const tw = host.tooltip.offsetWidth, th = host.tooltip.offsetHeight;
  const top = host.canvas.offsetTop;
  let x = hit.sx + 24, y = hit.sy + top - 20;
  if (x + tw > w - 10) x = hit.sx - tw - 24;
  if (y + th > window.innerHeight - 50) y = window.innerHeight - 50 - th;
  host.tooltip.style.left = `${x}px`;
  host.tooltip.style.top = `${Math.max(top + 8, y)}px`;
}

/** Tooltip rows for where a gate or rift goes: its threat against your ship, and a line about it */
export function destRows(host: MapHost, t: StarSystemData | undefined): string {
  if (!t) return '';
  const threat = host.state.threats[t.id];
  const mine = host.myRating?.() ?? 0;
  let row = '';
  if (threat) {
    const o = outmatch(mine, threat);
    row = `<div class="t-row"><b>Threat</b> <span style="color:${o.color}">◆${Math.round(threat)}${mine ? ` vs your ◆${Math.round(mine)} · ${o.word}` : ''}</span></div>`;
  }
  const line = (t.description ?? '').split(/(?<=[.!?])\s/)[0];
  return row + (line ? `<div class="t-desc">${esc(line)}</div>` : '');
}

export function injectStyles(host: MapHost): void {
  const style = document.createElement('style');
  style.textContent = `
    #galaxy-map { position: fixed; inset: 0; z-index: 2500; pointer-events: auto; background: #02040c; font-family: 'Segoe UI', system-ui, sans-serif; color: #cfd8e6; }
    #galaxy-map canvas { position: absolute; z-index: 1; left: 0; top: 52px; width: 100%; height: calc(100% - 52px - 30px); display: block; }
    #galaxy-map .gm-over { position: absolute; z-index: 1; left: 0; top: 52px; width: 100%; height: calc(100% - 52px - 30px); pointer-events: none; overflow: hidden; }
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
