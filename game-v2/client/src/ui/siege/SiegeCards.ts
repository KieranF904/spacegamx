/**
 * A moon siege's two cards (server: sieges/): at dusk, tonight's title (the
 * siege, the night's number, its boss, what's new tonight and the roles some
 * ships play, each in its role's colour and glyph as marked on the hostiles at
 * night), for a few seconds; at dawn, the night held (kills, yours, the
 * turrets', the best turret, hull lost, turrets lost, objectives, supplies
 * with the streak's bonus, perfect nights in a row, the score counting up),
 * until it's closed or the next night falls.
 */

import type { ServerSiegeStateMessage } from '@space-game/common';
import { ROLE_LOOKS, PLAIN_LOOK, type Glyph } from '../../rendering/surface/siege/siegeLook';
import { esc } from '../escape';

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
/** Each night-mark glyph as text (the card's chips) */
const GLYPH_TEXT: Record<Glyph, string> = { dot: '●', diamond: '◆', chevron: '»', cross: '✚', shield: '⛊', crown: '♛' };
/** Perfect nights in a row the streak pips show (the bonus caps there) */
const STREAK_PIPS = 5;

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.scard { position: fixed; left: 50%; top: 29%; transform: translate(-50%, -50%); z-index: 960; display: none; text-align: center;
  font: 12px 'Segoe UI', system-ui, sans-serif; color: #d6deeb; }
.scard.on { display: block; animation: scardIn 0.5s ease-out; }
.scard.out { animation: scardOut 0.6s ease-in forwards; }
.scard-title { pointer-events: none; width: min(760px, 100vw); padding: 16px 0 14px; text-shadow: 0 2px 12px #000, 0 0 2px #000;
  background: linear-gradient(90deg, transparent, rgba(60, 8, 12, 0.72) 22%, rgba(60, 8, 12, 0.72) 78%, transparent); }
.scard-title::before, .scard-title::after { content: ''; position: absolute; left: 12%; right: 12%; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(252, 165, 165, 0.75), transparent); }
.scard-title::before { top: 0; } .scard-title::after { bottom: 0; }
.scard-title .p { font: 600 12px 'Segoe UI', sans-serif; letter-spacing: 6px; text-transform: uppercase; color: #fca5a5; }
.scard-title .n { margin-top: 2px; font: 800 46px/1.05 'Segoe UI', sans-serif; letter-spacing: 12px; color: #fff1f1;
  text-shadow: 0 0 24px rgba(239, 68, 68, 0.65), 0 2px 10px #000; animation: scardTrack 1.2s ease-out; }
.scard-title .b { display: inline-block; margin-top: 10px; padding: 3px 14px; border-radius: 999px; font-size: 14px; font-weight: 700; color: #fff;
  background: linear-gradient(90deg, rgba(220, 38, 38, 0.75), rgba(244, 63, 94, 0.75)); box-shadow: 0 0 18px rgba(239, 68, 68, 0.55); }
.scard-title .k { margin-top: 9px; font-size: 13px; color: #e2e8f0; }
.scard-title .k b { color: #fde68a; font-weight: 600; }
.scard-title .rs { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; margin-top: 8px; }
.scard-title .r { padding: 3px 10px 3px 8px; border-radius: 7px; font-size: 12px; color: #dbe4f0; text-shadow: none;
  background: rgba(8, 12, 22, 0.75); border: 1px solid color-mix(in srgb, var(--c) 55%, transparent); }
.scard-title .r i { font-style: normal; color: var(--c); margin-right: 5px; }
.scard-title .r b { color: var(--c); }
.scard-dawn { width: min(400px, calc(100vw - 32px)); padding: 0 0 12px; border-radius: 14px; text-align: left; overflow: hidden;
  background: linear-gradient(180deg, rgba(22, 20, 30, 0.96), rgba(10, 14, 24, 0.96)); border: 1px solid rgba(253, 230, 138, 0.38);
  box-shadow: 0 16px 50px rgba(0,0,0,0.55), 0 0 40px rgba(251, 191, 36, 0.12); }
.scard-dawn .sky { position: relative; padding: 14px 18px 12px; overflow: hidden;
  background: linear-gradient(180deg, rgba(251, 146, 60, 0.32), rgba(244, 114, 182, 0.12) 70%, transparent); }
.scard-dawn .sky::before { content: ''; position: absolute; right: 26px; bottom: -46px; width: 92px; height: 92px; border-radius: 50%;
  background: radial-gradient(circle, rgba(255, 236, 170, 0.95), rgba(251, 191, 36, 0.55) 45%, rgba(251, 146, 60, 0) 70%); animation: scardSun 2.4s ease-out; }
.scard-dawn .t { position: relative; font: 700 11px 'Segoe UI', sans-serif; letter-spacing: 3px; text-transform: uppercase; color: #fde68a; }
.scard-dawn .h { position: relative; margin-top: 2px; font: 700 21px 'Segoe UI', sans-serif; color: #fff7e0; }
.scard-dawn .perfect { display: inline-block; margin-left: 8px; padding: 1px 9px; border-radius: 999px; font-size: 11px; vertical-align: 3px;
  background: rgba(74, 222, 128, 0.18); color: #86efac; border: 1px solid rgba(74, 222, 128, 0.45); box-shadow: 0 0 12px rgba(74, 222, 128, 0.3); }
.scard-dawn .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 10px 14px 4px; }
.scard-dawn .tile { padding: 7px 8px 6px; border-radius: 9px; background: rgba(255,255,255,0.04); border: 1px solid rgba(140, 170, 220, 0.14); text-align: center; }
.scard-dawn .tile b { display: block; font: 700 20px 'Segoe UI', sans-serif; color: #eef3fa; }
.scard-dawn .tile.g b { color: #86efac; }
.scard-dawn .tile small { color: #93a3ba; font-size: 10.5px; }
.scard-dawn dl { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; margin: 8px 18px 6px; }
.scard-dawn dt { color: #a3b1c6; }
.scard-dawn dd { margin: 0; text-align: right; color: #eef3fa; font-weight: 600; }
.scard-dawn dd.r { color: #fca5a5; }
.scard-dawn .hull { grid-column: 1 / -1; height: 4px; margin: -1px 0 2px; border-radius: 2px; background: rgba(74, 222, 128, 0.7); overflow: hidden; display: flex; justify-content: flex-end; }
.scard-dawn .hull > i { display: block; height: 100%; background: #f87171; }
.scard-dawn .sup { display: flex; justify-content: space-between; align-items: center; margin: 6px 14px 0; padding: 8px 10px; border-radius: 10px;
  background: rgba(253, 230, 138, 0.07); border: 1px solid rgba(253, 230, 138, 0.2); }
.scard-dawn .sup b { font-size: 18px; color: #fde68a; }
.scard-dawn .sup small { color: #c9b98a; }
.scard-dawn .pips { display: flex; gap: 4px; align-items: center; }
.scard-dawn .pips i { width: 9px; height: 9px; border-radius: 50%; background: rgba(255,255,255,0.1); border: 1px solid rgba(134, 239, 172, 0.35); }
.scard-dawn .pips i.on { background: #4ade80; box-shadow: 0 0 8px rgba(74, 222, 128, 0.7); }
.scard-dawn .s { display: flex; justify-content: space-between; align-items: baseline; margin: 8px 18px 0; padding-top: 8px; border-top: 1px solid rgba(253, 230, 138, 0.18); }
.scard-dawn .s b { font-size: 24px; color: #fde68a; font-variant-numeric: tabular-nums; }
.scard-dawn .s small { color: #a3b1c6; }
.scard-dawn .s .best { color: #86efac; }
.scard-dawn .nb { margin: 8px 18px 0; color: #fca5a5; }
.scard-dawn button { display: block; margin: 10px 14px 0; width: calc(100% - 28px); padding: 7px; border-radius: 8px; cursor: pointer; font: 600 12px 'Segoe UI', sans-serif;
  border: 1px solid rgba(253, 230, 138, 0.35); background: rgba(253, 230, 138, 0.08); color: #fde68a; }
.scard-dawn button:hover { background: rgba(253, 230, 138, 0.16); }
@keyframes scardIn { from { opacity: 0; transform: translate(-50%, -46%) scale(0.98); } }
@keyframes scardOut { to { opacity: 0; } }
@keyframes scardTrack { from { letter-spacing: 34px; opacity: 0; } }
@keyframes scardSun { from { transform: translateY(40px); opacity: 0.3; } }
@media (prefers-reduced-motion: reduce) { .scard.on, .scard.out, .scard-title .n, .scard-dawn .sky::before { animation: none; } }
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
  private countRaf = 0;

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
    let html = `<div class="p">${esc(m.profile?.name ?? m.title ?? '')}</div><div class="n">NIGHT ${t.night}</div>`;
    if (t.boss) html += `<div class="b">${GLYPH_TEXT.crown} ${esc(t.boss)} comes tonight</div>`;
    if (t.newKinds.length) html += `<div class="k">New tonight: <b>${t.newKinds.map(esc).join(', ')}</b></div>`;
    if (t.roles.length) {
      html += `<div class="rs">${t.roles.map((r) => {
        const look = (r.id && ROLE_LOOKS[r.id]) || PLAIN_LOOK;
        return `<div class="r" style="--c:${hex(look.color)}"><i>${GLYPH_TEXT[look.glyph]}</i><b>${esc(r.name)}</b> ${esc(r.ship)}: ${esc(r.note)}</div>`;
      }).join('')}</div>`;
    }
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
    const bonus = s.streakBonus > 0 ? ` <small>+${Math.round(s.streakBonus * 100)}% streak</small>` : '';
    const row = (k: string, v: string | number, cls = '') => `<dt>${k}</dt><dd${cls ? ` class="${cls}"` : ''}>${v}</dd>`;
    const tile = (v: number, k: string, cls = '') => `<div class="tile ${cls}"><b>${v}</b><small>${k}</small></div>`;
    const pips = Array.from({ length: STREAK_PIPS }, (_, i) => `<i class="${i < Math.min(STREAK_PIPS, s.streak) ? 'on' : ''}"></i>`).join('');
    this.dawn.innerHTML = `<div class="sky"><div class="t">Dawn · ${esc(m.title ?? '')}</div>`
      + `<div class="h">Night ${s.night} held${s.perfect ? '<span class="perfect">Perfect night</span>' : ''}</div></div>`
      + `<div class="tiles">${tile(s.kills, 'shot down')}${tile(s.yourKills, 'by you', 'g')}${tile(s.turretKills, 'by turrets')}</div><dl>`
      + (s.mvp ? row(`Best turret: ${esc(s.mvp.label)}`, `${s.mvp.kills} down`) : '')
      + row('Bastion hull lost', `${s.hullLost}%`, s.hullLost > 10 ? 'r' : '')
      + `<div class="hull"><i style="width:${Math.max(0, Math.min(100, s.hullLost))}%"></i></div>`
      + row('Turrets lost', s.turretsLost, s.turretsLost ? 'r' : '')
      + row('Objectives', s.objectives)
      + `</dl><div class="sup"><span>Supplies <b>+${s.supplies}</b>${bonus}</span><span class="pips" title="Perfect nights in a row: ${s.streak}">${pips}</span></div>`
      + `<div class="s"><span>Score <small class="${s.best ? 'best' : ''}">${s.best ? 'best night so far' : `best ${m.score?.best ?? s.score}`}</small></span><b>0</b></div>`
      + (m.nextBoss ? `<div class="nb">Tonight: ${esc(m.nextBoss)} comes with the dark</div>` : '')
      + `<button>Back to the day</button>`;
    this.dawn.classList.remove('out');
    this.dawn.classList.add('on');
    this.countUp(this.dawn.querySelector('.s b') as HTMLElement, s.score);
  }

  /** The score counting up from 0 (under a second) */
  private countUp(el: HTMLElement, to: number): void {
    cancelAnimationFrame(this.countRaf);
    const t0 = performance.now(), ms = 900;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))).toLocaleString();
      if (k < 1) this.countRaf = requestAnimationFrame(step);
    };
    step();
  }

  private hideDawn(): void {
    cancelAnimationFrame(this.countRaf);
    this.dawn.classList.remove('on', 'out');
  }
}
