/**
 * Station tab: Overview.
 *
 * Owns: the Your ship status, hangar, cargo and gun range buttons, quick sell and quick store, the people here, the services list, and the job list that ticks along under it.
 * Needs: StationCtx (the pilot, the station message, send/sound, the jobs ticker).
 * Extend: add a block to render(); the job list is any element with data-jobs (see jobs.ts).
 */

import {
  saleTotal, DOCK_FEE_LEVEL,
} from '@space-game/common';
import { costHtml } from '../windowKit';
import { storeControls } from '../storeControls';
import { boundKeyName } from '../../input/keybindings';
import { settings } from '../../settings/Settings';
import { esc, DOCK_FEES } from './shared';
import { gunRangeButton } from '../gunRange/stationButton';
import type { StationCtx } from './shared';

export class OverviewTab {
  constructor(private c: StationCtx) {}
  private get d() { return this.c.d; }
  private get st() { return this.c.st; }

  render(b: HTMLElement): void {
    const p = this.d.pilot;
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns: 1.2fr 1fr; gap:14px;';

    const left = document.createElement('div');
    left.className = 'sgw-col';
    left.innerHTML = `<h4>Your ship</h4>`;
    const r = p.rebuild;
    const status = document.createElement('div');
    status.style.cssText = 'line-height:1.6; color:#a9b6c9; margin-bottom:12px;';
    if (r && r.missing > 0) {
      const free = p.profile && p.profile.level < r.freeBelowLevel;
      status.innerHTML = `<b style="color:#fbbf24">${r.missing} part${r.missing > 1 ? 's' : ''} missing.</b> The station's crews rebuild them one at a time while you're here.<br>`
        + (free ? '<span style="color:#86efac">New pilot: rebuilds are free until level ' + r.freeBelowLevel + '.</span>'
          : `Next part needs ${costHtml(p.econ, r.next, (id) => this.c.have(id))}`
          + (r.aid ? `<br><span style="color:#fcd34d">You can't cover the ${r.credits} cr right now, so the station lends it: a share of what you earn pays it back.</span>`
            : Object.keys(r.short).length ? `<br><span style="color:#fcd34d">You're short of minerals: the station supplies them for ${r.credits} cr a part.</span>` : ''));
    } else {
      status.innerHTML = 'Hull sound. Damaged parts are repaired for free while you\'re near a station.';
    }
    const debt = p.profile?.debt ?? 0;
    if (debt > 0) status.innerHTML += `<br><span style="color:#fca5a5">Rebuild loan: ${debt.toLocaleString()} cr owed, repaid from a quarter of everything you earn.</span>`;
    left.append(status);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:8px; flex-wrap:wrap;';
    const hangar = document.createElement('button');
    hangar.className = 'sgw-btn primary';
    hangar.textContent = 'Open hangar';
    hangar.onclick = () => this.d.openHangar();
    if (this.d.quests.currentHint() === 'hangar') hangar.classList.add('hint');
    const inv = document.createElement('button');
    inv.className = 'sgw-btn';
    inv.textContent = `Cargo & storage (${boundKeyName('inventory', settings.data.bindings)})`;
    inv.onclick = () => this.d.openInventory();
    row.append(hangar, inv, gunRangeButton((m) => this.d.send(m), (id, v) => this.d.sound(id, v)));
    left.append(row);

    // Quick sell: cargo full of ore? one click
    const ore = p.cargo.filter((s) => ['mineral', 'gem', 'volatile'].includes(p.econ.items.get(s.id)?.category ?? ''));
    if (ore.length && this.st!.services.includes('market')) {
      const total = ore.reduce((t, s) => t + saleTotal(p.econ.items, s.id, s.n, this.st!.demand[s.id] ?? 1, this.st!.sat?.[s.id] ?? 0), 0);
      const qs = document.createElement('div');
      qs.style.cssText = 'margin-top:14px; padding-top:12px; border-top:1px solid rgba(140,170,220,0.12); display:flex; align-items:center; gap:10px;';
      qs.innerHTML = `<span style="color:#a9b6c9">Ore in your hold: ${costHtml(p.econ, Object.fromEntries(ore.map((s) => [s.id, s.n])))}</span>`;
      const sell = document.createElement('button');
      sell.className = 'sgw-btn good';
      sell.style.marginLeft = 'auto';
      sell.textContent = `Sell all ore · ${total.toLocaleString()} cr`;
      sell.onclick = () => { for (const s of ore) this.d.send({ type: 'marketSell', id: s.id, n: s.n }); this.d.sound('sell', 0.7); };
      qs.append(sell);
      left.append(qs);
    }
    // Quick storage: ammunition, your loadout and utility stay aboard unless you say everything
    if (p.cargo.length) {
      const sc = document.createElement('div');
      sc.style.cssText = 'margin-top:12px; padding-top:12px; border-top:1px solid rgba(140,170,220,0.12);';
      sc.innerHTML = '<div style="color:#8394ad; font-size:11px; margin-bottom:6px">Your hold to storage <span style="color:#56657c">· ammunition, your loadout and utility stay aboard unless you store everything</span></div>';
      sc.append(storeControls(p, (m) => this.d.send(m), (id) => this.d.sound(id, 0.4)));
      left.append(sc);
    }

    const right = document.createElement('div');
    right.className = 'sgw-col';
    // Who's here to talk to: ! has a job for you, ▸ a job of yours needs them
    const people = this.d.quests.peopleAt(this.st!.id);
    if (people.length) {
      const ph = document.createElement('div');
      ph.innerHTML = '<h4>People here <span class="r">talk to them for work</span></h4>';
      for (const person of people) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:6px 8px; margin-bottom:6px; border-radius:9px; border:1px solid rgba(140,170,220,0.12); background:rgba(4,8,16,0.35);';
        const mark = person.mark === 'offer' ? '<b style="color:#fbbf24" title="Has work for you">!</b>' : person.mark === 'step' ? '<b style="color:#fbbf24" title="A job of yours needs them">▸</b>' : '';
        row.innerHTML = `<span style="width:10px; height:10px; border-radius:50%; background:${person.color}; box-shadow:0 0 8px ${person.color}"></span>
          <div style="flex:1; min-width:0"><b style="color:#e5ecf7">${esc(person.name)}</b> ${mark}<div style="color:#8394ad; font-size:11px">${esc(person.title)}</div></div>`;
        const talk = document.createElement('button');
        talk.className = `sgw-btn${person.mark ? ' primary' : ''}`;
        talk.textContent = 'Talk';
        talk.onclick = () => { this.d.quests.talk(person.id); this.d.sound('ui_click', 0.4); };
        row.appendChild(talk);
        ph.appendChild(row);
      }
      right.appendChild(ph);
    }
    right.insertAdjacentHTML('beforeend', `<h4>Services</h4>`);
    const list = document.createElement('div');
    list.style.cssText = 'line-height:1.9; color:#a9b6c9;';
    const sv = this.st!.services;
    const line = (on: boolean, name: string, text: string) => `<div style="opacity:${on ? 1 : 0.4}">${on ? '●' : '○'} <b style="color:#e5ecf7">${name}</b> · ${text}</div>`;
    list.innerHTML = line(sv.includes('repair'), 'Repair', 'heals and rebuilds your ship')
      + line(sv.includes('storage'), 'Storage', 'shared between all stations')
      + line(sv.includes('market'), 'Market', 'buy and sell')
      + line(sv.includes('refinery'), 'Refinery', 'ore into plate and wire')
      + line(sv.includes('fabricator'), 'Fabricator', 'build parts and equipment');
    const fee = DOCK_FEES.get(this.st!.id);
    if (fee) list.innerHTML += line((this.d.pilot.profile?.level ?? 0) >= DOCK_FEE_LEVEL, 'Docking fee', `${fee} cr a visit from level ${DOCK_FEE_LEVEL} (outer ring)`);
    right.append(list);
    const jobs = document.createElement('div');
    jobs.dataset.jobs = '1';
    right.append(jobs);
    grid.append(left, right);
    b.append(grid);
    this.c.renderJobs();
  }
}
