/**
 * The Ship window's Status tab: the ship schematic (the HUD's renderer, ui/shipStatus/Schematic.ts, drawn larger), the
 * core and hull, each shield, the damaged and missing parts, and "Queue repairs": in the field the fabricator switched
 * on with the repairs put first (fabQueue.ts repairMessages); docked, the repair bank mends the ship at the station.
 */
import { shapedOf, shieldHp, shieldUp, coreIndex } from '@space-game/common';
import { Schematic } from '../../shipStatus/Schematic';
import { readStatus, newMemory, emptyStatus } from '../../shipStatus/source';
import { fieldHudMarks } from '../../../ships/field/bridge';
import { fieldClient } from '../../../ships/field/fieldState';
import { setHtml } from '../../domWrite';
import { fabQueue, repairMessages } from '../fabQueue';
import { queueInput } from './queueParts';
import { tabRoot, onAct, sec, meter, row, note, num, pct, esc } from './view';
import type { ShipCtx, ShipTab } from '../shipTabs';
import { hpColor, numToCss } from '../../../ships/shipColors';

const SHIELD_WORD = { none: 'none', full: 'full', regen: 'charging', wait: 'hit: waiting to charge', down: 'down' } as const;

export function statusTab(): ShipTab {
  let root: HTMLElement | null = null;
  let info: HTMLElement, acts: HTMLElement, schem: Schematic;
  const mem = newMemory(), rec = emptyStatus();
  let ctxRef: ShipCtx | null = null;

  const make = (): HTMLElement => {
    const r = document.createElement('div');
    schem = new Schematic(300, 160);
    schem.canvas.style.margin = '0 auto 4px';
    info = document.createElement('div');
    // (The buttons apart from the live numbers: redrawn only when they change, so a click is never lost to a redraw)
    acts = document.createElement('div');
    r.append(schem.canvas, info, acts);
    onAct(r, (act) => {
      const c = ctxRef;
      if (!c) return;
      if (act === 'repairs') {
        const ship = c.ship();
        const qi = ship && queueInput(ship, c.fnName, (id) => c.pilot.cargo.find((x) => x.id === id)?.n ?? 0);
        if (!qi) return;
        for (const m of repairMessages(fabQueue(qi), !!fieldClient.machine('fabricator')?.on)) c.send(m);
        c.sound('ui_click');
      } else if (act === 'fab') c.openTab('fabricator');
      else if (act === 'station') c.openStation();
    });
    return r;
  };

  return {
    id: 'status', label: 'Status', title: 'Your ship: parts, core, hull, shields and repairs', live: 250,
    render(body, ctx) {
      ctxRef = ctx;
      root = tabRoot(body, root, make);
      const ship = ctx.ship();
      if (!ship) { setHtml(info, note('No ship to show.')); setHtml(acts, ''); return; }
      const inp = ctx.statusInput();
      if (inp) readStatus(inp, mem, rec); else rec.has = false;
      schem.draw(ship, ctx.geometry(ship), rec, performance.now(), fieldHudMarks(ship));
      const h = rec.hull, s = rec.shield;
      let html = sec('Core and hull');
      const cf = h.coreMax > 0 ? h.coreHp / h.coreMax : 0;
      html += row('Core', `${num(h.coreHp)} / ${num(h.coreMax)}`, meter(cf, numToCss(hpColor(cf))));
      html += row('Hull', `${pct(h.integrity)} · ${h.intact}/${h.parts} parts`, meter(h.integrity, numToCss(hpColor(h.integrity))));
      // Shields: each shaped shield on its own, else the ship's one
      const shaped = shapedOf(ship);
      if (shaped.length || s.max > 0) {
        html += sec('Shields');
        if (shaped.length) shaped.forEach((sh, i) => {
          const hp = shieldHp(ship, i), up = shieldUp(ship, i);
          html += row(esc(ctx.fnName(ship.blueprint.parts[sh.part]?.fn ?? 'shield')), up ? `${num(hp)} / ${num(sh.cap)}` : '<span class="sgsw-bad">down</span>', meter(sh.cap > 0 ? hp / sh.cap : 0, '#60a5fa'));
        });
        else html += row('Shield', `${num(s.cur)} / ${num(s.max)} · ${SHIELD_WORD[s.state]}`, meter(s.pct / 100, s.state === 'down' ? '#f87171' : '#60a5fa'));
      }
      // Damaged and missing parts
      const parts = ship.blueprint.parts, core = coreIndex(parts);
      const hurt: string[] = [];
      let missing = 0;
      for (let i = 0; i < parts.length; i++) {
        if (ship.ghost?.[i] && !ship.derived.alive[i]) { missing++; continue; }
        const alive = !!ship.derived.alive[i];
        if (!alive) { missing++; hurt.push(row(`<span class="sgsw-bad">${esc(ctx.fnName(parts[i].fn))}</span>`, 'missing')); continue; }
        const f = ship.maxHp[i] > 0 ? ship.hp[i] / ship.maxHp[i] : 1;
        if (f < 0.999 && i !== core) hurt.push(row(esc(ctx.fnName(parts[i].fn)), pct(f), meter(f, numToCss(hpColor(f)))));
      }
      html += sec('Damage', hurt.length ? `${hurt.length} part${hurt.length === 1 ? '' : 's'}${missing ? `, ${missing} missing` : ''}` : 'none');
      html += hurt.slice(0, 10).join('') + (hurt.length > 10 ? note(`and ${hurt.length - 10} more`) : '');
      setHtml(info, html);
      // Repairs
      html = sec('Repairs');
      if (ctx.docked()) {
        html += note('Docked: your repair bank mends damaged and missing parts while you stay at the station, nearest the core first.');
        html += `<div class="sgsw-btns"><button class="sgw-btn" data-act="station">Repair bank</button></div>`;
      } else {
        const fab = fieldClient.machine('fabricator');
        const work = hurt.length > 0 || missing > 0 || h.coreHp < h.coreMax;
        html += note(fab
          ? `In the field your ${fab.tier > 0 ? 'fabricator' : "core's own fabricator"} repairs from your hold: damaged parts first, then missing ones. It is <b class="${fab.on ? 'sgsw-ok' : 'sgsw-warn'}">${fab.on ? 'on' : 'off'}</b>.`
          : 'Your fabricator repairs from your hold while it is on.');
        html += `<div class="sgsw-btns"><button class="sgw-btn${work ? ' primary' : ''}" data-act="repairs"${work ? '' : ' disabled'} title="Switches the fabricator on and puts the damaged and missing parts first">Queue repairs</button><button class="sgw-btn" data-act="fab">Fabricator queue</button></div>`;
      }
      setHtml(acts, html);
    },
  };
}
