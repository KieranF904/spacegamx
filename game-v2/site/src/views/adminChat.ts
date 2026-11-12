/**
 * The admin panel's Chat tab: who is on each game server, and a conversation with everyone on one or with one pilot.
 * Made for a phone: one column, big tap targets, the newest message at the bottom with the box to write in under it.
 * The page's script (public/site.js, "admin chat") refreshes the two fragments below every few seconds.
 * Everything a pilot typed, and every name, is escaped here.
 */

import { html, raw, type SafeHtml } from '../html.js';
import type { ChatMessage, ChatServer, ChatState } from '../adminChat.js';
import { shell } from './admin.js';
import { csrfField, type PageCtx } from './layout.js';

/** Most characters of one message (the lobby's TEXT_MAX) */
export const CHAT_TEXT_MAX = 300;

export interface ChatView {
  state: ChatState | null;
  /** The server being looked at ('' when none is connected) */
  server: string;
  /** The pilot whose conversation this is ('' for everyone on the server) */
  pilot: string;
  /** Why the last send didn't go (a fixed line, or the lobby's own) */
  error?: string;
}

const q = (server: string, pilot = '') => `?server=${encodeURIComponent(server)}${pilot ? `&with=${encodeURIComponent(pilot)}` : ''}`;
const iso = (ms: number) => new Date(ms).toISOString();
/** A time the page's script shows in the reader's own clock (UTC until it has) */
const clock = (ms: number): SafeHtml => html`<time datetime="${iso(ms)}" data-clock>${iso(ms).slice(11, 16)} UTC</time>`;

const STATUS: Record<string, string> = { queued: 'sending', failed: 'not delivered: they had left', inbox: 'left in their inbox' };

/** The server being looked at: the one asked for if it is known, else the first that is connected */
export function pickServer(state: ChatState | null, asked: string): string {
  const servers = state?.servers ?? [];
  return servers.find((s) => s.name === asked)?.name ?? servers.find((s) => s.fresh)?.name ?? servers[0]?.name ?? '';
}

/** Who is on the server being looked at, each a link to their conversation */
export function onlineList(servers: ChatServer[], server: string, pilot: string): SafeHtml {
  const s = servers.find((x) => x.name === server);
  if (!s) return html`<p class="dim">No game server is connected right now.</p>`;
  if (!s.fresh) return html`<p class="dim">${s.name} isn't connected right now.</p>`;
  return html`<p class="chat-count">${s.online.length} on ${s.name}</p>
  <div class="chat-pilots">
    <a class="chat-pilot${pilot ? '' : ' on'}" href="/admin/chat${q(server)}"${pilot ? '' : raw(' aria-current="true"')}><b>Everyone</b><span>message all ${s.online.length}</span></a>
    ${s.online.map((p) => { const cur = p.name.toLowerCase() === pilot.toLowerCase(); return html`<a class="chat-pilot${cur ? ' on' : ''}" href="/admin/chat${q(server, p.name)}"${cur ? raw(' aria-current="true"') : ''}><b>${p.name}</b><span>${p.guest ? 'guest · ' : ''}on since ${clock(p.since)}</span></a>`; })}
  </div>`;
}

function line(m: ChatMessage, pilot: string): SafeHtml {
  const who = m.direction === 'in' ? m.pilot : m.admin;
  const to = m.direction === 'out' && !pilot ? (m.pilot ? html` to <a href="/admin/chat${q(m.server, m.pilot)}">${m.pilot}</a>` : ' to everyone') : m.direction === 'out' && !m.pilot ? ' to everyone' : '';
  const from = m.direction === 'in' && !pilot ? html`<a href="/admin/chat${q(m.server, m.pilot)}">${who}</a>` : who;
  return html`<li class="chat-line chat-${m.direction}${m.status === 'failed' ? ' chat-failed' : ''}"><p class="chat-meta"><b>${from}</b>${to} · ${clock(m.at)}${STATUS[m.status] ? html` · <span class="chat-status">${STATUS[m.status]}</span>` : ''}</p><p class="chat-text">${m.text}</p></li>`;
}

