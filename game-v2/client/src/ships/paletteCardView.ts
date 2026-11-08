/**
 * A palette row's compact card as markup (the palette's second line): three small bars for a weapon (or the headline
 * numbers of anything else), then the ammunition as its own item icon with how many a shot uses, and the power need
 * as a bolt and a number with where it is fed. Styled by HangarPalette's sheet (`.hp-card`); pure data in paletteCard.ts.
 */

import type { Economy } from '@space-game/common';
import { esc } from '../ui/componentKit';
import { itemIcon } from '../ui/itemIcons';
import type { CardStats } from './paletteCard';

const BOLT = `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.2 1 3 9h4l-.9 6L13 6.6H9L9.2 1Z"/></svg>`;

const n0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');

const SHORT = { hit: 'Dmg', rate: 'Rate', range: 'Reach', dps: 'Dmg/s' } as const;
/** A long number short for a narrow column: 7,182 -> 7.2k */
const compact = (t: string) => { const n = Number(t.replace(/,/g, '')); return Number.isFinite(n) && n >= 1000 ? `${n >= 10000 ? Math.round(n / 1000) : (n / 1000).toFixed(1)}k` : t; };

const POWER_WORD = { draw: 'Uses', make: 'Makes', hold: 'Holds' } as const;

/** The power chip: "⚡ 29/s from back" */
export function powerChipHtml(p: NonNullable<CardStats['power']>): string {
  const amount = p.kind === 'hold' ? n0(p.amount) : `${n0(p.amount)}/s`;
  const where = p.where ? `<small>from ${esc(p.where)}</small>` : '';
  const title = `${POWER_WORD[p.kind]} ${amount} of power${p.where ? `, fed from its ${p.where}` : ''}`;
  return `<span class="hp-pw ${p.kind}" title="${esc(title)}">${BOLT}<b>${amount}</b>${where}</span>`;
}

/** The ammo chip: the ammo item's icon and the rounds a shot spends */
export function ammoChipHtml(econ: Economy, a: NonNullable<CardStats['ammo']>): string {
  const name = econ.items.name(a.item);
  return `<span class="hp-am" title="${esc(`Fires ${name}: ${a.per} a shot, no power`)}"><img src="${itemIcon(econ, a.item)}" alt=""><b>×${a.per}</b></span>`;
}

/** The whole card (bars or headlines, then ammo and power chips) */
export function cardHtml(econ: Economy, c: CardStats): string {
  let top = '';
  if (c.bars.length) {
    top = `<span class="hp-bars" style="--n:${c.bars.length}">${c.bars.map((b) => `<span class="hp-bar" title="${esc(`${b.label}: ${b.text}`)}"><em>${SHORT[b.id]}</em><i style="--f:${(b.frac * 100).toFixed(0)}%"></i><b>${esc(b.id === 'range' ? compact(b.text) : b.text)}</b></span>`).join('')}</span>`;
  } else if (c.heads.length) {
    top = `<span class="hp-heads">${c.heads.map(esc).join(' · ')}</span>`;
  }
  const held = c.held ? '<span class="hp-held" title="Fires all the time while held">held</span>' : '';
  const chips = held + (c.ammo ? ammoChipHtml(econ, c.ammo) : '') + (c.power ? powerChipHtml(c.power) : '');
  return `${top}${chips ? `<span class="hp-chipsrow">${chips}</span>` : ''}`;
}

/** What the bars stand for, once, as a key above the list ("Damage per hit · Shots a second · Reach") */
export const BAR_KEY = 'Bars: damage per hit, shots a second, reach';
