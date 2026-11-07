/**
 * Station tab: Your station.
 *
 * Owns: chartering your own station (the sites) and building its tracks up a tier at a time.
 * Needs: StationCtx (the pilot, the station id, send), data/station.json.
 * Extend: a new track group goes in the groups list in render().
 */

import { costHtml } from '../windowKit';
import { esc, fmt, stationName, STATION } from './shared';
import type { StationCtx } from './shared';

export class OutpostTab {
  constructor(private c: StationCtx) {}
  private get d() { return this.c.d; }
  private get st() { return this.c.st; }

  render(b: HTMLElement): void {
    const econ = this.d.pilot.econ, p = this.d.pilot.profile, file = STATION;
    const col = document.createElement('div');
    col.className = 'sgw-col';
    col.style.cssText = 'overflow-y:auto; height: min(580px, calc(100vh - 230px));';
    const o = p?.outpost;
    if (!o) {
      const c = file.charter, level = p?.level ?? 1;
      col.innerHTML = `<h4>Your own station</h4><div style="color:#a7b4c8; line-height:1.6; max-width:640px; margin-bottom:12px">A station of your own, berthed beside one of the sites below: nine tracks to build up (refinery, fabricator, armoury, gem cutter, hangar, storage, scanner array, market link, defences), each tier from your plate and ore, over real time, while you're away too. Nothing on it makes a ship stronger: it's what you can make, keep and know.</div>
        <div class="t-row" style="margin-bottom:10px">Charter: <b>level ${c.level}</b>${level < c.level ? ` <span style="color:#fbbf24">(you're ${level})</span>` : ''} · ${c.credits.toLocaleString()} cr · ${costHtml(econ, c.items, (id) => this.c.have(id))}</div>`;
      for (const s of file.sites) {
        const here = this.st?.id === s.station;
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:12px; padding:9px 4px; border-bottom:1px solid rgba(140,170,220,0.07);';
        row.innerHTML = `<div style="flex:1"><b>${esc(s.name)}</b><br><small style="color:#8394ad">beside ${esc(stationName(s.station))}</small></div>`;
        const btn = document.createElement('button');
        btn.className = 'sgw-btn' + (here && level >= c.level ? ' primary' : ' off');
        btn.textContent = here ? 'Charter here' : 'Charter it there';
        btn.title = here ? '' : `Dock at ${stationName(s.station)} to charter it`;
        btn.onclick = () => this.d.send({ type: 'outpostCharter', site: s.id });
        row.appendChild(btn);
        col.appendChild(row);
      }
      b.appendChild(col);
      return;
    }
    const site = file.sites.find((s) => s.id === o.site);
    const now = Date.now() + this.d.pilot.clockSkew;
    const busy = o.build;
    col.innerHTML = `<h4>Your station <span class="r">${esc(site?.name ?? o.site)}${busy ? ` · building ${esc(file.tracks[busy.track]?.name ?? busy.track)} ${busy.tier}: ${fmt(Math.max(0, Math.ceil((busy.readyAt - now) / 1000)))} left` : ' · nothing building'}</span></h4>`;
    const groups: [string, string][] = [['make', 'Make'], ['keep', 'Keep'], ['know', 'Know and sell'], ['hold', 'Hold']];
    for (const [g, label] of groups) {
      col.insertAdjacentHTML('beforeend', `<h4 style="margin:12px 0 4px; color:#7dd3fc">${label}</h4>`);
      for (const [id, t] of Object.entries(file.tracks).filter(([, t]) => t.group === g)) {
        const tier = o.tracks[id] ?? 0, next = t.tiers[tier];
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:12px; padding:8px 4px; border-bottom:1px solid rgba(140,170,220,0.07);';
        const pips = t.tiers.map((_, i) => `<span style="color:${i < tier ? '#7dd3fc' : busy?.track === id && busy.tier === i + 1 ? '#fbbf24' : '#334155'}">●</span>`).join('');
        row.innerHTML = `<div style="width:190px"><b>${esc(t.name)}</b> ${pips}<br><small style="color:#8394ad">${esc(tier ? t.tiers[tier - 1].name : t.about)}</small></div>`
          + (next ? `<div style="flex:1"><small style="color:#a7b4c8">Next: ${esc(next.name)} · ${next.minutes < 60 ? `${next.minutes} min` : `${next.minutes / 60} h`}</small><br>${costHtml(econ, next.cost, (iid) => this.c.have(iid))}</div>` : '<div style="flex:1; color:#86efac">Built as far as it goes</div>');
        if (next) {
          const ok = !busy && Object.entries(next.cost).every(([iid, n]) => this.c.have(iid) >= n);
          const btn = document.createElement('button');
          btn.className = 'sgw-btn' + (ok ? ' primary' : ' off');
          btn.textContent = `Build ${tier + 1}`;
          btn.onclick = () => this.d.send({ type: 'outpostUpgrade', track: id });
          row.appendChild(btn);
        }
        col.appendChild(row);
      }
    }
    b.appendChild(col);
  }
}
