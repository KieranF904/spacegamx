/**
 * The Friends tab of the Social window (P): your status, add a friend by name, requests to answer, and your friends
 * online and offline. Click a name to message them (the chat box's private mode); right-click for a menu (message,
 * invite to party, remove). The list comes from the server ('friends'); everything here only asks it.
 * Pure parts are in friendsView.ts.
 */
import { SOCIAL_STATUSES, type ClientMessage, type FriendView, type ServerFriendsMessage } from '@space-game/common';
import { openMenu } from '../windowKit';
import { PRESENCE, emptyFriends, friendMenu, groupFriends } from './friendsView';

export interface FriendsDeps {
  send(m: ClientMessage): void;
  /** A private message to them in the chat box */
  chatTo(name: string): void;
  /** In your party already (no invite) */
  inParty(name: string): boolean;
  /** You may invite (flying solo, or leading) */
  canInvite(): boolean;
  /** Close the window (a name was clicked: the chat box takes over) */
  close(): void;
}

function esc(t: string): string {
  return t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.fr { --hull-top: #1d2635; --hull-mid: #141b27; --hull-low: #0e131c; --edge-hi: rgba(196, 216, 255, 0.2); --edge-lo: rgba(0, 0, 0, 0.65);
  --rim: rgba(130, 160, 200, 0.22); --ink: #e4ebf5; --ink-2: #b4c2d4; --ink-3: #8b9cb3; --port: #6cc8ff;
  display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 14px; color: var(--ink-2); }
@media (max-width: 700px) { .fr { grid-template-columns: 1fr; } }
.fr-plate { position: relative; padding: 14px 16px; border-radius: 5px; border: 1px solid #05080d; min-width: 0;
  background:
    radial-gradient(circle at 8px 8px, rgba(220, 230, 250, 0.2) 1.5px, rgba(0, 0, 0, 0.5) 2.5px, transparent 3.5px),
    radial-gradient(circle at calc(100% - 8px) 8px, rgba(220, 230, 250, 0.2) 1.5px, rgba(0, 0, 0, 0.5) 2.5px, transparent 3.5px),
    linear-gradient(180deg, var(--hull-top) 0%, var(--hull-mid) 45%, var(--hull-low) 100%);
  box-shadow: inset 0 1px 0 var(--edge-hi), inset 0 -2px 0 var(--edge-lo), 0 0 0 1px var(--rim), 0 10px 26px rgba(0, 0, 0, 0.45); }
.fr-h { display: flex; align-items: center; gap: 10px; margin: 0 0 10px; font: 600 11px/1 'Rajdhani', 'Segoe UI', system-ui, sans-serif;
  letter-spacing: 3px; text-transform: uppercase; color: var(--ink-3); }
.fr-h::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, rgba(140, 170, 210, 0.35), transparent); }
.fr-h b { color: var(--ink-2); font-weight: 600; letter-spacing: 1px; }
.fr-plate > .fr-h:not(:first-child) { margin-top: 18px; }
.fr-list { display: flex; flex-direction: column; gap: 3px; }
.fr-row { display: flex; align-items: center; gap: 9px; padding: 6px 8px; border-radius: 4px; background: rgba(3, 6, 12, 0.45);
  border: 1px solid transparent; }
