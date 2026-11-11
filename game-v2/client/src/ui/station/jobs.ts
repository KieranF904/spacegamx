/**
 * Station jobs: the job lists and what orders wait on.
 *
 * Owns: the live job rows (the refinery and fabricator queues and the overview list: rows rebuilt only when the list changes so clicks land, progress bars and timers updated in place) and the Waiting list of orders that cannot start yet.
 * Needs: StationCtx (the station jobs, the clock, send/sound); any element with data-jobs="refine" | "fab" | "1" in the window body.
 * Extend: a new job action is a data-act button in jobRow().
 */

import {
  JobView, countOf,
} from '@space-game/common';
import { costHtml } from '../windowKit';
import { itemIcon } from '../itemIcons';
import { esc, fmt, forText, stationName } from './shared';
import type { StationCtx } from './shared';

/** What hangar orders want from this queue but can't start yet (refinery: materials; fabricator: modules) */
export function waitingHtml(c: StationCtx, stage: 'material' | 'part'): string {
  const econ = c.d.pilot.econ;
  const rows: string[] = [];
  for (const o of c.orders()) {
    if (!o.auto) continue;
    for (const l of o.lines) {
      if (l.stage !== stage || (!l.waiting && l.blocked !== 'schematic')) continue;
      const n = l.waiting || l.short;
      let why = '';
      if (l.blocked === 'schematic') why = '<span style="color:#fca5a5">🔒 not open yet</span>';
      else if (l.blocked === 'queue') why = `<span style="color:#8394ad">next, when a ${stage === 'material' ? 'refinery' : 'fabricator'} slot frees</span>`;
      else {
        // What it's short of: for a material, its ore; for a module, its materials
        const inputs: Record<string, number> = {};
        if (stage === 'material') {
          const r = econ.recipes.refining.get(l.id);
          for (const [id, k] of Object.entries(r?.inputs ?? {})) inputs[id] = k * Math.ceil(n / Math.max(1, r!.out));
        } else {
          const r = econ.recipes.recipeFor(l.id);
          for (const [id, k] of Object.entries(r?.inputs ?? {})) inputs[id] = k * Math.ceil(n / Math.max(1, r!.out[l.id] ?? 1));
        }
        why = `<span style="color:#fbbf24">needs</span> ${costHtml(econ, inputs, (id) => countOf(c.d.pilot.storage, id))}`;
      }
      rows.push(`<div style="margin:6px 0 9px; font-size:12px"><div style="display:flex; align-items:center; gap:6px">`
        + `<img src="${itemIcon(econ, l.id)}" style="width:20px; height:20px"><span style="flex:1">${n} × ${esc(econ.items.name(l.id))}</span>`
        + `<span style="color:${o.paused ? '#fbbf24' : '#7dd3fc'}; font-size:11px; white-space:nowrap">${esc(o.name)}${o.paused ? ' ⏸' : ''}</span></div>`
        + `<div style="color:#8394ad; font-size:11px; margin:2px 0 0 26px">for ${esc(forText(l))}</div>`
        + `<div style="font-size:11px; margin:2px 0 0 26px">${why}</div></div>`);
    }
  }
  if (!rows.length) return '';
  return `<h4 style="margin-top:14px">Waiting <span class="r">orders that can't start yet</span></h4>${rows.join('')}`;
}

/** Just the job lists (they tick along every half second; rows are rebuilt only when the list changes, so clicks land) */
export function renderJobs(c: StationCtx, body: HTMLElement): void {
  const st = c.st;
  if (!st) return;
  const now = c.now();
  for (const el of body.querySelectorAll<HTMLElement>('[data-jobs]')) {
    const kind = el.dataset.jobs;
    const list = st.jobs.filter((j) => kind === 'refine' ? j.recipe.startsWith('refine:') : kind === 'fab' ? !j.recipe.startsWith('refine:') : true);
    if (!el.dataset.wired) {
      el.dataset.wired = '1';
      el.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
        if (!b) return;
        c.d.send({ type: 'job', id: Number(b.dataset.job), action: b.dataset.act as 'pause' | 'resume' | 'cancel' | 'top' });
        c.d.sound('ui_click', 0.4);
      });
    }
    const key = list.map((j) => `${j.id}:${j.done}:${j.paused ? 1 : 0}:${j.startedAt}`).join(',');
    if (el.dataset.key !== key) {
      el.dataset.key = key;
      el.innerHTML = list.length ? list.map((j) => jobRow(c, j, st.jobs, st.id)).join('')
        : `<div class="sgw-empty" style="padding:10px 0">${kind === 'refine' ? 'Nothing refining' : kind === 'fab' ? 'No fabrication in progress' : 'Nothing in progress'}</div>`;
    }
    for (const j of list) {
      const row = el.querySelector<HTMLElement>(`[data-row="${j.id}"]`);
      if (!row) continue;
      const span = j.unitMs * j.count;
      const frac = j.paused ? (j.done * j.unitMs + (j.heldMs ?? 0)) / Math.max(1, span) : Math.min(1, (now - j.startedAt) / Math.max(1, j.readyAt - j.startedAt));
      const left = Math.max(0, (j.readyAt - now) / 1000);
      row.querySelector<HTMLElement>('.sgw-bar > i')!.style.width = `${Math.max(0, frac) * 100}%`;
      const t = row.querySelector<HTMLElement>('[data-left]')!;
      t.textContent = j.paused ? '⏸ on hold' : left <= 0 ? 'done' : now < j.startedAt ? `queued · ${fmt(left)}` : fmt(left);
      t.style.color = j.paused ? '#fbbf24' : left <= 0 ? '#86efac' : '#8394ad';
    }
  }
}

/** One job: what it makes, what for, its progress, and its controls */
function jobRow(c: StationCtx, j: JobView & { stationName: string }, all: JobView[], here: string): string {
  const econ = c.d.pilot.econ;
  const out = Object.entries(j.out).map(([id, n]) => `${n * j.count} × ${esc(econ.items.name(id))}`).join(', ');
  const done = j.count > 1 ? ` <span style="color:#56657c">${j.done}/${j.count}</span>` : '';
  const refine = j.recipe.startsWith('refine:');
  const first = all.find((x) => x.station === j.station && x.recipe.startsWith('refine:') === refine && !x.paused);
  const act = (a: string, label: string, title: string) => `<button class="sgw-btn" data-job="${j.id}" data-act="${a}" title="${title}" style="padding:2px 7px; font-size:11px">${label}</button>`;
  const note = [j.for ? `for the ${esc(j.for)}` : '', j.station !== here ? `at ${esc(j.stationName)}` : ''].filter(Boolean).join(' · ');
  return `<div data-row="${j.id}" style="margin:6px 0 10px; ${j.paused ? 'opacity:0.75' : ''}"><div style="display:flex; justify-content:space-between; gap:8px"><span>${out}${done}</span>`
    + `<span data-left style="white-space:nowrap"></span></div>`
    + `<div class="sgw-bar" style="margin:4px 0 0"><i></i></div>`
    + `<div style="display:flex; align-items:center; gap:4px; margin-top:3px"><span style="flex:1; color:#56657c; font-size:11px">${note}</span>`
    + (j.paused ? act('resume', '▶', 'Resume') : act('pause', '⏸', 'Pause: the rest of the queue moves up'))
    + (first && first.id !== j.id ? act('top', '⇧', 'Move it to the front of the queue') : '')
    + act('cancel', '✕', j.for ? `Cancel (materials go back to storage); the ${j.for}'s order is paused` : 'Cancel: its materials go back to storage')
    + '</div></div>';
}
