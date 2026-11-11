/**
 * @contract client.ui.auto-pickup-panel
 * owns:       the auto-pickup panel the cargo panel opens: mining mode (mirrored from the cargo panel), the hold's whitelist (icons, a target or unlimited, right-click to set or remove), the pilot's ore blacklist (icons, right-click to remove), + Whitelist / + Blacklist (the catalogue), and the whitelist's templates (save as, load, delete)
 * needs:      PilotState (the whitelist, mining mode, templates), CataloguePicker, askBox, windowKit (tips, menus), itemIcons; the server's ghost, ghostTemplate, pickupPrefs and oreBlacklist; npm: @space-game/common
 * invariants: every change is one message the server checks; the panel only shows what the server last said (no local copies) — server/src/game/pickup.test.ts
 * extend:     a new list is one more block in render() with its message
 */

import type { ClientMessage } from '@space-game/common';
import type { PilotState } from '../../econ/clientEcon';
import { injectWindowStyles, itemTipHtml, showTip, hideTip, openMenu } from '../windowKit';
import { itemIcon } from '../itemIcons';
import { esc } from '../escape';
import { askValue } from './askBox';
import type { CataloguePicker } from './CataloguePicker';

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.sgap { position: fixed; left: 352px; bottom: 150px; width: 300px; z-index: 870; box-sizing: border-box; padding: 9px 11px 10px; display: none;
  background: rgba(8, 14, 26, 0.92); border: 1px solid rgba(125, 211, 252, 0.3); border-radius: 10px; color: #c9d4e5; font: 12px 'Segoe UI', system-ui, sans-serif; user-select: none; }
.sgap.on { display: block; }
.sgap-head { display: flex; align-items: center; gap: 8px; }
.sgap-head b { font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 2px; color: #7dd3fc; }
.sgap-head .x { all: unset; cursor: pointer; margin-left: auto; color: #8394ad; font-size: 15px; }
.sgap h5 { margin: 9px 0 4px; font: 700 9.5px 'Segoe UI', sans-serif; letter-spacing: 1.5px; text-transform: uppercase; color: #6f8099; display: flex; align-items: center; gap: 6px; }
.sgap h5 .sub { font-weight: 400; letter-spacing: 0; text-transform: none; color: #56657c; }
.sgap-icons { display: flex; flex-wrap: wrap; gap: 4px; }
.sgap-ic { position: relative; width: 34px; height: 34px; border-radius: 7px; background: rgba(4, 8, 16, 0.55); border: 1px solid rgba(140, 170, 220, 0.2); display: flex; align-items: center; justify-content: center; cursor: context-menu; }
.sgap-ic img { width: 26px; height: 26px; }
.sgap-ic .t { position: absolute; right: 1px; bottom: -1px; font: 700 9px 'Segoe UI', sans-serif; color: #fbbf24; text-shadow: 0 0 2px #000; }
.sgap-ic.black { border-color: rgba(248, 113, 113, 0.5); }
.sgap-ic.black::after { content: ''; position: absolute; left: 4px; right: 4px; top: 50%; height: 2px; background: rgba(248, 113, 113, 0.85); transform: rotate(-35deg); }
.sgap-add { all: unset; cursor: pointer; width: 34px; height: 34px; box-sizing: border-box; border-radius: 7px; border: 1px dashed rgba(125, 211, 252, 0.4); color: #7dd3fc; display: flex; align-items: center; justify-content: center; font-size: 16px; }
.sgap-add:hover { background: rgba(125, 211, 252, 0.12); }
.sgap-none { color: #56657c; font-size: 11px; padding: 2px 0; }
.sgap-mode { display: flex; align-items: center; gap: 7px; margin-top: 7px; cursor: pointer; }
.sgap-mode input { accent-color: #86efac; }
.sgap-tpl { display: flex; flex-wrap: wrap; gap: 5px; }
.sgap-tpl button { all: unset; cursor: pointer; padding: 2px 9px; border-radius: 999px; border: 1px solid rgba(125, 211, 252, 0.35); color: #bae6fd; font-size: 11px; }
.sgap-tpl button:hover { background: rgba(125, 211, 252, 0.14); }
`;
  document.head.appendChild(css);
}

export class AutoPickupPanel {
  private root: HTMLDivElement;
  private body: HTMLDivElement;
  private key = '';

  constructor(private pilot: PilotState, private picker: CataloguePicker, private send: (m: ClientMessage) => void, private sound: (id: string) => void) {
    injectWindowStyles();
    injectStyles();
    this.root = document.createElement('div');
    this.root.className = 'sgap';
    this.root.dataset.hudAvoid = '1';
    this.root.innerHTML = '<div class="sgap-head"><b>AUTO-PICKUP</b><button type="button" class="x" aria-label="Close">×</button></div><div class="sgap-body"></div>';
    this.body = this.root.querySelector('.sgap-body') as HTMLDivElement;
    (this.root.querySelector('.x') as HTMLElement).onclick = () => this.close();
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    document.body.appendChild(this.root);
    pilot.onChange(() => this.render());
  }

  get isOpen(): boolean { return this.root.classList.contains('on'); }

  toggle(): void { if (this.isOpen) this.close(); else this.open(); }

  open(): void {
    this.root.classList.add('on');
    this.key = '';
    this.render();
    this.sound('ui_open');
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.classList.remove('on');
    hideTip();
    this.sound('ui_close');
  }

  /** Next to the cargo panel, whatever its size */
  placeBy(rect: DOMRect | null): void {
    if (!rect) return;
    this.root.style.left = `${Math.round(rect.right + 10)}px`;
    this.root.style.bottom = `${Math.round(innerHeight - rect.bottom)}px`;
  }

  private icon(id: string, cls: string, badge: string, tip: string, menu: (e: MouseEvent) => void): HTMLElement {
    const econ = this.pilot.econ;
    const d = document.createElement('div');
    d.className = `sgap-ic ${cls}`;
    d.innerHTML = `<img src="${itemIcon(econ, id)}" alt="">${badge ? `<span class="t">${esc(badge)}</span>` : ''}`;
    d.addEventListener('mousemove', (e) => showTip(itemTipHtml(econ, id, { hint: tip }), e.clientX, e.clientY));
    d.addEventListener('mouseleave', hideTip);
    d.addEventListener('contextmenu', (e) => { e.preventDefault(); hideTip(); menu(e); });
    return d;
  }

  private addButton(label: string, run: () => void): HTMLElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sgap-add';
    b.title = label;
    b.textContent = '+';
    b.onclick = run;
    return b;
  }

  private render(): void {
    if (!this.isOpen) return;
    const p = this.pilot, mode = p.mining();
    const templates = p.profile?.pickup?.templates ?? [];
    const key = JSON.stringify([p.ghosts, mode, templates]);
    if (key === this.key) return;
    this.key = key;
    this.body.replaceChildren();
    // Mining mode (the cargo panel's switch, mirrored)
    const m = document.createElement('label');
    m.className = 'sgap-mode';
    m.innerHTML = `<input type="checkbox"${mode.on ? ' checked' : ''}><span>Mining mode: pick up every ore but the blacklisted</span>`;
    (m.querySelector('input') as HTMLInputElement).onchange = (e) => { this.send({ type: 'pickupPrefs', mining: (e.target as HTMLInputElement).checked }); this.sound('ui_click'); };
    this.body.appendChild(m);

    // The whitelist: this hold's
    const wh = document.createElement('h5');
    wh.innerHTML = 'Whitelist <span class="sub">this ship\'s hold</span>';
    const wl = document.createElement('div');
    wl.className = 'sgap-icons';
    for (const g of p.ghosts) {
      const tip = g.n === undefined ? 'Always picked up; 5 units of hold space kept for it. Right-click: set a target or remove' : `Picked up until you hold ${g.n}; the space for them is kept. Right-click: change or remove`;
      wl.appendChild(this.icon(g.item, '', g.n === undefined ? '∞' : String(g.n), tip, (e) => openMenu(e.clientX, e.clientY, [
        { label: g.n === undefined ? 'Set a target…' : 'Change the target…', run: () => askValue(e.clientX, e.clientY, 'Pick up until I hold', 'number', String(g.n ?? 20), (v) => this.send({ type: 'ghost', item: g.item, n: Math.max(1, Math.floor(Number(v)) || 1) })) },
        ...(g.n !== undefined ? [{ label: 'Unlimited', run: () => this.send({ type: 'ghost', item: g.item }) }] : []),
        { label: 'Remove', bad: true, run: () => this.send({ type: 'ghost', item: g.item, remove: true }) },
      ])));
    }
    wl.appendChild(this.addButton('Add items to pick up (the catalogue)', () => this.picker.open('whitelist')));
    this.body.append(wh, wl);

    // The blacklist: the pilot's
    const bh = document.createElement('h5');
    bh.innerHTML = 'Blacklist <span class="sub">ores mining mode leaves</span>';
    const bl = document.createElement('div');
    bl.className = 'sgap-icons';
    for (const id of mode.blacklist ?? []) {
      bl.appendChild(this.icon(id, 'black', '', 'Mining mode leaves it. Right-click: remove from the blacklist', (e) => openMenu(e.clientX, e.clientY, [
        { label: 'Remove from the blacklist', run: () => this.send({ type: 'oreBlacklist', item: id, on: false }) },
      ])));
    }
    bl.appendChild(this.addButton('Blacklist an ore (the catalogue)', () => this.picker.open('blacklist')));
    this.body.append(bh, bl);

    // Templates: whitelists saved in the profile
    const th = document.createElement('h5');
    th.textContent = 'Templates';
    const tl = document.createElement('div');
    tl.className = 'sgap-tpl';
    for (const t of templates) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t.name;
      b.title = `Load: this hold picks up ${t.ghosts.length} item${t.ghosts.length === 1 ? '' : 's'} (right-click to delete)`;
      b.onclick = () => { this.send({ type: 'ghostTemplate', load: t.name }); this.sound('ui_click'); };
      b.oncontextmenu = (e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, [{ label: `Delete "${t.name}"`, bad: true, run: () => this.send({ type: 'ghostTemplate', remove: t.name }) }]); };
      tl.appendChild(b);
    }
    if (p.ghosts.length) {
      const save = document.createElement('button');
      save.type = 'button';
      save.textContent = 'Save as…';
      save.onclick = (e) => askValue(e.clientX, e.clientY, 'Template name', 'text', '', (v) => this.send({ type: 'ghostTemplate', save: v }));
      tl.appendChild(save);
    }
    if (!templates.length && !p.ghosts.length) {
      const n = document.createElement('div');
      n.className = 'sgap-none';
      n.textContent = 'Whitelist some items, then save them as a template.';
      tl.appendChild(n);
    }
    this.body.append(th, tl);
  }
}
