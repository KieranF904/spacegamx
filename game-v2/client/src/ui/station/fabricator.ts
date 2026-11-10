/**
 * Station tab: Fabricator.
 *
 * Owns: the category list, the picked module or item (grades, sizes, ammunition, what it takes), the make bar (Make, Queue, Order) and the build queue beside it; the picked category, selection, grade, size and quantity.
 * Needs: StationCtx (the pilot, the station jobs, send/sound, render, the jobs ticker, waitingHtml), fabCats.ts (the categories), fabGems.ts.
 * Extend: a new category is an entry in FAB_CATS (fabCats.ts); a new picked-item layout is a fab* method here.
 */

import {
  Bag, CraftRecipe, canCraft, partItemId, PIECE_NAMES, RARITY_COLOR, FN_NAMES, partStats, gradeOf, markName, unlocks, CATEGORY_LABEL, stationLearned, type ItemDef, type FunctionDef,
} from '@space-game/common';
import { FAMILY_LABEL, familyLabel, familyRank, keyStats, modelLock, sizeText, tradeOff } from '../../ships/modelCards';
import { costHtml, itemTipHtml, showTip, hideTip } from '../windowKit';
import { itemIcon } from '../itemIcons';
import { esc, fmt, STATION } from './shared';
import { type FabCat, type FabEntry, FAB_CATS, licenceFor } from './fabCats';
import { waitingHtml } from './jobs';
import { renderGems } from './fabGems';
import type { StationCtx } from './shared';

export class FabricatorTab {
  constructor(private c: StationCtx) {}
  private get d() { return this.c.d; }
  private get st() { return this.c.st; }
  // Fabricator: a category, what's picked in each (a module's function or a recipe), the module's grade and size, and how many
  private fabCat: FabCat = 'weapons';
  private fabSel: Partial<Record<FabCat, string>> = {};
  private fabMat = 'alloy';
  private fabPiece = '';
  private fabQty = 1;
  /**
   * The fabricator: what to make down the left (categories, the open one's
   * modules or items), the picked one in the middle (what it is and does, its
   * grade and size, what it takes, how many, Make), and the queue on the right.
   */
  render(b: HTMLElement): void {
    const econ = this.d.pilot.econ;
    // (an armoury's own rounds only once your station's armoury presses them)
    const learned = stationLearned(this.d.pilot.profile?.recipes ?? [], this.d.pilot.profile?.outpost ?? undefined, STATION);
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns: 232px minmax(0, 1fr) 250px; gap:12px; height: min(580px, calc(100vh - 230px));';
    const nav = document.createElement('div');
    nav.className = 'sgw-col';
    nav.style.padding = '8px';
    const cats = (Object.keys(FAB_CATS) as FabCat[]).map((id) => ({ id, entries: id === 'gems' ? [] : this.fabEntries(id, learned) }))
      .filter((c) => c.id === 'gems' || c.entries.length);
    if (!cats.some((c) => c.id === this.fabCat)) this.fabCat = cats[0].id;
    // Categories, all in view
    const catGrid = document.createElement('div');
    catGrid.className = 'sgw-cats';
    for (const { id, entries } of cats) {
      const c = FAB_CATS[id];
      const open = entries.filter((e) => !e.locked).length;
      const cat = document.createElement('button');
      cat.className = this.fabCat === id ? 'on' : '';
      cat.dataset.fabcat = id;
      cat.innerHTML = `<img src="${itemIcon(econ, c.icon)}"><span>${c.label}</span>`;
      cat.title = c.title + (entries.length ? `: ${open} of ${entries.length} you can make` : '');
      cat.onclick = () => { this.fabCat = id; this.fabQty = 1; this.c.render(); this.d.sound('ui_click', 0.3); };
      catGrid.appendChild(cat);
    }
    nav.appendChild(catGrid);
    // The open category's modules or items
    const entries = cats.find((c) => c.id === this.fabCat)!.entries;
    const list = document.createElement('div');
    list.className = 'sgw-nav';
    if (entries.length) {
      const open = entries.filter((e) => !e.locked).length;
      list.insertAdjacentHTML('beforeend', `<div class="hd">${FAB_CATS[this.fabCat].title}<span>${open < entries.length ? `${open} of ${entries.length} unlocked` : ''}</span></div>`);
    }
    const picked = this.fabPicked(this.fabCat, entries);
    let group = '';
    for (const e of entries) {
      if (e.group && e.group !== group) { group = e.group; list.insertAdjacentHTML('beforeend', `<div class="grp">${esc(group)}</div>`); }
      const s = document.createElement('button');
      s.className = (picked === e.key ? 'on' : '') + (e.locked ? ' locked' : '');
      s.innerHTML = `<img src="${e.icon}"><span>${esc(e.name)}</span><span class="n">${e.locked ? `🔒${e.badge ? ` ${esc(e.badge)}` : ''}` : e.have ? `×${e.have}` : ''}</span>`;
      s.title = e.locked ? `${e.name}: ${e.why ?? 'it opens at a later level'}` : e.have ? `${e.name}: you have ${e.have}` : e.name;
      const cat = this.fabCat;
      s.onclick = () => { this.fabSel[cat] = e.key; this.fabQty = 1; this.c.render(); };
      list.appendChild(s);
    }
    if (this.fabCat === 'gems') list.insertAdjacentHTML('beforeend', '<div class="hd">Gems</div><div style="color:#8394ad; font-size:12px; line-height:1.5; padding:4px 8px">Cut raw gems into stones, and set them into the sockets of steel and better guns.</div>');
    nav.appendChild(list);
    if (FAB_CATS[this.fabCat].fns.length) {
      const note = document.createElement('div');
      note.style.cssText = 'color:#56657c; font-size:11px; line-height:1.45; padding:8px 4px 0; flex-shrink:0; border-top:1px solid rgba(140,170,220,0.08); margin-top:6px;';
      note.textContent = 'Hull, armour and cargo holds aren\'t made here: the hangar builds them from refined plate. Wire spools are under Components.';
      nav.appendChild(note);
    }

    // The picked one
    const main = document.createElement('div');
    main.className = 'sgw-col';
    main.style.padding = '0';
    const content = document.createElement('div');
    content.style.cssText = 'flex:1; min-height:0; overflow-y:auto; padding:12px; display:flex; flex-direction:column;';
    main.appendChild(content);
    if (this.fabCat === 'gems') {
      renderGems(this.c, content);
    } else {
      const key = picked;
      if (FAB_CATS[this.fabCat].fns.length) main.appendChild(this.fabModule(content, key, learned));
      else {
        const r = econ.recipes.craft.get(key) ?? null;
        if (r) main.appendChild(this.fabItem(content, r, learned));
      }
    }
    grid.append(nav, main, this.fabSide());
    b.append(grid);
    this.c.renderJobs();
  }

