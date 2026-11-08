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
import { esc } from '../escape';

export interface InboxAccount { token: string; username: string; isAdmin: boolean }

const SUBJECT_MAX = 120;
const BODY_MAX = 4000;

/** Text into HTML text or a quoted attribute */

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
      <span class="inbox-row-top"><span class="inbox-from">${esc(fromLabel(m.from))}</span><span class="inbox-date">${esc(formatWhen(m.createdAt))}</span></span>
      <span class="inbox-subject">${esc(m.subject)}</span>
    </button>`).join('');
}

/** The open message (null: a hint) */
export function readerHtml(m: InboxMessage | null): string {
  if (!m) return '<div class="inbox-hint">Pick a message to read it.</div>';
  return `
    <div class="inbox-read-subject">${esc(m.subject)}</div>
    <div class="inbox-read-meta">From <b>${esc(fromLabel(m.from))}</b> · ${esc(formatWhen(m.createdAt))}${m.important ? ` · <span class="inbox-tag">${m.from === 'system' ? 'important' : 'admin'}</span>` : ''}</div>
    <div class="inbox-read-body">${esc(m.body)}</div>
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
      <div class="inbox-banner-label">Message from ${esc(fromLabel(m.from))} ${more}</div>
      <div class="inbox-banner-subject">${esc(m.subject)}</div>
    </div>
    <button type="button" class="inbox-banner-read" data-id="${Number(m.id)}">Read</button>`;
}

/** What an admin has sent */
export function sentHtml(sent: SentInfo[]): string {
  if (!sent.length) return '<div class="inbox-empty">Nothing sent yet.</div>';
  return sent.slice(0, 8).map((s) => `
    <div class="inbox-sent-row">
      <span class="inbox-sent-to">${s.to === '*' ? 'Everyone' : esc(s.to)}</span>
      <span class="inbox-sent-subject">${esc(s.subject)}</span>
      <span class="inbox-sent-read">${s.read}/${s.recipients} read · ${esc(formatWhen(s.createdAt))}</span>
    </div>`).join('');
}

/** (The colours are the join screen's custom properties: ServerBrowserUI's styles; fallbacks for anywhere else) */
const STYLE = `
  /* An unread admin message: an amber-lit plate, its beacon glowing, above everything */
  .inbox-banner { position: relative; display: flex; align-items: center; gap: 16px; padding: 14px 16px 14px 20px;
    border-radius: 5px; border: 1px solid #2a1800; color: #ffeccc; overflow: hidden;
    background: linear-gradient(90deg, rgba(255, 170, 50, 0.26) 0%, rgba(255, 170, 50, 0.08) 55%, rgba(255, 170, 50, 0.04) 100%),
      linear-gradient(180deg, #2a2116 0%, #18130c 100%);
    box-shadow: inset 0 1px 0 rgba(255, 220, 160, 0.3), inset 0 -2px 0 rgba(0, 0, 0, 0.6),
      0 0 0 1px rgba(255, 190, 85, 0.55), 0 0 30px var(--amber-glow, rgba(255, 175, 60, 0.4)), 0 14px 30px rgba(0, 0, 0, 0.55); }
  .inbox-banner::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px;
    background: var(--amber, #ffbe55); box-shadow: 0 0 12px var(--amber, #ffbe55); }
  .inbox-banner[hidden] { display: none; }
  .inbox-banner-icon { flex: none; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%;
    font-size: 20px; line-height: 1; color: #2a1600;
    background: radial-gradient(circle at 40% 35%, #fff1c8, #ffbe55 55%, #c9821c);
    box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.5), 0 0 16px var(--amber-glow, rgba(255, 175, 60, 0.4)); }
  .inbox-banner-text { flex: 1; min-width: 0; }
  .inbox-banner-label { font-size: 11px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: var(--amber, #ffbe55); }
  .inbox-banner-subject { font-size: 18px; color: #fff6e4; font-weight: 700; margin-top: 3px; overflow-wrap: anywhere; }
  .inbox-banner-more { letter-spacing: 0; text-transform: none; font-weight: normal; color: #ead3a4; margin-left: 6px; }
  .inbox-banner-read { flex: none; padding: 10px 24px; border-radius: 4px; border: 1px solid #3a2200; cursor: pointer;
    background: linear-gradient(180deg, #ffd27a 0%, #f0b040 48%, #d3921f 52%, #b87a14 100%); color: #1d1200;
    font-weight: 700; font-size: 15px; letter-spacing: 1px;
    box-shadow: inset 0 1px 0 rgba(255, 248, 220, 0.8), 0 0 14px var(--amber-glow, rgba(255, 175, 60, 0.4));
    transition: filter var(--ease, 160ms), box-shadow var(--ease, 160ms); }
  .inbox-banner-read:hover { filter: brightness(1.08); box-shadow: inset 0 1px 0 rgba(255, 248, 220, 0.9), 0 0 22px rgba(255, 190, 80, 0.6); }
  #server-browser-panel .inbox-banner-read:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  @media (max-width: 560px) {
    .inbox-banner { flex-wrap: wrap; gap: 10px 12px; padding: 12px 12px 12px 16px; }
    .inbox-banner-icon { width: 32px; height: 32px; font-size: 16px; }
    .inbox-banner-read { width: 100%; }
  }

  .inbox-box[hidden] { display: none; }
  .inbox-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .inbox-head .join-h { margin: 0; }
  .inbox-count { font-size: 12px; font-weight: 600; padding: 2px 10px; border-radius: 999px; color: var(--ink-2, #b4c2d4);
    background: rgba(0, 0, 0, 0.35); box-shadow: inset 0 0 0 1px rgba(140, 170, 210, 0.25); }
  .inbox-count.has-unread { color: #04121e; background: var(--port, #6cc8ff); box-shadow: 0 0 10px var(--port-glow, rgba(90, 190, 255, 0.45)); }
  .inbox-count.has-important { color: #1d1200; background: var(--amber, #ffbe55); box-shadow: 0 0 10px var(--amber-glow, rgba(255, 175, 60, 0.4)); }
  .inbox-spacer { flex: 1; }
  /* Small steel buttons */
  .inbox-btn { padding: 7px 13px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600; color: var(--ink-2, #b4c2d4);
    background: linear-gradient(180deg, #243044, #161e2b); border: 1px solid #05080d;
    box-shadow: inset 0 1px 0 var(--edge-hi, rgba(196, 216, 255, 0.2)), 0 0 0 1px var(--rim, rgba(130, 160, 200, 0.22));
    transition: color var(--ease, 160ms), box-shadow var(--ease, 160ms); }
  .inbox-btn:hover { color: var(--ink, #e4ebf5); box-shadow: inset 0 1px 0 var(--edge-hi, rgba(196, 216, 255, 0.2)), 0 0 0 1px rgba(140, 200, 255, 0.5); }
  .inbox-btn:disabled { opacity: 0.5; cursor: default; }
  .inbox-btn.primary { color: #eaf6ff; background: linear-gradient(180deg, #2a5d8c, #1a3d62);
    box-shadow: inset 0 1px 0 rgba(190, 225, 255, 0.4), 0 0 0 1px rgba(108, 200, 255, 0.45), 0 0 12px rgba(90, 190, 255, 0.18); }
  .inbox-btn.primary:hover { box-shadow: inset 0 1px 0 rgba(190, 225, 255, 0.5), 0 0 0 1px rgba(108, 200, 255, 0.7), 0 0 16px var(--port-glow, rgba(90, 190, 255, 0.45)); }
  .inbox-main { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: 14px; margin-top: 14px; }
  @media (max-width: 620px) { .inbox-main { grid-template-columns: 1fr; } }
  /* Messages: slots recessed into the plate */
  .inbox-list { display: flex; flex-direction: column; gap: 6px; max-height: 250px; overflow-y: auto; padding: 1px 4px 1px 1px; }
  .inbox-row { position: relative; text-align: left; border-radius: 4px; padding: 8px 11px 8px 14px; cursor: pointer;
    color: var(--ink-2, #b4c2d4); font: inherit; display: flex; flex-direction: column; gap: 3px;
    background: var(--well, rgba(3, 6, 12, 0.62)); border: 1px solid rgba(0, 0, 0, 0.7);
    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.5), 0 1px 0 rgba(196, 216, 255, 0.06);
    transition: box-shadow var(--ease, 160ms), background var(--ease, 160ms); }
  .inbox-row:hover { background: rgba(20, 34, 54, 0.7); }
  .inbox-row.selected { background: rgba(26, 52, 84, 0.75);
    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(108, 200, 255, 0.55); }
  .inbox-row.unread .inbox-subject { color: #fff; font-weight: 700; }
  /* (an unread one has a lit port at its left edge: blue, or amber for an important one) */
  .inbox-row.unread::before { content: ''; position: absolute; left: 4px; top: 8px; bottom: 8px; width: 3px; border-radius: 2px;
    background: var(--port, #6cc8ff); box-shadow: 0 0 6px var(--port-glow, rgba(90, 190, 255, 0.45)); }
  .inbox-row.unread.important::before { background: var(--amber, #ffbe55); box-shadow: 0 0 6px var(--amber-glow, rgba(255, 175, 60, 0.4)); }
  .inbox-row-top { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--ink-3, #8b9cb3); }
  .inbox-from { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .inbox-date { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .inbox-subject { font-size: 13px; color: var(--ink, #e4ebf5); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* The reader: a recessed screen */
  .inbox-reader { border-radius: 4px; padding: 14px 16px; min-height: 130px; border: 1px solid rgba(0, 0, 0, 0.8);
    background: linear-gradient(180deg, rgba(4, 8, 15, 0.85), rgba(6, 11, 20, 0.7));
    box-shadow: inset 0 3px 8px rgba(0, 0, 0, 0.6), 0 1px 0 rgba(196, 216, 255, 0.07); }
  .inbox-read-subject { color: var(--ink, #e4ebf5); font-size: 17px; font-weight: 700; overflow-wrap: anywhere; }
  .inbox-read-meta { font-size: 12px; color: var(--ink-3, #8b9cb3); margin: 5px 0 12px; }
  .inbox-read-meta b { color: var(--ink-2, #b4c2d4); font-weight: 600; }
  .inbox-tag { color: var(--amber, #ffbe55); font-weight: 600; }
  .inbox-read-body { color: #ccd7e5; font-size: 14px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow-y: auto; }
  .inbox-read-actions { margin-top: 14px; display: flex; justify-content: flex-end; }
  .inbox-delete { color: #f0a8a0; }
  .inbox-delete:hover { color: #ffc4bd; box-shadow: inset 0 1px 0 var(--edge-hi, rgba(196, 216, 255, 0.2)), 0 0 0 1px rgba(255, 120, 110, 0.5); }
  .inbox-empty, .inbox-hint { color: var(--ink-3, #8b9cb3); font-size: 13px; }
  .inbox-error { color: #ff9a9a; font-size: 12px; margin-top: 8px; }
  .inbox-error:empty { display: none; }

  .inbox-compose { margin-top: 18px; border-top: 1px solid rgba(0, 0, 0, 0.7); box-shadow: inset 0 1px 0 rgba(196, 216, 255, 0.08); padding-top: 16px; }
  .inbox-compose[hidden] { display: none; }
  .inbox-form { display: grid; grid-template-columns: 90px 1fr; gap: 10px 12px; align-items: center; }
  .inbox-form label { font-size: 12px; color: var(--ink-3, #8b9cb3); }
  .inbox-form input[type=text], .inbox-form textarea { width: 100%; box-sizing: border-box; border-radius: 4px; padding: 8px 10px;
    color: var(--ink, #e4ebf5); font: 13px 'Segoe UI', system-ui, sans-serif;
    background: var(--well, rgba(3, 6, 12, 0.62)); border: 1px solid rgba(0, 0, 0, 0.8);
    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.5), 0 1px 0 rgba(196, 216, 255, 0.07); transition: box-shadow var(--ease, 160ms); }
  .inbox-form input::placeholder, .inbox-form textarea::placeholder { color: #66778e; }
  .inbox-form textarea { min-height: 100px; resize: vertical; }
  #server-browser-panel .inbox-form input[type=text]:focus, #server-browser-panel .inbox-form textarea:focus { outline: none;
    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.5), 0 0 0 1px var(--port, #6cc8ff), 0 0 10px var(--port-glow, rgba(90, 190, 255, 0.45)); }
  .inbox-form input:disabled { opacity: 0.5; }
  .inbox-to { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .inbox-to input[type=text] { flex: 1; min-width: 140px; width: auto; }
  .inbox-check { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: var(--ink-2, #b4c2d4); cursor: pointer; }
  .inbox-check input { accent-color: var(--port, #6cc8ff); }
  .inbox-form-foot { grid-column: 2; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  @media (max-width: 560px) {
    .inbox-form { grid-template-columns: 1fr; gap: 6px; }
    .inbox-form > span:empty { display: none; }
    .inbox-form-foot { grid-column: 1; margin-top: 4px; }
  }
  .inbox-form-status { font-size: 12px; color: #8cf5a4; }
  .inbox-form-status.bad { color: #ff9a9a; }
  .inbox-sent { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
  .inbox-sent-row { display: grid; grid-template-columns: minmax(70px, 1fr) minmax(0, 2fr) auto; gap: 10px; font-size: 12px; color: var(--ink-2, #b4c2d4);
    padding: 6px 10px; border-radius: 4px; background: rgba(0, 0, 0, 0.25); }
  .inbox-sent-to { color: var(--port, #6cc8ff); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .inbox-sent-subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink, #e4ebf5); }
  .inbox-sent-read { color: var(--ink-3, #8b9cb3); font-variant-numeric: tabular-nums; }
  /* (on the Join button: a dark inset tag, amber-lit, so it reads on the orange) */
  .join-main-btn .join-mail-badge { display: inline-block; margin-left: 12px; vertical-align: 6px; padding: 3px 11px; border-radius: 999px;
    font: 700 13px/1.3 'Segoe UI', system-ui, sans-serif; letter-spacing: 0; text-shadow: none;
    color: var(--amber, #ffbe55); background: rgba(30, 12, 0, 0.82); box-shadow: inset 0 0 0 1px rgba(255, 190, 85, 0.6), 0 0 10px rgba(255, 190, 85, 0.35); }
  .join-mail-badge[hidden] { display: none !important; }
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
    list.innerHTML = r.success ? sentHtml(r.sent) : `<div class="inbox-error">${esc(r.error)}</div>`;
  }
}
