/**
 * @contract client.hangar.designs
 * owns:       the hangar's load list and saved-design slots panel (save, load, delete with confirm)
 * needs:      HangarHost (deps, bp, designAsk, designPanel, loadSelect), blueprintApi; npm: @space-game/common
 * invariants: a save or delete that would lose a design asks first — client/src/ships/hangar/hangarViews.test.ts
 * extend:     a new load source is one case in loadSelected() and one option group in refreshLoadList()
 */

import { cloneJson as clone } from '@space-game/common';
import { esc } from '../../ui/escape';
import { listBlueprints, loadBlueprint } from '../blueprintApi';
import { shipIcon } from '../../ui/itemIcons';
import type { HangarHost } from './host';
import { button } from './hangarWidgets';

export async function refreshLoadList(host: HangarHost): Promise<void> {
  const presets = host.plans().map((p) => `<option value="preset:${p.file}">${esc(p.bp.name)} · ${p.bp.parts.length} parts</option>`).join('');
  let html = `<option value="">Load a plan…</option><option value="current">Current ship</option><optgroup label="Your ship plans">${presets}</optgroup>`;
  const designs = host.designs().map((bp, i) => (bp ? `<option value="design:${i}">D${i + 1} · ${esc(bp.name)} · ${bp.parts.length} parts</option>` : '')).join('');
  if (designs) html += `<optgroup label="Your designs">${designs}</optgroup>`;
  host.designSig = host.designKey();
  const shared = host.deps.sharedDesigns?.() ?? [];
  if (shared.length) html += `<optgroup label="Shared with you">${shared.map((d, i) => `<option value="shared:${i}">${esc(d.blueprint.name)} · from ${esc(d.from)} · ${d.blueprint.parts.length} parts</option>`).join('')}</optgroup>`;
  host.loadSelect.innerHTML = html;
  try {
    const names = await listBlueprints();
    host.devApi = true;
    html += `<optgroup label="Saved designs (dev)">${names.map((n) => `<option value="file:${n}">${n}</option>`).join('')}</optgroup>`;
    host.loadSelect.innerHTML = html;
  } catch {
    // No dev file API (production build): the pre-made ships are still there
  }
}

export async function loadSelected(host: HangarHost): Promise<void> {
  const value = host.loadSelect.value;
  if (!value) return;
  const [kind, file] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)];
  try {
    if (value === 'current') {
      host.bp = clone(host.deps.getBlueprint());
    } else if (kind === 'shared') {
      // A party member's design: parts you can't make yet show as problems, the rest become ghosts when you save
      const d = (host.deps.sharedDesigns?.() ?? [])[Number(file)];
      if (!d) return;
      host.bp = clone(d.blueprint);
      host.plan = undefined;
    } else if (kind === 'design') {
      const d = host.designs()[Number(file)];
      if (!d) return;
      host.bp = clone(d);
      host.plan = undefined;
    } else {
      const preset = kind === 'preset' ? host.plans().find((p) => p.file === file) : undefined;
      host.bp = preset ? clone(preset.bp) : await loadBlueprint(file);
      host.plan = preset?.file;
    }
    host.aids.reset();
    host.recenter();
    host.refresh();
    host.status(`loaded ${host.bp.name}`);
  } catch (e) {
    host.status(String(e));
  }
  host.loadSelect.value = '';
}

export function designKey(host: HangarHost): string {
  return host.designs().map((d) => (d ? `${d.name}:${d.parts.length}:${JSON.stringify(d.parts).length}` : '-')).join('|');
}

export function toggleDesigns(host: HangarHost, open = !host.designsOpen): void {
  host.designsOpen = open;
  host.designAsk = null;
  host.designPanel.style.display = open ? 'block' : 'none';
  host.designBtn.style.borderColor = open ? '#5fd4c4' : '#2a3a5a';
  if (open) {
    host.designPanel.style.left = `${Math.max(8, Math.min(host.designBtn.offsetLeft, innerWidth - 410))}px`;
    host.renderDesigns();
  }
}

