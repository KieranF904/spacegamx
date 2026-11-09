/**
 * @contract client.ui.resource-page-nav
 * owns:       the field guide's detail-page history: a stack of opened entries, Back, and the breadcrumb trail for the page on top (no DOM)
 * needs:      entryCards (View, entryName), resourceIndex (category labels), resourceData
 * invariants: opening the page already on top changes nothing; Back pops one page and an empty stack means the grid — client/src/ui/resources/pageNav.test.ts
 *             a breadcrumb starts at the view, a resource adds its category, and the last crumb is the entry itself — client/src/ui/resources/pageNav.test.ts
 * extend:     a new view needs its label in VIEW_LABEL
 */

import { entryName, type View } from './entryCards';
import { CATEGORY_LABEL } from './resourceIndex';
import { resourceEntries } from './resourceData';

export interface Page { view: View; id: string; /** where the page was scrolled when it was left */ scroll?: number }

export const VIEW_LABEL: Record<View, string> = { res: 'Resources', rock: 'Rocks', enemy: 'Enemies', sys: 'Systems' };

/** Open `p` on top of the stack; false (no change) if it already is the page showing */
export function pushPage(stack: Page[], p: Page): boolean {
  const top = stack[stack.length - 1];
  if (top && top.view === p.view && top.id === p.id) return false;
  stack.push(p);
  return true;
}

/** Go back one page: the page now showing, or undefined when the stack is empty (the grid shows) */
export function popPage(stack: Page[]): Page | undefined {
  stack.pop();
  return stack[stack.length - 1];
}

/** One step of the trail; `to` is the grid it returns to (a view, optionally with a category chip); the last crumb has none */
export interface Crumb { label: string; to?: { view: View; cat?: string } }

export function crumbsOf(p: Page): Crumb[] {
  const out: Crumb[] = [{ label: VIEW_LABEL[p.view], to: { view: p.view } }];
  if (p.view === 'res') {
    const e = resourceEntries().find((x) => x.id === p.id);
    if (e) out.push({ label: CATEGORY_LABEL[e.category], to: { view: 'res', cat: e.category } });
  }
  out.push({ label: entryName(p.view, p.id) });
  return out;
}
