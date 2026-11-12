/**
 * The Ship window's Weapons tab: your guns by model (the weapon ring's groups, ships/gunHud.ts), each with its weapon
 * groups, its state (ready, reloading, charging, no power), its ammunition (the open crate and crates in the hold), and
 * the weapon groups with the keys that pick them.
 */
import { WEAPON_GROUPS } from '@space-game/common';
import { setHtml } from '../../domWrite';
import { readStatus, newMemory, emptyStatus } from '../../shipStatus/source';
import { tabRoot, sec, row, note, num, esc } from './view';
import type { ShipTab } from '../shipTabs';

const TONE: Record<string, string> = { ok: 'sgsw-ok', busy: '', warn: 'sgsw-warn', bad: 'sgsw-bad', dim: 'sgsw-dim' };
const groupName = (g: number) => (g === 0 ? 'all' : String(g));

export function weaponsTab(): ShipTab {
  let root: HTMLElement | null = null;
  const mem = newMemory(), rec = emptyStatus();
  return {
    id: 'weapons', label: 'Weapons', title: 'Guns, weapon groups, ammunition and reloads', live: 250,
    render(body, ctx) {
      root = tabRoot(body, root, () => document.createElement('div'));
      const ship = ctx.ship();
      const inp = ctx.statusInput();
      if (!ship || !inp) { setHtml(root, note('No ship to show.')); return; }
      readStatus(inp, mem, rec);
      const gs = inp.groups;
      if (!gs.length) { setHtml(root, note('No guns fitted.')); return; }
      const k = (a: string) => `<span class="k">${esc(ctx.keyName(a))}</span>`;
      const sel = ctx.selection();
      let html = sec('Fire buttons');
      html += row(`Left button: group <b>${groupName(sel.left)}</b>`, `${k('groupPrev')} ${k('groupNext')}`);
      html += row(`Right button: group <b>${groupName(sel.right)}</b>`, k('groupRight'));
      html += note(`${[1, 2, 3, 4, 5].map((n) => esc(ctx.keyName(`group${n}`))).filter((s) => s).join(' ')} pick the left button's group, with Shift the right button's. Again: back to all.`);

      html += sec('Guns', `${gs.reduce((n, g) => n + g.parts.length, 0)}`);
      gs.forEach((g, i) => {
        const w = rec.weapons[i];
        const chips = [1, 2, 3, 4, 5].filter((n) => g.wg & (1 << (n - 1))).map((n) => `<span class="k">${n}</span>`).join(' ');
        let state = w ? `<span class="${TONE[w.tone] ?? ''}">${w.state.toLowerCase()}</span>` : '';
        if (g.state === 2) state = '<span class="sgsw-bad">no power</span>';
        let ammo = '';
        if (g.ammo >= 0) ammo = g.ammo === 0 && g.crates <= 0 ? '<span class="sgsw-warn">out of crates: plain rounds</span>' : `${num(g.ammo)} in crate · ${num(g.crates)} in hold`;
        else if (g.clip > 0) ammo = `clip ${num(g.rounds)} / ${g.clip}`;
        html += `<div class="sgsw-row"><span class="nm">${esc(ctx.fnName(g.fn))}${g.parts.length > 1 ? ` ×${g.parts.length}` : ''}</span>${chips}<span class="v">${state}${ammo ? ` · ${ammo}` : ''}</span></div>`;
      });

      html += sec('Weapon groups');
      for (let n = 1; n <= WEAPON_GROUPS; n++) {
        const inG = gs.filter((g) => g.wg & (1 << (n - 1)));
        html += row(`Group ${n}`, inG.length ? esc(inG.map((g) => `${ctx.fnName(g.fn)}${g.parts.length > 1 ? ` ×${g.parts.length}` : ''}`).join(', ')) : '<span class="sgsw-dim">empty</span>');
      }
      html += note('Set a gun\'s groups in the hangar or the build view.');
      setHtml(root, html);
    },
  };
}
