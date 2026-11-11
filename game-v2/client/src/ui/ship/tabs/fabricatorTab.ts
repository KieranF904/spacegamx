/**
 * The Ship window's Fabricator tab: the ship's fabricator (its part's, or the core's own): switch, the job under way and
 * its power; the pack mode; and its queue (fabQueue.ts): every part it has work for in the order it takes them, what each
 * waits on, and per part "First" (to the front of its priority list) and "Hold" / "Go on" (the server's fieldOrder).
 */
import { setHtml } from '../../domWrite';
import { fieldBridge } from '../../../ships/field/bridge';
import { fieldClient } from '../../../ships/field/fieldState';
import { PACK_MODE_LIST, PACK_MODE_TEXT, packModeOf } from '../../../ships/field/fieldText';
import { shortLine } from '../../../ships/field/FieldHud';
import { fabQueue, type QueueRow } from '../fabQueue';
import { queueInput } from './queueParts';
import { machineAct, machineHead } from './machineView';
import { tabRoot, onAct, sec, note, esc, pct } from './view';
import type { ShipTab } from '../shipTabs';

const KIND_WORD = { repair: 'Repair', build: 'Build', recycle: 'Recycle' } as const;
const STATE_CLS = { working: 'sgsw-ok', held: 'sgsw-dim', short: 'sgsw-warn', grade: 'sgsw-bad', ready: '' } as const;

function queueRow(r: QueueRow): string {
  const what = `${KIND_WORD[r.kind]}: ${esc(r.name)}${r.kind === 'repair' ? ` <span class="sgsw-dim">${pct(1 - r.missing)}</span>` : ''}`;
  const first = r.first ? `<span class="k" title="On your priority list">${r.first}</span>` : '';
  const btns = r.state === 'held'
    ? `<button class="sgsw-mini" data-act="resume" data-v="${r.uid}" title="Let the fabricator work on it again">Go on</button>`
    : `${r.state !== 'working' ? `<button class="sgsw-mini" data-act="top" data-v="${r.uid}" title="Put it first">First</button> ` : ''}<button class="sgsw-mini" data-act="hold" data-v="${r.uid}" title="Leave it for now (a job under way on it is called off, its inputs back to the hold)">Hold</button>`;
  return `<div class="sgsw-row">${first}<span class="nm">${what}<br><span class="${STATE_CLS[r.state]}" style="font-size:11px">${esc(r.waits)}</span></span><span class="v">${btns}</span></div>`;
}

export function fabricatorTab(): ShipTab {
  let root: HTMLElement | null = null;
  let head: HTMLElement, packsEl: HTMLElement, queueEl: HTMLElement;
  let packKey = '';
  return {
    id: 'fabricator', label: 'Fabricator', title: 'Your fabricator: its queue, what each part waits on, power, pause and priority', live: 300,
    render(body, ctx) {
      root = tabRoot(body, root, () => {
        const r = document.createElement('div');
        head = document.createElement('div');
        packsEl = document.createElement('div');
        queueEl = document.createElement('div');
        r.append(head, packsEl, queueEl);
        onAct(r, (act, v) => {
          if (machineAct('fabricator', act, (x) => ctx.send(x))) { ctx.sound('ui_click'); return; }
          const uid = Number(v);
          if (act === 'top' || act === 'hold' || act === 'resume') ctx.send({ type: 'fieldOrder', action: act, uid });
          else if (act === 'clear') ctx.send({ type: 'fieldOrder', action: 'clear' });
          else return;
          ctx.sound('ui_click');
        });
        r.addEventListener('change', (e) => {
          const t = e.target as HTMLSelectElement;
          if (t.dataset.k === 'packs') ctx.send({ type: 'machine', kind: 'fabricator', packs: t.value as (typeof PACK_MODE_LIST)[number] });
        });
        return r;
      });
      const ship = ctx.ship();
      const { m, html } = machineHead('fabricator', ship, ctx.charge());
      setHtml(head, html);
      const deps = fieldBridge.deps;
      if (!m || !deps || !ship) { setHtml(packsEl, ''); setHtml(queueEl, ''); packKey = ''; return; }
      const mode = packModeOf(m);
      if (mode !== packKey) {
        packKey = mode;
        setHtml(packsEl, `<div class="sgsw-row"><span class="nm">Material packs</span><select data-k="packs">${PACK_MODE_LIST.map((p) => `<option value="${p}"${p === mode ? ' selected' : ''}>${esc(PACK_MODE_TEXT[p])}</option>`).join('')}</select></div>`);
      }
      const qi = queueInput(ship, ctx.fnName, (id) => ctx.pilot.cargo.find((x) => x.id === id)?.n ?? 0);
      const rows = qi ? fabQueue(qi) : [];
      let q = sec('Queue', rows.length ? `${rows.length} part${rows.length === 1 ? '' : 's'}${m.first?.length ? ` · <button class="sgsw-mini" data-act="clear" title="Empty your priority list: back to the usual order">Usual order</button>` : ''}` : 'nothing to do');
      if (!rows.length) q += note('Nothing to build, repair or recycle. Plan new parts in the build view.');
      q += rows.slice(0, 24).map(queueRow).join('');
      if (rows.length > 24) q += note(`and ${rows.length - 24} more`);
      const need = shortLine(fieldClient.state?.short, (id) => deps.econ.items.name(id));
      if (need) q += note(need, 'sgsw-warn');
      q += note('Usual order: damaged parts nearest the core first, then recycling, then missing and planned parts. "First" puts a part ahead of that; "Hold" leaves it alone. Off pauses the job under way.');
      setHtml(queueEl, q);
    },
  };
}
