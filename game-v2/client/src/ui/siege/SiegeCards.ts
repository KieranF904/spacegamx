/**
 * A moon siege's two cards (server: sieges/): at dusk, tonight's title (the
 * night, the siege, its boss, what's new tonight and the roles some ships
 * play), for a few seconds; at dawn, the night held (kills, yours, the best
 * turret, hull lost, turrets lost, objectives, supplies with the streak's
 * bonus, the score), until it's closed or the next night falls.
 */

import type { ServerSiegeStateMessage } from '@space-game/common';

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.scard { position: fixed; left: 50%; top: 27%; transform: translate(-50%, -50%); z-index: 960; display: none; text-align: center;
  font: 12px 'Segoe UI', system-ui, sans-serif; color: #d6deeb; }
.scard.on { display: block; animation: scardIn 0.5s ease-out; }
.scard.out { animation: scardOut 0.6s ease-in forwards; }
.scard-title { pointer-events: none; text-shadow: 0 2px 12px #000, 0 0 2px #000; }
.scard-title .n { font: 800 44px 'Segoe UI', sans-serif; letter-spacing: 10px; color: #fecaca; }
.scard-title .p { margin-top: 2px; font: 600 13px 'Segoe UI', sans-serif; letter-spacing: 4px; text-transform: uppercase; color: #fca5a5; }
.scard-title .b { margin-top: 10px; font-size: 15px; color: #f87171; font-weight: 700; }
.scard-title .k { margin-top: 8px; font-size: 13px; color: #e2e8f0; }
.scard-title .r { margin-top: 3px; font-size: 12px; color: #c8d3e3; }
.scard-title .r b { color: #fde68a; }
.scard-dawn { width: min(380px, calc(100vw - 32px)); padding: 14px 18px 12px; border-radius: 12px; text-align: left;
  background: linear-gradient(180deg, rgba(40, 30, 14, 0.94), rgba(14, 18, 28, 0.94)); border: 1px solid rgba(253, 230, 138, 0.4);
  box-shadow: 0 16px 50px rgba(0,0,0,0.55); }
.scard-dawn .t { font: 700 11px 'Segoe UI', sans-serif; letter-spacing: 3px; text-transform: uppercase; color: #fde68a; }
.scard-dawn .h { margin-top: 2px; font: 700 20px 'Segoe UI', sans-serif; color: #fff7e0; }
.scard-dawn .perfect { display: inline-block; margin-left: 6px; padding: 1px 8px; border-radius: 999px; font-size: 11px; vertical-align: 3px;
  background: rgba(74, 222, 128, 0.18); color: #86efac; border: 1px solid rgba(74, 222, 128, 0.4); }
.scard-dawn dl { display: grid; grid-template-columns: 1fr auto; gap: 3px 12px; margin: 10px 0 8px; }
.scard-dawn dt { color: #a3b1c6; }
.scard-dawn dd { margin: 0; text-align: right; color: #eef3fa; font-weight: 600; }
.scard-dawn dd.g { color: #86efac; }
.scard-dawn dd.y { color: #fde68a; }
.scard-dawn .s { display: flex; justify-content: space-between; align-items: baseline; padding-top: 8px; border-top: 1px solid rgba(253, 230, 138, 0.18); }
.scard-dawn .s b { font-size: 20px; color: #fde68a; }
.scard-dawn .s small { color: #a3b1c6; }
.scard-dawn button { margin-top: 10px; width: 100%; padding: 7px; border-radius: 8px; cursor: pointer; font: 600 12px 'Segoe UI', sans-serif;
  border: 1px solid rgba(253, 230, 138, 0.35); background: rgba(253, 230, 138, 0.08); color: #fde68a; }
.scard-dawn button:hover { background: rgba(253, 230, 138, 0.16); }
@keyframes scardIn { from { opacity: 0; transform: translate(-50%, -46%) scale(0.98); } }
@keyframes scardOut { to { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .scard.on, .scard.out { animation: none; } }
`;
  document.head.appendChild(css);
}

export class SiegeCards {
  private title = document.createElement('div');
  private dawn = document.createElement('div');
  /** The night each card was last shown for (each shows once) */
  private titled = -1;
  private dawned = -1;
  private titleTimer = 0;

  constructor() {
    injectStyles();
    this.title.className = 'scard scard-title';
    this.dawn.className = 'scard scard-dawn';
    this.dawn.addEventListener('mousedown', (e) => e.stopPropagation());
    this.dawn.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button')) this.hideDawn(); });
    document.body.append(this.title, this.dawn);
  }

  update(m: ServerSiegeStateMessage | null): void {
    if (!m || !m.active) { this.hideTitle(); this.hideDawn(); this.titled = this.dawned = -1; return; }
    if (m.phase === 'dusk' && m.tonight && m.tonight.night !== this.titled) this.showTitle(m);
    if (m.phase === 'day' && m.summary && m.summary.night !== this.dawned) this.showDawn(m);
    if (m.phase !== 'day') this.hideDawn();
  }

  private showTitle(m: ServerSiegeStateMessage): void {
    const t = m.tonight!;
    this.titled = t.night;
    let html = `<div class="n">NIGHT ${t.night}</div><div class="p">${esc(m.profile?.name ?? m.title ?? '')}</div>`;
    if (t.boss) html += `<div class="b">${esc(t.boss)} comes tonight</div>`;
    if (t.newKinds.length) html += `<div class="k">New tonight: ${t.newKinds.map(esc).join(', ')}</div>`;
    for (const r of t.roles) html += `<div class="r"><b>${esc(r.name)}</b> (${esc(r.ship)}): ${esc(r.note)}</div>`;
    this.title.innerHTML = html;
    this.title.classList.remove('out');
    this.title.classList.add('on');
    clearTimeout(this.titleTimer);
    this.titleTimer = window.setTimeout(() => {
      this.title.classList.add('out');
      this.titleTimer = window.setTimeout(() => this.hideTitle(), 650);
    }, 5500);
  }

  private hideTitle(): void {
    clearTimeout(this.titleTimer);
    this.title.classList.remove('on', 'out');
  }

  private showDawn(m: ServerSiegeStateMessage): void {
    const s = m.summary!;
    this.dawned = s.night;
    const bonus = s.streakBonus > 0 ? ` <small>(+${Math.round(s.streakBonus * 100)}% streak)</small>` : '';
    const row = (k: string, v: string | number, cls = '') => `<dt>${k}</dt><dd${cls ? ` class="${cls}"` : ''}>${v}</dd>`;
    this.dawn.innerHTML = `<div class="t">Dawn · ${esc(m.title ?? '')}</div>`
      + `<div class="h">Night ${s.night} held${s.perfect ? '<span class="perfect">Perfect night</span>' : ''}</div><dl>`
      + row('Hostiles shot down', s.kills)
      + row('By you', s.yourKills, 'g')
      + row('By the turrets', s.turretKills)
      + (s.mvp ? row(`Best turret: ${esc(s.mvp.label)}`, s.mvp.kills) : '')
      + row('Bastion hull lost', `${s.hullLost}%`)
      + row('Turrets lost', s.turretsLost)
      + row('Objectives', s.objectives)
      + row('Supplies', `+${s.supplies}${bonus}`, 'y')
      + row('Perfect nights in a row', s.streak)
      + `</dl><div class="s"><span>Score <small>${s.best ? 'best night so far' : `best ${m.score?.best ?? s.score}`}</small></span><b>${s.score}</b></div>`
      + (m.nextBoss ? `<div class="r" style="margin-top:8px;color:#fca5a5">Tonight: ${esc(m.nextBoss)} comes with the dark</div>` : '')
      + `<button>Back to the day</button>`;
    this.dawn.classList.remove('out');
    this.dawn.classList.add('on');
  }

  private hideDawn(): void {
    this.dawn.classList.remove('on', 'out');
  }
}
