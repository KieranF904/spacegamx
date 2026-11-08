/**
 * A moon siege's panel (server: server/src/game/sieges/), at the side while
 * you're on the moon. Always: the party's supplies and your haul.
 *
 * By day: patching, the turret pads (pick an empty one and what to build on
 * it; upgrade, scrap or give orders to what's on one), a free refit, last
 * night's summary, who's ready, your own Ready button (the night comes when
 * everyone down here is ready), and Claim & leave. Scrapping and claiming ask
 * twice.
 *
 * At night: the turrets (hull, kills tonight, orders, how far a mend has got),
 * building on an empty pad you're close to (dearer), focus fire on your
 * target (the focus key, or the button), and how mending works.
 *
 * It also runs the night's HUD (siege/NightHud.ts) and the dusk and dawn
 * cards (siege/SiegeCards.ts), and gives the nav markers the fronts on their
 * way (`markers`).
 */

import type { ClientMessage, ServerSiegeStateMessage } from '@space-game/common';
import { NightHud } from './siege/NightHud';
import { SiegeCards } from './siege/SiegeCards';
import { focusState, frontMarkers, nextOrders, padName, padsInReach, type BastionLayout } from './siege/siegeView';
import { siegeFeed } from '../rendering/surface/siege/siegeFeed';
import { TURRET_DEFAULT, TURRET_LOOKS } from '../rendering/surface/siege/siegeLook';
import { esc } from './escape';


