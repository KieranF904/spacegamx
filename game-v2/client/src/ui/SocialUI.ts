/**
 * Playing together on the client: your party (a compact list on the left, and
 * the side panel's Party tab), your friends (the side panel's Social tab:
 * FriendsPanel), invitations, friend and trade requests, and the rally buttons
 * when you're destroyed. The side panel (ui/hub) draws the two tabs through
 * renderParty and friends.render; this class keeps the state.
 *
 *   P            the side panel's Social tab (hovering over another pilot: invite them)
 *   /p message   party chat; /invite name, /leave, /kick name, /promote name
 */

import {
  ServerPartyMessage, ServerPartyInviteMessage, ServerTradeRequestMessage, PartyMemberView, ClientMessage, EntityType, StarSystemData,
  ServerFriendsMessage, ServerFriendRequestMessage,
} from '@space-game/common';
import type { GameState } from '../state/GameState';
import type { AutoDest } from '../ships/Autopilot';
import { injectWindowStyles, openMenu } from './windowKit';
import { boundKeyName } from '../input/keybindings';
import { FriendsPanel } from './social/FriendsPanel';
import { onlineCount } from './social/friendsView';
import { settings } from '../settings/Settings';
import systemsData from '../../../data/systems.json';
import { esc } from './escape';
import { backupPicker } from './BackupPicker';

const SYSTEMS = new Map((systemsData as { systems: StarSystemData[] }).systems.map((s) => [s.id, s]));
const sysName = (id: string) => SYSTEMS.get(id)?.name.replace(/ System$/, '') ?? id;


export interface SocialDeps {
  state: GameState;
  send(m: ClientMessage): void;
  sound(id: string, v?: number): void;
  flyTo(dest: AutoDest): void;
  message(text: string, color?: string): void;
  /** Start a private message to this pilot in the chat box */
  chatTo(name: string): void;
  /** Friends online changed */
  friendsOnline(n: number): void;
  /** Show a side panel tab (the Social or Party tab) */
  openTab(tab: SocialTab): void;
}

/** The side panel's tabs this draws */
export type SocialTab = 'social' | 'party';

export class SocialUI {
  party: ServerPartyMessage = { type: 'party', id: 0, leader: '', members: [] };
  private hud: HTMLDivElement;
  private prompts: HTMLDivElement;
  private rally: HTMLDivElement;
  private visible = false;
  private listeners = new Set<() => void>();
  readonly friends: FriendsPanel;
  /** The Party tab's "What a party gives you" is open (kept across its redraws) */
  private perksOpen = false;

