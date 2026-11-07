/**
 * Station tab part: Gems (the Fabricator's Gems category).
 *
 * Owns: the sockets list for the ship you fly (set, take out) and the gem cutting rows (gemSocket, gemUnsocket, gemCut).
 * Needs: StationCtx (the pilot, send/sound), data/gems.json.
 * Extend: a new gem action is a row button here.
 */

import {
  partItemId, gradeOf, socketsFor, cutInputs, gemItemId,
} from '@space-game/common';
import { costHtml } from '../windowKit';
import { itemIcon } from '../itemIcons';
import { esc, fmt, GEMS } from './shared';
import type { StationCtx } from './shared';

/** Gems: cut them here (they take a while, and can fail), and set them into the guns of the ship you fly */
export function renderGems(c: StationCtx, main: HTMLElement): void {
  const econ = c.d.pilot.econ, p = c.d.pilot;
  const level = p.profile?.level ?? 1;
  const list = document.createElement('div');
  list.style.cssText = 'overflow-y:auto; flex:1;';
  const row = (html: string) => { const r = document.createElement('div'); r.style.cssText = 'display:flex; align-items:center; gap:10px; padding:7px 4px; border-bottom:1px solid rgba(140,170,220,0.07);'; r.innerHTML = html; return r; };
  // Sockets on the ship you fly
  const slot = p.hangar?.active ?? 0, bp = p.hangar?.slots[slot]?.blueprint;
  const held = [...new Set([...p.cargo, ...p.storage].map((s) => s.id).filter((id) => econ.items.get(id)?.socket))];
  list.insertAdjacentHTML('beforeend', '<h4 style="margin:0 0 6px">Sockets <span class="r">on the ship you fly · setting a gem is free; taking one out breaks it</span></h4>');
  const guns = (bp?.parts ?? []).filter((q) => socketsFor(GEMS, econ.ships, q, 100) > 0);
  if (!guns.length) list.insertAdjacentHTML('beforeend', `<div class="sgw-empty" style="padding:8px 0">No socketed guns: steel and better weapons have sockets (steel from level ${GEMS.sockets.levelByGrade[2] ?? '?'}, titanium from ${GEMS.sockets.levelByGrade[3] ?? '?'})</div>`);
  for (const q of guns) {
    const n = socketsFor(GEMS, econ.ships, q, level), now = q.gems ?? [];
    const r = row(`<img src="${itemIcon(econ, partItemId(q))}" style="width:26px;height:26px"><div style="flex:1">${esc(econ.items.name(partItemId(q)))}<br><small style="color:#8394ad">${n ? `${now.length} / ${n} sockets` : `sockets open at level ${(GEMS.sockets.levelByGrade[gradeOf(econ.ships.materials.get(q.material))] ?? 0) || '?'}`}</small></div>`);
    const acts = document.createElement('div');
    acts.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; max-width:320px;';
    now.forEach((g, i) => {
      const btn = document.createElement('button');
      btn.className = 'sgw-btn';
      btn.innerHTML = `<span style="color:${econ.items.get(g)?.color ?? '#fff'}">◆</span> ${esc(econ.items.name(g))} ✕`;
      btn.title = 'Take it out (it breaks)';
      btn.onclick = () => {
        if (btn.dataset.sure !== '1') { btn.dataset.sure = '1'; btn.innerHTML = 'Break it? Click again'; return; }
        c.d.send({ type: 'gemUnsocket', slot, uid: q.uid, index: i });
      };
      acts.appendChild(btn);
    });
    if (now.length < n) for (const g of held) {
      const btn = document.createElement('button');
      btn.className = 'sgw-btn primary';
      btn.innerHTML = `+ <span style="color:${econ.items.get(g)?.color ?? '#fff'}">◆</span> ${esc(econ.items.name(g))}`;
      btn.title = econ.items.get(g)?.description ?? '';
      btn.onclick = () => { c.d.send({ type: 'gemSocket', slot, uid: q.uid, gem: g }); c.d.sound('ui_click', 0.4); };
      acts.appendChild(btn);
    }
    r.appendChild(acts);
    list.appendChild(r);
  }
  // Cutting
  list.insertAdjacentHTML('beforeend', '<h4 style="margin:14px 0 6px">Cut a gem <span class="r">a level II cut can fail: half the stone comes back</span></h4>');
  for (const [type, t] of Object.entries(GEMS.types)) {
    for (const lv of Object.keys(t.levels)) {
      const need = cutInputs(GEMS, type, Number(lv))!, cut = GEMS.cuts[lv];
      const ok = Object.entries(need).every(([id, k]) => c.have(id) >= k);
      const r = row(`<img src="${itemIcon(econ, gemItemId(type, Number(lv)))}" style="width:26px;height:26px"><div style="flex:1"><span style="color:${t.color}">${esc(econ.items.name(gemItemId(type, Number(lv))))}</span><br><small style="color:#a7b4c8">${esc(t.levels[lv].summary)}</small></div>`
        + `<div style="width:230px">${costHtml(econ, need, (id) => c.have(id))}<br><small style="color:#8394ad">${fmt(cut.seconds)}${cut.fail ? ` · ${Math.round(cut.fail * 100)}% fail` : ''}</small></div>`);
      const btn = document.createElement('button');
      btn.className = 'sgw-btn' + (ok ? ' primary' : ' off');
      btn.textContent = 'Cut';
      btn.onclick = () => { c.d.send({ type: 'gemCut', gem: type, level: Number(lv) }); c.d.sound('ui_click', 0.4); };
      r.appendChild(btn);
      list.appendChild(r);
    }
  }
  main.append(list);
}