let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.sg { position: fixed; right: 12px; top: 50%; transform: translateY(-50%); width: 280px; z-index: 950; display: none;
  background: linear-gradient(180deg, rgba(14, 22, 40, 0.94), rgba(7, 12, 24, 0.94)); border: 1px solid rgba(125, 211, 252, 0.3); border-radius: 12px;
  box-shadow: 0 16px 50px rgba(0,0,0,0.5); color: #d6deeb; font: 12px 'Segoe UI', system-ui, sans-serif; overflow: hidden; }
.sg.on { display: block; }
/* The jobs tracker makes way while the siege is on */
body.sg-open .qt { visibility: hidden; }
.sg.night { border-color: rgba(248, 113, 113, 0.45); }
.sg-h { padding: 10px 14px 8px; border-bottom: 1px solid rgba(140, 170, 220, 0.14); background: linear-gradient(180deg, rgba(125, 211, 252, 0.09), transparent); }
.sg.night .sg-h { background: linear-gradient(180deg, rgba(248, 113, 113, 0.14), transparent); border-bottom-color: rgba(248, 113, 113, 0.2); }
.sg.night { box-shadow: 0 16px 50px rgba(0,0,0,0.5), 0 0 24px rgba(239, 68, 68, 0.12); }
.sg-t { font: 700 11px 'Segoe UI', sans-serif; letter-spacing: 3px; text-transform: uppercase; color: #7dd3fc; }
.sg.night .sg-t { color: #fca5a5; }
.sg-s { margin-top: 2px; color: #8fa0b8; }
.sg-prof { margin-bottom: 8px; font-size: 12px; color: #c8d3e3; }
.sg-prof small { display: block; margin-top: 2px; color: #8fa0b8; line-height: 1.35; }
.sg-boss { margin-bottom: 8px; padding: 6px 8px; border-radius: 6px; background: rgba(248, 113, 113, 0.1); border: 1px solid rgba(248, 113, 113, 0.35); color: #fca5a5; font-size: 12px; }
.sg-b { padding: 10px 14px 12px; max-height: calc(100vh - 150px); overflow-y: auto; }
.sg-haul { margin: -2px 0 8px; padding: 7px 9px; border-radius: 8px; background: rgba(253, 230, 138, 0.06); border: 1px solid rgba(253, 230, 138, 0.18); }
.sg-haul b { color: #fde68a; }
.sg-haul small { display: block; margin-top: 2px; color: #8394ad; font-size: 10.5px; }
.sg-haul .x { color: #86efac; font-weight: 600; }
.sg-last { margin: 0 0 8px; padding: 6px 9px; border-radius: 8px; background: rgba(125, 211, 252, 0.05); border: 1px solid rgba(125, 211, 252, 0.16); color: #a9b8cc; font-size: 11px; }
.sg-last b { color: #e2e8f0; }
.sg-last .p { color: #86efac; }
.sg-pad { margin: 4px 0; padding: 5px 4px 5px 9px; border-radius: 8px; border: 1px solid rgba(140, 170, 220, 0.16); }
.sg-pad .row { display: flex; align-items: center; gap: 5px; }
.sg-pad .n { flex: 1; min-width: 0; }
.sg-pad .n small { display: block; color: #8394ad; font-size: 10.5px; }
.sg-pad.built { border-left: 3px solid var(--k, #7dd3fc); background: linear-gradient(90deg, color-mix(in srgb, var(--k, #7dd3fc) 9%, transparent), transparent 60%); }
.sg-pad .pip { display: inline-block; width: 6px; height: 6px; margin-left: 3px; border-radius: 50%; background: var(--k, #7dd3fc); box-shadow: 0 0 6px var(--k, #7dd3fc); vertical-align: 1px; }
.sg-pad.empty { color: #8394ad; border-style: dashed; }
.sg-pad.lost { border-color: rgba(248, 113, 113, 0.35); }
.sg-pad.pick { border-color: rgba(125, 211, 252, 0.6); background: rgba(125, 211, 252, 0.06); }
.sg-pad .kinds { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin: 6px 4px 2px 0; }
.sg-pad .hb { height: 3px; margin-top: 3px; border-radius: 2px; background: rgba(255,255,255,0.08); overflow: hidden; }
.sg-pad .hb > i { display: block; height: 100%; background: #4ade80; }
.sg-pad .hb > i.mid { background: #fbbf24; }
.sg-pad .hb > i.low { background: #f87171; }
.sg-pad .mend { height: 3px; margin-top: 2px; border-radius: 2px; background: rgba(125, 211, 252, 0.12); overflow: hidden; }
.sg-pad .mend > i { display: block; height: 100%; background: #7dd3fc; }
.sg-mini { padding: 4px 7px; border-radius: 6px; cursor: pointer; font: 600 11px 'Segoe UI', sans-serif; white-space: nowrap;
  border: 1px solid rgba(140, 170, 220, 0.3); background: rgba(255,255,255,0.03); color: #d6deeb; }
.sg-mini:hover { border-color: rgba(125, 211, 252, 0.6); background: rgba(125, 211, 252, 0.1); }
.sg-mini:disabled { opacity: 0.4; cursor: default; background: none; }
.sg-mini.up { color: #fde68a; }
.sg-mini.ord { color: #a5f3fc; font-weight: 500; }
.sg-mini.kind { text-align: left; display: flex; justify-content: space-between; }
.sg-mini.kind span { color: #fde68a; }
.sg-mini.armed, .sg-claim.armed { border-color: #f87171; color: #fca5a5; background: rgba(248, 113, 113, 0.12); }
.sg-claim { width: 100%; margin-top: 6px; padding: 8px; border-radius: 9px; cursor: pointer; font: 600 12px 'Segoe UI', sans-serif;
  border: 1px solid rgba(253, 230, 138, 0.4); background: rgba(253, 230, 138, 0.08); color: #fde68a; }
.sg-claim:hover { background: rgba(253, 230, 138, 0.16); }
.sg-sup { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.sg-sup b { font-size: 18px; color: #fde68a; font-weight: 700; }
.sg-item { display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box; margin: 4px 0; padding: 6px 9px; border-radius: 8px; cursor: pointer;
  border: 1px solid rgba(140, 170, 220, 0.22); background: rgba(255,255,255,0.02); color: #d6deeb; font: inherit; text-align: left; }
.sg-item:hover { background: rgba(125, 211, 252, 0.1); border-color: rgba(125, 211, 252, 0.5); }
.sg-item:disabled { opacity: 0.4; cursor: default; background: none; border-color: rgba(140, 170, 220, 0.15); }
.sg-item .n { flex: 1; }
.sg-item .n small { display: block; color: #8394ad; font-size: 10.5px; }
.sg-item .c { color: #fde68a; font-weight: 600; }
.sg-item.focus { border-color: rgba(125, 211, 252, 0.45); }
.sg-sec { margin: 10px 0 4px; color: #8394ad; font-size: 10.5px; letter-spacing: 1.5px; text-transform: uppercase; }
.sg-hint { color: #8394ad; font-size: 10.5px; line-height: 1.4; margin: 4px 0; }
.sg-who { display: flex; flex-wrap: wrap; gap: 4px; }
.sg-who span { padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,0.05); color: #8fa0b8; }
.sg-who span.r { background: rgba(74, 222, 128, 0.16); color: #86efac; }
.sg-ready { width: 100%; margin-top: 10px; padding: 10px; border-radius: 9px; cursor: pointer; font: 700 13px 'Segoe UI', sans-serif; letter-spacing: 1px;
  border: 1px solid #2e8a5a; background: #1f5f3f; color: #fff; }
.sg-ready:hover { background: #267a50; }
.sg-ready.on { background: rgba(255,255,255,0.04); border-color: rgba(140, 170, 220, 0.3); color: #8fa0b8; font-weight: 600; }
`;
  document.head.appendChild(css);
}

const fmt = (n: number) => Math.round(n).toLocaleString();

/** What the panel reads from the game (all optional: without them it shows less) */
export interface SiegePanelHost {
  /** The server tick now (countdowns) */
  tick(): number;
  /** Your current target (0: none) */
  target(): number;
  /** Where your ship is */
  me(): { x: number; y: number } | null;
  /** This moon's bastion and its pads (systems data) */
  bastion(): BastionLayout | null;
  /** The focus key's name, for the hints */
  focusKey(): string;
}

type Action = 'ready' | 'unready' | 'refit' | 'buy' | 'upgrade' | 'scrap' | 'claim' | 'orders' | 'focus';

export class SiegePanel {
  private el = document.createElement('div');
  private last = '';
  private msg: ServerSiegeStateMessage | null = null;
  /** A scrap or claim clicked once: it asks again (which button, and until when) */
  private armed: { key: string; until: number } | null = null;
  /** The empty pad picked to build on (by day), -1 none */
  private picked = -1;
  /** The pad row under the mouse (-1 none): for the ground's range rings */
  hovered = -1;
  private host: SiegePanelHost;
  private hud: NightHud;
  private cards = new SiegeCards();
  private timer = 0;

  constructor(private send: (m: ClientMessage) => void, host: Partial<SiegePanelHost> = {}) {
    this.host = { tick: () => 0, target: () => 0, me: () => null, bastion: () => null, focusKey: () => '6', ...host };
    this.hud = new NightHud(() => this.host.tick(), () => this.host.bastion(), () => this.host.focusKey());
    // (the bastion's ground reads the state and the pad in focus from here)
    siegeFeed.padFocus = () => this.padFocus;
    siegeFeed.tick = () => this.host.tick();
    injectStyles();
    this.el.className = 'sg';
    // Clicks here aren't shots
    this.el.addEventListener('mousedown', (e) => e.stopPropagation());
    this.el.addEventListener('mouseover', (e) => {
      const row = (e.target as HTMLElement).closest('[data-row]') as HTMLElement | null;
      this.hovered = row ? Number(row.dataset.row) : -1;
    });
    this.el.addEventListener('mouseleave', () => { this.hovered = -1; });
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
      if (!b || (b as HTMLButtonElement).disabled) return;
      const a = b.dataset.a as Action | 'pick';
      const pad = b.dataset.pad !== undefined ? Number(b.dataset.pad) : undefined;
      if (a === 'pick') { this.picked = this.picked === pad ? -1 : pad ?? -1; this.render(true); return; }
      if (a === 'focus') { this.focus(); return; }
      if (a === 'scrap' || a === 'claim') {
        const key = `${a}:${pad ?? ''}`;
        if (this.armed?.key !== key || performance.now() > this.armed.until) {
          this.armed = { key, until: performance.now() + 3000 };
          this.render(true);
          setTimeout(() => { if (this.armed?.key === key && performance.now() > this.armed.until) { this.armed = null; this.render(true); } }, 3100);
          return;
        }
        this.armed = null;
      }
      if (a === 'buy') this.picked = -1;
      this.send({ type: 'siege', action: a, item: b.dataset.item, pad });
    });
    document.body.appendChild(this.el);
  }

  get isOpen(): boolean {
    return this.el.classList.contains('on');
  }

  update(m: ServerSiegeStateMessage): void {
    siegeFeed.msg = m.active ? m : null;
    this.cards.update(m.active ? m : null);
    this.hud.update(m.active ? m : null);
    if (!m.active) { this.hide(); return; }
    if (this.msg?.phase !== m.phase) this.picked = -1;
    this.msg = m;
    this.render(false);
    // At night the panel follows you round the pads (what you can build) and the focus fire's countdown
    const night = m.phase === 'night' || m.phase === 'dusk';
    if (night && !this.timer) this.timer = window.setInterval(() => this.render(false), 300);
    if (!night && this.timer) { clearInterval(this.timer); this.timer = 0; }
  }

  /** Pick an empty pad to build on (a click on the ground could call this) */
  selectPad(pad: number): void {
    if (this.msg?.phase !== 'day' || !this.msg.turrets || this.msg.turrets[pad] !== null) return;
    this.picked = pad;
    this.render(true);
  }

  /** The pad picked in the panel, or under the mouse there (-1 none): for range rings on the ground */
  get padFocus(): number {
    return this.hovered >= 0 ? this.hovered : this.picked;
  }

  /** Fronts on their way, for the nav markers (edge arrows with a countdown) */
  markers(): { name: string; x: number; y: number }[] {
    return frontMarkers(this.msg, this.host.tick());
  }

  /** At night: the turrets in reach focus on your target. True if the key was the siege's (on the moon at night) */
  focus(): boolean {
    const m = this.msg;
    if (!m?.active || m.phase !== 'night') return false;
    const target = this.host.target();
    this.send({ type: 'siege', action: 'focus', target: target || -1 });
    return true;
  }

  private render(force: boolean): void {
    const m = this.msg;
    if (!m) return;
    const now = this.host.tick();
    const day = m.phase === 'day';
    const night = m.phase === 'night' || m.phase === 'dusk';
    const b = this.host.bastion();
    const reach = night ? padsInReach(m, b, this.host.me()) : [];
    const fs = night ? focusState(m, now) : null;
    const key = JSON.stringify(m) + (this.armed?.key ?? '') + this.picked + reach.join() + JSON.stringify(fs) + (this.host.target() ? 1 : 0);
    if (!force && key === this.last) return;
    this.last = key;
    const armed = (k: string) => this.armed?.key === k;
    const supplies = m.supplies ?? 0;
    this.el.classList.add('on');
    document.body.classList.add('sg-open');
    this.el.classList.toggle('night', !day);
    const title = day ? `Day ${(m.wave ?? 0) + 1}` : m.phase === 'dusk' ? `Night ${m.wave} is falling` : m.phase === 'night' ? `Night ${m.wave}` : 'The bastion has fallen';
    const sub = day ? 'Rest, repair and build. The night comes when everyone is ready.' : m.phase === 'lost' ? 'Back to orbit shortly.' : 'Hold the bastion until dawn.';
    let body = '';
    // This moon's siege, and (by day) a boss coming tonight
    if (m.profile && day) body += `<div class="sg-prof"><b>${esc(m.profile.name)}</b><small>${esc(m.profile.about)}</small></div>`;
    if (m.nextBoss && day) body += `<div class="sg-boss">Tonight: <b>${esc(m.nextBoss)}</b> comes with the dark</div>`;
    body += `<div class="sg-sup"><span>Party supplies</span><b>${supplies}</b></div>`;
    const h = m.haul;
    if (h) {
      const bonus = h.bonus > 1 ? ` <span class="x">×${h.bonus}</span>` : '';
      body += `<div class="sg-haul">Your haul: <b>${fmt(h.credits)} cr</b> · <b>${fmt(h.xp)} XP</b>${bonus}`
        + `<small>${h.nights} night${h.nights === 1 ? '' : 's'} held · ×${h.nextBonus} if you hold to night ${h.nextBonusAt} · half if the bastion falls</small></div>`;
    }
    const s = m.summary;
    if (day && s) {
      body += `<div class="sg-last">Night ${s.night}: <b>${s.kills}</b> shot down (you ${s.yourKills}) · score <b>${s.score}</b>`
        + (s.streak ? ` · <span class="p">${s.streak} perfect in a row</span>` : '') + `</div>`;
    }
    if (day) body += this.dayBody(m, b, armed);
    else if (night) body += this.nightBody(m, b, reach, fs);
    this.el.innerHTML = `<div class="sg-h"><div class="sg-t">${esc(m.title ?? 'Siege')} · ${esc(title)}</div><div class="sg-s">${esc(sub)}</div></div><div class="sg-b">${body}</div>`;
  }

  private ordersButton(m: ServerSiegeStateMessage, i: number, orders: string | undefined): string {
    const label = m.orders?.find((o) => o.id === orders)?.label ?? 'Nearest';
    const next = nextOrders(m.orders, orders);
    return next ? `<button class="sg-mini ord" data-a="orders" data-pad="${i}" data-item="${esc(next)}" title="What it fires on first: click for the next">◎ ${esc(label)}</button>` : '';
  }

  /** A built pad's row attributes: its kind's colour (the same as its emplacement and reach ring on the ground) */
  private kindStyle(kind: string | undefined): string {
    return `style="--k:#${(TURRET_LOOKS[kind ?? ''] ?? TURRET_DEFAULT).toString(16).padStart(6, '0')}"`;
  }

  private pips(mark: number): string {
    return '<span class="pip"></span>'.repeat(Math.max(0, mark));
  }

  private hullBar(hull: number, mend?: number): string {
    const cls = hull < 35 ? 'low' : hull < 70 ? 'mid' : '';
    return `<div class="hb"><i class="${cls}" style="width:${Math.max(0, Math.min(100, hull))}%"></i></div>`
      + (mend ? `<div class="mend"><i style="width:${Math.round(mend * 100)}%"></i></div>` : '');
  }

  private dayBody(m: ServerSiegeStateMessage, b: BastionLayout | null, armed: (k: string) => boolean): string {
    const supplies = m.supplies ?? 0;
    let body = `<div class="sg-sec">Build</div>`;
    const kinds = (m.shop ?? []).filter((s) => s.id.startsWith('turret_'));
    for (const s of (m.shop ?? []).filter((x) => !x.id.startsWith('turret_'))) {
      body += `<button class="sg-item" data-a="buy" data-item="${esc(s.id)}"${supplies >= s.cost ? '' : ' disabled'}><span class="n">${esc(s.label)}<small>${esc(s.note)}</small></span><span class="c">${s.cost}</span></button>`;
    }
    const pads = m.turrets ?? [];
    if (pads.length) {
      body += `<div class="sg-sec">Turret pads · ${m.pads?.free ?? 0}/${m.pads?.total ?? pads.length} free</div>`;
      body += pads.map((t, i) => {
        const name = padName(b, i);
        if (!t) {
          const pick = this.picked === i;
          const lost = m.padsLost?.includes(i) ? ' lost' : '';
          let row = `<div class="sg-pad empty${pick ? ' pick' : ''}${lost}" data-row="${i}"><div class="row"><span class="n">${esc(name)}<small>empty${lost ? ' · scorched' : ''}</small></span>`
            + `<button class="sg-mini" data-a="pick" data-pad="${i}">${pick ? 'Cancel' : 'Build ▾'}</button></div>`;
          if (pick) {
            row += `<div class="kinds">${kinds.map((k) => `<button class="sg-mini kind" data-a="buy" data-item="${esc(k.id)}" data-pad="${i}" title="${esc(k.note)}"${supplies >= k.cost ? '' : ' disabled'}>${esc(k.label.replace(/ turret$/i, ''))}<span>${k.cost}</span></button>`).join('')}</div>`;
          }
          return row + '</div>';
        }
        const up = t.upgrade !== undefined
          ? `<button class="sg-mini up" data-a="upgrade" data-pad="${i}"${supplies >= t.upgrade ? '' : ' disabled'} title="Upgrade to the next mark (full hull)">▲ ${t.upgrade}</button>`
          : '';
        const scrap = `<button class="sg-mini${armed(`scrap:${i}`) ? ' armed' : ''}" data-a="scrap" data-pad="${i}" title="Scrap it for half what it cost">${armed(`scrap:${i}`) ? 'Sure?' : `✕ +${t.refund}`}</button>`;
        return `<div class="sg-pad built" data-row="${i}" ${this.kindStyle(t.kind)}><div class="row"><span class="n">${esc(t.label)}${this.pips(t.mark)}<small>${esc(name)} · hull ${t.hull}%${t.range ? ` · reach ${t.range}` : ''}${t.upgrade === undefined ? ' · max mark' : ''}</small></span>${up}${scrap}</div>`
          + `${this.hullBar(t.hull)}<div class="row" style="margin-top:4px">${this.ordersButton(m, i, t.orders)}</div></div>`;
      }).join('');
    }
    body += `<div class="sg-sec">Ship</div>`;
    body += `<button class="sg-item" data-a="refit"><span class="n">Refit your ship<small>Mend every part, free by day</small></span><span class="c">free</span></button>`;
    body += `<div class="sg-sec">Ready</div><div class="sg-who">${(m.ready ?? []).map((r) => `<span class="${r.ready ? 'r' : ''}">${r.ready ? '✓ ' : ''}${esc(r.name)}</span>`).join('')}</div>`;
    body += m.youReady ? `<button class="sg-ready on" data-a="unready">Waiting for the others… (not ready)</button>` : `<button class="sg-ready" data-a="ready">Ready for the night</button>`;
    const h = m.haul;
    const claim = h && (h.credits || h.xp) ? `Claim ${fmt(h.credits * h.bonus)} cr & leave` : 'Leave for orbit';
    body += `<button class="sg-claim${armed('claim:') ? ' armed' : ''}" data-a="claim">${armed('claim:') ? 'Click again to leave' : claim}</button>`;
    return body;
  }

  private nightBody(m: ServerSiegeStateMessage, b: BastionLayout | null, reach: number[], fs: ReturnType<typeof focusState>): string {
    const supplies = m.supplies ?? 0;
    const N = m.night;
    let body = '';
    // Focus fire
    if (m.phase === 'night' && fs) {
      const key = esc(this.host.focusKey());
      const hasTarget = !!this.host.target();
      const label = fs.kind === 'on' ? `Turrets on your mark · ${fs.secs}s` : fs.kind === 'wait' ? `Focus fire ready in ${fs.secs}s` : hasTarget ? 'Turrets: focus on your target' : 'Target a hostile (Tab) to focus fire';
      body += `<button class="sg-item focus" data-a="focus"${fs.kind === 'ready' && hasTarget ? '' : ' disabled'}><span class="n">${label}<small>Every turret in reach fires on it for a few seconds</small></span><span class="c">${key}</span></button>`;
    }
    const pads = m.turrets ?? [];
    if (pads.length) {
      body += `<div class="sg-sec">Turrets</div>`;
      body += pads.map((t, i) => {
        const name = padName(b, i);
        if (!t) {
          if (!reach.includes(i) || !N) return '';
          const kinds = (m.shop ?? []).filter((s) => s.id.startsWith('turret_'));
          return `<div class="sg-pad empty pick" data-row="${i}"><div class="row"><span class="n">${esc(name)}<small>empty · you're here: build at the night price</small></span></div>`
            + `<div class="kinds">${kinds.map((k) => { const c = Math.round(k.cost * N.buildCost); return `<button class="sg-mini kind" data-a="buy" data-item="${esc(k.id)}" data-pad="${i}"${supplies >= c ? '' : ' disabled'}>${esc(k.label.replace(/ turret$/i, ''))}<span>${c}</span></button>`; }).join('')}</div></div>`;
        }
        const kills = t.kills ? ` · ${t.kills} down` : '';
        return `<div class="sg-pad built" data-row="${i}" ${this.kindStyle(t.kind)}><div class="row"><span class="n">${esc(t.label)}${this.pips(t.mark)}<small>${esc(name)} · hull ${t.hull}%${kills}</small></span>${this.ordersButton(m, i, t.orders)}</div>${this.hullBar(t.hull, t.mend)}</div>`;
      }).join('');
      const empty = pads.filter((t) => !t).length - reach.length;
      if (empty > 0 && N) body += `<div class="sg-hint">${empty} empty pad${empty === 1 ? '' : 's'}: fly to one to build there (×${N.buildCost} cost)</div>`;
    }
    if (N) {
      body += `<div class="sg-hint">Stay beside a damaged turret for ${N.mendSeconds}s to mend it (+${Math.round(N.mendHeal * 100)}% for ${N.mendCost}), or by the bastion (+${Math.round(N.bastionHeal * 100)}% for ${N.bastionCost}${m.breach ? ', the first one free in the last stand' : ''}).`
        + `${m.bastionMend ? ` Bastion mend: ${Math.round(m.bastionMend * 100)}%` : ''}</div>`;
    }
    return body;
  }

  hide(): void {
    this.el.classList.remove('on');
    document.body.classList.remove('sg-open');
    this.last = '';
    this.msg = null;
    this.armed = null;
    this.picked = -1;
    this.hovered = -1;
    if (this.timer) { clearInterval(this.timer); this.timer = 0; }
  }
}