  /** What's picked in a category (the first you can make, until you pick) */
  private fabPicked(cat: FabCat, entries: FabEntry[]): string {
    const now = this.fabSel[cat];
    if (now && entries.some((e) => e.key === now)) return now;
    return (entries.find((e) => !e.locked) ?? entries[0])?.key ?? '';
  }

  /** A category's entries: its modules (by function), or its recipes; the ones you can make first */
  private fabEntries(cat: FabCat, learned: string[]): FabEntry[] {
    const econ = this.d.pilot.econ;
    const c = FAB_CATS[cat];
    if (c.fns.length) {
      // Models (each in its own material) in their families, and the core; locked ones say what unlocks them
      const level = this.d.pilot.profile?.level ?? 1, items = econ.items.all();
      const known = (fn: string) => [...econ.ships.materials.keys()].some((m) => canCraft({ id: partItemId({ material: m, fn, piece: 'sq' }), out: {}, inputs: {}, time: 0 }, learned, level));
      return c.fns.filter((f) => econ.ships.functions.has(f)).map((f, i): FabEntry => {
        const fn = econ.ships.functions.get(f)!;
        const piece = fn.pieces === '*' ? 'sq' : fn.pieces[0];
        if (!fn.model) return { key: f, name: fn.name ?? FN_NAMES[f] ?? f, icon: itemIcon(econ, partItemId({ material: 'alloy', fn: f, piece })), locked: !known(f), order: i };
        const id = partItemId({ material: fn.material!, fn: f, piece });
        const r = econ.recipes.recipeFor(id);
        const lock = modelLock(fn, !!r && canCraft(r, learned, level), level, items);
        const group = familyLabel(fn);
        return { key: f, name: fn.name ?? f, icon: itemIcon(econ, id), locked: !lock.open, have: this.c.have(id), group, badge: lock.badge, why: lock.why, order: familyRank(group) * 1000 + i };
      }).sort((a, b) => a.order - b.order);
    }
    // Recipes: a job's own kit only while you're on it
    const gunName = new Map<string, { name: string; order: number }>();
    // (ammunition by the guns that fire it: their family)
    FAB_CATS.weapons.fns.forEach((f, i) => { const w = econ.ships.functions.get(f)?.weapon; if (w && !gunName.has(w)) gunName.set(w, { name: FAMILY_LABEL[w] ?? FN_NAMES[f] ?? f, order: i }); });
    for (const f of FAB_CATS.utility.fns) { const w = econ.ships.functions.get(f)?.weapon; if (w && !gunName.has(w)) gunName.set(w, { name: FAMILY_LABEL[w] ?? FN_NAMES[f] ?? f, order: 100 }); }
    return [...econ.recipes.craft.values()]
      .filter((r) => (!r.quest || this.d.quests.active.some((q) => q.id === r.quest)) && c.items!(econ.items.get(Object.keys(r.out)[0])))
      .map((r, i) => {
        const outId = Object.keys(r.out)[0], d = econ.items.get(outId);
        const gun = d?.ammoFor ? gunName.get(d.ammoFor.weapon) : undefined;
        return { key: r.id, name: econ.items.name(outId), icon: itemIcon(econ, outId), locked: !canCraft(r, learned, this.d.pilot.profile?.level ?? 1), have: this.c.have(outId),
          group: d?.ammoFor ? `For ${gun?.name ?? d.ammoFor.weapon}` : undefined, order: (gun?.order ?? 200) * 1000 + (d?.ammoFor?.mods ? 1 : 0) * 100 + i };
      })
      .sort((a, b) => cat === 'ammo' ? a.order - b.order : Number(a.locked) - Number(b.locked) || a.order - b.order);
  }