  constructor(private d: SocialDeps) {
    injectWindowStyles();
    const css = document.createElement('style');
    css.textContent = `
.pty { position: fixed; left: 16px; top: 372px; width: 184px; display: none; flex-direction: column; gap: 4px; z-index: 860;
  font: 12px 'Segoe UI', system-ui, sans-serif; color: #d6deeb; }
.pty-h { display: flex; justify-content: space-between; font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 2px; color: #86efac; padding: 0 2px; }
.pty-h b { color: #fde68a; letter-spacing: 1px; font-weight: 700; }
.pty-m { background: rgba(8, 16, 28, 0.82); border: 1px solid rgba(74, 222, 128, 0.25); border-radius: 8px; padding: 5px 8px; cursor: pointer; }
.pty-m:hover { border-color: rgba(74, 222, 128, 0.6); }
.pty-m.dead { opacity: 0.55; }
.pty-m .n { display: flex; justify-content: space-between; gap: 6px; }
.pty-m .n span { color: #8394ad; font-size: 11px; white-space: nowrap; }
.pty-m .bar { height: 3px; border-radius: 2px; background: rgba(255,255,255,0.08); margin-top: 4px; overflow: hidden; }
.pty-m .bar i { display: block; height: 100%; background: linear-gradient(90deg, #22c55e, #86efac); }
.pty-m .bar i.low { background: linear-gradient(90deg, #dc2626, #f97316); }
.sp-prompts { position: fixed; left: 50%; top: 160px; transform: translateX(-50%); display: flex; flex-direction: column; gap: 8px; z-index: 2400; }
.sp-card { background: linear-gradient(180deg, rgba(14, 26, 44, 0.97), rgba(8, 14, 26, 0.97)); border: 1px solid rgba(74, 222, 128, 0.45);
  border-radius: 12px; padding: 12px 16px; color: #d6deeb; font: 13px 'Segoe UI', sans-serif; box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  display: flex; align-items: center; gap: 14px; animation: spin .2s ease-out; }
@keyframes spin { from { transform: translateY(-8px); opacity: 0; } }
.sp-card b { color: #86efac; }
.sp-rally { position: fixed; left: 50%; top: calc(50% + 70px); transform: translateX(-50%); display: none; gap: 8px; z-index: 2300; flex-wrap: wrap; justify-content: center; }
.pw { display: flex; flex-direction: column; gap: 1px; color: #b4c2d4; font-size: 11px; }
.pw-h { display: flex; align-items: center; gap: 6px; margin: 4px 0 1px; font: 600 8.5px/1 'Segoe UI', system-ui, sans-serif; letter-spacing: 1.6px; text-transform: uppercase; color: #8b9cb3; }
.pw-h:first-child { margin-top: 0; }
.pw-h::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, rgba(140, 170, 210, 0.3), transparent); }
.pw-h b { color: #b4c2d4; font-weight: 600; letter-spacing: 1px; }
.pw-row { display: flex; align-items: center; gap: 5px; padding: 1px 5px; min-height: 18px; border-radius: 3px; background: rgba(3, 6, 12, 0.4); }
.pw-row .who { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pw-row .who b { color: #e5ecf7; }
.pw-row .who div { color: #8394ad; font-size: 9.5px; line-height: 12px; overflow: hidden; text-overflow: ellipsis; }
.pw-row .sgw-btn { padding: 0 6px; line-height: 14px; font-size: 9.5px; border-radius: 4px; }
.pw-row .bar { height: 2px; border-radius: 1px; background: rgba(255,255,255,0.08); margin-top: 1px; overflow: hidden; }
.pw-row .bar i { display: block; height: 100%; background: linear-gradient(90deg, #22c55e, #86efac); }
.pw-row .bar i.low { background: linear-gradient(90deg, #dc2626, #f97316); }
.pw-inv { display: flex; gap: 4px; margin: 3px 0 1px; }
.pw-inv input { flex: 1; min-width: 0; padding: 1px 6px; font-size: 11px; border-radius: 5px; }
.pw-inv .sgw-btn { padding: 0 8px; line-height: 18px; font-size: 10.5px; border-radius: 5px; }
.pw-empty { color: #8b9cb3; font-size: 10.5px; padding: 1px 2px; }
.pw details { margin-top: 3px; font-size: 10.5px; }
.pw summary { cursor: pointer; color: #8b9cb3; font-size: 10px; }
.pw summary:hover { color: #e5ecf7; }
.pw-perks { margin: 4px 0 0; padding-left: 16px; color: #a9b6c9; line-height: 1.45; font-size: 11px; }
.pw-perks b { color: #86efac; font-weight: 600; }
.pw button:focus-visible, .pw input:focus-visible, .pw summary:focus-visible { outline: 2px solid #6cc8ff; outline-offset: 1px; }`;
    document.head.appendChild(css);
    this.hud = document.createElement('div');
    this.hud.className = 'pty';
    this.hud.dataset.hudAvoid = '1';
    this.prompts = document.createElement('div');
    this.prompts.className = 'sp-prompts';
    this.rally = document.createElement('div');
    this.rally.className = 'sp-rally';
    document.body.append(this.hud, this.prompts, this.rally);
    this.friends = new FriendsPanel({
      send: (m) => this.d.send(m),
      chatTo: (n) => this.d.chatTo(n),
      inParty: (n) => this.party.members.some((m) => m.name.toLowerCase() === n.toLowerCase()),
      canInvite: () => !this.inParty() || this.amLeader(),
    });
  }

  /** The party list's bottom edge on screen (0 while hidden): the side panel keeps below it */
  hudBottom(): number {
    return this.hud.style.display === 'flex' ? this.hud.getBoundingClientRect().bottom : 0;
  }

  /** Party or friends changed (the side panel's tabs redraw) */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Party members other than you (entity ids) */
  memberIds(): Set<number> {
    return new Set(this.party.members.filter((m) => m.eid !== this.d.state.playerId).map((m) => m.eid));
  }

  inParty(): boolean {
    return this.party.members.length > 1;
  }

