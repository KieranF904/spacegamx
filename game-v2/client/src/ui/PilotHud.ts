/**
 * The pilot's always-on readout (under the ship panel): credits, level and XP,
 * cargo fill, and, when the ship has lost parts, what the next rebuild needs.
 * Plus toasts: short notices from the server, stacked at the top centre.
 */

import type { PilotState } from '../econ/clientEcon';
import { costHtml } from './windowKit';
import { injectWindowStyles } from './windowKit';
import { threatTag } from './threat';
import { REGION_COLOR } from './RegionUI';

export class PilotHud {
  private root: HTMLDivElement;
  private credits: HTMLSpanElement;
  private level: HTMLSpanElement;
  private xpBar: HTMLElement;
  private cargoText: HTMLSpanElement;
  private cargoBar: HTMLElement;
  private rebuild: HTMLDivElement;
  private zone: HTMLDivElement;
  private zoneKey = '';
  private rating: HTMLDivElement;
  private ratingKey = '';
  private lastCredits = -1;

  constructor(private pilot: PilotState) {
    injectWindowStyles();
    this.root = document.createElement('div');
    this.root.style.cssText = `position: fixed; left: 16px; top: 266px; width: 180px; padding: 8px 10px 9px; z-index: 850;
      background: rgba(8, 14, 26, 0.78); border: 1px solid rgba(120, 150, 200, 0.22); border-radius: 10px;
      color: #c9d4e5; font: 12px 'Segoe UI', system-ui, sans-serif; pointer-events: none; display: none;`;
    this.root.innerHTML = `
      <div data-k="zone" style="margin:-2px 0 6px; font-size:11px; letter-spacing:1px;"></div>
      <div data-k="rating" style="margin:-3px 0 6px; font-size:11px;"></div>
      <div style="display:flex; justify-content:space-between; align-items:baseline;">
        <span data-k="level" style="color:#7dd3fc; font-weight:700; letter-spacing:1px;">LVL 1</span>
        <span data-k="credits" class="sgw-credits" style="transition: color .3s">0 cr</span>
      </div>
      <div class="sgw-bar" style="margin:4px 0 7px; height:4px;"><i data-k="xp"></i></div>
      <div style="display:flex; justify-content:space-between; color:#8394ad;"><span>Cargo</span><span data-k="cargo">0 / 0</span></div>
      <div class="sgw-bar" style="margin:3px 0 0; height:4px;"><i data-k="cargobar"></i></div>
      <div data-k="ammo" style="display:none; margin-top:6px; line-height:1.45;"></div>
      <div data-k="rebuild" style="display:none; margin-top:8px; padding-top:7px; border-top:1px solid rgba(140,170,220,0.15); line-height:1.5;"></div>`;
    const q = <T extends HTMLElement>(k: string) => this.root.querySelector(`[data-k="${k}"]`) as T;
    this.credits = q('credits');
    this.level = q('level');
    this.xpBar = q('xp');
    this.cargoText = q('cargo');
    this.cargoBar = q('cargobar');
    this.rebuild = q('rebuild');
    this.ammo = q('ammo');
    this.zone = q('zone');
    this.rating = q('rating');
    this.root.dataset.hudAvoid = '1';
    document.body.appendChild(this.root);
    pilot.onChange(() => this.render());
  }

  /** Its bottom edge on screen (0 while hidden): the cargo panel keeps below it */
  bottom(): number {
    return this.root.style.display === 'none' ? 0 : this.root.getBoundingClientRect().bottom;
  }

  /** The ammunition crates the ship you fly takes (set by the game) */
  ammoKinds: () => string[] = () => [];
  private ammo: HTMLElement;
  private ammoKey = '';

  /** A line per kind of crate your guns fire: crates aboard and rounds left in the open one, or plain rounds when out */
  renderAmmo(): void {
    const p = this.pilot, open = p.profile?.ammo ?? {};
    const rows = this.ammoKinds().map((id) => {
      const crates = p.cargo.reduce((n, s) => n + (s.id === id ? s.n : 0), 0), loose = open[id] ?? 0;
      const name = p.econ.items.name(id);
      return crates || loose
        ? `<div style="display:flex; justify-content:space-between; color:#8394ad;"><span>${name}</span><span style="color:#c9d4e5">${crates} crate${crates === 1 ? '' : 's'}${loose ? ` + ${loose}` : ''}</span></div>`
        : `<div style="color:#fca5a5">${name}: none · plain rounds</div>`;
    });
    const html = rows.join('');
    if (html === this.ammoKey) return;
    this.ammoKey = html;
    this.ammo.innerHTML = html;
    this.ammo.style.display = html ? 'block' : 'none';
  }