  /** A module: what it does, its grades (and what each gives), its sizes; returns its make bar */
  private fabModule(el: HTMLElement, fnId: string, learned: string[]): HTMLElement {
    const econ = this.d.pilot.econ;
    const fn = econ.ships.functions.get(fnId)!;
    if (fn.model) return this.fabModel(el, fn, learned);
    const area = (pc: string) => econ.ships.variants.get(pc)?.[0]?.area ?? 0;
    const pieces = (fn.pieces === '*' ? econ.ships.pieceIds : fn.pieces).filter((pc) => area(pc) >= 1 - 1e-9).sort((a, b) => area(a) - area(b));
    if (!pieces.includes(this.fabPiece)) this.fabPiece = pieces[0];
    if (!econ.ships.materials.has(this.fabMat)) this.fabMat = 'alloy';
    const pid = (material: string, piece = this.fabPiece) => partItemId({ material, fn: fnId, piece });
    const id = pid(this.fabMat);
    const r = econ.recipes.recipeFor(id);
    const stats = (material: string, piece = this.fabPiece) => partStats(econ.ships, econ.tuning, { material, fn: fnId, piece });
    const n0 = (v: number) => Math.round(v).toLocaleString();
    const key = (material: string) => {
      const st = stats(material);
      if (!st) return '';
      return st.dps !== undefined ? `<b style="color:#fca5a5">${n0(st.dps)}</b> dmg/s`
        : st.supply ? `<b style="color:#86efac">+${n0(st.supply)}</b> power`
        : st.thrust ? `<b style="color:#93c5fd">${st.thrust.toFixed(1)}</b> thrust`
        : st.shield ? `<b style="color:#7dd3fc">${n0(st.shield)}</b> shield`
        : `<b style="color:#e5ecf7">${n0(st.hp)}</b> hp`;
    };
    // What it is
    const desc = econ.items.get(pid('alloy', pieces[0]))?.description ?? '';
    const extra = fn.weapon ? 'Bigger guns hit harder for the power they draw; better grades hit harder still, and draw more.'
      : (fn.produce ?? 0) > 0 ? 'Better grades make more power: what better weapons and shields need.'
      : (fn.thrust ?? 0) > 0 ? `Bigger engines push more for their size; better grades push harder. Boosting: ×${fn.boost ?? 2.2} push, ${fn.boostDrain ?? 1}× battery drain.` : '';
    el.insertAdjacentHTML('beforeend', `<div style="display:flex; gap:12px; align-items:flex-start">
      <img src="${itemIcon(econ, id)}" style="width:52px; height:52px; flex-shrink:0; border-radius:10px; background:rgba(255,255,255,0.04)">
      <div style="min-width:0"><div style="font-size:16px; font-weight:600; color:#e5ecf7">${esc(FN_NAMES[fnId] ?? fnId)}</div>
      <div style="color:#a7b4c8; font-size:12px; line-height:1.45; margin-top:2px">${esc(desc)} ${esc(extra)}</div></div></div>`);
    // Grades: what each gives at this size, and which you can make
    const mats = [...econ.ships.materials.values()].filter((m) => !m.exclusive).sort((a, b) => gradeOf(a) - gradeOf(b));
    el.insertAdjacentHTML('beforeend', `<div class="sgw-label">Grade <span>better grades do more and take more hits · 🔒 opens at a later level</span></div>`);
    const grades = document.createElement('div');
    grades.style.cssText = 'display:grid; grid-template-columns: repeat(auto-fill, minmax(124px, 1fr)); gap:5px;';
    for (const m of mats) {
      const ok = canCraft({ id: pid(m.id), out: {}, inputs: {}, time: 0 }, learned, this.d.pilot.profile?.level ?? 1);
      const t = document.createElement('button');
      t.className = 'sgw-pick' + (this.fabMat === m.id ? ' on' : '') + (ok ? '' : ' locked');
      t.innerHTML = `<div style="display:flex; align-items:center; gap:5px; white-space:nowrap; overflow:hidden"><span style="color:${m.color}">■</span><span style="overflow:hidden; text-overflow:ellipsis">${esc(m.name ?? m.id)}</span>${ok ? '' : '<span style="margin-left:auto">🔒</span>'}</div>`
        + `<div style="font-size:11px; color:#8394ad; margin-top:2px; white-space:nowrap">${markName(gradeOf(m))} · ${key(m.id)}</div>`;
      t.title = `${m.name ?? m.id}: ${Math.round((m.output ?? 1) * 100)}% output, ${m.toughness} toughness, ${m.density} mass per cell`
        + (ok ? '' : `\nNeeds ${licenceFor({ id: pid(m.id), out: {}, inputs: {}, time: 0 }, learned, econ.items, this.d.pilot.profile?.level ?? 1)}`);
      t.onclick = () => { this.fabMat = m.id; this.fabQty = 1; this.c.render(); };
      grades.appendChild(t);
    }
    el.appendChild(grades);
    // Sizes (or shapes)
    el.insertAdjacentHTML('beforeend', `<div class="sgw-label">Size <span>bigger takes more cells, does more</span></div>`);
    const sizes = document.createElement('div');
    sizes.style.cssText = 'display:grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap:5px;';
    for (const pc of pieces) {
      const st = stats(this.fabMat, pc);
      const pr = econ.recipes.recipeFor(pid(this.fabMat, pc));
      const t = document.createElement('button');
      t.className = 'sgw-pick' + (this.fabPiece === pc ? ' on' : '');
      t.style.cssText = 'display:flex; align-items:center; gap:8px;';
      const what = st ? [
        st.dps !== undefined ? `${n0(st.dps)} dmg/s` : '', st.supply ? `+${n0(st.supply)} power` : '', st.draw ? `draws ${n0(st.draw)}` : '',
        st.thrust ? `thrust ${st.thrust.toFixed(1)}` : '', st.shield ? `shield ${n0(st.shield)}` : '', `${n0(st.hp)} hp`,
      ].filter(Boolean).join(' · ') : '';
      const have = this.c.have(pid(this.fabMat, pc));
      t.innerHTML = `<img src="${itemIcon(econ, pid(this.fabMat, pc))}" style="width:30px; height:30px; flex-shrink:0">`
        + `<div style="min-width:0; flex:1"><div style="white-space:nowrap">${esc(st?.size || PIECE_NAMES[pc] || pc)} <small style="color:#8394ad">${esc(PIECE_NAMES[pc] ?? pc)}, ${Math.round(st?.area ?? 1)} cell${(st?.area ?? 1) > 1 ? 's' : ''}</small></div>`
        + `<div style="font-size:11px; color:#a7b4c8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${what}</div></div>`
        + `<div style="font-size:11px; color:#8394ad; text-align:right; white-space:nowrap">${have ? `<span style="color:#86efac">have ${have}</span><br>` : ''}${pr ? (pr.time > 0 ? fmt(pr.time) : 'instant') : ''}</div>`;
      t.addEventListener('mousemove', (e) => showTip(itemTipHtml(econ, pid(this.fabMat, pc), { count: have }), e.clientX, e.clientY));
      t.addEventListener('mouseleave', hideTip);
      t.onclick = () => { this.fabPiece = pc; this.fabQty = 1; this.c.render(); };
      sizes.appendChild(t);
    }
    el.appendChild(sizes);
    // Its ammunition, a click away
    const w = fn.weapon;
    const crates = w ? [...econ.recipes.craft.values()].filter((x) => econ.items.get(Object.keys(x.out)[0])?.ammoFor?.weapon === w) : [];
    if (crates.length) {
      el.insertAdjacentHTML('beforeend', `<div class="sgw-label">Ammunition <span>it fires from crates in your hold</span></div>`);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:5px; flex-wrap:wrap;';
      for (const x of crates) {
        const outId = Object.keys(x.out)[0];
        const c = document.createElement('button');
        c.className = 'sgw-chip';
        c.innerHTML = `<img src="${itemIcon(econ, outId)}" style="width:16px; height:16px; vertical-align:-4px"> ${esc(econ.items.name(outId))}${this.c.have(outId) ? ` <small style="color:#86efac">×${this.c.have(outId)}</small>` : ''}`;
        c.onclick = () => { this.fabCat = 'ammo'; this.fabSel.ammo = x.id; this.fabQty = 1; this.c.render(); };
        row.appendChild(c);
      }
      el.appendChild(row);
    }
    const locked = r && !canCraft(r, learned, this.d.pilot.profile?.level ?? 1) ? licenceFor(r, learned, econ.items, this.d.pilot.profile?.level ?? 1) : null;
    return this.makeBar(r, locked, `${markName(gradeOf(econ.ships.materials.get(this.fabMat)!))} ${econ.items.name(id)}`);
  }

