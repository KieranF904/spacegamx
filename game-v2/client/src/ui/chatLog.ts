/**
 * The chat panel's lines and tabs, with no DOM: every line has a channel, set where it is made
 * ('chat' for what players type, 'game' for what the game says), and identical game lines in a
 * row fold into one with a count. The panel (Game.ts) draws what this hands back.
 */
export type ChatChannel = 'chat' | 'game';
export type ChatTab = 'all' | ChatChannel;

export const CHAT_TABS: readonly { id: ChatTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'chat', label: 'Chat' },
  { id: 'game', label: 'Game' },
];

export interface ChatLine {
  channel: ChatChannel;
  /** Who said it (empty for the game) */
  name: string;
  text: string;
  color?: string;
  /** How many times in a row (1 = once) */
  count: number;
}

/** Newest lines kept */
export const CHAT_HISTORY = 100;

export class ChatLog {
  readonly lines: ChatLine[] = [];

  /** Add a line. Returns the line and whether it folded into the one before it (so the panel updates that row). */
  add(channel: ChatChannel, name: string, text: string, color?: string): { line: ChatLine; merged: boolean } {
    const last = this.lines[this.lines.length - 1];
    // Only game lines fold: a player repeating themselves is still talking
    if (channel === 'game' && last && last.channel === 'game' && last.text === text && last.name === name && last.color === color) {
      last.count++;
      return { line: last, merged: true };
    }
    const line: ChatLine = { channel, name, text, color, count: 1 };
    this.lines.push(line);
    while (this.lines.length > CHAT_HISTORY) this.lines.shift();
    return { line, merged: false };
  }

  /** The lines a tab shows */
  visible(tab: ChatTab): ChatLine[] {
    return tab === 'all' ? this.lines : this.lines.filter((l) => l.channel === tab);
  }
}

/** A line's text with its count ("Jump drive cooling down (3s) ×3") */
export function lineText(line: ChatLine): string {
  return line.count > 1 ? `${line.text} ×${line.count}` : line.text;
}

export function parseTab(v: unknown): ChatTab {
  return v === 'chat' || v === 'game' ? v : 'all';
}
