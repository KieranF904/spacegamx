/**
 * The side panel's Pilot tab: the live pilot and ship readout that was the Esc menu's "Pilot & ship" page (callsign,
 * level and XP, credits, location; the ship's core, parts, mass, length, speed, acceleration, turn rate, power, guns,
 * engines, controls and jump drive), with a dock button inside a docking ring. Redrawn twice a second while on show.
 * pilotShipHtml is the markup with no DOM (tested).
 */
import type { MenuPilotInfo, MenuShipInfo } from '../../GameMenuUI';
import type { HubTab } from '../hubTabs';
import { esc } from '../../escape';

export interface PilotTabDeps {
  pilot(): MenuPilotInfo;
  ship(): MenuShipInfo | null;
  /** The station whose docking ring you're in (null: none) */
  dockableStation(): string | null;
  dock(): void;
  /** A key's name as bound (the respawn hint) */
  keyName(action: string): string;
}

const pct = (v: number, max: number) => (max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0);

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.ps { display: flex; flex-direction: column; gap: 1px; color: #b4c2d4; }
.ps-h { display: flex; align-items: center; gap: 6px; margin: 4px 0 1px; font: 600 8.5px/1 'Segoe UI', system-ui, sans-serif; letter-spacing: 1.6px; text-transform: uppercase; color: #8b9cb3; }
.ps-h:first-child { margin-top: 0; }
.ps-h::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, rgba(140, 170, 210, 0.3), transparent); }
.ps-h b { color: #e5ecf7; letter-spacing: 1px; font-weight: 600; text-transform: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ps-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 2px; }
.ps-s { background: rgba(3, 6, 12, 0.4); border-radius: 3px; padding: 1px 5px 2px; min-width: 0; }
.ps-s.w { grid-column: 1 / -1; }
.ps-s span { display: block; font-size: 8px; line-height: 10px; letter-spacing: 0.8px; text-transform: uppercase; color: #7a8ba3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ps-s b { display: block; color: #f1f5fb; font-weight: 600; font-size: 11px; line-height: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ps-s b small { color: #7a8ba3; font-weight: 400; font-size: 10px; }
.ps-bar { height: 2px; border-radius: 1px; background: #1b2639; overflow: hidden; margin-top: 1px; }
.ps-bar > i { display: block; height: 100%; background: linear-gradient(90deg, #3b82f6, #7dd3fc); }
.ps-bar.core > i { background: linear-gradient(90deg, #16a34a, #4ade80); }
.ps-note { color: #6f8099; font-size: 10px; margin-top: 3px; line-height: 1.3; }
.ps-note kbd { padding: 0 4px; border-radius: 3px; background: #1a2740; border: 1px solid #33496d; font: 600 10px 'Segoe UI', sans-serif; color: #e8f0fb; }
.ps .sgw-btn { margin-top: 3px; padding: 0 8px; line-height: 18px; font-size: 10.5px; border-radius: 5px; align-self: flex-start; }
.ps .sgw-btn:focus-visible { outline: 2px solid #6cc8ff; outline-offset: 1px; }`;
  document.head.appendChild(css);
}

/** The readout's markup (the dock button is `data-a="dock"`) */
export function pilotShipHtml(p: MenuPilotInfo, s: MenuShipInfo | null, dock: string | null, respawnKey: string): string {
  const stat = (label: string, value: string, extra = '', wide = false) => `<div class="ps-s${wide ? ' w' : ''}"><span>${label}</span><b>${value}</b>${extra}</div>`;
  const bar = (v: number, max: number, cls = '') => `<div class="ps-bar${cls ? ` ${cls}` : ''}"><i style="width:${pct(v, max).toFixed(0)}%"></i></div>`;
  const rank = p.owner ? ' <small>owner</small>' : p.admin ? ' <small>admin</small>' : '';
  let html = `<div class="ps-h">Pilot <b>${esc(p.name)}${rank}</b></div><div class="ps-grid">
    ${stat(`Level ${p.level}`, `${p.xp.toLocaleString()} <small>/ ${p.xpToNext.toLocaleString()} XP</small>`, bar(p.xp, p.xpToNext))}
    ${stat('Credits', p.credits.toLocaleString())}
    ${stat('Location', esc(p.system))}
  </div>`;
  if (s) {
    const j = s.jump;
    const jumpText = j.phase === 'ready' ? 'Ready' : j.phase === 'cooldown' ? `Cooling · ${j.cooldownSecs}s` : j.phase === 'charging' ? 'Spooling' : 'Jumping';
    html += `<div class="ps-h">Ship <b>${esc(s.name)}</b></div><div class="ps-grid">
      ${stat('Core', `${Math.round(s.coreHp)} / ${Math.round(s.coreMax)}`, bar(s.coreHp, s.coreMax, 'core'))}
      ${stat('Jump drive', jumpText, bar(j.phase === 'ready' ? 1 : j.progress, 1))}
      ${stat('Parts', String(s.parts))}
      ${stat('Mass', s.mass.toFixed(0))}
      ${stat('Length', `${Math.round(s.radius * 2)} u`)}
      ${stat('Top speed', `${s.topSpeed.toFixed(1)} <small>u/tick</small>`)}
      ${stat('Acceleration', s.accel.toFixed(3))}
      ${stat('Turn rate', s.turn.toFixed(4))}
      ${stat('Power', `${Math.round(s.power.supply)} / ${Math.round(s.power.demand)}`)}
      ${stat('Guns', `${s.guns}${s.turrets ? ` <small>(${s.turrets} turrets)</small>` : ''}`)}
      ${stat('Engines', String(s.engines))}
      ${stat('Controls', esc(s.controls))}
    </div><div class="ps-note">One jump carries you about ${(j.distance / 1000).toFixed(0)}k units along your nose.</div>`;
  } else {
    html += `<div class="ps-h">Ship</div><div class="ps-note">No ship right now. Press <kbd>${esc(respawnKey)}</kbd> to respawn.</div>`;
  }
  html += dock ? `<button class="sgw-btn primary" data-a="dock">Dock at ${esc(dock)}</button>` : `<div class="ps-note">Fly into a station's docking ring to refit your ship in its hangar.</div>`;
  return `<div class="ps">${html}</div>`;
}

export function pilotTab(d: PilotTabDeps): HubTab {
  injectStyles();
  return {
    id: 'pilot',
    label: 'Pilot',
    title: 'Pilot & ship: live readout',
    live: 500,
    render: (body) => {
      body.innerHTML = pilotShipHtml(d.pilot(), d.ship(), d.dockableStation(), d.keyName('respawn'));
      body.querySelector('[data-a="dock"]')?.addEventListener('click', () => d.dock());
    },
  };
}
