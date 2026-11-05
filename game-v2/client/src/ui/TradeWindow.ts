/**
 * Trading with another pilot: your offer on the left (click items in your hold
 * below to add them), theirs on the right, credits on both. Both accept and the
 * swap happens at once; any change to either offer clears both acceptances.
 * What you receive goes to storage.
 */

import type { Bag, ClientMessage, ServerTradeMessage, Stack } from '@space-game/common';
import type { PilotState } from '../econ/clientEcon';
import { GameWindow, ItemGrid } from './windowKit';

function esc(t: string): string {
  return t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const toStacks = (b: Bag): Stack[] => Object.entries(b).map(([id, n]) => ({ id, n }));

export class TradeWindow {
  private win: GameWindow;
  private state: ServerTradeMessage | null = null;
  private mine: ItemGrid;
  private theirs: ItemGrid;
  private hold: ItemGrid;
  private credits: HTMLInputElement;
  private theirCredits: HTMLDivElement;
  private status: HTMLDivElement;
  private accept: HTMLButtonElement;
  private mineHead: HTMLHeadingElement;
  private theirHead: HTMLHeadingElement;

  constructor(private pilot: PilotState, private send: (m: ClientMessage) => void, private sound: (id: string) => void) {
    this.win = new GameWindow('Trade');
    this.win.root.style.width = 'min(900px, calc(100vw - 32px))';
    this.win.onClose = () => { if (this.state?.open) this.send({ type: 'tradeCancel' }); };
    const econ = pilot.econ;
    this.mine = new ItemGrid({ econ, zone: 'trade-mine', empty: 'Click items in your hold below to offer them',
      onClick: (id, e) => this.change(id, -(e.shiftKey ? 10 : 1)), onContext: (id) => this.change(id, -Infinity),
      hint: () => 'Click: take one back · Shift: ten · Right-click: all' });
    this.theirs = new ItemGrid({ econ, zone: 'trade-theirs', empty: 'Nothing offered yet' });
    this.hold = new ItemGrid({ econ, zone: 'trade-hold', empty: 'Your hold is empty',
      onClick: (id, e) => this.change(id, e.shiftKey ? 10 : 1), onContext: (id) => this.change(id, Infinity),
      hint: () => 'Click: offer one · Shift: ten · Right-click: all of them' });
    const b = this.win.body;
    b.innerHTML = `<div style="display:grid; grid-template-columns: 1fr 1fr; gap: 14px">
      <div class="sgw-col"><h4 data-h="mine">Your offer</h4><div data-g="mine"></div>
        <div style="display:flex; align-items:center; gap:8px; margin-top:8px">Credits <input class="sgw-input" type="number" min="0" step="10" value="0" style="width:120px"></div></div>
      <div class="sgw-col"><h4 data-h="theirs">Their offer</h4><div data-g="theirs"></div><div data-c="theirs" style="margin-top:12px; color:#fbbf24"></div></div>
    </div>
    <div class="sgw-col" style="margin-top:12px"><h4>Your hold <span class="r">plus storage when you're at a station</span></h4><div data-g="hold"></div></div>
    <div style="display:flex; align-items:center; gap:12px; margin-top:12px"><div data-s style="flex:1; color:#a9b6c9"></div>
      <button class="sgw-btn" data-a="cancel">Cancel</button><button class="sgw-btn good" data-a="accept">Accept trade</button></div>`;
    b.querySelector('[data-g="mine"]')!.replaceWith(this.mine.el);
    b.querySelector('[data-g="theirs"]')!.replaceWith(this.theirs.el);
    b.querySelector('[data-g="hold"]')!.replaceWith(this.hold.el);
    this.mine.el.style.minHeight = this.theirs.el.style.minHeight = '120px';
    this.hold.el.style.minHeight = '90px';
    this.hold.el.style.maxHeight = '190px';
    this.credits = b.querySelector('input')!;
    this.theirCredits = b.querySelector('[data-c="theirs"]')!;
    this.status = b.querySelector('[data-s]')!;
    this.accept = b.querySelector('[data-a="accept"]')!;
    this.mineHead = b.querySelector('[data-h="mine"]')!;
    this.theirHead = b.querySelector('[data-h="theirs"]')!;
    this.credits.addEventListener('change', () => this.offer(this.state?.mine.items ?? {}));
    this.accept.onclick = () => { this.send({ type: 'tradeAccept' }); this.sound('ui_click'); };
    (b.querySelector('[data-a="cancel"]') as HTMLButtonElement).onclick = () => this.win.close();
    pilot.onChange(() => { if (this.win.isOpen) this.renderHold(); });
  }

  get isOpen(): boolean {
    return this.win.isOpen;
  }

  close(): void {
    this.win.close();
  }

  onTrade(m: ServerTradeMessage): void {
    const was = this.state?.open;
    this.state = m;
    if (!m.open) {
      if (this.win.isOpen) { this.state = null; this.win.close(); }
      return;
    }
    if (!was) { this.win.open(); this.sound('ui_open'); this.credits.value = '0'; }
    this.win.sub.textContent = `with ${m.with}`;
    this.mine.render(toStacks(m.mine.items));
    this.theirs.render(toStacks(m.theirs.items));
    if (document.activeElement !== this.credits) this.credits.value = String(m.mine.credits);
    this.theirCredits.textContent = m.theirs.credits ? `+ ${m.theirs.credits.toLocaleString()} credits` : '';
    this.mineHead.innerHTML = `Your offer${m.myAccept ? ' <span class="r" style="color:#86efac">✓ accepted</span>' : ''}`;
    this.theirHead.innerHTML = `${esc(m.with)}'s offer${m.theirAccept ? ' <span class="r" style="color:#86efac">✓ accepted</span>' : ''}`;
    this.status.textContent = m.myAccept && !m.theirAccept ? `Waiting for ${m.with} to accept…`
      : m.theirAccept && !m.myAccept ? `${m.with} has accepted. Check their offer, then accept to trade.`
      : 'Both pilots must accept. Changing an offer clears both acceptances.';
    this.accept.classList.toggle('off', m.myAccept);
    this.renderHold();
  }

  private renderHold(): void {
    const offered = this.state?.mine.items ?? {};
    const have = new Map<string, number>();
    for (const s of this.pilot.cargo) have.set(s.id, (have.get(s.id) ?? 0) + s.n);
    if (this.pilot.atStation) for (const s of this.pilot.storage) have.set(s.id, (have.get(s.id) ?? 0) + s.n);
    const left: Stack[] = [];
    for (const [id, n] of have) if (n - (offered[id] ?? 0) > 0) left.push({ id, n: n - (offered[id] ?? 0) });
    this.hold.render(left);
  }

  private change(id: string, k: number): void {
    const cur = { ...(this.state?.mine.items ?? {}) };
    const have = this.pilot.cargo.filter((s) => s.id === id).reduce((t, s) => t + s.n, 0)
      + (this.pilot.atStation ? this.pilot.storage.filter((s) => s.id === id).reduce((t, s) => t + s.n, 0) : 0);
    const n = Math.max(0, Math.min(have, (cur[id] ?? 0) + (Number.isFinite(k) ? k : k > 0 ? have : -Infinity)));
    if (n > 0) cur[id] = n; else delete cur[id];
    this.offer(cur);
    this.sound('ui_click');
  }

  private offer(items: Bag): void {
    this.send({ type: 'tradeOffer', items, credits: Math.max(0, Math.floor(Number(this.credits.value) || 0)) });
  }
}