/** The design slots: save the ship on the grid into one, load one, or empty one (each asks first when it would lose a design) */
export function renderDesigns(host: HangarHost): void {
  const el = host.designPanel;
  const designs = host.designs();
  const used = designs.filter(Boolean).length;
  el.innerHTML = `<div style="display:flex; align-items:baseline; gap:8px; margin-bottom:8px"><b style="color:#ffb547; letter-spacing:1px">SAVED DESIGNS</b>`
    + `<span style="color:#6b7a93">${used} / ${designs.length}</span><span style="margin-left:auto; color:#6b7a93; font-size:11px">gems aren't saved with them</span></div>`;
  if (!designs.length) {
    el.insertAdjacentHTML('beforeend', '<div style="color:#6b7a93; padding:6px 0">Saved designs aren\'t available here.</div>');
    return;
  }
  el.insertAdjacentHTML('beforeend', `<div style="color:#8ea0bd; font-size:11px; line-height:1.45; margin-bottom:8px">Keep a design to build later: <b style="color:#cfd8e6">Save here</b> puts the ship on the grid (${esc(host.bp.name)}, ${host.bp.parts.length} parts) in that slot.</div>`);
  designs.forEach((bp, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:4px 6px; border-radius:6px; border:1px solid #1c2840; margin-bottom:4px; background:#0d1524; min-height:32px;';
    const ask = host.designAsk?.slot === i ? host.designAsk.kind : null;
    const tag = `<span style="color:#6b7a93; width:24px; flex-shrink:0">D${i + 1}</span>`;
    const act = (text: string, fn: () => void, bg = '#1a2540', title = '') => {
      const b = button(text, fn, bg);
      b.style.padding = '3px 8px';
      b.style.fontSize = '11px';
      b.title = title;
      row.appendChild(b);
      return b;
    };
    if (ask) {
      row.style.borderColor = ask === 'delete' ? '#7f1d1d' : '#7c5a12';
      row.innerHTML = `${tag}<span style="flex:1; min-width:0; color:${ask === 'delete' ? '#fca5a5' : '#fcd34d'}">${ask === 'delete' ? `Delete ${esc(bp?.name ?? 'it')}?` : `Replace ${esc(bp?.name ?? 'it')} with ${esc(host.bp.name)}?`}</span>`;
      act(ask === 'delete' ? 'Delete' : 'Replace', () => (ask === 'delete' ? host.deleteDesign(i) : host.saveDesign(i)), ask === 'delete' ? '#6b1f2a' : '#6b4f12');
      act('Cancel', () => { host.designAsk = null; host.renderDesigns(); });
    } else if (bp) {
      row.innerHTML = `${tag}<img src="${shipIcon(host.deps.econ, bp.parts, 28)}" style="width:28px; height:28px; flex-shrink:0">`
        + `<div style="flex:1; min-width:0"><div style="color:#e5ecf7; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${esc(bp.name)}</div><div style="color:#6b7a93; font-size:11px">${bp.parts.length} parts</div></div>`;
      act('Load', () => host.loadDesign(i), '#1d3d5c', 'Put it on the grid (Save to build it in host slot)');
      act('Save here', () => { host.designAsk = { slot: i, kind: 'save' }; host.renderDesigns(); }, '#1a2540', 'Replace it with the ship on the grid');
      act('✕', () => { host.designAsk = { slot: i, kind: 'delete' }; host.renderDesigns(); }, '#2a1a22', 'Delete host design');
    } else {
      row.innerHTML = `${tag}<span style="flex:1; color:#4b5870">empty</span>`;
      act('Save here', () => host.saveDesign(i), '#1f4a37', 'Keep the ship on the grid here');
    }
    el.appendChild(row);
  });
}

export function saveDesign(host: HangarHost, slot: number): void {
  host.deps.send({ type: 'designSave', slot, blueprint: clone(host.bp) });
  host.designAsk = null;
  host.status(`saved ${host.bp.name} as design D${slot + 1}`);
  host.renderDesigns();
}

export function deleteDesign(host: HangarHost, slot: number): void {
  host.deps.send({ type: 'designDelete', slot });
  host.designAsk = null;
  host.status(`design D${slot + 1} deleted`);
  host.renderDesigns();
}

export function loadDesign(host: HangarHost, slot: number): void {
  const d = host.designs()[slot];
  if (!d) return;
  host.bp = clone(d);
  host.plan = undefined;
  host.aids.reset();
  host.toggleDesigns(false);
  host.recenter();
  host.refresh();
  host.status(`loaded ${host.bp.name}: Save to build it in slot ${host.slot + 1}`);
}