/** The conversation, oldest first (the newest is at the bottom, by the box) */
export function chatLog(messages: ChatMessage[], pilot: string): SafeHtml {
  if (!messages.length) return html`<li class="chat-empty dim">${pilot ? `Nothing said with ${pilot} yet.` : 'Nothing said yet.'}</li>`;
  return html`${messages.map((m) => line(m, pilot))}`;
}

export function adminChatPage(ctx: PageCtx, d: ChatView): SafeHtml {
  const servers = d.state?.servers ?? [];
  const s = servers.find((x) => x.name === d.server);
  const target = d.pilot ? s?.online.find((p) => p.name.toLowerCase() === d.pilot.toLowerCase()) : undefined;
  const offline = !!d.pilot && !target;
  const canSend = !!s?.fresh && (d.pilot ? !!target : s.online.length > 0);
  return shell(ctx, 'chat', 'Chat', html`
  <h1>Chat</h1>
  ${!d.state ? html`<p class="form-error" role="alert">The lobby isn't answering, or admin chat is off. Try again in a moment.</p>` : html`
  <div class="chat" data-chat data-feed="/admin/chat/feed${q(d.server, d.pilot)}">
    ${servers.length > 1 ? html`<nav class="chat-servers" aria-label="Game servers">${servers.map((x) => html`<a class="chat-server${x.name === d.server ? ' on' : ''}" href="/admin/chat${q(x.name)}">${x.name} <span>${x.fresh ? String(x.online.length) : 'off'}</span></a>`)}</nav>` : ''}
    <section aria-label="Who is on" data-chat-online>${onlineList(servers, d.server, d.pilot)}</section>
    <section class="chat-talk" aria-label="Conversation">
      <h2>${d.pilot ? html`${d.pilot}${d.server ? ` on ${d.server}` : ''}` : d.server ? `Everyone on ${d.server}` : 'Messages'}</h2>
      <p class="dim small">${d.pilot ? 'A private message: only they see it. They reply with /w and your name, or from their private messages.' : 'Shown in game chat to everyone on this server, as from [Admin] and your name.'} Private replies come here, never to the public feed.</p>
      <ol class="chat-log" data-chat-log aria-live="polite">${chatLog(d.state.messages, d.pilot)}</ol>
      <p class="form-error" role="alert" data-chat-error${d.error ? '' : raw(' hidden')}>${d.error ?? ''}</p>
      <form method="post" action="/admin/chat/send" class="chat-form" data-chat-form>
        ${csrfField(ctx)}
        <input type="hidden" name="server" value="${d.server}">
        <input type="hidden" name="with" value="${d.pilot}">
        <input id="chat-text" name="text" aria-label="Message" required maxlength="${CHAT_TEXT_MAX}" autocomplete="off" enterkeyhint="send" placeholder="${d.pilot ? `Message ${d.pilot}` : 'Message everyone'}"${canSend ? '' : raw(' disabled')}>
        <button class="btn btn-primary" type="submit"${canSend ? '' : raw(' disabled')}>Send</button>
      </form>
      ${offline ? html`<div class="chat-offline">
        <p><b>${d.pilot}</b> is not online${s?.fresh ? ` on ${d.server}` : ''}.</p>
        <form method="post" action="/admin/chat/inbox" class="chat-form">
          ${csrfField(ctx)}
          <input type="hidden" name="server" value="${d.server}">
          <input type="hidden" name="with" value="${d.pilot}">
          <input id="chat-inbox" name="text" aria-label="Message for their inbox" required maxlength="${CHAT_TEXT_MAX}" autocomplete="off" placeholder="Leave it in their inbox instead">
          <button class="btn" type="submit">To inbox</button>
        </form>
        <p class="dim small">Only an account has an inbox: a guest doesn't.</p>
      </div>` : ''}
    </section>
  </div>`}
  <p class="dim small">Everything sent here is logged with your name. Pilots' public chat is on the <a href="/admin/activity">Activity</a> page.</p>`);
}
