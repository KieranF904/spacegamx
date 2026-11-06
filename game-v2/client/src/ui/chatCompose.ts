/**
 * What the chat input is writing: public chat, or a private message to someone (no DOM; ui/ChatPanel.ts asks it).
 *
 *   Tab         reply to whoever sent you the last private message, as of the moment Tab is pressed
 *   (friends)   a friend's name clicked starts a private message to them
 *   Backspace   at the very start of the input: back to public chat, the draft deleted
 *   Esc         in a private message: back to public chat, the draft deleted (in public chat: leave the input)
 *   Enter       sends (a private message goes as `whisper`), then back to public chat
 */
import type { ClientMessage } from '@space-game/common';

export type ComposeMode = { kind: 'public' } | { kind: 'private'; to: string; reply: boolean };

export interface KeyResult {
  /** The panel stops the key's default (Tab never leaves the input) */
  handled: boolean;
  /** Empty the input */
  clear: boolean;
  /** Leave the input */
  blur: boolean;
}

const NONE: KeyResult = { handled: false, clear: false, blur: false };

export class ChatCompose {
  mode: ComposeMode = { kind: 'public' };
  private lastFrom: string | null = null;

  /** A private message came in from this pilot */
  heard(from: string): void {
    if (from) this.lastFrom = from;
  }

  get lastSender(): string | null {
    return this.lastFrom;
  }

  get isPrivate(): boolean {
    return this.mode.kind === 'private';
  }

  /** Reply to the last private sender (now). False if nobody has sent you one */
  tab(): boolean {
    if (!this.lastFrom) return false;
    this.mode = { kind: 'private', to: this.lastFrom, reply: true };
    return true;
  }

  /** A private message to this pilot (a friend's name clicked) */
  startTo(name: string): void {
    if (name) this.mode = { kind: 'private', to: name, reply: false };
  }

  /** Back to public chat (the panel clears the draft) */
  cancel(): void {
    this.mode = { kind: 'public' };
  }

  /** A key pressed in the input; caret is the selection (start, end) */
  key(key: string, caretStart: number, caretEnd: number): KeyResult {
    switch (key) {
      case 'Tab':
        this.tab();
        return { handled: true, clear: false, blur: false };
      case 'Backspace':
        if (this.isPrivate && caretStart === 0 && caretEnd === 0) {
          this.cancel();
          return { handled: true, clear: true, blur: false };
        }
        return NONE;
      case 'Escape':
        if (this.isPrivate) {
          this.cancel();
          return { handled: true, clear: true, blur: false };
        }
        return { handled: true, clear: false, blur: true };
    }
    return NONE;
  }

  /** The label before the input ('' in public chat) */
  prefix(): string {
    if (this.mode.kind === 'public') return '';
    return this.mode.reply ? `Reply to ${this.mode.to}:` : `To ${this.mode.to}:`;
  }

  /** Enter: the message to send for this text (null if there's nothing to send); a private one returns to public chat */
  submit(text: string): ClientMessage | null {
    const t = text.trim();
    if (!t) return null;
    if (this.mode.kind === 'private') {
      const to = this.mode.to;
      this.cancel();
      return { type: 'whisper', to, text: t };
    }
    return { type: 'chat', text: t };
  }
}
