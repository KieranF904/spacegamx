/**
 * The friends list, drawn small for the side panel's Social tab (ui/hub/tabs/socialTab.ts): your status (a button
 * with a menu), "+ Add" for a name, requests to answer (accept, decline) and requests you sent (cancel), then your
 * friends online and offline. Click a name to message them (the chat box's private mode); right-click for a menu
 * (message, invite to party, remove). The list comes from the server ('friends'); everything here only asks it.
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
.fr { --ink: #e4ebf5; --ink-2: #b4c2d4; --ink-3: #8b9cb3; --port: #6cc8ff; color: var(--ink-2); display: flex; flex-direction: column; gap: 2px; }
.fr-top { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.fr-me { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: 999px;
  border: 1px solid rgba(140, 170, 220, 0.22); background: rgba(3, 6, 12, 0.4); color: var(--ink); font-size: 11px; }
.fr-me:hover { border-color: rgba(108, 200, 255, 0.5); }
.fr-me .v { color: var(--ink-3); font-size: 9px; }
.fr-addbtn { all: unset; cursor: pointer; margin-left: auto; padding: 3px 9px; border-radius: 999px; font-size: 11px; color: #bfe6ff;
  border: 1px solid rgba(108, 200, 255, 0.35); background: rgba(29, 94, 122, 0.35); }
.fr-addbtn:hover, .fr-addbtn.on { background: rgba(36, 115, 154, 0.6); color: #fff; }
.fr-add { display: flex; gap: 5px; margin: 0 0 6px; }
.fr-add input { flex: 1; min-width: 0; padding: 4px 8px; font-size: 12px; border-radius: 6px; }
.fr-add .sgw-btn { padding: 3px 10px; font-size: 11px; border-radius: 6px; }
.fr-h { display: flex; align-items: center; gap: 8px; margin: 6px 0 3px; font: 600 9.5px/1 'Segoe UI', system-ui, sans-serif;
  letter-spacing: 2px; text-transform: uppercase; color: var(--ink-3); }
.fr-h::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, rgba(140, 170, 210, 0.3), transparent); }
.fr-h b { color: var(--ink-2); font-weight: 600; letter-spacing: 1px; }
.fr-h.req { color: #fcd34d; }
.fr-h.req b { color: #fde68a; }
.fr-top + .fr-h, .fr-add + .fr-h { margin-top: 2px; }
.fr-list { display: flex; flex-direction: column; gap: 2px; }
.fr-row { display: flex; align-items: center; gap: 7px; padding: 3px 6px; border-radius: 4px; background: rgba(3, 6, 12, 0.4); border: 1px solid transparent; }
.fr-row.f { cursor: pointer; }
.fr-row.f:hover { border-color: rgba(108, 200, 255, 0.45); background: rgba(108, 200, 255, 0.07); }
.fr-row.f:focus-visible { outline: 2px solid var(--port); outline-offset: 0; }
.fr-row.off { opacity: 0.6; }
.fr-row.ask { background: rgba(251, 191, 36, 0.07); border-color: rgba(251, 191, 36, 0.22); }
.fr-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.fr-name { color: var(--ink); font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fr-pres { color: var(--ink-3); font-size: 10.5px; }
.fr-row .sgw-btn { padding: 1px 8px; font-size: 10.5px; border-radius: 5px; }
.fr-empty { color: var(--ink-3); font-size: 11px; padding: 2px; }
.fr-hint { color: #56657c; font-size: 10px; margin-top: 6px; }
.fr button:focus-visible, .fr input:focus-visible { outline: 2px solid var(--port); outline-offset: 1px; }
.fr .sgw-input:focus { border-color: rgba(108, 200, 255, 0.7); }`;
  document.head.appendChild(css);
}

export class FriendsPanel {
  data: ServerFriendsMessage = emptyFriends();
  /** The add-a-friend field is out (kept across redraws) */
  private adding = false;

  constructor(private d: FriendsDeps) {
    injectStyles();
  }

  render(into: HTMLElement): void {
    into.replaceChildren();
    const root = document.createElement('div');
    root.className = 'fr';
    into.appendChild(root);

    const top = document.createElement('div');
    top.className = 'fr-top';
    top.appendChild(this.statusButton());
    root.appendChild(top);

    if (!this.data.account) {
      root.appendChild(this.empty('Sign in to keep a friends list. You can still send private messages: /w name message.'));
      return;
    }

    // + Add: a name field under the bar
    const addBtn = document.createElement('button');
    addBtn.className = `fr-addbtn${this.adding ? ' on' : ''}`;
    addBtn.textContent = '+ Add friend';
    addBtn.setAttribute('aria-expanded', String(this.adding));
    top.appendChild(addBtn);
    let input: HTMLInputElement | null = null;
    if (this.adding) {
      const add = document.createElement('div');
      add.className = 'fr-add';
      add.innerHTML = '<input class="sgw-input" placeholder="Pilot name" maxlength="40" aria-label="Pilot name to add"><button class="sgw-btn primary">Add</button>';
      input = add.querySelector('input')!;
      const go = () => { const n = input!.value.trim(); if (n) { this.d.send({ type: 'friendRequest', name: n }); input!.value = ''; } };
      add.querySelector('button')!.onclick = go;
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      root.appendChild(add);
    }
    addBtn.onclick = () => {
      this.adding = !this.adding;
      this.render(into);
      if (this.adding) into.querySelector<HTMLInputElement>('.fr-add input')?.focus();
    };

    // Requests to answer, first: they're what needs you
    if (this.data.incoming.length) {
      root.appendChild(this.head(`Requests <b>${this.data.incoming.length}</b>`, 'req'));
      const l = this.listEl();
      for (const n of this.data.incoming) {
        l.appendChild(this.row(n, [
          { label: 'Accept', cls: 'good', run: () => this.d.send({ type: 'friendRespond', name: n, accept: true }) },
          { label: 'Decline', run: () => this.d.send({ type: 'friendRespond', name: n, accept: false }) },
        ], 'ask'));
      }
      root.appendChild(l);
    }

    // Friends, online then offline
    const { online, offline } = groupFriends(this.data.friends);
    root.appendChild(this.head(`Online <b>${online.length}</b>`));
    root.appendChild(online.length ? this.list(online) : this.empty(this.data.friends.length ? 'Nobody on right now.' : 'No friends yet: + Add friend.'));
    if (offline.length) {
      root.appendChild(this.head(`Offline <b>${offline.length}</b>`));
      root.appendChild(this.list(offline));
    }
    if (this.data.outgoing.length) {
      root.appendChild(this.head(`Sent <b>${this.data.outgoing.length}</b>`));
      const l = this.listEl();
      for (const n of this.data.outgoing) l.appendChild(this.row(n, [{ label: 'Cancel', run: () => this.d.send({ type: 'friendRemove', name: n }) }]));
      root.appendChild(l);
    }
    if (this.data.friends.length) {
      const hint = document.createElement('div');
      hint.className = 'fr-hint';
      hint.textContent = 'Click a name to message them. Right-click for more.';
      root.appendChild(hint);
    }
  }

  private head(html: string, cls = ''): HTMLElement {
    const h = document.createElement('div');
    h.className = `fr-h${cls ? ` ${cls}` : ''}`;
    h.innerHTML = html;
    return h;
  }

  private listEl(): HTMLElement {
    const l = document.createElement('div');
    l.className = 'fr-list';
    return l;
  }

  private empty(text: string): HTMLElement {
    const e = document.createElement('div');
    e.className = 'fr-empty';
    e.textContent = text;
    return e;
  }

  /** Your status: a button showing it, a menu of the four */
  private statusButton(): HTMLElement {
    const cur = SOCIAL_STATUSES.find((s) => s.id === this.data.status) ?? SOCIAL_STATUSES[0];
    const color = (id: string) => PRESENCE[id === 'invisible' ? 'offline' : (id as 'online')].color;
    const b = document.createElement('button');
    b.className = 'fr-me';
    b.title = 'Your status: what your friends see';
    b.setAttribute('aria-haspopup', 'menu');
    b.innerHTML = `<span class="fr-dot" style="background:${color(cur.id)}"></span>${esc(cur.label)}<span class="v">▾</span>`;
    b.onclick = () => {
      const r = b.getBoundingClientRect();
      openMenu(r.left, r.bottom + 4, SOCIAL_STATUSES.map((s) => ({
        label: `${s.id === this.data.status ? '● ' : ''}${s.label}${s.id === 'invisible' ? ' (no private messages)' : ''}`,
        run: () => { if (this.data.status !== s.id) this.d.send({ type: 'setStatus', status: s.id }); },
      })));
    };
    return b;
  }

  private row(name: string, buttons: { label: string; cls?: string; run: () => void }[], cls = ''): HTMLElement {
    const r = document.createElement('div');
    r.className = `fr-row${cls ? ` ${cls}` : ''}`;
    r.innerHTML = `<span class="fr-name">${esc(name)}</span>`;
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = `sgw-btn${b.cls ? ` ${b.cls}` : ''}`;
      el.textContent = b.label;
      el.setAttribute('aria-label', `${b.label}: ${name}`);
      el.onclick = b.run;
      r.appendChild(el);
    }
    return r;
  }

  private list(friends: FriendView[]): HTMLElement {
    const l = this.listEl();
    for (const f of friends) {
      const p = PRESENCE[f.presence];
      const r = document.createElement('div');
      r.className = `fr-row f${f.presence === 'offline' ? ' off' : ''}`;
      r.dataset.name = f.name;
      r.tabIndex = 0;
      r.setAttribute('role', 'button');
      r.title = f.presence === 'offline' ? 'Offline: right-click for options' : `Message ${f.name} · right-click for more`;
      r.innerHTML = `<span class="fr-dot" style="background:${p.color}${f.presence === 'online' ? `;box-shadow:0 0 6px ${p.color}` : ''}"></span>
        <span class="fr-name">${esc(f.name)}</span><span class="fr-pres">${p.label}</span>`;
      const message = () => { if (f.presence !== 'offline') this.d.chatTo(f.name); };
      r.addEventListener('click', message);
      r.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.stopPropagation(); message(); }
        else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
          e.preventDefault();
          const b = r.getBoundingClientRect();
          this.menu(f, b.left + 20, b.bottom);
        }
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
        if (it.id === 'message') this.d.chatTo(f.name);
        else if (it.id === 'invite') this.d.send({ type: 'partyInvite', name: f.name });
        else this.d.send({ type: 'friendRemove', name: f.name });
      },
    })));
  }
}
