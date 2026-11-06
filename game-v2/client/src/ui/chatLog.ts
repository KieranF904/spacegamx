/**
 * The chat panel's lines and channel toggles, with no DOM: every line has a channel, set where it is made
 * ('chat' for what players say in public, 'private' for private messages, 'game' for what the game says), and
 * identical game lines in a row fold into one with a count. The panel (ui/ChatPanel.ts) draws what this hands back.
 *
 * Channels are a registry (CHAT_CHANNELS): a new one is a row here, and the panel makes its toggle from it.
 * The toggles are independent; "All" turns every one on.
 */
export type ChatChannel = 'chat' | 'private' | 'game';

export interface ChatChannelDef {
  id: ChatChannel;
  /** The toggle's label */
  label: string;
  /** Its lines' class in the panel (colour) */
  cls: string;
  /** Lines on it may show as speech bubbles over the ship (public chat only: never private) */
  bubbles: boolean;
}

export const CHAT_CHANNELS: readonly ChatChannelDef[] = [
  { id: 'chat', label: 'Public', cls: 'public', bubbles: true },
  { id: 'private', label: 'Private', cls: 'private', bubbles: false },
  { id: 'game', label: 'Game', cls: 'system', bubbles: false },
];

export const ALL_CHANNELS: readonly ChatChannel[] = CHAT_CHANNELS.map((c) => c.id);

export function channelDef(id: ChatChannel): ChatChannelDef {
  return CHAT_CHANNELS.find((c) => c.id === id)!;
}

/** May lines on this channel show as bubbles */
export function channelBubbles(id: ChatChannel): boolean {
  return channelDef(id)?.bubbles ?? false;
}

export interface ChatLine {
  channel: ChatChannel;
  /** Who said it (empty for the game) */
  name: string;
  text: string;
  color?: string;
  /** A private message you sent: who to (name is you) */
  to?: string;
  /** How many times in a row (1 = once) */
  count: number;
}

/** Newest lines kept */
export const CHAT_HISTORY = 100;

export class ChatLog {
  readonly lines: ChatLine[] = [];

  /** Add a line. Returns the line and whether it folded into the one before it (so the panel updates that row). */
  add(channel: ChatChannel, name: string, text: string, color?: string, to?: string): { line: ChatLine; merged: boolean } {
    const last = this.lines[this.lines.length - 1];
    // Only game lines fold: a player repeating themselves is still talking
    if (channel === 'game' && last && last.channel === 'game' && last.text === text && last.name === name && last.color === color) {
      last.count++;
      return { line: last, merged: true };
    }
    const line: ChatLine = { channel, name, text, color, count: 1 };
    if (to !== undefined) line.to = to;
    this.lines.push(line);
    while (this.lines.length > CHAT_HISTORY) this.lines.shift();
    return { line, merged: false };
  }

  /** The lines the toggles that are on show */
  visible(on: ReadonlySet<ChatChannel>): ChatLine[] {
    return this.lines.filter((l) => on.has(l.channel));
  }
}

/** A line's text with its count ("Jump drive cooling down (3s) ×3") */
export function lineText(line: ChatLine): string {
  return line.count > 1 ? `${line.text} ×${line.count}` : line.text;
}

// ---------------------------------------------------------------------------
// Toggles
// ---------------------------------------------------------------------------

export function allOn(on: ReadonlySet<ChatChannel>): boolean {
  return ALL_CHANNELS.every((c) => on.has(c));
}

/** Flip one toggle. The last one on stays on (an empty chat would look broken) */
export function toggleChannel(on: ReadonlySet<ChatChannel>, id: ChatChannel): Set<ChatChannel> {
  const next = new Set(on);
  if (next.has(id)) { if (next.size > 1) next.delete(id); } else next.add(id);
  return next;
}

/**
 * The saved toggles: a JSON list of channels. Also reads the old single tab ('all' | 'chat' | 'game'). Anything
 * else (nothing saved, junk, an empty list) is all on.
 */
export function parseToggles(v: unknown): Set<ChatChannel> {
  if (v === 'chat' || v === 'game') return new Set([v]);
  if (typeof v === 'string' && v.startsWith('[')) {
    try {
      const list = (JSON.parse(v) as unknown[]).filter((c): c is ChatChannel => ALL_CHANNELS.includes(c as ChatChannel));
      if (list.length) return new Set(list);
    } catch { /* junk: all on */ }
  }
  return new Set(ALL_CHANNELS);
}

export function saveToggles(on: ReadonlySet<ChatChannel>): string {
  return JSON.stringify(ALL_CHANNELS.filter((c) => on.has(c)));
}