  isMember(eid: number): boolean {
    return this.party.members.some((m) => m.eid === eid);
  }

  /** Other members, for the map and markers */
  others(): PartyMemberView[] {
    return this.party.members.filter((m) => m.eid !== this.d.state.playerId);
  }

  private amLeader(): boolean {
    return this.party.members.some((m) => m.leader && m.eid === this.d.state.playerId);
  }

  setParty(m: ServerPartyMessage): void {
    const was = this.party.members.length;
    this.party = m;
    if (!was && m.members.length) this.d.sound('ui_open', 0.5);
    this.render();
    for (const fn of this.listeners) fn();
  }

  show(): void { this.visible = true; this.render(); }
  hide(): void { this.visible = false; this.hud.style.display = 'none'; }

  invite(eid: number): void {
    this.d.send({ type: 'partyInvite', id: eid });
  }

  // ---------------------------------------------------------------------------
  // Prompts
  // ---------------------------------------------------------------------------

  onInvite(m: ServerPartyInviteMessage): void {
    this.prompt(`<span><b>${esc(m.from)}</b> invites you to ${m.size > 1 ? `their party (${m.size}/4)` : 'form a party'}</span>`, 'Join', (ok) => this.d.send({ type: 'partyRespond', accept: ok }));
  }

  onFriendRequest(m: ServerFriendRequestMessage): void {
    this.prompt(`<span><b>${esc(m.from)}</b> wants to be friends</span>`, 'Accept', (ok) => this.d.send({ type: 'friendRespond', name: m.from, accept: ok }));
  }

  /** Your friends list, requests and status (the server's) */
  setFriends(m: ServerFriendsMessage): void {
    const first = !this.friends.data.account && m.account;
    this.friends.data = m;
    this.d.friendsOnline(onlineCount(m));
    if (first && m.incoming.length) this.d.message(`${m.incoming.length} friend request${m.incoming.length > 1 ? 's' : ''} waiting. Open the Social tab (${boundKeyName('party', settings.data.bindings)})`, '#7dd3fc');
    for (const fn of this.listeners) fn();
  }

  /** Friend requests waiting for an answer (the Social tab's badge) */
  requests(): number {
    return this.friends.data.incoming.length;
  }

  /** Friends online, of how many */
  friendsLine(): string {
    return this.friends.data.account ? `${onlineCount(this.friends.data)} of ${this.friends.data.friends.length} friends online` : 'Signed out';
  }

  onTradeRequest(m: ServerTradeRequestMessage): void {
    this.prompt(`<span><b>${esc(m.from)}</b> wants to trade with you</span>`, 'Trade', (ok) => this.d.send({ type: 'tradeRespond', accept: ok }));
  }

  private prompt(html: string, yes: string, answer: (ok: boolean) => void): void {
    this.d.sound('scan_ping', 0.5);
    const card = document.createElement('div');
    card.className = 'sp-card';
    card.innerHTML = `${html}<button class="sgw-btn good">${yes}</button><button class="sgw-btn">Decline</button>`;
    const [a, b] = card.querySelectorAll('button');
    let done = false;
    const close = (ok: boolean | null) => {
      if (done) return;
      done = true;
      card.remove();
      if (ok !== null) answer(ok);
    };
    a.addEventListener('click', () => close(true));
    b.addEventListener('click', () => close(false));
    setTimeout(() => close(null), 45_000);
    this.prompts.appendChild(card);
  }

  // ---------------------------------------------------------------------------
  // Rally (destroyed)
  // ---------------------------------------------------------------------------

  showRally(on: boolean): void {
    const others = this.others().filter((m) => m.alive);
    if (!on || !others.length) { this.rally.style.display = 'none'; return; }
    this.rally.replaceChildren();
    const home = document.createElement('button');
    home.className = 'sgw-btn';
    home.textContent = `Respawn at home (${boundKeyName('respawn', settings.data.bindings)})`;
    home.onclick = () => this.d.send({ type: 'respawn', ...backupPicker.choice() });
    this.rally.appendChild(home);
    for (const m of others) {
      const b = document.createElement('button');
      b.className = 'sgw-btn good';
      b.textContent = `Rally with ${m.name} · ${sysName(m.system)}`;
      b.title = 'Respawn beside them (if they are not in a fight)';
      b.onclick = () => this.d.send({ type: 'respawn', rally: m.name, ...backupPicker.choice() });
      this.rally.appendChild(b);
    }
    this.rally.style.display = 'flex';
  }

