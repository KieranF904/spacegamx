/**
 * The station's Repair bank tab (docs/design/field-fabrication.md, 2.4): your one bank, the same at every station.
 *
 *   Free part  a bar that refills by itself ("full in ..."). It pays for your ship at once after a respawn and can't be
 *              taken out. The spare is the top of it that may also pay repairs.
 *   Deposits   packs and refined materials you put in; counted apart, never taken out. They mend your ship near a
 *              station and rebuild it after a respawn.
 *
 * Everything shown is what the server reported (`repairBank`); a deposit is a request the server checks. The html is
 * built by pure functions (bankHtml, depositRows) so tests can read it without a page.
 */

import { depositable, countOf, type Bag, type Economy, type ServerRepairBankMessage, type Stack, type ClientMessage } from '@space-game/common';
import { packRows, packsHtml, wirePacks } from './packs';
import { esc } from '../escape';


export type DepositFrom = 'cargo' | 'storage';

/** The stacks the bank would take: packs, refined materials and components only (never ore, parts or ammunition) */
export function depositStacks(econ: Economy, stacks: readonly Stack[]): Stack[] {
  return stacks.filter((s) => s.n > 0 && depositable(econ, s.id)).sort((a, b) => econ.items.name(a.id).localeCompare(econ.items.name(b.id)));
}

