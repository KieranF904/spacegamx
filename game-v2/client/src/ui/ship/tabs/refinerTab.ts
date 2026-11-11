/**
 * The Ship window's Refiner tab: the ship's refiner (its part's, or the core's own): switch, job and progress, power;
 * what it refines (one chosen recipe, or auto: what the fabricator's plan is short of), and its auto list (the server's
 * FieldRecord.refine: once the plan needs nothing it can make, it refines these in order from the hold's ore).
 */
import { setHtml } from '../../domWrite';
import { fieldBridge } from '../../../ships/field/bridge';
import { fieldClient } from '../../../ships/field/fieldState';
import { refineChoices } from '../../../ships/field/FieldHud';
import { machineAct, machineHead } from './machineView';
import { tabRoot, onAct, sec, row, note, esc } from './view';
import type { ShipTab } from '../shipTabs';

export function refinerTab(): ShipTab {
  let root: HTMLElement | null = null;
  let head: HTMLElement, settingsEl: HTMLElement;
  let shownKey = '';
  return {
    id: 'refiner', label: 'Refiner', title: 'Your refiner: what it refines, in what order, and its power', live: 250,
    render(body, ctx) {
      root = tabRoot(body, root, () => {
        const r = document.createElement('div');
        head = document.createElement('div');
        settingsEl = document.createElement('div');
        r.append(head, settingsEl);
        onAct(r, (act, v) => {
          const m = fieldClient.machine('refiner');
          const list = m?.refine ?? [];
          if (machineAct('refiner', act, (x) => ctx.send(x))) { ctx.sound('ui_click'); return; }
          if (act === 'up') { const i = list.indexOf(v); if (i > 0) { const l = [...list]; [l[i - 1], l[i]] = [l[i], l[i - 1]]; ctx.send({ type: 'machine', kind: 'refiner', refine: l }); } }
          else if (act === 'drop') ctx.send({ type: 'machine', kind: 'refiner', refine: list.filter((x) => x !== v) });
          else if (act === 'add') {
            const sel = r.querySelector<HTMLSelectElement>('select[data-k=add]');
            if (sel?.value && !list.includes(sel.value)) ctx.send({ type: 'machine', kind: 'refiner', refine: [...list, sel.value] });
          } else return;
          ctx.sound('ui_click');
        });
        r.addEventListener('change', (e) => {
          const t = e.target as HTMLSelectElement;
          if (t.dataset.k === 'mode') ctx.send({ type: 'machine', kind: 'refiner', recipe: t.value === '' ? null : t.value });
        });
        return r;
      });
      const { m, html } = machineHead('refiner', ctx.ship(), ctx.charge());
      setHtml(head, html);
      const deps = fieldBridge.deps;
      if (!m || !deps) { setHtml(settingsEl, ''); shownKey = ''; return; }
      // (The pickers and the list: drawn again only when they change, so a select being used is never redrawn)
      const key = JSON.stringify([m.tier, m.recipe ?? '', m.refine ?? [], deps.level()]);
      if (key === shownKey) return;
      shownKey = key;
      const name = (id: string) => deps.econ.items.name(id);
      const choices = refineChoices(deps.econ, m.tier, deps.level());
      let s = sec('Refines');
      s += `<div class="sgsw-row"><span class="nm">Mode</span><select data-k="mode"><option value="">Auto: what the plan needs</option>`
        + choices.map((id) => `<option value="${esc(id)}"${m.recipe === id ? ' selected' : ''}>Only: ${esc(name(id))}</option>`).join('')
        + (m.recipe && !choices.includes(m.recipe) ? `<option value="${esc(m.recipe)}" selected>Only: ${esc(name(m.recipe))} (can't run)</option>` : '')
        + '</select></div>';
      s += note(m.recipe ? 'It refines only this, while the hold has the ore.' : 'On auto it refines what your fabricator\'s plan is short of first, then the list below.');
      s += sec('Auto list', 'refined in this order once the plan needs nothing');
      const list = m.refine ?? [];
      if (!list.length) s += note('Empty: on auto it rests once the plan needs nothing.');
      list.forEach((id, i) => {
        s += row(`${i + 1}. ${esc(name(id))}${choices.includes(id) ? '' : ' <span class="sgsw-warn">(needs a better refiner)</span>'}`,
          `${i > 0 ? `<button class="sgsw-mini" data-act="up" data-v="${esc(id)}" title="Earlier">↑</button> ` : ''}<button class="sgsw-mini" data-act="drop" data-v="${esc(id)}" title="Take it off the list">×</button>`);
      });
      const left = choices.filter((id) => !list.includes(id));
      if (left.length) s += `<div class="sgsw-btns"><select data-k="add">${left.map((id) => `<option value="${esc(id)}">${esc(name(id))}</option>`).join('')}</select><button class="sgw-btn" data-act="add">Add</button></div>`;
      s += note(`${m.tier > 0 ? `Refiner T${m.tier}` : 'The core\'s own refiner'} runs recipes up to its grade.`);
      setHtml(settingsEl, s);
    },
  };
}
