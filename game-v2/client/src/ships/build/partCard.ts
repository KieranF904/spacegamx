/**
 * @contract client.ships.build-part-card
 * owns:       what the one hover card says about a part (pure): its kind, the one plain sentence, the three key numbers, and where the card sits
 * needs:      modelCards (tradeOff, fireChip), npm: @space-game/common
 * invariants: the sentence is never empty and never over 15 words — client/src/ships/build/partCard.test.ts
 *             at most three numbers, chosen by the part's kind — client/src/ships/build/partCard.test.ts
 *             the card is placed inside the viewport — client/src/ships/build/partCard.test.ts
 * extend:     a new part kind is one case in cardKind() and one in cardNumbers()
 */

import { partStats, type Catalog, type FunctionDef, type ShipTuning } from '@space-game/common';
import { fireChip, tradeOff } from '../modelCards';

export type CardKind = 'weapon' | 'engine' | 'generator' | 'shield' | 'storage' | 'structure';

export interface CardNumber { label: string; value: string }

const n0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
export const SUMMARY_WORDS = 15;

type Stats = NonNullable<ReturnType<typeof partStats>>;

function statsOf(catalog: Catalog, tuning: ShipTuning, fn: FunctionDef, piece?: string, material?: string): Stats | null {
  const pc = piece ?? (fn.pieces === '*' ? 'sq' : fn.pieces[0]);
  return partStats(catalog, tuning, { fn: fn.id, piece: pc, material: fn.model ? fn.material ?? 'alloy' : material ?? fn.material ?? 'alloy' }) ?? null;
}

/** What sort of part this is, for picking its numbers */
export function cardKind(fn: FunctionDef, st: Pick<Stats, 'supply' | 'thrust' | 'shield' | 'cargo'>): CardKind {
  if (fn.weapon) return 'weapon';
  if (st.thrust) return 'engine';
  if (st.supply) return 'generator';
  if (st.shield || fn.shaped) return 'shield';
  if ((fn.store ?? 0) > 0 || st.cargo) return 'storage';
  return 'structure';
}

/** A gun's rate or clip, in the gun's own terms */
function rateText(fn: FunctionDef, st: Stats): string {
  const f = fn.fire;
  if (st.pulse) return `${st.pulse.seconds.toFixed(1)} s a pulse`;
  if (f?.model === 'clip' && f.clip) return `clip of ${f.clip}`;
  if (f?.model === 'beam') return 'held beam';
  if (f?.model === 'charge') return `charge ${((f.charge ?? 0) / 60).toFixed(1)} s`;
  const rate = 60 / Math.max(1, fn.fireInterval ?? f?.interval ?? 10);
  return `${rate >= 10 ? n0(rate) : rate.toFixed(1)}/s`;
}

