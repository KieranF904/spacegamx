/**
 * The Ship window's Kills tab: the session's significant events, newest first (killLog.ts): kills collapsed by enemy
 * ("5× Scrap Mother") with what they paid totalled under them, bosses beaten, the ship lost. No per-hit log.
 */
import { setHtml } from '../../domWrite';
import { killLog, killLoot, killTitle, type KillKind } from '../killLog';
import { tabRoot, onAct, note, esc } from './view';
import type { ShipTab } from '../shipTabs';

const COLOR: Record<KillKind, string> = { kill: '#e5ecf7', assist: '#9fb0cc', boss: '#fbbf24', death: '#f87171' };

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

export function killsTab(): ShipTab {
  let root: HTMLElement | null = null;
  return {
    id: 'kills', label: 'Kills', title: 'What you have shot down this session, and what it paid', live: 1000,
    render(body, ctx) {
      root = tabRoot(body, root, () => {
        const r = document.createElement('div');
        onAct(r, (act) => { if (act === 'clear') { killLog.clear(); ctx.sound('ui_click'); ctx.openTab('kills'); } });
        return r;
      });
      const rows = killLog.rows;
      if (!rows.length) { setHtml(root, note('Nothing yet this session. Your kills, bosses beaten and what they paid show here.')); return; }
      const now = Date.now();
      let html = `<div class="sgsw-sec">This session<span><button class="sgsw-mini" data-act="clear">Clear</button></span></div>`;
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        const loot = killLoot(r, (id) => ctx.pilot.econ.items.name(id));
        html += `<div class="sgsw-row" style="display:block"><div style="display:flex; gap:8px"><b style="color:${COLOR[r.kind]}; flex:1">${esc(killTitle(r))}</b><span class="v">${ago(now - r.last)}</span></div>`
          + (loot ? `<div class="sgsw-note" style="margin:2px 0 0">${esc(loot)}</div>` : '') + '</div>';
      }
      setHtml(root, html);
    },
  };
}
