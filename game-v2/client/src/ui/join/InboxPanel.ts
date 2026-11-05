/**
 * The join screen's inbox (signed-in pilots only; guests have no account to send to): the unread count, a message
 * list and a reader, and a banner above the join screen for an unread important message (an admin's, by default)
 * until it's read. Admins also get a "Send message" form (one player by username, or everyone) and what was sent.
 *
 * The lobby keeps the mail (network/inbox.ts). Everything a sender wrote is plain text, escaped here before it's
 * shown (escapeHtml); nothing from a message ever goes into an attribute but its numeric id.
 * The panel's elements (banner, box) are made once and kept: the join screen re-renders around them.
 */

import type { InboxApi, InboxMessage, SentInfo } from '../../network/inbox';

export interface InboxAccount { token: string; username: string; isAdmin: boolean }

const SUBJECT_MAX = 120;
const BODY_MAX = 4000;

/** Text into HTML text or a quoted attribute */
export function escapeHtml(text: string): string {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** "2026-11-05 14:03" in the reader's own time */
export function formatWhen(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const fromLabel = (from: string) => (from === 'system' ? 'Space Game' : from);

/** The message list */
export function listHtml(messages: InboxMessage[], selected: number | null): string {
  if (!messages.length) return '<div class="inbox-empty">No messages yet. Messages from the developers will show up here.</div>';
  return messages.map((m) => `
    <button type="button" class="inbox-row${m.readAt === null ? ' unread' : ''}${m.important ? ' important' : ''}${m.id === selected ? ' selected' : ''}" data-id="${Number(m.id)}">
      <span class="inbox-row-top"><span class="inbox-from">${escapeHtml(fromLabel(m.from))}</span><span class="inbox-date">${escapeHtml(formatWhen(m.createdAt))}</span></span>
      <span class="inbox-subject">${escapeHtml(m.subject)}</span>
    </button>`).join('');
}

/** The open message (null: a hint) */
export function readerHtml(m: InboxMessage | null): string {
  if (!m) return '<div class="inbox-hint">Pick a message to read it.</div>';
  return `
    <div class="inbox-read-subject">${escapeHtml(m.subject)}</div>
    <div class="inbox-read-meta">From <b>${escapeHtml(fromLabel(m.from))}</b> · ${escapeHtml(formatWhen(m.createdAt))}${m.important ? ' · <span class="inbox-tag">admin</span>' : ''}</div>
    <div class="inbox-read-body">${escapeHtml(m.body)}</div>
    <div class="inbox-read-actions"><button type="button" class="inbox-btn inbox-delete" data-id="${Number(m.id)}">Delete</button></div>`;
}

/** The banner for the newest unread important message ('' when there's none) */
export function bannerHtml(messages: InboxMessage[]): string {
  const waiting = messages.filter((m) => m.important && m.readAt === null);
  if (!waiting.length) return '';
  const m = waiting[0];
  const more = waiting.length > 1 ? `<span class="inbox-banner-more">+${waiting.length - 1} more</span>` : '';
  return `
    <div class="inbox-banner-icon" aria-hidden="true">✉</div>
    <div class="inbox-banner-text">
      <div class="inbox-banner-label">Message from ${escapeHtml(fromLabel(m.from))} ${more}</div>
      <div class="inbox-banner-subject">${escapeHtml(m.subject)}</div>
    </div>
    <button type="button" class="inbox-banner-read" data-id="${Number(m.id)}">Read</button>`;
}

/** What an admin has sent */
export function sentHtml(sent: SentInfo[]): string {
  if (!sent.length) return '<div class="inbox-empty">Nothing sent yet.</div>';
  return sent.slice(0, 8).map((s) => `
    <div class="inbox-sent-row">
      <span class="inbox-sent-to">${s.to === '*' ? 'Everyone' : escapeHtml(s.to)}</span>
      <span class="inbox-sent-subject">${escapeHtml(s.subject)}</span>
      <span class="inbox-sent-read">${s.read}/${s.recipients} read · ${escapeHtml(formatWhen(s.createdAt))}</span>
    </div>`).join('');
}

const STYLE = `
  .inbox-banner { display: flex; align-items: center; gap: 14px; padding: 12px 16px; border-radius: 12px;
    background: linear-gradient(90deg, rgba(120, 78, 8, 0.95) 0%, rgba(70, 44, 6, 0.95) 100%);
    border: 1px solid #f0b040; box-shadow: 0 0 26px rgba(240, 170, 60, 0.35); color: #ffe7b0; box-sizing: border-box; }
  .inbox-banner[hidden] { display: none; }
  .inbox-banner-icon { font-size: 26px; line-height: 1; color: #ffd27a; }
  .inbox-banner-text { flex: 1; min-width: 0; }
  .inbox-banner-label { font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: #f5c56a; }
  .inbox-banner-subject { font-size: 17px; color: #fff4dc; font-weight: bold; margin-top: 2px; overflow-wrap: anywhere; }
  .inbox-banner-more { letter-spacing: 0; text-transform: none; color: #e8cf98; margin-left: 6px; }
  .inbox-banner-read { padding: 9px 22px; border-radius: 8px; border: 1px solid #ffd27a; cursor: pointer;
    background: linear-gradient(180deg, #e0a030 0%, #b07418 100%); color: #1d1200; font-weight: bold; font-size: 15px; letter-spacing: 1px; }
  .inbox-banner-read:hover { background: linear-gradient(180deg, #f0b444 0%, #c4861f 100%); }
  .inbox-banner-read:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }

  .inbox-box[hidden] { display: none; }
  .inbox-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .inbox-head .join-h { margin: 0; }
  .inbox-count { font-size: 12px; padding: 2px 9px; border-radius: 999px; background: rgba(34, 102, 170, 0.35); color: #bfe0ff; }
  .inbox-count.has-unread { background: #2a7ad0; color: #fff; }
  .inbox-count.has-important { background: #d08a20; color: #1d1200; font-weight: bold; }
  .inbox-spacer { flex: 1; }
  .inbox-btn { padding: 6px 12px; background: transparent; border: 1px solid #2a5a8a; border-radius: 6px; color: #9fc4ea; font-size: 12px; cursor: pointer; }
  .inbox-btn:hover { background: rgba(34, 102, 170, 0.25); color: #dde8f5; }
  .inbox-btn:disabled { opacity: 0.5; cursor: default; }
  .inbox-btn.primary { background: #1d5a96; border-color: #3a8ad6; color: #fff; }
  .inbox-btn.primary:hover { background: #2669ab; }
  .inbox-main { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: 12px; margin-top: 12px; }
  @media (max-width: 620px) { .inbox-main { grid-template-columns: 1fr; } }
  .inbox-list { display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow-y: auto; padding-right: 4px; }
  .inbox-row { text-align: left; background: rgba(0, 30, 70, 0.5); border: 1px solid #1b3f66; border-radius: 6px;
    padding: 7px 10px; cursor: pointer; color: #9fb4cc; font: inherit; display: flex; flex-direction: column; gap: 2px; }
  .inbox-row:hover { border-color: #2f6aa3; }
  .inbox-row.selected { border-color: #5aa6f0; background: rgba(20, 70, 130, 0.55); }
  .inbox-row.unread .inbox-subject { color: #fff; font-weight: bold; }
  .inbox-row.unread { border-left: 3px solid #4aa3ff; }
  .inbox-row.unread.important { border-left-color: #f0b040; }
  .inbox-row-top { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: #6f8fb5; }
  .inbox-from { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .inbox-date { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .inbox-subject { font-size: 13px; color: #dde8f5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .inbox-reader { border: 1px solid #1b3f66; border-radius: 6px; padding: 12px 14px; background: rgba(0, 12, 32, 0.6); min-height: 120px; }
  .inbox-read-subject { color: #dde8f5; font-size: 16px; font-weight: bold; overflow-wrap: anywhere; }
  .inbox-read-meta { font-size: 12px; color: #6f8fb5; margin: 4px 0 10px; }
  .inbox-read-meta b { color: #9fc4ea; font-weight: normal; }
  .inbox-tag { color: #f5c56a; }
  .inbox-read-body { color: #c4d4e6; font-size: 14px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow-y: auto; }
  .inbox-read-actions { margin-top: 12px; display: flex; justify-content: flex-end; }
  .inbox-delete { border-color: #664444; color: #cc8888; }
  .inbox-delete:hover { background: rgba(150, 50, 50, 0.2); color: #ff9999; }
  .inbox-empty, .inbox-hint { color: #6a7d96; font-size: 13px; }
  .inbox-error { color: #ff9a9a; font-size: 12px; margin-top: 8px; }

  .inbox-compose { margin-top: 16px; border-top: 1px solid #1b3f66; padding-top: 14px; }
  .inbox-compose[hidden] { display: none; }
  .inbox-form { display: grid; grid-template-columns: 90px 1fr; gap: 8px 10px; align-items: center; }
  .inbox-form label { font-size: 12px; color: #6f8fb5; }
  .inbox-form input[type=text], .inbox-form textarea { width: 100%; box-sizing: border-box; background: rgba(0, 10, 30, 0.8);
    border: 1px solid #234e7a; border-radius: 6px; color: #dde8f5; padding: 7px 9px; font: 13px 'Segoe UI', system-ui, sans-serif; }
  .inbox-form textarea { min-height: 96px; resize: vertical; }
  .inbox-form input[type=text]:focus, .inbox-form textarea:focus { outline: none; border-color: #4a9ae6; }
  .inbox-form input:disabled { opacity: 0.5; }
  .inbox-to { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .inbox-to input[type=text] { flex: 1; min-width: 140px; width: auto; }
  .inbox-check { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: #9fb4cc; cursor: pointer; }
  .inbox-form-foot { grid-column: 2; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .inbox-form-status { font-size: 12px; color: #88ff88; }
  .inbox-form-status.bad { color: #ff9a9a; }
  .inbox-sent { margin-top: 12px; display: flex; flex-direction: column; gap: 4px; }
  .inbox-sent-row { display: grid; grid-template-columns: minmax(70px, 1fr) minmax(0, 2fr) auto; gap: 10px; font-size: 12px; color: #9fb4cc; }
  .inbox-sent-to { color: #9fc4ea; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .inbox-sent-subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #dde8f5; }
  .inbox-sent-read { color: #6f8fb5; font-variant-numeric: tabular-nums; }
  .join-mail-badge { display: inline-block; margin-left: 10px; vertical-align: middle; font-size: 13px; letter-spacing: 0;
    padding: 2px 10px; border-radius: 999px; background: #f0b040; color: #1d1200; font-weight: bold; }
  .join-mail-badge[hidden] { display: none; }
`;

let styled = false;

export class InboxPanel {
  /** Above the join screen's main panel */
  readonly banner: HTMLElement;
  /** The inbox itself */
  readonly box: HTMLElement;
  /** Unread counts changed (the Join button's badge) */
  onCounts: ((unread: number, important: number) => void) | null = null;

  private account: InboxAccount | null = null;
  private messages: InboxMessage[] = [];
  private unread = 0;
  private important = 0;
  private selected: number | null = null;
  private error = '';
  private loaded = false;
  private head: HTMLElement;
  private main: HTMLElement;
  private errorEl: HTMLElement;
  private compose: HTMLElement | null = null;

  constructor(private api: InboxApi, doc: Document = document) {
    if (!styled) {
      styled = true;
      const style = doc.createElement('style');
      style.textContent = STYLE;
      doc.head.appendChild(style);
    }
    this.banner = doc.createElement('div');
    this.banner.className = 'inbox-banner';
    this.banner.setAttribute('role', 'status');
    this.banner.hidden = true;
    this.box = doc.createElement('div');
    this.box.className = 'join-box inbox-box';
    this.box.hidden = true;
    this.head = doc.createElement('div');
    this.head.className = 'inbox-head';
    this.main = doc.createElement('div');
    this.main.className = 'inbox-main';
    this.errorEl = doc.createElement('div');
    this.errorEl.className = 'inbox-error';
    this.box.append(this.head, this.main, this.errorEl);

    this.banner.addEventListener('click', (e) => {
      const id = Number((e.target as HTMLElement).closest<HTMLElement>('.inbox-banner-read')?.dataset.id);
      if (id) { this.open(id); this.box.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' }); }
    });
    this.box.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const row = t.closest<HTMLElement>('.inbox-row');
      if (row) { this.open(Number(row.dataset.id)); return; }
      const del = t.closest<HTMLElement>('.inbox-delete');
      if (del) { void this.remove(Number(del.dataset.id)); return; }
      if (t.closest('.inbox-markall')) { void this.markAll(); return; }
      if (t.closest('.inbox-compose-btn') && this.compose) {
        this.compose.hidden = !this.compose.hidden;
        if (!this.compose.hidden) { void this.loadSent(); this.compose.querySelector<HTMLInputElement>('.inbox-to-name')?.focus(); }
      }
    });
  }

  /** Signed in (the panel shows) or a guest / signed out (null: it hides, and forgets the last account's mail) */
  setAccount(account: InboxAccount | null): void {
    const changed = account?.token !== this.account?.token;
    this.account = account;
    if (changed) { this.messages = []; this.unread = this.important = 0; this.selected = null; this.loaded = false; this.error = ''; }
    if (this.compose && (!account?.isAdmin || changed)) { this.compose.remove(); this.compose = null; }
    if (account?.isAdmin && !this.compose) this.buildCompose();
    this.render();
  }

  /** Fetch the mail again */
  async refresh(): Promise<void> {
    const acc = this.account;
    if (!acc) return;
    const r = await this.api.list(acc.token);
    if (acc !== this.account) return;
    this.loaded = true;
    if (!r.success) { this.error = r.error; this.render(); return; }
    this.error = '';
    this.messages = r.messages;
    this.setCounts(r.unread, r.unreadImportant);
    if (this.selected !== null && !this.messages.some((m) => m.id === this.selected)) this.selected = null;
    this.render();
  }

  /** Open a message (marked read at the lobby) */
  open(id: number): void {
    const m = this.messages.find((x) => x.id === id);
    if (!m || !this.account) return;
    this.selected = id;
    if (m.readAt === null) {
      m.readAt = Date.now();
      const acc = this.account;
      void this.api.read(acc.token, [id]).then((r) => { if (r.success && acc === this.account) this.setCounts(r.unread, r.unreadImportant); this.render(); });
      this.setCounts(Math.max(0, this.unread - 1), Math.max(0, this.important - (m.important ? 1 : 0)));
    }
    this.render();
  }

  private async remove(id: number): Promise<void> {
    const acc = this.account;
    if (!acc) return;
    const r = await this.api.remove(acc.token, id);
    if (acc !== this.account) return;
    if (!r.success) { this.error = r.error; this.render(); return; }
    this.messages = this.messages.filter((m) => m.id !== id);
    if (this.selected === id) this.selected = null;
    this.setCounts(r.unread, r.unreadImportant);
    this.render();
  }

  private async markAll(): Promise<void> {
    const acc = this.account;
    if (!acc) return;
    const r = await this.api.read(acc.token, 'all');
    if (acc !== this.account || !r.success) return;
    for (const m of this.messages) m.readAt ??= Date.now();
    this.setCounts(r.unread, r.unreadImportant);
    this.render();
  }

  private setCounts(unread: number, important: number): void {
    this.unread = unread;
    this.important = important;
    this.onCounts?.(unread, important);
  }

  /** Unread, and unread important */
  counts(): { unread: number; important: number } {
    return { unread: this.unread, important: this.important };
  }

  private render(): void {
    const acc = this.account;
    this.box.hidden = !acc;
    const banner = acc ? bannerHtml(this.messages) : '';
    this.banner.hidden = !banner;
    this.banner.innerHTML = banner;
    if (!acc) return;
    const countCls = this.important ? 'has-important' : this.unread ? 'has-unread' : '';
    this.head.innerHTML = `
      <span class="join-h">Inbox</span>
      <span class="inbox-count ${countCls}">${this.unread ? `${this.unread} unread` : 'All read'}</span>
      <span class="inbox-spacer"></span>
      ${this.unread ? '<button type="button" class="inbox-btn inbox-markall">Mark all read</button>' : ''}
      ${acc.isAdmin ? '<button type="button" class="inbox-btn primary inbox-compose-btn">Send message</button>' : ''}`;
    const open = this.messages.find((m) => m.id === this.selected) ?? null;
    this.main.innerHTML = !this.loaded
      ? '<div class="inbox-empty">Checking for messages…</div>'
      : `<div class="inbox-list">${listHtml(this.messages, this.selected)}</div><div class="inbox-reader">${readerHtml(open)}</div>`;
    this.errorEl.textContent = this.error;
  }

  // --- Admins: sending ---------------------------------------------------------

  private buildCompose(): void {
    const c = document.createElement('div');
    c.className = 'inbox-compose';
    c.hidden = true;
    c.innerHTML = `
      <div class="join-h" style="margin-top:0">Send a message</div>
      <form class="inbox-form" autocomplete="off">
        <label for="inbox-to-name">To</label>
        <div class="inbox-to">
          <input type="text" id="inbox-to-name" class="inbox-to-name" placeholder="Username" maxlength="32" spellcheck="false">
          <label class="inbox-check"><input type="checkbox" class="inbox-everyone"> Everyone</label>
        </div>
        <label for="inbox-subject">Subject</label>
        <input type="text" id="inbox-subject" class="inbox-subject-in" maxlength="${SUBJECT_MAX}" placeholder="What it's about">
        <label for="inbox-text">Message</label>
        <textarea id="inbox-text" class="inbox-text" maxlength="${BODY_MAX}" placeholder="Plain text"></textarea>
        <span></span>
        <div class="inbox-form-foot">
          <label class="inbox-check"><input type="checkbox" class="inbox-important" checked> Show as a banner until read</label>
          <span class="inbox-spacer"></span>
          <span class="inbox-form-status" role="status"></span>
          <button type="submit" class="inbox-btn primary inbox-send">Send</button>
        </div>
      </form>
      <div class="join-h">Sent</div>
      <div class="inbox-sent"></div>`;
    const q = <T extends Element>(s: string) => c.querySelector<T>(s)!;
    const everyone = q<HTMLInputElement>('.inbox-everyone');
    const name = q<HTMLInputElement>('.inbox-to-name');
    everyone.addEventListener('change', () => { name.disabled = everyone.checked; });
    q<HTMLFormElement>('form').addEventListener('submit', (e) => { e.preventDefault(); void this.send(c); });
    // (Typing here mustn't reach the game's keys)
    c.addEventListener('keydown', (e) => e.stopPropagation());
    this.compose = c;
    this.box.appendChild(c);
  }

  private async send(c: HTMLElement): Promise<void> {
    const acc = this.account;
    if (!acc?.isAdmin) return;
    const q = <T extends Element>(s: string) => c.querySelector<T>(s)!;
    const status = q<HTMLElement>('.inbox-form-status');
    const button = q<HTMLButtonElement>('.inbox-send');
    const everyone = q<HTMLInputElement>('.inbox-everyone').checked;
    const to = q<HTMLInputElement>('.inbox-to-name').value.trim();
    const subject = q<HTMLInputElement>('.inbox-subject-in').value.trim();
    const body = q<HTMLTextAreaElement>('.inbox-text').value.trim();
    const say = (text: string, bad = false) => { status.textContent = text; status.classList.toggle('bad', bad); };
    if (!everyone && !to) return say('Who to? A username, or tick Everyone', true);
    if (!body) return say('Write a message first', true);
    button.disabled = true;
    say('Sending…');
    const r = await this.api.send(acc.token, { ...(everyone ? { everyone: true } : { to }), subject, body, important: q<HTMLInputElement>('.inbox-important').checked });
    button.disabled = false;
    if (!r.success) return say(r.error, true);
    say(r.to === '*' ? `Sent to everyone (${r.sent})` : `Sent to ${r.to}`);
    q<HTMLInputElement>('.inbox-subject-in').value = '';
    q<HTMLTextAreaElement>('.inbox-text').value = '';
    void this.loadSent();
    // (A message to yourself, or everyone, is in your own inbox too)
    if (everyone || to.toLowerCase() === acc.username.toLowerCase()) void this.refresh();
  }

  private async loadSent(): Promise<void> {
    const acc = this.account;
    const list = this.compose?.querySelector<HTMLElement>('.inbox-sent');
    if (!acc?.isAdmin || !list) return;
    const r = await this.api.sent(acc.token);
    list.innerHTML = r.success ? sentHtml(r.sent) : `<div class="inbox-error">${escapeHtml(r.error)}</div>`;
  }
}