  /** Sector danger and PvP status, e.g. ('Sol', 1, false) */
  setZone(system: string, danger: number, pvp: boolean, safe: boolean, ring?: { name: string; color?: string }, region?: { name: string; danger: 'safe' | 'contested' | 'hostile' }): void {
    const key = `${system}|${danger}|${pvp}|${safe}|${ring?.name}|${region?.name}`;
    if (key === this.zoneKey) return;
    this.zoneKey = key;
    const col = danger >= 6 ? '#f87171' : danger >= 4 ? '#fbbf24' : danger >= 2 ? '#a3e635' : '#86efac';
    const pips = '●'.repeat(danger) + '○'.repeat(Math.max(0, 7 - danger));
    this.zone.innerHTML = `<span style="color:#8394ad">${system.toUpperCase()}</span> <span style="color:${col}" title="Danger ${danger} of 7">${pips}</span>`
      + (region ? `<div style="color:${REGION_COLOR[region.danger]}; margin-top:2px" title="${region.danger === 'safe' ? 'Hostiles keep out of safe space, and a ship lost here comes back whole' : region.danger === 'hostile' ? 'Hostile space: lose your ship here and your hold goes with the wreck' : 'Contested space'}">${region.danger === 'safe' ? '◈' : region.danger === 'hostile' ? '⚠' : '◆'} ${region.name.toUpperCase()} · ${region.danger === 'safe' ? 'SAFE' : region.danger.toUpperCase()}</div>` : '')
      + (ring && ring.name !== region?.name ? `<div style="color:${ring.color ?? '#c9a46a'}; margin-top:2px">${ring.name.toUpperCase()}</div>` : '')
      + (pvp ? (safe ? '<div style="color:#86efac; margin-top:2px">PVP SECTOR · station ring: safe</div>'
        : '<div style="color:#f87171; font-weight:700; margin-top:2px">⚠ PVP ZONE · players can attack you</div>') : '');
  }

  /** Your ship's rating, against what this system's hostiles rate */
  setRating(mine: number, threat: number | undefined): void {
    const key = `${Math.round(mine)}|${threat}`;
    if (key === this.ratingKey) return;
    this.ratingKey = key;
    this.rating.innerHTML = mine > 0
      ? `<span style="color:#7dd3fc" title="Your ship's rating: firepower and toughness together">◆ ${Math.round(mine)}</span>${threat ? ` <span style="color:#56657c">vs</span> ${threatTag(mine, threat)}` : ''}`
      : '';
  }

  show(): void {
    this.root.style.display = 'block';
    this.render();
  }

  hide(): void {
    this.root.style.display = 'none';
  }

  private render(): void {
    const p = this.pilot;
    const prof = p.profile;
    if (prof) {
      this.level.textContent = `LVL ${prof.level}${prof.skillPoints ? ` · ${prof.skillPoints} SP` : ''}`;
      const span = Math.max(1, prof.xpNext - prof.xpLevel);
      this.xpBar.style.width = `${Math.min(100, ((prof.xp - prof.xpLevel) / span) * 100)}%`;
    }
    if (p.credits !== this.lastCredits) {
      if (this.lastCredits >= 0) {
        this.credits.style.color = p.credits > this.lastCredits ? '#86efac' : '#fca5a5';
        setTimeout(() => (this.credits.style.color = ''), 600);
      }
      this.lastCredits = p.credits;
      this.credits.textContent = `${p.credits.toLocaleString()} cr`;
    }
    const used = p.cargoUsed();
    this.cargoText.textContent = `${Math.round(used)} / ${p.cargoCapacity}`;
    const frac = p.cargoCapacity > 0 ? Math.min(1, used / p.cargoCapacity) : 1;
    this.cargoBar.style.width = `${frac * 100}%`;
    this.cargoBar.parentElement!.classList.toggle('full', frac >= 0.999);
    this.renderAmmo();

    const r = p.rebuild;
    if (r && r.missing > 0) {
      this.rebuild.style.display = 'block';
      const free = prof && prof.level < r.freeBelowLevel;
      const short = Object.keys(r.short).length > 0;
      this.rebuild.innerHTML = `<b style="color:#fbbf24">${r.missing} part${r.missing > 1 ? 's' : ''} missing</b><br>`
        + (free ? '<span style="color:#86efac">Rebuilt free at any station (new pilot)</span>'
          : `Next rebuild: ${costHtml(p.econ, r.next, (id) => p.count(id))}`
          + (r.aid ? `<br><span style="color:#fcd34d">Can't afford it: the station lends you ${r.credits} cr</span>`
            : short ? `<br><span style="color:#fcd34d">Short minerals bought for ${r.credits} cr</span>` : '<br><span style="color:#8394ad">Rebuilt near any station</span>'))
        + (r.debt > 0 ? `<br><span style="color:#fca5a5">Rebuild loan: ${r.debt.toLocaleString()} cr owed</span>` : '');
    } else {
      this.rebuild.style.display = 'none';
    }
  }
}

export class ToastUI {
  private root: HTMLDivElement;

  constructor() {
    this.root = document.createElement('div');
    this.root.style.cssText = 'position: fixed; top: 122px; left: 50%; transform: translateX(-50%); z-index: 3500; display: flex; flex-direction: column; align-items: center; gap: 6px; pointer-events: none;';
    document.body.appendChild(this.root);
  }

  show(text: string, kind: 'info' | 'good' | 'warn' | 'bad' = 'info'): void {
    const colors = { info: ['#7dd3fc', 'rgba(125,211,252,0.35)'], good: ['#86efac', 'rgba(74,222,128,0.4)'], warn: ['#fcd34d', 'rgba(251,191,36,0.4)'], bad: ['#fca5a5', 'rgba(248,113,113,0.45)'] }[kind];
    const el = document.createElement('div');
    el.style.cssText = `padding: 8px 16px; border-radius: 999px; background: rgba(8, 14, 26, 0.92); border: 1px solid ${colors[1]};
      color: ${colors[0]}; font: 13px 'Segoe UI', system-ui, sans-serif; box-shadow: 0 6px 20px rgba(0,0,0,0.4);
      opacity: 0; transform: translateY(-6px); transition: opacity .2s, transform .2s;`;
    el.textContent = text;
    this.root.appendChild(el);
    while (this.root.children.length > 4) this.root.firstElementChild?.remove();
    requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'none'; });
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(-6px)'; }, 3200);
    setTimeout(() => el.remove(), 3500);
  }
}
