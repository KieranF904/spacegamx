/**
 * @contract client.ships.plan-cost-view
 * owns:       the words and the small DOM for the plan-cost readout shared by the world build view and the hangar: needs against the hold, what is short (each a link to its Resources entry), the time
 * needs:      planCost (the numbers), ../../ui/escape, ../../ui/resources/resourceFocus (the link target); DOM (bindResourceLinks only)
 * invariants: every name is escaped — client/src/ships/build/planCost.test.ts
 *             a short material is a link carrying its item id — client/src/ships/build/planCost.test.ts
 * extend:     a new line is one more piece in fieldReadoutHtml / stationReadoutHtml
 */
import { esc } from '../../ui/escape';
import { openResource } from '../../ui/resources/resourceFocus';
import { durationText, type CostReadout, type StationReadout } from './planCost';

type Name = (id: string) => string;

const LINK_STYLE = 'color:#fbbf24; text-decoration:underline dotted; cursor:pointer';

/** A material name that opens its Resources entry */
export function resLink(id: string, text: string): string {
  return `<a data-res="${esc(id)}" href="#" title="Open ${esc(text)} in the field guide" style="${LINK_STYLE}">${esc(text)}</a>`;
}

const lower = (s: string): string => s.toLowerCase();

/** "3 alloy plate, 1 copper wire" with each material a link */
function shortList(short: Record<string, number>, name: Name): string {
  return Object.keys(short).filter((id) => short[id] > 0).sort().map((id) => `${short[id]} ${resLink(id, lower(name(id)))}`).join(', ');
}

/** The world view's readout: "Needs: 6 alloy plate (have 3) · Short: 3 alloy plate · about 4 min to build" ('' when nothing is missing) */
export function fieldReadoutHtml(r: CostReadout, name: Name): string {
  if (r.parts === 0) return '';
  const rows: string[] = [];
  if (r.lines.length) rows.push(`Needs: ${r.lines.slice(0, 6).map((l) => `${l.need} ${esc(lower(name(l.id)))} (have ${l.have})`).join(', ')}${r.lines.length > 6 ? ` and ${r.lines.length - 6} more` : ''}`);
  else if (r.fromHold) rows.push(`${r.fromHold} finished part${r.fromHold > 1 ? 's' : ''} in your cargo: only attaching`);
  const short = shortList(r.short, name);
  rows.push(short ? `<span style="color:#fbbf24">Short:</span> ${short}` : r.lines.length ? '<span style="color:#4ade80">The hold has it all</span>' : '');
  const time = r.seconds > 0 ? `${durationText(r.seconds)} to build${short ? ' once you have it' : ''}` : '';
  const notes = [...(r.unmakeable ? [`${r.unmakeable} part${r.unmakeable > 1 ? 's' : ''} this fabricator can't make`] : []), ...r.notes];
  return [rows.filter(Boolean).join(' · '), [time, ...notes.map((n) => `<span style="color:#f87171">${esc(n)}</span>`)].filter(Boolean).join(' · ')].filter(Boolean).join('<br>');
}

/** The hangar's readout for a slot against storage and the hold ('' when there is nothing to make) */
export function stationReadoutHtml(r: StationReadout, name: Name): string {
  const rows: string[] = [];
  const short = shortList(r.short, name);
  if (short) rows.push(`<span style="color:#fbbf24">Short:</span> ${short}`);
  if (r.seconds > 0) rows.push(`${durationText(r.seconds)} to make${short ? ' once you have it' : ''}`);
  if (r.blocked) rows.push(`<span style="color:#f87171">${r.blocked} part${r.blocked > 1 ? 's' : ''} you can't make yet</span>`);
  return rows.join(' · ');
}

/** Make the `data-res` links under `root` open the field guide at their item (once per element; clicks are delegated) */
export function bindResourceLinks(root: HTMLElement, open: (id: string) => boolean = openResource): void {
  if (root.dataset.resBound) return;
  root.dataset.resBound = '1';
  root.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-res]');
    if (!a || !root.contains(a)) return;
    e.preventDefault();
    e.stopPropagation();
    open(a.dataset.res!);
  });
}