/** The three numbers that matter most for this kind of part (fewer when the part has fewer) */
export function cardNumbers(catalog: Catalog, tuning: ShipTuning, fn: FunctionDef, piece?: string, material?: string): CardNumber[] {
  const st = statsOf(catalog, tuning, fn, piece, material);
  if (!st) return [];
  const hull: CardNumber = { label: 'Hull', value: `${n0(st.hp)} hp` };
  const mass: CardNumber = { label: 'Mass', value: st.mass.toFixed(1) };
  const out: CardNumber[] = [];
  switch (cardKind(fn, st)) {
    case 'weapon':
      if (st.heal) out.push({ label: 'Mends', value: `${n0(st.heal)} hp/s` });
      else if (st.intercept) out.push({ label: 'Shoots', value: `${st.intercept.perSec.toFixed(1)}/s` });
      else out.push({ label: 'Damage', value: `${n0(st.dps ?? 0)}/s` });
      out.push({ label: fn.fire?.model === 'clip' ? 'Clip' : 'Rate', value: rateText(fn, st) });
      out.push({ label: 'Reach', value: st.range ? n0(st.range) : n0(st.intercept?.range ?? 0) });
      break;
    case 'engine':
      out.push({ label: 'Thrust', value: st.thrust!.toFixed(1) });
      out.push({ label: 'Power', value: st.draw ? `${n0(st.draw)}/s` : 'none' });
      out.push((st.boost ?? 1) > 1 ? { label: 'Boost', value: `×${st.boost}` } : { label: 'Boost', value: 'none' });
      break;
    case 'generator':
      out.push({ label: 'Output', value: `${n0(st.supply!)}/s` }, hull, mass);
      break;
    case 'shield':
      if (fn.shaped) {
        // (a shaped shield: a wall or an arc held out from the hull)
        const s = fn.shaped;
        out.push({ label: 'Shield', value: `${n0(s.cap)} hp` }, { label: 'Refills', value: `${s.rate}/s` });
        out.push({ label: 'Covers', value: s.kind === 'wall' ? `${s.len ?? 0} cells` : `${s.span ?? 0}°` });
        break;
      }
      out.push({ label: 'Shield', value: `${n0(st.shield ?? 0)} hp` });
      out.push({ label: 'Refills', value: fn.shieldRegen ? `${n0(fn.shieldRegen * st.area)}/s` : 'on a break' });
      out.push(st.draw ? { label: 'Power', value: `${n0(st.draw)}/s` } : hull);
      break;
    case 'storage':
      out.push(st.cargo && !(fn.store ?? 0) ? { label: 'Cargo', value: n0(st.cargo) } : { label: 'Holds', value: `${n0((fn.store ?? 0) * st.area)}` });
      out.push(hull, mass);
      break;
    default:
      out.push(hull, mass, { label: 'Armour', value: `${st.armour}` });
  }
  return out.slice(0, 3);
}

/** The first sentence of a description ("The sky-filler: a canister shell that bursts…" stays whole: the colon is no stop) */
function firstSentence(s: string | undefined): string {
  const m = (s ?? '').trim().match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : (s ?? '').trim()).replace(/[.!?]+$/, '').trim();
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * The one plain sentence on what the part is for, from text that already exists (the description's first sentence if short, else the model's trade-off line, else its
 * guide blurb), at most 15 words; else the description cut short; else its name. Never empty
 */
export function partSummary(fn: FunctionDef): string {
  const ok = (s: string) => words(s) >= 2 && words(s) <= SUMMARY_WORDS;
  const cands = [firstSentence(fn.description), tradeOff(fn), fn.guide?.blurb ?? ''].map((s) => s.trim()).filter(ok);
  if (cands.length) return cap(cands[0]);
  const d = firstSentence(fn.description).split(/\s+/).filter(Boolean);
  if (d.length) return cap(d.slice(0, SUMMARY_WORDS - 1).join(' ').replace(/[,;:]$/, '') + '…');
  return fn.name ?? fn.id;
}

/** The firing model's chip, for the card's weapon line ("clip 6 · 1.5s reload"); empty for anything but a gun */
export function fireNote(fn: FunctionDef): string {
  return fn.weapon ? fireChip(fn) : '';
}

export interface Place { x: number; y: number }

/**
 * Where the card goes: beside the list (right of it, else left), level with the row, inside the viewport; where that
 * would cover the viewport's centre (where the ship is), above or below it instead when there is room
 */
export function placeCard(list: { left: number; right: number }, row: { top: number; height: number }, w: number, h: number, vw: number, vh: number, gap = 10): Place {
  const right = list.right + gap;
  const x = right + w <= vw - 8 ? right : Math.max(8, list.left - w - gap);
  const clampY = (y: number) => Math.max(8, Math.min(vh - h - 8, y));
  const want = clampY(row.top + row.height / 2 - h / 2);
  const cx = vw / 2, cy = vh / 2, R = 70;
  const hitsCentre = x < cx + R && x + w > cx - R && want < cy + R && want + h > cy - R;
  if (!hitsCentre) return { x, y: want };
  const above = cy - R - 8 - h, below = cy + R + 8;
  const fits = (y: number) => y >= 8 && y + h <= vh - 8;
  const options = [above, below].filter(fits).sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
  return { x, y: options.length ? options[0] : want };
}
