/**
 * @contract client.ui.rewards.model
 * owns:       what the reward screen lists (a quest's RewardView or the tutorial's starter pack as lines with icon, name and count),
 *             the short outro, and the compact card's open/pill/gone state machine (no DOM)
 * needs:      common RewardView; an item namer and icon function passed in
 * invariants: a card opened in combat starts as a pill and one open when combat starts folds at once; an open card folds on its own after a while — client/src/ui/rewards/rewardModel.test.ts
 * extend:     a new kind of reward is a RewardKind and a branch of `questRewardLines`
 */

import type { RewardView } from '@space-game/common';

export type RewardKind = 'item' | 'credits' | 'xp' | 'rep' | 'unlock' | 'skill';

export interface RewardLine {
  kind: RewardKind;
  /** The line's words (the item's name, "credits", "XP", the faction...) */
  label: string;
  /** How many (shown with tabular figures); absent for an unlock */
  count?: number;
  /** An image URL (an item's icon) */
  icon?: string;
}

/** The glyph drawn for a line with no item icon */
export const KIND_GLYPH: Record<RewardKind, string> = { item: '▣', credits: '¢', xp: '✦', rep: '★', unlock: '◆', skill: '▲' };

export interface RewardNames {
  item(id: string): string;
  icon?(id: string): string;
}

/** A quest's rewards in reading order: credits, XP, items, skill points, standing, then plans, recipes and licences */
export function questRewardLines(r: RewardView, names: RewardNames): RewardLine[] {
  const out: RewardLine[] = [];
  if (r.credits) out.push({ kind: 'credits', label: 'credits', count: r.credits });
  if (r.xp) out.push({ kind: 'xp', label: 'XP', count: r.xp });
  for (const [id, n] of Object.entries(r.items)) out.push({ kind: 'item', label: names.item(id), count: n, icon: names.icon?.(id) });
  if (r.skillPoints) out.push({ kind: 'skill', label: r.skillPoints > 1 ? 'skill points' : 'skill point', count: r.skillPoints });
  for (const [f, n] of Object.entries(r.reputation)) out.push({ kind: 'rep', label: `${f} reputation`, count: n });
  for (const p of r.plans) out.push({ kind: 'unlock', label: `Design: ${p}` });
  for (const p of r.recipes) out.push({ kind: 'unlock', label: `Recipe: ${p}` });
  for (const p of r.licences) out.push({ kind: 'unlock', label: `Licence: ${p}` });
  return out;
}

/** The tutorial's starter pack: credits first, then each item */
export function packRewardLines(pack: { credits: number; items: Record<string, number> }, names: RewardNames): RewardLine[] {
  const out: RewardLine[] = [];
  if (pack.credits > 0) out.push({ kind: 'credits', label: 'credits', count: pack.credits });
  for (const [id, n] of Object.entries(pack.items)) out.push({ kind: 'item', label: names.item(id), count: n, icon: names.icon?.(id) });
  return out;
}

/** The giver's outro cut to a sentence or two that fit a card (nothing for none) */
export function shortOutro(text: string | undefined, max = 150): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (stop > max * 0.4) return cut.slice(0, stop + 1);
  const sp = cut.lastIndexOf(' ');
  return `${cut.slice(0, sp > 0 ? sp : max).replace(/[,;:\s]+$/, '')}…`;
}

/** How long an open card waits before it folds away on its own (ms) */
export const CARD_OPEN_MS = 14_000;
/** How long a folded card's "View" stays offered (ms) */
export const CARD_PILL_MS = 45_000;

export type CardState = 'open' | 'pill' | 'gone';

/**
 * The compact card: open (full), pill (one line with View), gone. Opened in combat it starts as a pill; combat starting folds
 * it; it folds after CARD_OPEN_MS and goes after CARD_PILL_MS. "View" reopens it (even in combat: the player asked, so combat
 * alone does not fold it again, only its time)
 */
export class CardLife {
  state: CardState = 'gone';
  private since = 0;
  private asked = false;
  open(now: number, inCombat: boolean): void { this.state = inCombat ? 'pill' : 'open'; this.since = now; this.asked = false; }
  /** Enter, Esc, the close button: folds an open card, drops a pill */
  dismiss(now: number): void {
    if (this.state === 'open') { this.state = 'pill'; this.since = now; } else this.state = 'gone';
  }
  view(now: number): void { if (this.state === 'pill') { this.state = 'open'; this.since = now; this.asked = true; } }
  /** Called regularly; true when the state changed */
  tick(now: number, inCombat: boolean): boolean {
    const was = this.state;
    if (this.state === 'open' && ((inCombat && !this.asked) || now - this.since >= CARD_OPEN_MS)) { this.state = 'pill'; this.since = now; }
    else if (this.state === 'pill' && now - this.since >= CARD_PILL_MS) this.state = 'gone';
    return this.state !== was;
  }
}
