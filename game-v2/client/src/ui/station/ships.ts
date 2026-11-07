/**
 * Station tab: Ships.
 *
 * Owns: your hangar slots with their order controls (hold, resume, do first, call off), what each unfinished ship still needs down to the ore (and which bills are opened), the plans you know, and your saved designs; the rating cache.
 * Needs: StationCtx (the pilot, the orders against the station jobs, send/sound, render to redraw).
 * Extend: a new per-ship control goes in render()'s button row; a new bill line in billHtml().
 */

import {
  Bag, partItemId, isWeaponFn, OrderPlan, OrderLine, countOf, type Blueprint,
} from '@space-game/common';
import { costHtml, showTip, hideTip } from '../windowKit';
import { itemIcon, shipIcon } from '../itemIcons';
import { shipSummary } from '../../ships/shipSummary';
import { esc, shortName, forText, lineStatus } from './shared';
import type { StationCtx } from './shared';

export class ShipsTab {
  constructor(private c: StationCtx) {}
  private get d() { return this.c.d; }
  private get st() { return this.c.st; }
  /** Ships cards opened to their full bill */
  private openBills = new Set<number>();
  render(b: HTMLElement): void {
    const p = this.d.pilot;
    const econ = p.econ;
    const hs = p.hangar;
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns: 1fr 1fr; gap:14px; height: min(580px, calc(100vh - 230px));';
    const left = document.createElement('div');
    left.className = 'sgw-col';
    left.style.overflowY = 'auto';
    left.innerHTML = '<h4>Hangar <span class="r">your ships and builds</span></h4>';
    const coming = p.coming();
    const orders = this.c.orders();
    const firstOnOrder = orders.find((o) => o.auto)?.slot;
    (hs?.slots ?? []).forEach((rec, slot) => {
      const card = document.createElement('div');
      card.style.cssText = 'border:1px solid rgba(140,170,220,0.14); border-radius:10px; padding:8px 10px; margin-bottom:6px; background:rgba(4,8,16,0.35); flex-shrink:0;';
      if (!rec) {
        card.style.padding = '4px 6px 4px 10px';
        card.innerHTML = `<div style="display:flex; align-items:center; gap:8px"><b style="color:#56657c">Slot ${slot + 1}</b><span style="color:#56657c">empty</span><span style="flex:1"></span></div>`;
        const open = document.createElement('button');
        open.className = 'sgw-btn';
        open.style.padding = '4px 10px';
        open.textContent = 'Design a ship';
        open.onclick = () => this.d.openHangar(slot);
        card.firstElementChild!.appendChild(open);
        left.appendChild(card);
        return;
      }
      const total = rec.blueprint.parts.length, built = total - rec.ghosts.length;
      const flying = slot === hs!.active;
      const ghostIds = new Set(rec.ghosts);
      const onWay = rec.blueprint.parts.filter((q) => ghostIds.has(q.uid)).reduce((t, q) => t + ((coming[partItemId(q)] ?? 0) > 0 ? 1 : 0), 0);
      const core = rec.blueprint.parts.find((q) => q.fn === 'core');
      const coreBuilt = !!core && !ghostIds.has(core.uid);
      const orderTag = rec.auto ? (rec.paused ? ' · <span style="color:#fbbf24">⏸ on hold</span>' : slot === firstOnOrder ? ' · <span style="color:#7dd3fc">on order · first</span>' : ' · <span style="color:#7dd3fc">on order</span>') : '';
      const status = flying && !rec.ghosts.length ? `<span style="color:#4ade80">✈ flying</span>` : !rec.ghosts.length ? '<span style="color:#4ade80">ready to fly</span>'
        : `<span style="color:${rec.lost ? '#fbbf24' : '#7dd3fc'}">${flying ? '✈ flying · ' : ''}${rec.lost ? 'rebuilding · ' : ''}${built} / ${total} parts built</span>${orderTag || (onWay ? ` · <span style="color:#fbbf24">⏳ parts on the way</span>` : '')}`;
      card.innerHTML = `<div style="display:flex; align-items:baseline; gap:8px"><b>Slot ${slot + 1} · ${esc(rec.blueprint.name)}</b><span style="flex:1"></span>${status}</div>
        <div class="sgw-bar" style="margin:6px 0 8px"><i style="width:${(built / total) * 100}%"></i></div>
        <div class="sgw-needs"></div>
        <div style="display:flex; gap:6px; flex-wrap:wrap"></div>`;
      const plan = orders.find((o) => o.slot === slot);
      if (plan) this.renderNeeds(card.querySelector('.sgw-needs')!, plan);
      const row = card.lastElementChild as HTMLElement;
      const btn = (label: string, cls: string, fn: () => void, title = '') => {
        const x = document.createElement('button');
        x.className = `sgw-btn ${cls}`;
        x.textContent = label;
        x.title = title;
        x.onclick = fn;
        row.appendChild(x);
        return x;
      };
      btn('Open in hangar', '', () => this.d.openHangar(slot));
      if (rec.ghosts.length && !rec.auto) btn('Put on order', 'primary', () => this.d.send({ type: 'slotBuild', slot }), 'Refine your ore, fabricate the modules and fit everything, as far as your materials go');
      if (rec.ghosts.length && rec.auto) {
        const order = (action: 'pause' | 'resume' | 'cancel' | 'top') => () => { this.d.send({ type: 'slotOrder', slot, action }); this.d.sound('ui_click', 0.4); };
        if (rec.paused) btn('▶ Resume', 'primary', order('resume'), 'Carry on: its jobs pick up where they left off');
        else btn('⏸ Hold', '', order('pause'), 'Start nothing new for it, and hold its jobs (others move up)');
        if (slot !== firstOnOrder) btn('⇧ Do first', '', order('top'), 'Work this order first: it takes what it needs before the others, and its jobs go to the front of their queues');
        if (!rec.lost) btn('Call off', '', order('cancel'), 'Take it off order: its queued jobs stop and their materials go back to storage (parts already fitted stay)');
      }
      if (!flying) {
        const flyable = coreBuilt && !rec.lost;
        const fly = btn('Fly', 'good', () => this.d.send({ type: 'slotFly', slot }), flyable ? 'Swap to this ship' : rec.lost ? 'Being rebuilt: fly it once it is whole' : 'Build its core first');
        if (!flyable) fly.classList.add('off');
      }
      left.appendChild(card);
    });

    const right = document.createElement('div');
    right.className = 'sgw-col';
    right.style.overflowY = 'auto';
    const empty = (hs?.slots ?? []).findIndex((s) => !s);
    const plans = (p.profile?.plans ?? []).map((f) => ({ f, bp: econ.plans[f] })).filter((x) => x.bp).sort((a, c) => a.bp.parts.length - c.bp.parts.length);
    right.innerHTML = `<h4>Your ship plans <span class="r">${empty < 0 ? 'no empty hangar slot' : `build one in slot ${empty + 1}`}</span></h4>`;
    if (!plans.length) right.innerHTML += '<div class="sgw-empty" style="padding:8px">No plans yet. Design a ship in the hangar.</div>';
    for (const { f, bp } of plans) right.appendChild(this.planRow(bp, empty, f));
    // Designs saved in the hangar's design slots
    const designs = hs?.designs ?? [];
    const saved = designs.map((bp, i) => ({ bp, i })).filter((x): x is { bp: Blueprint; i: number } => !!x.bp);
    right.insertAdjacentHTML('beforeend', `<h4 style="margin-top:12px">Your designs <span class="r">${designs.length ? `${saved.length} / ${designs.length} slots · save them in the hangar` : 'save them in the hangar'}</span></h4>`);
    if (!saved.length) right.insertAdjacentHTML('beforeend', '<div class="sgw-empty" style="padding:8px">None saved yet. In the hangar, Designs saves the ship you\'re drawing for later.</div>');
    for (const { bp, i } of saved) right.appendChild(this.planRow(bp, empty, undefined, `D${i + 1}`));
    grid.append(left, right);
    b.appendChild(grid);
  }