  // ---------------------------------------------------------------------------
  // HUD panel
  // ---------------------------------------------------------------------------

  private render(): void {
    const ms = this.party.members;
    if (!this.visible || ms.length < 2) { this.hud.style.display = 'none'; return; }
    this.hud.style.display = 'flex';
    const me = ms.find((m) => m.eid === this.d.state.playerId);
    const wing = me && me.wing > 1 ? `<b>WING +${Math.round((me.wing - 1) * 100)}%</b>` : '';
    this.hud.innerHTML = `<div class="pty-h"><span>PARTY</span>${wing}</div>` + ms.map((m) => {
      const here = m.system === this.d.state.systemId;
      return `<div class="pty-m${m.alive ? '' : ' dead'}" data-n="${esc(m.name)}" title="Click for options">
        <div class="n"><b>${m.leader ? '★ ' : ''}${esc(m.name)}</b><span>L${m.level}${m.alive ? (here ? '' : ` · ${esc(sysName(m.system))}`) : ' · down'}</span></div>
        <div class="bar"><i class="${m.hull < 35 ? 'low' : ''}" style="width:${m.alive ? m.hull : 0}%"></i></div></div>`;
    }).join('');
    this.hud.querySelectorAll<HTMLElement>('.pty-m').forEach((el) => {
      el.onclick = (e) => this.memberMenu(ms.find((m) => m.name === el.dataset.n)!, e.clientX, e.clientY);
    });
  }

  private memberMenu(m: PartyMemberView, x: number, y: number): void {
    const self = m.eid === this.d.state.playerId;
    const items: { label: string; run: () => void; bad?: boolean }[] = [];
    if (!self && m.alive) {
      items.push({ label: 'Fly to them (autopilot)', run: () => this.d.flyTo({ kind: 'player', id: m.eid, system: m.system, name: m.name }) });
      if (m.system === this.d.state.systemId) items.push({ label: 'Trade', run: () => this.d.send({ type: 'tradeRequest', id: m.eid }) });
    }
    if (!self && this.amLeader()) {
      items.push({ label: 'Make leader', run: () => this.d.send({ type: 'partyPromote', name: m.name }) });
      items.push({ label: 'Remove from party', bad: true, run: () => this.d.send({ type: 'partyKick', name: m.name }) });
    }
    if (self) items.push({ label: 'Leave party', bad: true, run: () => this.d.send({ type: 'partyLeave' }) });
    items.push({ label: 'Party tab', run: () => this.d.openTab('party') });
    openMenu(x, y, items);
  }

  // ---------------------------------------------------------------------------
  // The side panel's Party tab
  // ---------------------------------------------------------------------------