.fr-row.f { cursor: pointer; }
.fr-row.f:hover { border-color: rgba(108, 200, 255, 0.45); background: rgba(108, 200, 255, 0.07); }
.fr-row.off { opacity: 0.6; }
.fr-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.fr-name { color: var(--ink); font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fr-pres { color: var(--ink-3); font-size: 12px; }
.fr-row .sgw-btn { padding: 3px 10px; font-size: 11px; }
.fr-empty { color: var(--ink-3); font-size: 12px; padding: 4px 2px; }
.fr-status { display: flex; flex-wrap: wrap; gap: 6px; }
.fr-status .sgw-chip { display: inline-flex; align-items: center; gap: 6px; }
.fr-add { display: flex; gap: 6px; }
.fr-add input { flex: 1; min-width: 0; }
.fr-hint { color: var(--ink-3); font-size: 11px; margin-top: 10px; line-height: 1.5; }
.fr button:focus-visible, .fr input:focus-visible { outline: 2px solid var(--port); outline-offset: 2px; }
.fr .sgw-input:focus { border-color: rgba(108, 200, 255, 0.7); }`;
  document.head.appendChild(css);
}

export class FriendsPanel {
  data: ServerFriendsMessage = emptyFriends();

  constructor(private d: FriendsDeps) {
    injectStyles();
  }

  render(into: HTMLElement): void {
    into.replaceChildren();
    const root = document.createElement('div');
    root.className = 'fr';
    const left = document.createElement('div');
    left.className = 'fr-plate';
    const right = document.createElement('div');
    right.className = 'fr-plate';
    root.append(left, right);
    into.appendChild(root);

    if (!this.data.account) {
      left.innerHTML = `<div class="fr-h">Friends</div><div class="fr-empty">Sign in to keep a friends list. You can still send private messages: /w name message.</div>`;
      right.innerHTML = `<div class="fr-h">Your status</div>`;
      right.appendChild(this.statusChips());
      return;
    }

    // Friends, online then offline
    const { online, offline } = groupFriends(this.data.friends);
    left.insertAdjacentHTML('beforeend', `<div class="fr-h">Online <b>${online.length}</b></div>`);
    left.appendChild(online.length ? this.list(online) : this.empty(this.data.friends.length ? 'Nobody on right now.' : 'No friends yet. Add one by name.'));
    left.insertAdjacentHTML('beforeend', `<div class="fr-h">Offline <b>${offline.length}</b></div>`);
    left.appendChild(offline.length ? this.list(offline) : this.empty('None.'));
    left.insertAdjacentHTML('beforeend', '<div class="fr-hint">Click a name to message them. Right-click for more.</div>');

    // Status, add, requests
    right.insertAdjacentHTML('beforeend', '<div class="fr-h">Your status</div>');
    right.appendChild(this.statusChips());
    right.insertAdjacentHTML('beforeend', '<div class="fr-h">Add a friend</div>');
    const add = document.createElement('div');
    add.className = 'fr-add';
    add.innerHTML = '<input class="sgw-input" placeholder="Pilot name" maxlength="40"><button class="sgw-btn primary">Add</button>';
    const input = add.querySelector('input')!;
    const go = () => { const n = input.value.trim(); if (n) { this.d.send({ type: 'friendRequest', name: n }); input.value = ''; } };
    add.querySelector('button')!.onclick = go;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    right.appendChild(add);
    if (this.data.incoming.length) {
      right.insertAdjacentHTML('beforeend', `<div class="fr-h">Requests <b>${this.data.incoming.length}</b></div>`);
      const l = document.createElement('div');
      l.className = 'fr-list';
      for (const n of this.data.incoming) {
        l.appendChild(this.row(n, [
          { label: 'Accept', cls: 'good', run: () => this.d.send({ type: 'friendRespond', name: n, accept: true }) },
          { label: 'Decline', run: () => this.d.send({ type: 'friendRespond', name: n, accept: false }) },
        ]));
      }
      right.appendChild(l);
    }
    if (this.data.outgoing.length) {
      right.insertAdjacentHTML('beforeend', `<div class="fr-h">Sent <b>${this.data.outgoing.length}</b></div>`);
      const l = document.createElement('div');
      l.className = 'fr-list';
      for (const n of this.data.outgoing) l.appendChild(this.row(n, [{ label: 'Cancel', run: () => this.d.send({ type: 'friendRemove', name: n }) }]));
      right.appendChild(l);
    }
  }

  private empty(text: string): HTMLElement {
    const e = document.createElement('div');
    e.className = 'fr-empty';
    e.textContent = text;
    return e;
  }

  private statusChips(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'fr-status';
    for (const s of SOCIAL_STATUSES) {
      const b = document.createElement('button');
      b.className = `sgw-chip${this.data.status === s.id ? ' on' : ''}`;
      const color = PRESENCE[s.id === 'invisible' ? 'offline' : s.id].color;
      b.innerHTML = `<span class="fr-dot" style="background:${color}"></span>${s.label}`;
      b.title = s.id === 'invisible' ? 'Friends see you as offline, and private messages to you are not sent' : `Friends see you as ${s.label.toLowerCase()}`;
      b.onclick = () => { if (this.data.status !== s.id) this.d.send({ type: 'setStatus', status: s.id }); };
      box.appendChild(b);
    }
    return box;
  }

  private row(name: string, buttons: { label: string; cls?: string; run: () => void }[]): HTMLElement {
    const r = document.createElement('div');
    r.className = 'fr-row';
    r.innerHTML = `<span class="fr-name">${esc(name)}</span>`;
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = `sgw-btn${b.cls ? ` ${b.cls}` : ''}`;
      el.textContent = b.label;
      el.onclick = b.run;
      r.appendChild(el);
    }
    return r;
  }

  private list(friends: FriendView[]): HTMLElement {
    const l = document.createElement('div');
    l.className = 'fr-list';
    for (const f of friends) {
      const p = PRESENCE[f.presence];
      const r = document.createElement('div');
      r.className = `fr-row f${f.presence === 'offline' ? ' off' : ''}`;
      r.dataset.name = f.name;
      r.title = f.presence === 'offline' ? 'Offline: right-click for options' : `Message ${f.name}`;
      r.innerHTML = `<span class="fr-dot" style="background:${p.color}${f.presence === 'online' ? `;box-shadow:0 0 6px ${p.color}` : ''}"></span>
        <span class="fr-name">${esc(f.name)}</span><span class="fr-pres">${p.label}</span>`;
      r.addEventListener('click', () => {
        if (f.presence === 'offline') return;
        this.d.close();
        this.d.chatTo(f.name);
      });
      r.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.menu(f, e.clientX, e.clientY);
      });
      l.appendChild(r);
    }
    return l;
  }

  /** A friend's right-click menu (also used by tests through friendMenu) */
  menu(f: FriendView, x: number, y: number): void {
    openMenu(x, y, friendMenu(f, { inParty: (n) => this.d.inParty(n), canInvite: this.d.canInvite() }).map((it) => ({
      label: it.label, bad: it.bad,
      run: () => {
        if (it.id === 'message') { this.d.close(); this.d.chatTo(f.name); }
        else if (it.id === 'invite') this.d.send({ type: 'partyInvite', name: f.name });
        else this.d.send({ type: 'friendRemove', name: f.name });
      },
    })));
  }
}