  /**
   * A model (docs/parts-redesign.md §1): what it is and its trade-off, its
   * family, size and numbers, the level it's learned at (never earlier),
   * what it's made from; returns its make bar
   */
  private fabModel(el: HTMLElement, fn: FunctionDef, learned: string[]): HTMLElement {
    const econ = this.d.pilot.econ, level = this.d.pilot.profile?.level ?? 1;
    const pieces = fn.pieces === '*' ? ['sq'] : fn.pieces;
    if (!pieces.includes(this.fabPiece)) this.fabPiece = pieces[0];
    const mat = fn.material ?? 'alloy';
    const pid = (piece = this.fabPiece) => partItemId({ material: mat, fn: fn.id, piece });
    const id = pid();
    const r = econ.recipes.recipeFor(id);
    const lock = modelLock(fn, !!r && canCraft(r, learned, level), level, econ.items.all());
    const st = partStats(econ.ships, econ.tuning, { material: mat, fn: fn.id, piece: this.fabPiece });
    const n0 = (v: number) => Math.round(v).toLocaleString();
    const m = econ.ships.materials.get(mat);
    el.insertAdjacentHTML('beforeend', `<div style="display:flex; gap:12px; align-items:flex-start">
      <img src="${itemIcon(econ, id)}" style="width:52px; height:52px; flex-shrink:0; border-radius:10px; background:rgba(255,255,255,0.04)">
      <div style="min-width:0"><div style="font-size:16px; font-weight:600; color:${RARITY_COLOR[fn.rarity ?? 'common'] ?? '#e5ecf7'}">${esc(fn.name ?? fn.id)}</div>
      <div style="color:#8394ad; font-size:11px; letter-spacing:0.5px">${esc(familyLabel(fn))} · ${esc(sizeText(econ.ships, fn))} · ${markName(fn.grade ?? 1)}</div>
      <div style="color:#a7b4c8; font-size:12px; line-height:1.45; margin-top:4px">${esc(fn.description ?? '')}</div>
      <div style="color:#fbbf24; font-size:12px; font-style:italic; margin-top:2px">${esc(tradeOff(fn))}</div></div></div>`);
    const rows: [string, string][] = [];
    rows.push(['Does', esc(keyStats(econ.ships, econ.tuning, fn, this.fabPiece))]);
    if (st) rows.push(['Hull', `${n0(st.hp)} hp · ${st.mass.toFixed(1)} mass · armour ${st.armour}`]);
    rows.push(['Made of', `<span style="color:${m?.color ?? '#cfd8e6'}">■</span> ${esc(m?.name ?? mat)} <small style="color:#8394ad">(its own: its hit points, mass and resistances)</small>`]);
    if (fn.points !== undefined && st) rows.push(['Build points', `${Math.round(fn.points * st.area * 10) / 10}`]);
    rows.push(['Learned at', fn.unlock ? `level ${fn.unlock.level}${level >= fn.unlock.level ? ' <span style="color:#86efac">✓</span>' : ` <span style="color:#fca5a5">(you're ${level})</span>`}` : '<span style="color:#c4b5fd">no pilot can make it</span>']);
    rows.push(['You have', `${this.c.have(id)}`]);
    el.insertAdjacentHTML('beforeend', `<div style="margin-top:12px; display:grid; grid-template-columns: 90px 1fr; gap:5px 10px; font-size:12px">${rows.map(([k, v]) => `<span style="color:#8394ad">${k}</span><span>${v}</span>`).join('')}</div>`);
    // Sizes it comes in (most models one)
    if (pieces.length > 1) {
      el.insertAdjacentHTML('beforeend', `<div class="sgw-label">Size</div>`);
      const sizes = document.createElement('div');
      sizes.style.cssText = 'display:grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap:5px;';
      for (const pc of pieces) {
        const t = document.createElement('button');
        t.className = 'sgw-pick' + (this.fabPiece === pc ? ' on' : '');
        t.style.cssText = 'display:flex; align-items:center; gap:8px;';
        t.innerHTML = `<img src="${itemIcon(econ, pid(pc))}" style="width:30px; height:30px; flex-shrink:0"><div style="min-width:0; flex:1"><div>${esc(PIECE_NAMES[pc] ?? pc)}</div>`
          + `<div style="font-size:11px; color:#a7b4c8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${esc(keyStats(econ.ships, econ.tuning, fn, pc))}</div></div>`;
        t.onclick = () => { this.fabPiece = pc; this.fabQty = 1; this.c.render(); };
        sizes.appendChild(t);
      }
      el.appendChild(sizes);
    }
    // Its ammunition, a click away
    const crates = fn.weapon ? [...econ.recipes.craft.values()].filter((x) => econ.items.get(Object.keys(x.out)[0])?.ammoFor?.weapon === fn.weapon) : [];
    if (crates.length) {
      el.insertAdjacentHTML('beforeend', `<div class="sgw-label">Ammunition <span>it fires from crates in your hold</span></div>`);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:5px; flex-wrap:wrap;';
      for (const x of crates) {
        const outId = Object.keys(x.out)[0];
        const c = document.createElement('button');
        c.className = 'sgw-chip';
        c.innerHTML = `<img src="${itemIcon(econ, outId)}" style="width:16px; height:16px; vertical-align:-4px"> ${esc(econ.items.name(outId))}${this.c.have(outId) ? ` <small style="color:#86efac">×${this.c.have(outId)}</small>` : ''}`;
        c.onclick = () => { this.fabCat = 'ammo'; this.fabSel.ammo = x.id; this.fabQty = 1; this.c.render(); };
        row.appendChild(c);
      }
      el.appendChild(row);
    }
    return this.makeBar(r, lock.open ? null : lock.why, econ.items.name(id), true);
  }

  /** An item recipe (ammunition, supplies, components): what it is and what it's for; returns its make bar */
  private fabItem(el: HTMLElement, r: CraftRecipe, learned: string[]): HTMLElement {
    const econ = this.d.pilot.econ;
    const outId = Object.keys(r.out)[0];
    const d: ItemDef | undefined = econ.items.get(outId);
    const rows: [string, string][] = [];
    if (d?.ammoFor) {
      const fns = [...econ.ships.functions.values()].filter((f) => f.weapon === d.ammoFor!.weapon && !f.legacy && !f.exclusive);
      const names = fns.map((f) => f.name ?? FN_NAMES[f.id] ?? f.id);
      const ids = new Set(fns.map((f) => f.id));
      const slot = this.d.pilot.hangar?.active ?? 0;
      const onShip = (this.d.pilot.hangar?.slots[slot]?.blueprint.parts ?? []).filter((q) => ids.has(q.fn)).length;
      rows.push(['For', esc(names.join(', ') || d.ammoFor.weapon)]);
      rows.push(['A crate', `${d.ammoFor.rounds} rounds`]);
      rows.push(['Your ship', onShip ? `<span style="color:#86efac">${onShip} gun${onShip > 1 ? 's' : ''} that fire${onShip > 1 ? '' : 's'} it</span>` : '<span style="color:#8394ad">nothing that fires it</span>']);
    }
    // A component: the models it goes into
    if (d?.category === 'component') {
      const into = [...econ.ships.functions.values()].filter((f) => f.model && !f.exclusive && (f.pieces === '*' ? ['sq'] : f.pieces).some((pc) => (econ.recipes.recipeFor(partItemId({ material: f.material!, fn: f.id, piece: pc }))?.inputs[outId] ?? 0) > 0));
      if (into.length) rows.push(['Goes into', esc(into.map((f) => f.name ?? f.id).join(', '))]);
    }
    if (r.out[outId] > 1) rows.push(['Makes', `${r.out[outId]} a batch`]);
    rows.push(['You have', `${this.c.have(outId)}`]);
    el.insertAdjacentHTML('beforeend', `<div style="display:flex; gap:12px; align-items:flex-start">
      <img src="${itemIcon(econ, outId)}" style="width:52px; height:52px; flex-shrink:0; border-radius:10px; background:rgba(255,255,255,0.04)">
      <div style="min-width:0"><div style="font-size:16px; font-weight:600; color:${d ? RARITY_COLOR[d.rarity] : '#e5ecf7'}">${esc(econ.items.name(outId))}</div>
      <div style="color:#8394ad; font-size:11px; letter-spacing:0.5px">${d ? CATEGORY_LABEL[d.category] : ''}</div>
      <div style="color:#a7b4c8; font-size:12px; line-height:1.45; margin-top:4px">${esc(d?.description ?? '')}</div></div></div>
      <div style="margin-top:12px; display:grid; grid-template-columns: 90px 1fr; gap:5px 10px; font-size:12px">${rows.map(([k, v]) => `<span style="color:#8394ad">${k}</span><span>${v}</span>`).join('')}</div>`);
    // Other crates for the same guns
    if (d?.ammoFor) {
      const kin = [...econ.recipes.craft.values()].filter((x) => x.id !== r.id && econ.items.get(Object.keys(x.out)[0])?.ammoFor?.weapon === d.ammoFor!.weapon);
      if (kin.length) {
        el.insertAdjacentHTML('beforeend', `<div class="sgw-label">Other rounds for it</div>`);
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; gap:5px; flex-wrap:wrap;';
        for (const x of kin) {
          const id = Object.keys(x.out)[0];
          const c = document.createElement('button');
          c.className = 'sgw-chip';
          c.innerHTML = `<img src="${itemIcon(econ, id)}" style="width:16px; height:16px; vertical-align:-4px"> ${esc(econ.items.name(id))}${canCraft(x, learned, this.d.pilot.profile?.level ?? 1) ? '' : ' 🔒'}`;
          c.title = econ.items.get(id)?.description ?? '';
          c.onclick = () => { this.fabSel.ammo = x.id; this.fabQty = 1; this.c.render(); };
          row.appendChild(c);
        }
        el.appendChild(row);
      }
    }
    return this.makeBar(r, canCraft(r, learned, this.d.pilot.profile?.level ?? 1) ? null : licenceFor(r, learned, econ.items, this.d.pilot.profile?.level ?? 1), econ.items.name(outId));
  }

  /** The bottom of the picked one: what it takes (have / need), how long, how many, and the one button */
  private makeBar(r: CraftRecipe | null, locked: string | null, name: string, model = false): HTMLElement {
    const econ = this.d.pilot.econ;
    const bar = document.createElement('div');
    bar.style.cssText = 'flex-shrink:0; border-top:1px solid rgba(140,170,220,0.14); padding:10px 12px; background:rgba(125,211,252,0.03); border-radius:0 0 12px 12px;';
    if (!r) { bar.innerHTML = '<span style="color:#56657c">The fabricator doesn\'t make this</span>'; return bar; }
    // (a model: learned at its level, never earlier)
    if (locked && model) {
      bar.innerHTML = `<div style="display:flex; align-items:center; gap:4px 6px; flex-wrap:wrap; font-size:12px; opacity:0.7"><span style="color:#8394ad; margin-right:2px">Takes</span>${costHtml(econ, r.inputs, (id) => this.c.have(id))}`
        + `<span style="margin-left:auto; color:#8394ad; white-space:nowrap">${r.time > 0 ? `⏳ ${fmt(r.time)}` : 'instant'}</span></div>`
        + `<div style="color:#fca5a5; margin-top:8px">🔒 ${esc(locked)}</div><div style="color:#8394ad; font-size:11px; margin-top:3px">Levels come from jobs, fights and mining.</div>`;
      return bar;
    }
    if (locked) {
      bar.innerHTML = `<div style="color:#fca5a5">🔒 Needs ${esc(locked)}</div><div style="color:#8394ad; font-size:11px; margin-top:3px">Everything opens at its level (a job's kit with its job too). Levels come from jobs, fights and mining.</div>`;
      return bar;
    }
    const max = Math.min(...Object.entries(r.inputs).map(([id, n]) => Math.floor(this.c.have(id) / n)));
    const n = Math.max(1, Math.min(99, this.fabQty));
    const outId = Object.keys(r.out)[0];
    const need: Bag = Object.fromEntries(Object.entries(r.inputs).map(([id, k]) => [id, k * n]));
    bar.innerHTML = `<div style="display:flex; align-items:center; gap:4px 6px; flex-wrap:wrap; font-size:12px"><span style="color:#8394ad; margin-right:2px">Takes</span>${costHtml(econ, need, (id) => this.c.have(id))}`
      + `<span style="margin-left:auto; color:#8394ad; white-space:nowrap">${r.time > 0 ? `⏳ ${fmt(r.time * n)}${n > 1 ? ` (${fmt(r.time)} each)` : ''}` : 'instant'}</span></div>`
      + `<div style="display:flex; align-items:center; gap:6px; margin-top:9px"></div>`;
    const row = bar.lastElementChild as HTMLElement;
    const small = (label: string, to: number, title = '') => {
      const x = document.createElement('button');
      x.className = 'sgw-btn';
      x.style.cssText = 'padding:5px 10px;';
      x.textContent = label;
      x.title = title;
      x.onclick = () => { this.fabQty = Math.max(1, Math.min(99, to)); this.c.render(); };
      return x;
    };
    const qty = document.createElement('span');
    qty.style.cssText = 'min-width:28px; text-align:center; font-size:15px; font-weight:600; color:#e5ecf7;';
    qty.textContent = String(n);
    row.append(small('−', n - 1), qty, small('+', n + 1), small('×5', 5), small(`Max${max > 0 ? ` ${Math.min(99, max)}` : ''}`, max, 'As many as your materials make'));
    if (max <= 0) (row.lastElementChild as HTMLElement).classList.add('off');
    const status = document.createElement('span');
    status.style.cssText = 'flex:1; text-align:right; font-size:11px;';
    status.innerHTML = max >= n ? `<span style="color:#8394ad">${n * r.out[outId]} × ${esc(name)}</span>`
      : `<span style="color:#fbbf24">${max > 0 ? `Enough for ${max} now` : 'Short of materials'}: order it, and it's refined and made as ore comes in</span>`;
    const go = document.createElement('button');
    go.className = 'sgw-btn primary';
    go.style.cssText = 'padding:8px 22px; font-size:13px; font-weight:600;';
    go.textContent = `${r.time > 0 ? 'Queue' : 'Make'}${n > 1 ? ` ${n}` : ''}`;
    go.title = r.time > 0 ? 'Goes into the build queue: it lands in storage when done, even if you leave' : 'Made at once, into storage';
    if (max < n) {
      // Short: an order instead, worked through as the ore comes in
      go.textContent = `Order${n > 1 ? ` ${n}` : ''}`;
      go.title = 'Refines what it\'s short of from your storage (waiting for ore if need be), then fabricates: all into storage';
      go.onclick = () => { this.d.send({ type: 'fabOrder', item: outId, n: n * r.out[outId] }); this.d.sound('ui_click', 0.5); };
    } else go.onclick = () => { this.d.send({ type: 'craft', recipe: r.id, n }); this.d.sound('ui_click', 0.5); };
    row.append(status, go);
    return bar;
  }
  /** The fabricator's queue, beside whatever it's showing */
  private fabSide(): HTMLElement {
    const side = document.createElement('div');
    side.className = 'sgw-col';
    side.innerHTML = `<h4>Build queue <span class="r">${this.st!.jobs.filter((j) => !j.recipe.startsWith('refine:')).length} / ${this.st!.queueSlots}</span></h4>`;
    side.style.overflowY = 'auto';
    const jobs = document.createElement('div');
    jobs.dataset.jobs = 'fab';
    const waiting = document.createElement('div');
    waiting.innerHTML = waitingHtml(this.c, 'part');
    side.append(jobs, waiting);
    // Orders: made as their materials come in
    const orders = this.d.pilot.hangar?.orders ?? [];
    if (orders.length) {
      const box = document.createElement('div');
      box.innerHTML = `<h4 style="margin-top:12px">Orders <span class="r">made as materials come in</span></h4>`;
      for (const o of orders) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid rgba(140,170,220,0.07); font-size:12px;';
        row.innerHTML = `<img src="${itemIcon(this.d.pilot.econ, o.item)}" style="width:22px;height:22px"><div style="flex:1">${esc(this.d.pilot.econ.items.name(o.item))} <b>${o.made} / ${o.n}</b><br><small style="color:#8394ad">${esc(o.waiting || 'starting')}</small></div>`;
        const x = document.createElement('button');
        x.className = 'sgw-btn';
        x.textContent = '✕';
        x.title = 'Call it off (its refining stops and the ore comes back)';
        x.onclick = () => this.d.send({ type: 'fabOrderCancel', id: o.id });
        row.appendChild(x);
        box.appendChild(row);
      }
      side.append(box);
    }
    const note = document.createElement('div');
    note.style.cssText = 'margin-top:auto; color:#56657c; font-size:11px; line-height:1.5; padding-top:10px;';
    note.textContent = 'Small modules are made at once. Bigger builds take time and keep going while you\'re away: they go to storage, wherever you are. Short of plate? Refine it first.';
    side.append(note);
    return side;
  }
}
