/**
 * The admin panel's repair bank buttons (dev servers only; the server refuses `devBank` anywhere else too). Pure html and
 * the message each button sends, so the panel needs a line to show them and a line to wire them.
 */

import { packDefs, type Bag, type ClientDevBankMessage, type Economy } from '@space-game/common';

export const DEV_BANK_BUTTONS: { act: ClientDevBankMessage['action']; label: string; title: string }[] = [
  { act: 'fill', label: 'Fill bank', title: 'Dev server only: the free part to full' },
  { act: 'empty', label: 'Empty bank', title: 'Dev server only: the free part to nothing (the next death comes back as a bare core)' },
  { act: 'clearDeposits', label: 'Clear deposits', title: 'Dev server only: take every deposit out of the bank' },
  { act: 'grant', label: 'Grant pack kit', title: 'Dev server only: 10 of every pack, into the deposits' },
];

/** The buttons' row; nothing at all unless the server is a dev server */
export function devBankHtml(dev: boolean): string {
  if (!dev) return '';
  return `<div class="adm-sec">Repair bank</div><div class="adm-row">${DEV_BANK_BUTTONS.map((b) => `<button class="adm-btn" data-devbank="${b.act}" title="${b.title}">${b.label}</button>`).join('')}</div>`;
}

/** What `grant` gives: some of every pack in the catalogue */
export function packKit(econ: Economy, each = 10): Bag {
  const out: Bag = {};
  for (const p of packDefs(econ.items)) out[p.id] = each;
  return out;
}

/** The message a button sends */
export function devBankMessage(econ: Economy, act: string): ClientDevBankMessage | null {
  const b = DEV_BANK_BUTTONS.find((x) => x.act === act);
  if (!b) return null;
  return b.act === 'grant' ? { type: 'devBank', action: 'grant', items: packKit(econ) } : { type: 'devBank', action: b.act };
}
