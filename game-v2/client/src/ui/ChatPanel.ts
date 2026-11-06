/**
 * The chat box (bottom left, markup in index.html): the channel toggles (built from CHAT_CHANNELS, chatLog.ts), the
 * lines, and the input with its private-message prefix (chatCompose.ts). Game builds one and hands it lines; the
 * logic lives in the two pure modules, this only draws and listens.
 */
import type { ClientMessage, ServerWhisperMessage } from '@space-game/common';
import { ChatLog, CHAT_CHANNELS, allOn, channelDef, lineText, parseToggles, saveToggles, toggleChannel, ALL_CHANNELS, type ChatChannel, type ChatLine } from './chatLog';
import { ChatCompose } from './chatCompose';

const TOGGLES_KEY = 'spacegame.chatChannels';
/** (Before the toggles: one tab) */
const OLD_TAB_KEY = 'spacegame.chatTab';

export interface ChatPanelHost {
  send(m: ClientMessage): void;
  /** The game's own keys off while typing */
  setGameInput(on: boolean): void;
  /** Enter may open the chat (connected, no menu) */
  canFocus(): boolean;
  /** The chat box is hidden (settings): show it to type */
  ensureShown(): void;
  onFocusChange(focused: boolean): void;
  /** The friends list (the side panel's Social tab) */
  openFriends(): void;
  sound?(id: string, v?: number): void;
}