  /** Your party (or how to start one), invite by name, the pilots nearby, and what a party gives you */
  renderParty(into: HTMLElement): void {
    into.replaceChildren();
    const root = document.createElement('div');
    root.className = 'pw';
    const head = (html: string) => { const h = document.createElement('div'); h.className = 'pw-h'; h.innerHTML = html; root.appendChild(h); };
    const btn = (label: string, cls: string, run: (e: MouseEvent) => void, aria?: string) => {
      const b = document.createElement('button');
      b.className = `sgw-btn${cls ? ` ${cls}` : ''}`;
      b.textContent = label;
      if (aria) b.setAttribute('aria-label', aria);
      b.onclick = run;
      return b;
    };
    // Your party
    if (this.inParty()) {
      const me = this.party.members.find((m) => m.eid === this.d.state.playerId);
      head(`Party <b>${this.party.members.length}/4</b>${me && me.wing > 1 ? ` <b style="color:#fde68a">wing +${Math.round((me.wing - 1) * 100)}%</b>` : ''}`);
      for (const m of this.party.members) {
        const row = document.createElement('div');
        row.className = 'pw-row';
        row.innerHTML = `<div class="who"><b>${m.leader ? '★ ' : ''}${esc(m.name)}</b> <span style="color:#8394ad">L${m.level}</span>
          <div>${m.alive ? `${esc(m.ship || 'Ship')} · ${esc(sysName(m.system))}` : 'Destroyed'}</div>
          <div class="bar"><i class="${m.hull < 35 ? 'low' : ''}" style="width:${m.alive ? m.hull : 0}%"></i></div></div>`;
        row.appendChild(btn('⋯', '', (e) => this.memberMenu(m, e.clientX, e.clientY), `Options: ${m.name}`));
        root.appendChild(row);
      }
    } else {
      head('Party');
      root.insertAdjacentHTML('beforeend', '<div class="pw-empty">Flying solo. Invite a pilot nearby, or by name.</div>');
    }
    // Invite by name
    const inv = document.createElement('div');
    inv.className = 'pw-inv';
    inv.innerHTML = '<input class="sgw-input" placeholder="Pilot name" maxlength="40" aria-label="Pilot name to invite"><button class="sgw-btn primary">Invite</button>';
    const input = inv.querySelector('input')!;
    const go = () => { const n = input.value.trim(); if (n) { this.d.send({ type: 'partyInvite', name: n }); input.value = ''; } };
    inv.querySelector('button')!.onclick = go;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    root.appendChild(inv);
    if (this.inParty()) {
      const leave = btn('Leave party', '', () => this.d.send({ type: 'partyLeave' }));
      leave.style.cssText = 'align-self: flex-start; padding: 0 8px; line-height: 16px; font-size: 10px; border-radius: 5px; margin-top: 1px;';
      root.appendChild(leave);
    }
    // Pilots nearby
    const me = this.d.state.entities.get(this.d.state.playerId);
    const near = [...this.d.state.entities.values()].filter((e) => e.type === EntityType.Player && e.id !== this.d.state.playerId)
      .map((e) => ({ e, d: me ? Math.hypot(e.renderX - me.renderX, e.renderY - me.renderY) : 0 })).sort((a, b) => a.d - b.d);
    head(`Nearby <b>${near.length}</b>`);
    if (!near.length) root.insertAdjacentHTML('beforeend', '<div class="pw-empty">Nobody else in this system right now.</div>');
    for (const { e, d } of near.slice(0, 8)) {
      const name = e.name ?? 'Pilot';
      const row = document.createElement('div');
      row.className = 'pw-row';
      row.innerHTML = `<div class="who"><b>${esc(name)}</b> <span style="color:#8394ad; font-size:10.5px">${(d / 1000).toFixed(1)} km${this.isMember(e.id) ? ' · party' : ''}</span></div>`;
      if (!this.isMember(e.id)) row.appendChild(btn('Invite', 'primary', () => this.invite(e.id), `Invite ${name}`));
      row.appendChild(btn('⋯', '', (ev) => openMenu(ev.clientX, ev.clientY, [
        { label: 'Trade (within 2.5 km)', run: () => this.d.send({ type: 'tradeRequest', id: e.id }) },
        { label: 'Fly to them (autopilot)', run: () => this.d.flyTo({ kind: 'player', id: e.id, system: this.d.state.systemId, name }) },
      ]), `Options: ${name}`));
      root.appendChild(row);
    }
    if (near.length > 8) root.insertAdjacentHTML('beforeend', `<div class="pw-empty">and ${near.length - 8} more further out</div>`);
    root.insertAdjacentHTML('beforeend', `<details${this.perksOpen ? ' open' : ''}><summary>What a party gives you</summary><ul class="pw-perks">
      <li><b>Shared kills:</b> a kill counts for everyone in the party within 8 km, for jobs and bounties too, with a share of XP and credits</li>
      <li><b>Wing bonus:</b> each wingmate within 3 km adds 8% weapon damage and mining yield</li>
      <li><b>Fleet operations:</b> party jobs on station boards (uplinks, convoys, sieges) that need two or more pilots</li>
      <li><b>Rally:</b> when you're destroyed, respawn beside a party member who isn't in a fight</li>
      <li><b>Map and markers:</b> see your party anywhere, and autopilot to them</li>
      <li><b>Party chat:</b> start a chat line with /p</li>
      <li>Hover over a ship to see who flies it, and press ${boundKeyName('party', settings.data.bindings)} to invite them</li></ul></details>`);
    root.querySelector('details')!.addEventListener('toggle', (e) => { this.perksOpen = (e.currentTarget as HTMLDetailsElement).open; });
    into.appendChild(root);
  }
}