  /** A plan or saved design in one compact row: silhouette, what it is, what it takes, and Build */
  private planRow(bp: Blueprint, empty: number, plan: string | undefined, tag = ''): HTMLElement {
    const p = this.d.pilot, econ = p.econ;
    const count = (fn: string) => bp.parts.filter((q) => q.fn === fn).length;
    const guns = bp.parts.filter((q) => isWeaponFn(q.fn)).length;
    const n = bp.parts.length;
    const size = n <= 20 ? 'small' : n <= 60 ? 'medium' : n <= 150 ? 'large' : 'capital';
    const facts = [`${n} parts`, size, guns ? `${guns} gun${guns > 1 ? 's' : ''}` : 'unarmed',
      count('cargo') ? `${count('cargo')} cargo` : '', count('miner') ? 'mining' : '', count('armor') ? `${count('armor')} armour` : '']
      .filter(Boolean).join(' · ');
    const cost = econ.recipes.raw(Object.entries(econ.designParts(bp)).reduce((acc, [id, k]) => {
      for (const [kk, m] of Object.entries(econ.recipes.recipeFor(id)?.inputs ?? {})) acc[kk] = (acc[kk] ?? 0) + m * k;
      return acc;
    }, {} as Bag));
    for (const k of Object.keys(cost)) cost[k] = Math.ceil(cost[k]);
    // Parts you neither have nor can make yet (licences)
    const locked = [...new Set(bp.parts.map((q) => partItemId(q)).filter((id) => this.c.have(id) <= 0 && !p.canMake(id)))];
    const rating = this.rating(bp);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:5px 8px; margin-bottom:5px; flex-shrink:0; border-radius:9px; border:1px solid rgba(140,170,220,0.12); background:rgba(4,8,16,0.35);';
    const clip = 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis';
    row.innerHTML = `<img src="${shipIcon(econ, bp.parts, 38)}" style="width:38px; height:38px; flex-shrink:0">`
      + `<div style="flex:1; min-width:0"><div style="${clip}">${tag ? `<span style="color:#56657c; font-size:11px">${tag}</span> ` : ''}<b>${esc(bp.name)}</b>${rating ? ` <span style="color:#7dd3fc; font-size:11px" title="Rating">◆ ${rating.toLocaleString()}</span>` : ''}`
      + ` <span style="color:#8394ad; font-size:11px">${facts}</span></div>`
      + `<div style="font-size:11px; ${clip}">${locked.length ? `<span style="color:#fca5a5">🔒 Needs a licence: ${locked.slice(0, 2).map((id) => esc(econ.items.name(id))).join(', ')}${locked.length > 2 ? '…' : ''}</span>` : costHtml(econ, cost, (id) => this.c.have(id))}</div></div>`;
    row.addEventListener('mousemove', (e) => showTip(`<div class="t-n">${esc(bp.name)}</div><div class="t-c">${facts}${rating ? ` · ◆ ${rating}` : ''}</div>`
      + `<div class="t-d" style="margin-top:4px">Raw materials (have / need):</div><div style="margin-top:3px; line-height:1.9">${costHtml(econ, cost, (id) => this.c.have(id))}</div>`
      + (locked.length ? `<div class="t-h" style="color:#fca5a5">Needs a licence for: ${locked.map((id) => esc(econ.items.name(id))).join(', ')}</div>` : ''), e.clientX, e.clientY));
    row.addEventListener('mouseleave', hideTip);
    const go = document.createElement('button');
    go.className = 'sgw-btn primary' + (empty < 0 || locked.length ? ' off' : '');
    go.style.cssText = 'padding:5px 10px; white-space:nowrap;';
    go.textContent = empty < 0 ? 'No empty slot' : locked.length ? 'Licence needed' : `Build in slot ${empty + 1}`;
    go.onclick = () => { this.d.send({ type: 'slotSave', slot: empty, blueprint: JSON.parse(JSON.stringify(bp)), ...(plan ? { plan } : {}) }); this.d.sound('ui_click', 0.5); };
    row.appendChild(go);
    return row;
  }