/** "12 min", "1 h 5 min", "40 s" */
export function fullInText(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.ceil(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

const whole = (v: number) => Math.floor(v + 1e-9);
const sum = (b: Bag) => Object.values(b).reduce((a, n) => a + n, 0);

/** The free part as a share of its cap, 0 to 1 */
export function freeShare(m: Pick<ServerRepairBankMessage, 'free' | 'cap'>): number {
  const cap = sum(m.cap);
  if (cap <= 0) return 1;
  let have = 0;
  for (const [id, c] of Object.entries(m.cap)) have += Math.min(c, m.free[id] ?? 0);
  return Math.max(0, Math.min(1, have / cap));
}

function chips(econ: Economy, icon: (id: string) => string, bag: Bag, cap?: Bag): string {
  const ids = Object.keys(cap ?? bag).filter((id) => (bag[id] ?? 0) > 0 || cap);
  return ids.map((id) => `<span class="sgw-cost" title="${esc(econ.items.name(id))}"><img src="${icon(id)}">${whole(bag[id] ?? 0)}${cap ? `<small style="opacity:.6">/${cap[id] ?? 0}</small>` : ''}</span>`).join('');
}

/**
 * The top of the tab: the free part, the spare and the deposits. `elapsed`: seconds since the message came, so "full in"
 * counts down between reports
 */
export function bankHtml(econ: Economy, icon: (id: string) => string, m: ServerRepairBankMessage | null, elapsed = 0): string {
  if (!m) return '<div class="sgw-empty">Reading your repair bank…</div>';
  const share = freeShare(m);
  const left = Math.max(0, m.fullIn - elapsed);
  const full = m.fullIn <= 0 || left <= 0 || share >= 1;
  const spare = chips(econ, icon, m.spare);
  const deposits = chips(econ, icon, m.deposits);
  return `<h4>Free part <span class="r" data-bank="fullin">${full ? 'full' : `full in ${fullInText(left)}`}</span></h4>
    <div class="sgw-bar${full ? ' full' : ''}" data-bank="bar"><i style="width:${Math.round(share * 100)}%"></i></div>
    <div class="bank-items" data-bank="free">${chips(econ, icon, m.free, m.cap)}</div>
    <p class="bank-note">Refills by itself. After a respawn it pays for your ship at once, core first. It can't be taken out.</p>
    <p class="bank-note" data-bank="spare">${spare ? `Spare for repairs: <span class="bank-items">${spare}</span>` : 'No spare for repairs: it opens when the free part is more than 75% full.'}</p>
    <h4 style="margin-top:14px">Deposits <span class="r">${deposits ? '' : 'none yet'}</span></h4>
    <div class="bank-items" data-bank="deposits">${deposits}</div>
    <p class="bank-note">Deposits are kept apart and can't be taken out. They mend your ship near any station. After a respawn they rebuild what the free part didn't cover, anywhere. A pack gives all it holds to the part it repairs; anything the part doesn't need is wasted.</p>
    ${m.rebuilding ? `<p class="bank-note" style="color:#7dd3fc" data-bank="rebuilding">Rebuilding from deposits: ${m.rebuilding} part${m.rebuilding === 1 ? '' : 's'} left.</p>` : ''}`;
}

/** One side of the deposit list (the hold or storage): every depositable stack with its buttons */
export function depositRows(econ: Economy, icon: (id: string) => string, stacks: readonly Stack[], from: DepositFrom): string {
  const rows = depositStacks(econ, stacks);
  if (!rows.length) return '<div class="bank-note">Nothing here the bank takes.</div>';
  return rows.map((s) => `<div class="bank-row" data-dep="${esc(s.id)}" data-from="${from}">
      <img src="${icon(s.id)}" alt=""><span class="nm">${esc(econ.items.name(s.id))}</span><span class="ct">${s.n}</span>
      <button class="sgw-btn" data-put="1">Put in 1</button>${s.n > 1 ? `<button class="sgw-btn" data-put="${s.n}">Put in all</button>` : ''}
    </div>`).join('');
}

export const BANK_CSS = `
.bank-items { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-height: 20px; }
.bank-note { color: #8394ad; font-size: 12px; line-height: 1.5; margin: 6px 0; max-width: 680px; }
.bank-row { display: flex; align-items: center; gap: 8px; padding: 4px 2px; border-bottom: 1px solid rgba(140,170,220,0.07); font-size: 12px; }
.bank-row img { width: 22px; height: 22px; }
.bank-row .nm { flex: 1; }
.bank-row .ct { color: #8394ad; min-width: 28px; text-align: right; }
.bank-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
`;

export interface BankPanelDeps {
  econ: Economy;
  icon(id: string): string;
  send(m: ClientMessage): void;
  sound(id: string, volume?: number): void;
  cargo(): Stack[];
  storage(): Stack[];
  /** Recipes learned and the pilot's level (which packs can be made) */
  learned(): string[];
  level(): number;
}

/** Draw the tab into `host`: the bank, what can be put in (hold, storage) and the packs to make */
export function mountBank(host: HTMLElement, d: BankPanelDeps, m: ServerRepairBankMessage | null, receivedAt: number): void {
  const css = document.createElement('style');
  css.textContent = BANK_CSS;
  const col = document.createElement('div');
  col.className = 'sgw-col';
  col.style.cssText = 'overflow-y:auto; height: min(580px, calc(100vh - 230px));';
  col.innerHTML = `${bankHtml(d.econ, d.icon, m, (Date.now() - receivedAt) / 1000)}
    <h4 style="margin-top:14px">Put in <span class="r">from your hold or storage; kept for good</span></h4>
    <div class="bank-cols">
      <div><div class="sgw-label">Hold</div>${depositRows(d.econ, d.icon, d.cargo(), 'cargo')}</div>
      <div><div class="sgw-label">Storage</div>${depositRows(d.econ, d.icon, d.storage(), 'storage')}</div>
    </div>
    ${packsHtml(d.econ, d.icon, packRows(d.econ, d.learned(), d.level(), d.storage()))}`;
  col.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const put = t.closest<HTMLElement>('[data-put]');
    const row = t.closest<HTMLElement>('[data-dep]');
    if (!put || !row) return;
    const id = row.dataset.dep!, from = row.dataset.from as DepositFrom;
    const n = Math.min(countOf(from === 'cargo' ? d.cargo() : d.storage(), id), Number(put.dataset.put));
    if (n < 1 || !depositable(d.econ, id)) return;
    d.send({ type: 'bankDeposit', items: { [id]: n }, from });
    d.sound('ui_click', 0.5);
  });
  wirePacks(col, d.send, d.sound);
  host.append(css, col);
}
