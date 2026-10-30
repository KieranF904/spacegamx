/**
 * A moon siege's panel (server: Sieges.ts), at the side while you're on the
 * moon. Always: the party's supplies and your haul. By day: the shop (patch
 * the bastion and turrets, build turrets on its pads), the pads (upgrade or
 * scrap what's on them), a free refit, who's ready, your own Ready button
 * (the night comes when everyone down here is ready), and Claim & leave.
 * Scrapping and claiming ask twice.
 */

import type { ClientMessage, ServerSiegeStateMessage } from '@space-game/common';

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.sg { position: fixed; right: 12px; top: 50%; transform: translateY(-50%); width: 272px; z-index: 950; display: none;
  background: linear-gradient(180deg, rgba(14, 22, 40, 0.94), rgba(7, 12, 24, 0.94)); border: 1px solid rgba(125, 211, 252, 0.3); border-radius: 12px;
  box-shadow: 0 16px 50px rgba(0,0,0,0.5); color: #d6deeb; font: 12px 'Segoe UI', system-ui, sans-serif; overflow: hidden; }
.sg.on { display: block; }
/* The jobs tracker makes way while the siege is on */
body.sg-open .qt { visibility: hidden; }
.sg.night { border-color: rgba(248, 113, 113, 0.45); }
.sg-h { padding: 10px 14px 8px; border-bottom: 1px solid rgba(140, 170, 220, 0.14); }
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
.sg-pad { display: flex; align-items: center; gap: 5px; margin: 4px 0; padding: 5px 4px 5px 9px; border-radius: 8px; border: 1px solid rgba(140, 170, 220, 0.16); }
.sg-pad .n { flex: 1; min-width: 0; }
.sg-pad .n small { display: block; color: #8394ad; font-size: 10.5px; }
.sg-pad.empty { color: #64748b; border-style: dashed; }
.sg-mini { padding: 4px 7px; border-radius: 6px; cursor: pointer; font: 600 11px 'Segoe UI', sans-serif; white-space: nowrap;
  border: 1px solid rgba(140, 170, 220, 0.3); background: rgba(255,255,255,0.03); color: #d6deeb; }
.sg-mini:hover { border-color: rgba(125, 211, 252, 0.6); background: rgba(125, 211, 252, 0.1); }
.sg-mini:disabled { opacity: 0.4; cursor: default; background: none; }
.sg-mini.up { color: #fde68a; }
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
.sg-sec { margin: 10px 0 4px; color: #8394ad; font-size: 10.5px; letter-spacing: 1.5px; text-transform: uppercase; }
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

export class SiegePanel {
  private el = document.createElement('div');
  private last = '';
  private msg: ServerSiegeStateMessage | null = null;
  /** A scrap or claim clicked once: it asks again (which button, and until when) */
  private armed: { key: string; until: number } | null = null;

  constructor(private send: (m: ClientMessage) => void) {
    injectStyles();
    this.el.className = 'sg';
    // Clicks here aren't shots
    this.el.addEventListener('mousedown', (e) => e.stopPropagation());
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
      if (!b || (b as HTMLButtonElement).disabled) return;
      const a = b.dataset.a as 'ready' | 'unready' | 'refit' | 'buy' | 'upgrade' | 'scrap' | 'claim';
      const pad = b.dataset.pad !== undefined ? Number(b.dataset.pad) : undefined;
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
      this.send({ type: 'siege', action: a, item: b.dataset.item, pad });
    });
    document.body.appendChild(this.el);
  }

  get isOpen(): boolean {
    return this.el.classList.contains('on');
  }

  update(m: ServerSiegeStateMessage): void {
    if (!m.active) { this.hide(); return; }
    this.msg = m;
    this.render(false);
  }

  private render(force: boolean): void {
    const m = this.msg;
    if (!m) return;
    const key = JSON.stringify(m) + (this.armed?.key ?? '');
    if (!force && key === this.last) return;
    this.last = key;
    const armed = (k: string) => this.armed?.key === k;
    const day = m.phase === 'day';
    this.el.classList.add('on');
    document.body.classList.add('sg-open');
    this.el.classList.toggle('night', !day);
    const title = day ? `Day ${(m.wave ?? 0) + 1}` : m.phase === 'dusk' ? `Night ${m.wave} is falling` : m.phase === 'night' ? `Night ${m.wave}` : 'The bastion has fallen';
    const sub = day ? 'Rest, repair and build. The night comes when everyone is ready.' : m.phase === 'lost' ? 'Back to orbit shortly.' : 'Hold the bastion until dawn.';
    let body = '';
    // This moon's siege, and (by day) a boss coming tonight
    if (m.profile && day) body += `<div class="sg-prof"><b>${esc(m.profile.name)}</b><small>${esc(m.profile.about)}</small></div>`;
    if (m.nextBoss && day) body += `<div class="sg-boss">Tonight: <b>${esc(m.nextBoss)}</b> comes with the dark</div>`;
    body += `<div class="sg-sup"><span>Party supplies</span><b>${m.supplies ?? 0}</b></div>`;
    const h = m.haul;
    if (h) {
      const bonus = h.bonus > 1 ? ` <span class="x">×${h.bonus}</span>` : '';
      body += `<div class="sg-haul">Your haul: <b>${fmt(h.credits)} cr</b> · <b>${fmt(h.xp)} XP</b>${bonus}`
        + `<small>${h.nights} night${h.nights === 1 ? '' : 's'} held · ×${h.nextBonus} if you hold to night ${h.nextBonusAt} · half if the bastion falls</small></div>`;
    }
    if (day) {
      body += `<div class="sg-sec">Build</div>`;
      body += (m.shop ?? []).map((s) => {
        const turret = s.id.startsWith('turret_');
        const can = (m.supplies ?? 0) >= s.cost && (!turret || (m.pads?.free ?? 0) > 0);
        return `<button class="sg-item" data-a="buy" data-item="${esc(s.id)}"${can ? '' : ' disabled'}><span class="n">${esc(s.label)}<small>${esc(s.note)}${turret ? ` · pads ${m.pads?.free ?? 0}/${m.pads?.total ?? 0} free` : ''}</small></span><span class="c">${s.cost}</span></button>`;
      }).join('');
      const pads = m.turrets ?? [];
      if (pads.length) {
        body += `<div class="sg-sec">Turret pads</div>`;
        body += pads.map((t, i) => {
          if (!t) return `<div class="sg-pad empty"><span class="n">Pad ${i + 1} · empty</span></div>`;
          const up = t.upgrade !== undefined
            ? `<button class="sg-mini up" data-a="upgrade" data-pad="${i}"${(m.supplies ?? 0) >= t.upgrade ? '' : ' disabled'} title="Upgrade to the next mark (full hull)">▲ ${t.upgrade}</button>`
            : '';
          const scrap = `<button class="sg-mini${armed(`scrap:${i}`) ? ' armed' : ''}" data-a="scrap" data-pad="${i}" title="Scrap it for half what it cost">${armed(`scrap:${i}`) ? 'Sure?' : `✕ +${t.refund}`}</button>`;
          return `<div class="sg-pad"><span class="n">${esc(t.label)}<small>Pad ${i + 1} · hull ${t.hull}%${t.upgrade === undefined ? ' · max mark' : ''}</small></span>${up}${scrap}</div>`;
        }).join('');
      }
      body += `<div class="sg-sec">Ship</div>`;
      body += `<button class="sg-item" data-a="refit"><span class="n">Refit your ship<small>Mend every part, free by day</small></span><span class="c">free</span></button>`;
      body += `<div class="sg-sec">Ready</div><div class="sg-who">${(m.ready ?? []).map((r) => `<span class="${r.ready ? 'r' : ''}">${r.ready ? '✓ ' : ''}${esc(r.name)}</span>`).join('')}</div>`;
      body += m.youReady ? `<button class="sg-ready on" data-a="unready">Waiting for the others… (not ready)</button>` : `<button class="sg-ready" data-a="ready">Ready for the night</button>`;
      const claim = h && (h.credits || h.xp) ? `Claim ${fmt(h.credits * h.bonus)} cr & leave` : 'Leave for orbit';
      body += `<button class="sg-claim${armed('claim:') ? ' armed' : ''}" data-a="claim">${armed('claim:') ? 'Click again to leave' : claim}</button>`;
    }
    this.el.innerHTML = `<div class="sg-h"><div class="sg-t">${esc(m.title ?? 'Siege')} · ${esc(title)}</div><div class="sg-s">${esc(sub)}</div></div><div class="sg-b">${body}</div>`;
  }

  hide(): void {
    this.el.classList.remove('on');
    document.body.classList.remove('sg-open');
    this.last = '';
    this.msg = null;
    this.armed = null;
  }
}
