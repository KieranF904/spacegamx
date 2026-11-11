/**
 * Station tab: Refinery.
 *
 * Owns: the refining recipes with their batch buttons (refine), and the refining job list with what orders are waiting on.
 * Needs: StationCtx (the pilot, the station jobs, send/sound, the jobs ticker, waitingHtml from jobs.ts).
 * Extend: a new recipe button goes in render()'s batch loop.
 */

import {
  jobLanes,
} from '@space-game/common';
import { costHtml } from '../windowKit';
import { itemIcon } from '../itemIcons';
import { esc, fmt } from './shared';
import { waitingHtml } from './jobs';
import type { StationCtx } from './shared';

export class RefineryTab {
  constructor(private c: StationCtx) {}
  private get d() { return this.c.d; }
  private get st() { return this.c.st; }

  render(b: HTMLElement): void {
    const econ = this.d.pilot.econ;
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns: 1fr 300px; gap:14px; height: min(580px, calc(100vh - 230px));';
    const col = document.createElement('div');
    col.className = 'sgw-col';
    col.style.overflowY = 'auto';
    col.innerHTML = '<h4>Refinery <span class="r">ore from cargo and storage · plate to storage as each batch finishes</span></h4>';
    const level = this.d.pilot.profile?.level ?? 1;
    for (const r of econ.recipes.refining.values()) {
      const locked = !!r.level && level < r.level;
      const max = locked ? 0 : Math.min(...Object.entries(r.inputs).map(([id, n]) => Math.floor(this.c.have(id) / n)));
      const row = document.createElement('div');
      row.style.cssText = `display:flex; align-items:center; gap:12px; padding:9px 4px; border-bottom:1px solid rgba(140,170,220,0.07);${locked ? ' opacity:0.5;' : ''}`;
      row.innerHTML = `<div style="flex:1">${costHtml(econ, r.inputs, (id) => this.c.have(id))}</div><div style="color:#7dd3fc; font-size:18px">→</div>`
        + `<div style="width:200px; display:flex; align-items:center; gap:6px"><img src="${itemIcon(econ, r.id)}" style="width:30px;height:30px"><span>${r.out} × ${esc(econ.items.name(r.id))}<br><small style="color:#8394ad">${r.time ?? 2}s a batch</small></span></div>`;
      // The buttons in a fixed-width column, so every row's arrow and output line up
      const acts = document.createElement('div');
      acts.style.cssText = 'width:200px; display:flex; justify-content:flex-end; align-items:center; gap:8px;';
      row.appendChild(acts);
      // Orders go in whatever ore is in hand: a batch starts when its ore is in storage (the queue has no limit)
      for (const n of locked ? [] : [1, 10, 100, max]) {
        if (n <= 0 || (n === max && (max === 1 || max === 10 || max === 100))) continue;
        const btn = document.createElement('button');
        btn.className = 'sgw-btn' + (n === max ? ' primary' : '');
        btn.dataset.key = `refine:${r.id}:${n === max ? 'max' : n}`;
        btn.textContent = n === max ? `Max (${max})` : `×${n}`;
        btn.title = `${n * r.out} × ${econ.items.name(r.id)}: ${fmt((r.time ?? 2) * n)}${n > max ? ' (waits for ore: it starts as the ore reaches storage)' : ''}`;
        btn.onclick = () => { this.d.send({ type: 'refine', recipe: r.id, batches: n }); this.d.sound('ui_click', 0.4); };
        acts.appendChild(btn);
      }
      if (locked) {
        const no = document.createElement('span');
        no.style.cssText = 'color:#56657c; font-size:12px; width:70px; text-align:right';
        no.textContent = `level ${r.level}`;
        acts.appendChild(no);
      }
      col.appendChild(row);
    }
    const side = document.createElement('div');
    side.className = 'sgw-col';
    const lanes = jobLanes({ skills: this.d.pilot.profile?.skills });
    side.innerHTML = `<h4>Refining <span class="r" title="No limit on orders; the refinery works ${lanes} at once, and an order short of ore waits without holding up the rest">runs ${lanes} at once</span></h4>`;
    side.style.overflowY = 'auto';
    const jobs = document.createElement('div');
    jobs.dataset.jobs = 'refine';
    const waiting = document.createElement('div');
    waiting.innerHTML = waitingHtml(this.c, 'material');
    side.append(jobs, waiting);
    const note = document.createElement('div');
    note.style.cssText = 'margin-top:auto; color:#56657c; font-size:11px; line-height:1.5; padding-top:10px;';
    note.textContent = 'Refining takes a while, and keeps going while you\'re away. Ships on order in the hangar queue their own refining.';
    side.append(note);
    grid.append(col, side);
    b.append(grid);
    this.c.renderJobs();
  }
}