function esc(t: string): string {
  return t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export class ChatPanel {
  readonly log = new ChatLog();
  readonly compose = new ChatCompose();
  private on: Set<ChatChannel> = new Set(ALL_CHANNELS);
  private box: HTMLElement | null;
  private input: HTMLInputElement | null;
  private sendBtn: HTMLElement | null;
  private tabs: HTMLElement | null;
  private prefixEl: HTMLSpanElement | null = null;
  private friendsBtn: HTMLButtonElement | null = null;
  private placeholder = '';
  focused = false;

  constructor(private host: ChatPanelHost) {
    this.box = document.getElementById('chatMessages');
    this.input = document.getElementById('chatInput') as HTMLInputElement | null;
    this.sendBtn = document.getElementById('chatSendBtn');
    this.tabs = document.getElementById('chatTabs');
  }

  /** Listeners and the toggles (once, from Game.init) */
  install(): void {
    let saved: string | null = null;
    try { saved = localStorage.getItem(TOGGLES_KEY) ?? localStorage.getItem(OLD_TAB_KEY); } catch { /* no storage */ }
    this.on = parseToggles(saved);
    this.buildToggles();
    const input = this.input;
    if (!input || !this.sendBtn) { this.render(); return; }
    this.placeholder = input.placeholder;
    this.prefixEl = document.createElement('span');
    this.prefixEl.id = 'chatPrefix';
    this.prefixEl.hidden = true;
    input.before(this.prefixEl);
    input.addEventListener('keydown', (e) => {
      // (Typing never reaches the game)
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.submit();
        return;
      }
      const r = this.compose.key(e.key, input.selectionStart ?? 0, input.selectionEnd ?? 0);
      if (r.handled) e.preventDefault();
      if (r.clear) input.value = '';
      if (r.blur) input.blur();
      if (r.handled) this.showMode();
    });
    input.addEventListener('focus', () => { this.setFocused(true); });
    input.addEventListener('blur', () => { this.setFocused(false); });
    this.sendBtn.addEventListener('click', () => this.submit());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !this.focused && this.host.canFocus()) {
        e.preventDefault();
        this.focus();
      }
    });
    this.render();
  }

  private setFocused(f: boolean): void {
    this.focused = f;
    this.host.setGameInput(!f);
    this.host.onFocusChange(f);
  }

  focus(): void {
    this.host.ensureShown();
    this.input?.focus();
  }

  /** A private message to this pilot (a friend's name clicked): the input with the prefix */
  messageTo(name: string): void {
    this.compose.startTo(name);
    this.showMode();
    this.focus();
  }

  private submit(): void {
    const input = this.input;
    if (!input) return;
    const m = this.compose.submit(input.value);
    if (!m) return;
    this.host.send(m);
    input.value = '';
    this.showMode();
    input.blur();
  }

  private showMode(): void {
    const p = this.compose.prefix();
    if (this.prefixEl) {
      this.prefixEl.textContent = p;
      this.prefixEl.hidden = !p;
    }
    if (this.input) {
      this.input.classList.toggle('private', !!p);
      this.input.placeholder = p ? 'Private message...' : this.placeholder;
    }
  }

  // ---------------------------------------------------------------------------
  // Lines
  // ---------------------------------------------------------------------------

  /** A line from the game (isSystem) or a player in public chat */
  add(playerName: string, text: string, isSystem = false, color?: string): void {
    this.log.add(isSystem ? 'game' : 'chat', isSystem ? '' : playerName, text, color);
    this.render();
  }

  /** A private message, to you or the copy of one you sent (no bubbles: it never goes through public chat) */
  addPrivate(m: ServerWhisperMessage): void {
    if (m.out) this.log.add('private', m.from, m.text, undefined, m.to);
    else {
      this.compose.heard(m.from);
      this.log.add('private', m.from, m.text);
      this.host.sound?.('scan_ping', 0.3);
    }
    this.render();
  }

  private lineEl(line: ChatLine): HTMLDivElement {
    const el = document.createElement('div');
    el.className = `chat-message ${channelDef(line.channel).cls}`;
    if (line.channel === 'game') {
      el.textContent = lineText(line);
      el.style.whiteSpace = 'pre-wrap';
      if (line.color) el.style.color = line.color;
    } else if (line.channel === 'private') {
      const who = line.to ?? line.name;
      el.innerHTML = `<span class="player-name" title="Reply">${line.to !== undefined ? 'To' : 'From'} ${esc(who)}:</span> <span class="message-text">${esc(line.text)}</span>`;
      el.querySelector('.player-name')!.addEventListener('click', () => this.messageTo(who));
    } else {
      el.innerHTML = `<span class="player-name">${esc(line.name)}:</span> <span class="message-text">${esc(line.text)}</span>`;
    }
    return el;
  }

  render(): void {
    const box = this.box;
    if (!box) return;
    box.textContent = '';
    for (const line of this.log.visible(this.on)) box.appendChild(this.lineEl(line));
    box.scrollTop = box.scrollHeight;
  }

  // ---------------------------------------------------------------------------
  // Toggles
  // ---------------------------------------------------------------------------

  private buildToggles(): void {
    const tabs = this.tabs;
    if (!tabs) return;
    tabs.querySelectorAll('button[data-ch]').forEach((b) => b.remove());
    const hide = document.getElementById('chatHideBtn');
    const mk = (id: string, label: string, title: string) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.ch = id;
      b.textContent = label;
      b.title = title;
      tabs.insertBefore(b, hide);
      return b;
    };
    mk('all', 'All', 'Show every channel').addEventListener('click', () => this.setToggles(new Set(ALL_CHANNELS)));
    for (const c of CHAT_CHANNELS) mk(c.id, c.label, `Show or hide ${c.label.toLowerCase()} lines`).addEventListener('click', () => this.setToggles(toggleChannel(this.on, c.id)));
    this.friendsBtn = mk('friends', 'Friends', 'Your friends (the side panel)');
    this.friendsBtn.classList.add('chat-friends');
    this.friendsBtn.addEventListener('click', () => this.host.openFriends());
    this.paintToggles();
  }

  private setToggles(on: Set<ChatChannel>): void {
    this.on = on;
    try { localStorage.setItem(TOGGLES_KEY, saveToggles(on)); } catch { /* storage blocked: not remembered */ }
    this.paintToggles();
    this.render();
  }

  private paintToggles(): void {
    this.tabs?.querySelectorAll<HTMLElement>('button[data-ch]').forEach((b) => {
      const id = b.dataset.ch!;
      if (id === 'friends') return;
      b.classList.toggle('active', id === 'all' ? allOn(this.on) : this.on.has(id as ChatChannel));
    });
  }

  /** Friends online, on the chat's Friends button */
  setFriendsOnline(n: number): void {
    if (this.friendsBtn) this.friendsBtn.textContent = n > 0 ? `Friends ${n}` : 'Friends';
  }
}