  /** A design's rating (cached: it builds the ship to work it out) */
  private ratings = new WeakMap<Blueprint, number>();
  private rating(bp: Blueprint): number {
    let r = this.ratings.get(bp);
    if (r === undefined) {
      const econ = this.d.pilot.econ;
      r = econ.tuning ? Math.round(shipSummary(econ.ships, econ.tuning, econ, bp)?.rating ?? 0) : 0;
      this.ratings.set(bp, r);
    }
    return r;
  }
  /** A ship's needs: what to gather at a glance, and (opened) every item down to ore */
  private renderNeeds(el: HTMLElement, plan: OrderPlan): void {
    const econ = this.d.pilot.econ;
    const gather = Object.entries(plan.gather);
    const lines = plan.lines.filter((l) => l.need > 0);
    const parts = lines.filter((l) => l.stage === 'part');
    const ready = lines.filter((l) => l.stage !== 'ore').reduce((t, l) => t + l.ready, 0);
    const making = lines.filter((l) => l.stage !== 'ore').reduce((t, l) => t + l.coming, 0);
    const locked = parts.filter((l) => l.blocked === 'schematic');
    const inHold = gather.filter(([id]) => countOf(this.d.pilot.cargo, id) > 0);
    const open = this.openBills.has(plan.slot);
    el.innerHTML = `<div style="font-size:12px; margin:-2px 0 6px; line-height:1.7">`
      + (gather.length
        ? `<span style="color:#fca5a5">To gather:</span> ${gather.map(([id, n]) => `<span class="sgw-cost short" title="${esc(econ.items.name(id))}: ${n} more"><img src="${itemIcon(econ, id)}">${n} ${esc(shortName(econ.items.name(id)))}</span>`).join('')}`
        : locked.length ? '' : '<span style="color:#86efac">✓ Everything it needs is in storage or being made</span>')
      + (locked.length ? `<div style="color:#fca5a5">🔒 Not open yet (a level away): ${locked.map((l) => esc(econ.items.name(l.id))).join(', ')}</div>` : '')
      + (inHold.length ? `<div style="color:#fbbf24; font-size:11px">Some of that is in your hold: orders use storage, so store it (Inventory)</div>` : '')
      + `<div style="color:#8394ad; font-size:11px">${ready ? `${ready} ready in storage · ` : ''}${making ? `${making} being made · ` : ''}<a href="#" data-bill style="color:#7dd3fc">${open ? 'Hide' : 'Show'} the full bill</a></div></div>`
      + (open ? this.billHtml(lines) : '');
    el.querySelector<HTMLElement>('[data-bill]')!.onclick = (e) => {
      e.preventDefault();
      if (open) this.openBills.delete(plan.slot); else this.openBills.add(plan.slot);
      this.c.render();
    };
  }

  /** Every line of an order: parts, then what they're made from, then ore */
  private billHtml(lines: OrderLine[]): string {
    const econ = this.d.pilot.econ;
    const stages: [OrderLine['stage'], string][] = [['part', 'Parts'], ['material', 'Materials'], ['ore', 'Ore']];
    return `<div style="border-top:1px solid rgba(140,170,220,0.1); padding-top:6px; margin-bottom:8px; font-size:12px">`
      + stages.map(([stage, label]) => {
        const ls = lines.filter((l) => l.stage === stage);
        if (!ls.length) return '';
        return `<div style="color:#56657c; font-size:10px; letter-spacing:1.5px; text-transform:uppercase; margin:6px 0 2px">${label}</div>`
          + ls.map((l) => `<div style="display:flex; align-items:center; gap:6px; padding:2px 0">`
            + `<img src="${itemIcon(econ, l.id)}" style="width:18px; height:18px">`
            + `<span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap" title="For ${esc(forText(l))}">${l.need} × ${esc(econ.items.name(l.id))}</span>`
            + `<span style="white-space:nowrap">${lineStatus(l)}</span></div>`).join('');
      }).join('') + '</div>';
  }
}
