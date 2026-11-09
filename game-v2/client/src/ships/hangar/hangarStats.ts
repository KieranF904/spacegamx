/**
 * @contract client.hangar.stats
 * owns:       the hangar's right-hand panel: build, ammunition, power and summary sections, details and problems
 * needs:      HangarHost (deps, derived, bp, errors), shipSummary, portsReport; npm: @space-game/common
 * invariants: renderStats rebuilds the panel and rebinds its buttons — none pinned
 * extend:     a new section is one html function here, appended in renderStats()
 */

import { Bag, ShipTuning, ShipDerived, ghostBill, SALVAGE, buildPoints, loadoutKinds, cratesFor, crateOrder, MAX_LOADOUT_CRATES } from '@space-game/common';
import { cargoEffect, CATEGORY_MASS, strafeForce, bestDodge, burstEnergy, DODGE_FORWARD, DODGE_BACK, DODGE_LEFT, DODGE_RIGHT } from '@space-game/common';
import { gunDrawFlatOut, energyTuning, loadTest, BROWNOUT, type LoadTestResult } from '@space-game/common';
import { settings } from '../../settings/Settings';
import { boundKeyName } from '../../input/keybindings';
import { costHtml } from '../../ui/windowKit';
import { drawsText, portsReport, portsWarnings } from '../portsReport';
import { portsPanelHtml } from '../portsGrid';
import { esc } from '../../ui/escape';
import { itemIcon } from '../../ui/itemIcons';
import { shipSummary, designFields, ShipSummary, BIGGER_IS_BETTER, jumpRatioNote } from '../shipSummary';
import type { HangarHost } from './host';
import { btnCss } from './hangarWidgets';
import { applyChips } from '../build/statDeltaView';

/** The build panel: what host slot still needs, and buttons to make it */
export function buildHtml(host: HangarHost): string {
  const hs = host.deps.hangarState();
  const rec = hs?.slots[host.slot];
  if (!hs || host.grantAll) return '';
  const econ = host.deps.econ;
  let html = `<div style="color:#ffb547; font-weight:bold; margin-bottom:6px; font-family:'Segoe UI',sans-serif">BUILD</div>`;
  if (host.unsaved) {
    html += `<div style="font-family:'Segoe UI',sans-serif; color:#fbbf24; line-height:1.5; margin-bottom:10px">Unsaved changes: <b>Save</b> to build in what you have.<br><span style="color:#8ea0bd">Parts you don't have yet become ghosts that fill in as they're made.</span></div>`;
    return html;
  }
  if (!rec) return html + `<div style="font-family:'Segoe UI',sans-serif; color:#8ea0bd; margin-bottom:10px">Empty slot. Design a ship or load one of your plans, then Save.</div>`;
  const ghosts = new Set(rec.ghosts);
  // What the unbuilt parts take: modules as items, structure as its materials
  const need = ghostBill(econ, rec.blueprint, rec.ghosts);
  const coming = host.deps.coming();
  const ids = Object.keys(need).sort((a, b) => econ.items.rank(a) - econ.items.rank(b));
  const total = rec.blueprint.parts.length, built = total - rec.ghosts.length;
  const font = `font-family:'Segoe UI',sans-serif;`;
  if (rec.lost) html += `<div style="${font} color:#fbbf24; line-height:1.5; margin-bottom:8px">Lost in battle. ${Math.round(SALVAGE * 100)}% of its materials and all its components were salvaged: it's being rebuilt, and can't be flown until it's whole.</div>`;
  html += `<div style="${font} margin-bottom:6px">${built} / ${total} parts built${rec.auto && ids.length ? ' <span style="color:#7dd3fc">· on order</span>' : ''}</div>
    <div style="height:5px; border-radius:3px; background:#1a2438; overflow:hidden; margin-bottom:8px"><i style="display:block; height:100%; width:${(built / total) * 100}%; background:linear-gradient(90deg,#2c87ad,#7dd3fc)"></i></div>`;
  if (!ids.length) {
    html += `<div style="${font} color:#4ade80; margin-bottom:10px">Every part is built.${host.slot === hs.active ? '' : ' Ready to fly.'}</div>`;
  } else {
    // Modules still to fabricate, and the materials still to refine (for structure and for those modules)
    const materials: Bag = {};
    let blocked = false;
    html += `<div style="${font} font-size:11px; line-height:1.55; margin-bottom:8px">`;
    for (const id of ids) {
      const n = need[id];
      const stored = Math.min(n, host.deps.have(id));
      const on = Math.min(n - stored, coming[id] ?? 0);
      const left = n - stored - on;
      const refined = econ.recipes.refining.has(id);
      const r = refined ? null : econ.recipes.recipeFor(id);
      const can = refined || host.deps.canMake(id);
      if (left > 0 && r && can) for (const [k, m] of Object.entries(r.inputs)) materials[k] = (materials[k] ?? 0) + m * left;
      if (left > 0 && !can) blocked = true;
      const status = !can && left > 0 ? `<span style="color:#f87171">can't make yet</span>`
        : left <= 0 ? (on ? `<span style="color:#7dd3fc">⏳ on its way</span>` : `<span style="color:#4ade80">in storage</span>`)
        : refined ? `<span style="color:#fbbf24">refine ${left}</span>`
        : r && r.time > 0 ? `<span style="color:#fbbf24">⏳ ${r.time}s each</span>` : `<span style="color:#a5f3a1">instant</span>`;
      const label = econ.items.name(id).replace(/^(Alloy|Composite|Steel|Titanium|Cobalt|Neutronium) /, '');
      html += `<div style="display:flex; justify-content:space-between; gap:6px"><span>${n} × ${label}</span>${status}</div>`;
    }
    html += `</div>`;
    if (Object.keys(materials).length) {
      html += `<div style="${font} font-size:11px; color:#8ea0bd; margin-bottom:4px">Fabricating the rest takes:</div>
        <div style="${font} font-size:11px; white-space:normal; margin-bottom:6px">${costHtml(econ, materials, (id) => host.deps.have(id))}</div>`;
    }
    html += rec.auto
      ? `<div style="${font} font-size:11px; color:#7dd3fc; line-height:1.5; margin-bottom:10px">On order: the refinery and fabricator work through it, and parts go in as they're ready.${blocked ? ' <span style="color:#f87171">Some parts need a licence first.</span>' : ''}</div>`
      : `<div style="display:flex; flex-direction:column; gap:5px; margin-bottom:10px">
          <button data-act="all" style="${btnCss('#2f6f4f')}" title="Refine your ore, fabricate the modules and fit everything, as far as your materials go">Put it on order</button></div>`;
  }
  if (host.slot !== hs.active) {
    const core = rec.blueprint.parts.find((q) => q.fn === 'core');
    const flyable = !!core && !ghosts.has(core.uid) && !rec.lost;
    html += `<div style="display:flex; gap:5px; margin-bottom:12px">
      <button data-act="fly" style="${btnCss(flyable ? '#2f6f4f' : '#2a3346')}" ${flyable ? '' : `disabled title="${rec.lost ? 'Being rebuilt: fly it once it\'s whole' : 'Build its core first'}"`}>Fly host ship</button>
      <button data-act="clear" style="${btnCss('#4a2430')}" title="Break its built parts down: ${Math.round(SALVAGE * 100)}% of their minerals back as ore, every component in full">Scrap ship</button></div>`;
  }
  return html;
}

/**
 * The slot's ammunition loadout (as saved: a design's guns count once it's
 * saved): per gun kind that fires crates, how many of each to carry and
 * which opens first, with what you have and what's short.
 */
export function ammoHtml(host: HangarHost): string {
  const hs = host.deps.hangarState();
  const rec = hs?.slots[host.slot];
  if (!hs || !rec || host.grantAll) return '';
  const { catalog, tuning, econ } = host.deps;
  const kinds = loadoutKinds(catalog, tuning, rec.blueprint);
  if (!kinds.length) return '';
  const load = rec.loadout ?? {};
  const font = `font-family:'Segoe UI',sans-serif;`;
  const step = (item: string, d: number, off: boolean) => `<button data-ammo="${item}" data-d="${d}" ${off ? 'disabled' : ''} style="width:20px; height:20px; padding:0; border-radius:4px; border:1px solid #2a3a5a; background:#14203a; color:${off ? '#3b4a66' : '#e5ecf7'}; cursor:${off ? 'default' : 'pointer'}; font:13px/1 'Segoe UI',sans-serif">${d > 0 ? '+' : '−'}</button>`;
  let html = `<div style="color:#ffb547; font-weight:bold; margin-bottom:4px; ${font} letter-spacing:1px">AMMUNITION</div>
    <div style="${font} color:#8ea0bd; font-size:11px; line-height:1.45; margin-bottom:6px">Crates host ship carries: docking, launching and flying it load them from storage. They stay aboard when you store, and ★ opens first.</div>`;
  let vol = 0;
  for (const kind of kinds) {
    const crates = cratesFor(tuning, kind);
    const free = !tuning.weapons?.[kind]?.ammo;
    const order = crateOrder(crates, load);
    const first = rec.first?.[kind] && crates.includes(rec.first[kind]) ? rec.first[kind] : order[0];
    html += `<div style="${font} margin:6px 0 2px; color:#e5ecf7; text-transform:capitalize">${esc(kind)}${free ? ' <span style="color:#6b7a93; font-size:11px; text-transform:none">· fires plain shells free; crates are a choice</span>' : ''}</div>`;
    for (const item of crates) {
      const n = load[item] ?? 0, have = host.deps.have(item), d = econ.items.get(item);
      vol += n * econ.items.volume(item);
      const star = item === first;
      const tip = esc(`${d?.name ?? item}: ${d?.ammoFor?.rounds ?? '?'} rounds a crate${d?.description ? `. ${d.description}` : ''}`);
      html += `<div style="display:flex; align-items:center; gap:5px; padding:2px 0; ${font} font-size:11px" title="${tip}">
        <button data-first="${esc(kind)}:${item}" title="${star ? 'Opens first' : 'Open these first'}" style="all:unset; cursor:pointer; width:12px; color:${star ? '#fbbf24' : '#3b4a66'}">★</button>
        <img src="${itemIcon(econ, item)}" style="width:16px; height:16px">
        <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:${n ? '#e5ecf7' : '#8ea0bd'}">${esc((d?.name ?? item).replace(/ Crate$/, ''))}</span>
        <span style="color:${have >= n ? '#6b7a93' : '#fbbf24'}" title="In your hold and storage">${have}</span>
        ${step(item, -1, n <= 0)}<b style="width:16px; text-align:center; color:${n ? '#e5ecf7' : '#56657c'}">${n}</b>${step(item, 1, n >= MAX_LOADOUT_CRATES)}</div>`;
    }
  }
  // What's short of the loadout (across hold and storage), and where it comes from
  const short = Object.entries(load).map(([id, n]) => [id, n - host.deps.have(id)] as const).filter(([, k]) => k > 0);
  const cap = shipSummary(catalog, tuning, econ, rec.blueprint)?.cargo ?? 0;
  html += `<div style="${font} font-size:11px; color:${cap && vol > cap ? '#f87171' : '#6b7a93'}; margin-top:4px">Takes ${Math.round(vol)} of ${Math.round(cap)} hold${cap && vol > cap ? ': more than fits' : ''}</div>`;
  for (const [id, k] of short) {
    const can = host.deps.canMake(id);
    html += `<div style="display:flex; align-items:center; gap:6px; ${font} font-size:11px; margin-top:4px"><span style="flex:1; color:#fbbf24">Short ${k} × ${esc(econ.items.name(id))}</span>`
      + (can ? `<button data-make="${id}:${k}" style="${btnCss('#1d5e7a')} flex:0; padding:3px 8px; font-size:11px; white-space:nowrap" title="Put it on order: made as its materials come in, into storage">Order ${k}</button>`
        : `<span style="color:#8ea0bd" title="You don't know how to make it yet">buy at a market</span>`) + `</div>`;
  }
  return html + '<div style="margin-bottom:12px"></div>';
}

export function bindBuildButtons(host: HangarHost): void {
  const act = (a: string, fn: () => void) => { const b = host.stats.querySelector<HTMLButtonElement>(`[data-act="${a}"]`); if (b) b.onclick = fn; };
  // Ammunition: a crate more or fewer, the one that opens first, an order for what's short
  const load = host.deps.hangarState()?.slots[host.slot]?.loadout ?? {};
  host.stats.querySelectorAll<HTMLButtonElement>('[data-ammo]').forEach((b) => b.onclick = () => {
    const item = b.dataset.ammo!, n = Math.max(0, Math.min(MAX_LOADOUT_CRATES, (load[item] ?? 0) + Number(b.dataset.d)));
    host.deps.send({ type: 'slotLoadout', slot: host.slot, load: { [item]: n } });
  });
  host.stats.querySelectorAll<HTMLButtonElement>('[data-first]').forEach((b) => b.onclick = () => {
    const [kind, item] = b.dataset.first!.split(':');
    host.deps.send({ type: 'slotLoadout', slot: host.slot, load: {}, first: { [kind]: item } });
  });
  host.stats.querySelectorAll<HTMLButtonElement>('[data-make]').forEach((b) => b.onclick = () => {
    const [item, n] = b.dataset.make!.split(':');
    host.deps.send({ type: 'fabOrder', item, n: Number(n) });
  });
  // The ports load test's rows pick what the energy overlay shows; its toggle shows or hides it
  host.stats.querySelectorAll<HTMLElement>('[data-scn]').forEach((b) => b.onclick = () => { host.ports.scenario = b.dataset.scn as typeof host.ports.scenario; host.setEnergy(true); host.renderStats(); host.renderPalette(); host.draw(); });
  act('energy', () => { host.setEnergy(!host.overlays.energy); host.renderStats(); host.renderPalette(); host.draw(); });
  act('all', () => host.deps.send({ type: 'slotBuild', slot: host.slot }));
  act('fly', () => { host.deps.send({ type: 'slotFly', slot: host.slot }); host.close(null); });
  act('clear', () => {
    const rec = host.deps.hangarState()?.slots[host.slot];
    if (confirm(`Scrap the ${rec?.blueprint.name ?? 'ship'}? Its built parts break down: ${Math.round(SALVAGE * 100)}% of their minerals come back as ore, and every component.`)) host.deps.send({ type: 'slotClear', slot: host.slot });
  });
}

/**
 * Power: each network (in its overlay colour) with its generators and
 * batteries and what it makes against what's drawn on it, and what's left
 * without power; then the ship's pool and Output, its banks, and the load
 * test. (The networks are the old energy system's: P5 replaces host with the
 * energy overlay's report.)
 */
export function powerHtml(host: HangarHost): string {
  const rep = host.power, d = host.derived;
  if (d?.ports) return host.portsHtml(d.ports);
  if (!rep || !d) return '';
  let html = `<div style="display:flex; align-items:baseline; margin-bottom:4px"><b style="color:#ffb547; letter-spacing:1px">POWER</b></div>`;
  const nets = rep.nets.map((n, k) => ({ n, k })).filter(({ n }) => n.generators.length || n.batteries.length || n.demand > 0);
  if (!nets.length) html += '<div style="color:#6b7a93; font-size:11px; margin-bottom:4px">No generator on host ship.</div>';
  for (const { n, k } of nets) {
    const gens = n.generators.length, bats = n.batteries.length;
    const what = [gens ? `${gens} generator${gens > 1 ? 's' : ''}` : 'no generator', bats ? `${bats} batter${bats > 1 ? 'ies' : 'y'}` : ''].filter(Boolean).join(' · ');
    const ok = n.supply >= n.demand - 1e-6;
    html += `<div style="display:flex; align-items:center; gap:6px; padding:2px 0; border-bottom:1px solid #18223a; font-size:11px" title="${n.parts.length} parts on it">`
      + `<span style="width:10px; height:10px; border-radius:2px; flex-shrink:0; background:${n.color}"></span><span style="color:#cfd8e6; white-space:nowrap">Network ${k + 1}</span><span style="color:#8ea0bd; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${what}</span>`
      + `<span style="margin-left:auto; white-space:nowrap" title="Made / drawn steadily (engines and guns draw on the batteries)"><b style="color:${!n.powered ? '#8ea0bd' : ok ? '#4ade80' : '#fbbf24'}">+${Math.round(n.supply)}</b><span style="color:#6b7a93"> / ${Math.round(n.demand)}</span></span></div>`;
  }
  // The ship's numbers in four lines, its banks, and the one load-test warning (rework 2026-11 section 2.4)
  const L = d.power, n0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : '—');
  if (L) {
    const line = (t: string, tip = '') => `<div style="font-size:11px; color:#8ea0bd; padding:2px 0" ${tip ? `title="${tip}"` : ''}>${t}</div>`;
    const gen = rep.nets.reduce((s, n) => s + (n.powered ? n.supply : 0), 0), steady = Math.max(0, gen - L.spare);
    html += line(`Generation ${n0(gen)}/s · steady loads ${n0(steady)}/s · spare ${n0(L.spare)}/s`, 'What the generators make, what shields, scanners and coils take first, and what is left for the stores and the guns');
    const nb = L.pool.parts.length;
    html += line(`Store ${n0(L.pool.cap)} (core ${n0(L.pool.coreCap)}${nb ? ` + ${nb} ${nb === 1 ? 'battery' : 'batteries'}` : ''}) · Output ${n0(L.spare + L.pool.rate)}/s`, 'Your ship can give out at most its Output each second. Short of it, engines, guns and banks refilling share it by what each asks: thrust drops and guns reload slower. A bank asks for its intake, so it raises the share of what it feeds');
    const boost = energyTuning(host.deps.tuning).boostDraw;
    let eng = 0, engBoost = 0, guns = 0;
    for (const t of new Set(d.thrusters.filter((x) => x.force[0] || x.force[1]).map((x) => x.part))) { eng += L.draw[t]; engBoost += L.draw[t] * (1 + boost * L.boostDrain[t]); }
    for (const w of d.weapons) if (L.feedOf[w.part] >= 0) guns += gunDrawFlatOut(w, L.draw[w.part]);
    html += line(`Flat out: engines ${n0(eng)}/s (boosting ${n0(engBoost)}/s) · guns ${n0(guns)}/s`);
    const partName = (i: number) => { const p = host.bp.parts[i], fn = host.deps.catalog.functions.get(p.fn); return fn?.name ?? p.fn; };
    const r = host.bothTest();
    if (r && (guns > 0 || eng > 0)) {
      const unbanked = d.weapons.filter((w) => L.feedOf[w.part] >= 0 && !L.feeds[L.feedOf[w.part]].banks.length && gunDrawFlatOut(w, L.draw[w.part]) > 0);
      const share = unbanked.length ? Math.min(...unbanked.map((w) => r.part[w.part])) : 1;
      const act = guns > 0 ? 'Boosting while firing' : 'Boosting';
      // (Short of Output, the engines and the unbanked guns get the same share of what each asks: energy.ts powerTick)
      const both = Math.min(share, r.engines);
      if (r.brownAt >= 0 && share < BROWNOUT) html += `<div style="font-size:11px; padding:1px 0 3px; color:${both < 0.5 ? '#f87171' : '#fbbf24'}" title="Short of Output, everything drawing on it gets the same share of what it asks. A Capacitor bank touching the guns pays them first">⚠ Boosting while firing: engines and unbanked guns share the Output, down to ${Math.round(both * 100)}% each</div>`;
      else if (r.brownAt >= 0) html += `<div style="font-size:11px; padding:1px 0 3px; color:#fbbf24">⚠ ${act}: engines get ${Math.round(r.engines * 100)}%</div>`;
      else html += `<div style="font-size:11px; padding:1px 0 3px; color:#4ade80">Holds up: full power while ${guns > 0 ? 'boosting and firing' : 'boosting'}</div>`;
    }
    L.banks.forEach((B, k) => {
      const fed = [...new Set([...B.feeds, ...B.shields].map(partName))].join(', ');
      const never = !B.refills && B.dynamo <= 0;
      html += `<div style="font-size:11px; padding:1px 0; color:${never ? '#94a3b8' : B.kind === 'drive' ? '#7dd3fc' : '#fbbf24'}">Bank ${k + 1} (${B.parts.length} ${B.kind === 'drive' ? 'Drive Cell' : 'Capacitor'}${B.parts.length > 1 ? 's' : ''}) ${n0(B.cap)} · ${n0(B.rate)}/s → ${fed ? esc(fed) : 'feeds nothing'}${never ? ' · never refills' : ''}</div>`;
    });
  }
  if (rep.warnings.length) {
    html += `<div style="margin:5px 0 2px; font-size:11px; line-height:1.45">${rep.warnings.slice(0, 6).map((w) => `<div style="color:${/no power/.test(w) ? '#f87171' : '#fbbf24'}">• ${esc(w.charAt(0).toUpperCase() + w.slice(1))}</div>`).join('')}`
      + `${rep.warnings.length > 6 ? `<div style="color:#6b7a93">and ${rep.warnings.length - 6} more</div>` : ''}</div>`;
  } else if (nets.length) html += '<div style="color:#4ade80; font-size:11px; margin-top:4px">Everything that uses power has it.</div>';
  return html + '<div style="margin-bottom:12px"></div>';
}

/** Power on a ports design: what the generators make and the stores hold, what the routing leaves out (portsReport.ts), then the load test (portsGrid.ts) */
export function portsHtml(host: HangarHost, L: NonNullable<ShipDerived['ports']>): string {
  const r = portsReport(L), n0 = (v: number) => Math.round(v).toLocaleString();
  const name = (i: number) => host.partName(i);
  const warn = portsWarnings(r, name);
  let html = '<div style="display:flex; align-items:baseline; margin-bottom:4px"><b style="color:#ffb547; letter-spacing:1px">POWER</b></div>';
  html += `<div style="font-size:11px; color:#8ea0bd; padding:2px 0" title="Power moves only out of an out port into an in port across a shared edge: generators give at their front, stores take at the back and give at the front, guns and engines take at their back, the core takes at its sides">Generation ${n0(r.supply)}/s · stores hold ${n0(r.store)} · ${r.links} link${r.links === 1 ? '' : 's'}<span data-sd="power" title="Change in generation minus what everything draws flat out"></span></div>`;
  const draws = drawsText(r);
  if (draws) html += `<div style="font-size:11px; color:#8ea0bd; padding:2px 0" title="What each kind of part draws working flat out. Strafers burn only during a burst, gyros only while the ship turns (in proportion), shields all the time; each takes it from its own buffer, filled over its in ports, and works only as well as it is fed">Draws ${esc(draws)}</div>`;
  if (warn.length) html += `<div style="margin:5px 0 2px; font-size:11px; line-height:1.45">${warn.slice(0, 6).map((w) => `<div style="color:${/no power/.test(w) ? '#f87171' : '#fbbf24'}">• ${esc(w)}</div>`).join('')}${warn.length > 6 ? `<div style="color:#6b7a93">and ${warn.length - 6} more</div>` : ''}</div>`;
  else html += '<div style="color:#4ade80; font-size:11px; margin-top:4px">Every gun, engine and tool is fed.</div>';
  if (host.derived) html += portsPanelHtml(host.derived, host.ports.scenario, host.overlays.energy, name);
  return html + '<div style="margin-bottom:12px"></div>';
}

/** The ship at a glance, against the saved design when you've changed it */
export function summaryHtml(host: HangarHost): string {
  const { catalog, tuning, econ } = host.deps;
  const now = shipSummary(catalog, tuning, econ, host.bp);
  if (!now) return '<div style="color:#8ea0bd; margin-bottom:10px">Place a core to see what host ship can do.</div>';
  const savedBp = host.deps.hangarState()?.slots[host.slot]?.blueprint;
  const was = host.unsaved && savedBp ? shipSummary(catalog, tuning, econ, savedBp) : null;
  const delta = (k: keyof Omit<ShipSummary, 'power' | 'energy'>) => {
    if (!was) return '';
    const a = was[k], b = now[k];
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(b - a) < 1e-6) return '';
    const pct = a ? ((b - a) / Math.abs(a)) * 100 : 100;
    if (Math.abs(pct) < 0.5) return '';
    const good = (b > a) === BIGGER_IS_BETTER[k];
    return `<span style="color:${good ? '#4ade80' : '#f87171'}; font-size:11px; margin-left:6px">${b > a ? '▲' : '▼'}${Math.abs(pct) >= 1000 ? '' : ` ${Math.round(Math.abs(pct))}%`}</span>`;
  };
  // (sd: the stat-delta preview's key, build/statDelta.ts: a chip fills in beside the value while a part is hovered)
  const row = (label: string, value: string, k?: keyof Omit<ShipSummary, 'power' | 'energy'>, tip = '', sd?: string) =>
    `<div style="display:flex; justify-content:space-between; gap:8px; padding:3px 0; border-bottom:1px solid #18223a" title="${tip}"><span style="color:#8ea0bd">${label}</span><span><b style="color:#e5ecf7">${value}</b>${k ? delta(k) : ''}${sd ? `<span data-sd="${sd}"></span>` : ''}</span></div>`;
  const n0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : '—');
  let html = `<div style="color:#ffb547; font-weight:bold; margin-bottom:6px; letter-spacing:1px">SHIP${was ? ' <span style="color:#8ea0bd; font-weight:400; letter-spacing:0">vs saved</span>' : ''}</div>`;
  html += `<div style="display:flex; justify-content:space-between; align-items:baseline; padding:2px 0 6px; border-bottom:1px solid #18223a" title="Firepower and toughness together: how strong the ship is. Systems and siege moons show what their hostiles rate">`
    + `<span style="color:#8ea0bd">Rating</span><span><b style="color:#7dd3fc; font-size:18px">◆ ${n0(now.rating)}</b>${delta('rating')}</span></div>`;
  // Build points against the pilot's budget (a plan builds as designed)
  const cost = buildPoints(catalog, host.bp), budget = host.deps.hangarState()?.budget;
  if (budget !== undefined) {
    const over = cost > budget && !host.free;
    html += `<div style="display:flex; justify-content:space-between; gap:8px; padding:3px 0; border-bottom:1px solid #18223a" title="What the ship costs against your budget: every cell 1 point at Mk I, 1.6 at Mk II, 2.5 at Mk III, 3.8 at Mk IV, 5.5 at Mk V. More budget as you level; a ship built from a plan builds as designed">`
      + `<span style="color:#8ea0bd">Build points</span><span><b style="color:${over ? '#f87171' : '#e5ecf7'}">${cost} / ${budget}</b><span data-sd="points"></span><span data-sd="cost"></span>${over ? ' <span style="color:#f87171; font-size:11px">over budget</span>' : ''}</span></div>`;
  }
  html += row('Top speed', `${n0(now.topSpeed)} m/s`, 'topSpeed', 'Flat out, without boost', 'topSpeed');
  html += row('Acceleration', `${n0(now.accel)} m/s²`, 'accel', 'Main engines; more thrusters or less mass is faster', 'accel');
  html += row('Turn 180°', Number.isFinite(now.turn180) ? `${now.turn180.toFixed(1)} s` : 'can\'t turn', 'turn180', 'Thrusters and gyros against the ship\'s inertia', 'turn180');
  html += row('Firepower', `${n0(now.dps)} dmg/s`, 'dps', `${now.guns} gun${now.guns === 1 ? '' : 's'}${now.turrets ? `, ${now.turrets} on turrets` : ''}`, 'dps');
  html += row('Hull', `${n0(now.hull)} hp`, 'hull', 'Every part\'s hit points together', 'hull');
  if (now.shield > 0 || (was && was.shield > 0) || host.deltaNow?.lines.some((l) => l.key === 'shield')) html += row('Shield', `${n0(now.shield)}`, 'shield', '', 'shield');
  html += row('Cargo', `${n0(now.cargo)}`, 'cargo');
  // Cargo has mass (common/src/ships/load.ts): what the hold costs in thrust and turning, now and full of ore
  {
    const pct = (v: number) => `−${Math.round(v * 100)}%`;
    const load = host.deps.cargoMass?.() ?? 0;
    const full = cargoEffect(now, now.cargo * CATEGORY_MASS.mineral);
    const tip = 'Cargo has mass: a laden ship accelerates, turns and stops slower. It is weighed against the ship, so a bigger hull (or a hauler) minds the same load less; station storage weighs nothing';
    if (load > 0) {
      const e = cargoEffect(now, load);
      html += row('Hold now', `${load.toFixed(1)} mass · <span style="color:#fbbf24">${pct(e.thrustLoss)} thrust, ${pct(e.turnLoss)} turn</span>`, undefined, tip);
    }
    if (now.cargo > 0) html += row('Full of ore', `<span style="color:#fbbf24">${pct(full.thrustLoss)} thrust, ${pct(full.turnLoss)} turn</span>`, undefined, tip);
  }
  html += row('Jump drive', `${now.jump.toFixed(1)} km · ${Math.round(now.jumpCooldown)} s`, 'jump', 'Reach, and recharge time: from the jump coils (the core has one; on a ports design only coils power reaches count) against the size of the hull. Every jump charges 3 s');
  {
    const note = jumpRatioNote(now.jumpRatio);
    html += row('Jump coils', `${now.jumpRatio.toFixed(2)}× the hull's need · <span style="color:${note.color}">${note.word}</span>`, 'jumpRatio', note.hint);
  }
  if (now.miners || (was && was.miners)) html += row('Mining lasers', `${now.miners}`, 'miners');
  // Burst Strafer and Tow Beam (common/src/ships/strafer.ts, tow.ts)
  if (now.dodge > 0 || (was && was.dodge > 0)) {
    const s = host.derived?.fx?.strafe;
    const ways = s ? ([[DODGE_FORWARD, 'forward'], [DODGE_BACK, 'back'], [DODGE_LEFT, 'left'], [DODGE_RIGHT, 'right']] as const).filter(([w]) => strafeForce(s, w) > 1e-6).map(([, n]) => n) : [];
    const best = s ? bestDodge(s).dir : 0;
    const cost = host.derived && best ? burstEnergy(host.derived, best) : 0;
    html += row('Dodge', now.dodge > 0 ? `+${n0(now.dodge)} m/s a burst · ${ways.length === 4 ? 'any way' : ways.join(', ') || 'no way'} · ${n0(cost)} energy` : '<span style="color:#f87171">none</span>', 'dodge',
      `Burst Strafers: press ${boundKeyName('dodge', settings.data.bindings)} for one hard burst (${((s?.ticks ?? 12) / 60).toFixed(2)} s) the way you're steering, diagonals too, with whichever strafers push that way; `
      + `with nothing held, back the other way from your last dodge. Ready again ${((s ? Math.max(s.ticks, s.cooldown) : 24) / 60).toFixed(2)} s after the last one started. `
      + 'There are no charges: every burst draws a lot of energy, from a Drive Cell bank the strafer touches first, then the ship, so dodging often browns the ship out unless Drive Cells, batteries and generation back it. '
      + 'A strafer pushes away from its nozzle: fit them facing different ways to dodge any way. The heavier the ship, the less a burst moves it');
  }
  if (now.tow > 0) html += row('Tow Beam', now.tow >= 0.5 ? 'ready' : '<span style="color:#f87171">no power</span>', 'tow',
    `Press ${boundKeyName('tow', settings.data.bindings)} to take hold of the wreck, debris or pod nearest your cursor; again to let go. What you tow slows you by its mass. `
    + "Tow it into a station's reach to salvage it into your storage. It draws power only while towing");
  for (const f of designFields(catalog, tuning, host.bp)) html += row(f.label, f.text);
  html += row('Mass', `${n0(now.mass)}`, 'mass', '', 'mass');
  html += row('Loss cost', `${n0(now.rebuild)} cr`, 'rebuild', `If it's destroyed: the ${Math.round((1 - SALVAGE) * 100)}% of its minerals salvage doesn't bring back, at station prices`);
  html += energyHtml(now.energy, host.derived, host.deps.tuning);
  return html + '<div style="margin-bottom:12px"></div>';
}

export function renderStats(host: HangarHost): void {
  const d = host.derived;
  const t = host.deps.tuning;
  const fmt = (v: number, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : '—');
  let html = host.buildHtml();
  html += host.ammoHtml();
  html += host.powerHtml();
  html += host.summaryHtml();
  html += `<details style="margin-bottom:10px"><summary style="cursor:pointer; color:#8ea0bd">Engineering details</summary><div style="font-family:'Courier New', monospace; font-size:11px; margin-top:6px">`;
  html += `<div>parts   ${host.bp.parts.length} / ${t.maxParts}</div>`;
  const bill = host.deps.econ.rebuildBill(host.bp.parts.filter((q) => q.fn !== 'core'));
  const billText = Object.entries(bill).map(([id, n]) => `${n} ${host.deps.econ.items.name(id).replace(/ Ore$/, '')}`).join(', ');
  if (billText) html += `<div style="color:#8ea0bd; margin-top:4px">rebuild if destroyed:</div><div style="white-space:normal">  ${billText}</div>`;
  if (d && d.mass > 0) {
    const a = (f: number) => fmt(f / d.mass, 3);
    html += `<div>mass    ${fmt(d.mass)}</div>`;
    html += `<div>inertia ${fmt(d.inertia, 0)}</div>`;
    html += `<div style="margin-top:6px; color:#8ea0bd">accel (u/tick²)</div>`;
    html += `<div>  fwd ${a(Math.max(d.maxThrust.forward, d.maneuverForce))}  back ${a(Math.max(d.maxThrust.back, d.maneuverForce))}</div>`;
    html += `<div>  left ${a(Math.max(d.maxThrust.left, d.maneuverForce))}  right ${a(Math.max(d.maxThrust.right, d.maneuverForce))}</div>`;
    html += `<div style="margin-top:6px; color:#8ea0bd">turn accel (rad/tick²)</div>`;
    html += `<div>  ⟳ ${fmt(d.maxTorque.cw / d.inertia, 4)}  ⟲ ${fmt(d.maxTorque.ccw / d.inertia, 4)}</div>`;
    html += `<div style="margin-top:6px; color:#8ea0bd">power</div>`;
    d.networks.forEach((n, k) => {
      if (n.demand === 0 && n.supply === 0) return;
      const ok = n.supply >= n.demand;
      html += `<div>  net ${k + 1}: <span style="color:${ok ? '#4ade80' : '#f2d24b'}">${fmt(n.supply, 1)}</span> / ${fmt(n.demand, 1)}</div>`;
    });
    html += `<div style="margin-top:6px; color:#8ea0bd">weapons (fire interval)</div>`;
    for (const w of d.weapons) {
      const arc = w.window ? ` turret ${Math.round(w.window.open.reduce((s, [lo, hi]) => s + hi - lo, 0) * 180 / Math.PI)}°` : '';
      html += `<div>  #${w.uid}: ${fmt(w.interval, 1)} ticks (${Math.round(w.satisfaction * 100)}%)${arc}</div>`;
    }
    const consumers = host.bp.parts.map((p, i) => ({ p, i })).filter(({ p }) => p.fn === 'thruster');
    if (consumers.length) {
      html += `<div style="margin-top:6px; color:#8ea0bd">thrusters</div>`;
      for (const { p, i } of consumers) html += `<div>  #${p.uid}: ${Math.round(d.satisfaction[i] * 100)}% power</div>`;
    }
  } else {
    html += `<div style="color:#8ea0bd">(no core: nothing attached)</div>`;
  }
  html += `</div></details>`;
  html += `<div style="color:#ffb547; font-weight:bold; margin:12px 0 6px;">PROBLEMS</div>`;
  html += host.errors.length
    ? host.errors.map((e) => `<div style="color:#f87171; margin-bottom:3px;">• ${e.message}</div>`).join('')
    : `<div style="color:#4ade80">none</div>`;
  if (host.unreachable.size) {
    const k = host.unreachable.size;
    html += `<div style="color:#c4b5fd; margin-top:6px;">• ${k} part${k > 1 ? 's' : ''} not connected: ${k > 1 ? "they'll" : "it'll"} build once joined</div>`;
  }
  host.stats.innerHTML = html;
  applyChips(host.stats, host.deltaNow);
  host.bindBuildButtons();
}

/**
 * The hangar's energy readout, from the same power layout as the Power section
 * (circuits.ts, energy.ts; the store and the Output are in that section): how
 * long the engines and guns get full power, how low they drop after, and how
 * long the stores take to fill from empty. A consumer draws on the banks it
 * touches first (their cap, at their Gives rate), then on the Output; a bank
 * that feeds nothing counts for nothing, and one that never refills is a single
 * draught.
 */
/** The load tests behind the hangar's Energy rows, per derived ship */
const energyRuns = new WeakMap<ShipDerived, { cruise: LoadTestResult; boost: LoadTestResult; fire: LoadTestResult; refill: number }>();
const ENERGY_ROW_SECONDS = 20;

function energyHtml(e: ShipSummary['energy'], d: ShipDerived | null, tuning: ShipTuning): string {
  const L = d?.power;
  const row = (label: string, value: string, tip: string) =>
    `<div style="display:flex; justify-content:space-between; padding:2px 0" title="${tip}"><span style="color:#8ea0bd">${label}</span>${value}</div>`;
  const head = `<div style="color:#ffb547; font-weight:bold; margin:10px 0 4px; letter-spacing:1px">ENERGY</div>`;
  if (!L || !d) return head + row('Store', `<b style="color:#e5ecf7">${Math.round(e.max)}</b>`, 'The core store plus batteries') + row('Spare power', `<b style="color:#e5ecf7">${e.spare.toFixed(0)}/s</b>`, 'Generation left after the steady loads');
  const output = L.spare + L.pool.rate;
  let hasEng = false, hasGun = false, engDraw = 0;
  for (const t of d.thrusters) if (t.force[0] || t.force[1]) { hasEng = true; engDraw += L.draw[t.part]; }
  for (const w of d.weapons) if (L.feedOf[w.part] >= 0) hasGun = true;
  // Each row is the ship's own power code run tick by tick (loadTest): a bank pays only for the parts it touches
  let runs = energyRuns.get(d);
  if (!runs) energyRuns.set(d, runs = {
    cruise: loadTest(d, tuning, { fire: false, thrust: true, boost: false, seconds: ENERGY_ROW_SECONDS }),
    boost: loadTest(d, tuning, { fire: false, thrust: true, boost: true, seconds: ENERGY_ROW_SECONDS }),
    fire: loadTest(d, tuning, { fire: true, thrust: true, boost: false, seconds: ENERGY_ROW_SECONDS }),
    // (From every store empty, idle: how long until they're full)
    refill: loadTest(d, tuning, { fire: false, thrust: false, boost: false, seconds: 0, from: { g: 0, b: L.banks.map(() => 0) } }).refill,
  });
  const dash = '<span style="color:#8ea0bd">—</span>';
  const show = (r: LoadTestResult, share: number, any: boolean): { html: string; ok: boolean } => {
    if (!any) return { html: dash, ok: true };
    if (r.brownAt < 0) return r.end >= 99
      ? { html: '<span style="color:#4ade80">sustained</span>', ok: true }
      : { html: `<span style="color:#fbbf24">holds ${ENERGY_ROW_SECONDS} s+ · store ${Math.round(r.end)}%</span>`, ok: true };
    const t = r.brownAt;
    return { html: `<span style="color:#f87171">full power ${t.toFixed(t < 10 ? 1 : 0)} s, then ${Math.round(share * 100)}%</span>`, ok: false };
  };
  const cruise = show(runs.cruise, runs.cruise.engines, hasEng && engDraw > 0);
  const boosting = show(runs.boost, runs.boost.engines, hasEng && engDraw > 0);
  const firing = show(runs.fire, Math.min(runs.fire.engines, runs.fire.guns), hasGun);
  const dry = hasGun && !firing.ok;

  const rf = runs.refill;
  // (loadTest gives up after two minutes)
  const refill = !Number.isFinite(rf) ? `<span style="color:#f87171">${L.spare > 0 || L.banks.some((B) => B.dynamo > 0) ? 'over 2 min' : 'never: no spare power'}</span>`
    : rf <= 0 ? dash : `<span style="color:${rf > 30 ? '#fbbf24' : '#e5ecf7'}">${rf.toFixed(rf < 10 ? 1 : 0)} s from empty</span>`;
  return head
    + row('Cruising', cruise.html, `Engines thrusting for ${ENERGY_ROW_SECONDS} s, run through the ship's real power code: each bank pays only for the parts it touches. Sustained: the generators keep up`)
    + row('Boosting', boosting.html, `Engines boosting, same test: how long they get full power before the stores run dry, then the lowest share they get. Store ${Math.round(L.pool.cap)}, Output ${Math.round(output)}/s`)
    + row('Firing, cruising', firing.html, 'Every gun firing flat out while the engines thrust, same test. Short of power, engines and guns share it by what each asks: thrust drops, guns reload slower, beams flicker')
    + row('Refills', refill, 'Idle, from every store empty: how long the spare generation takes to fill the pool and every bank that refills (a bank takes in at most its intake a second)')
    + (dry ? `<div style="color:#fbbf24; font-size:11px; margin-top:4px">The ship runs short in a fight: engines and guns share what there is, so both slow. Add generation, a battery, or a Capacitor bank touching the guns (it pays them first, and its intake raises their share).</div>` : '');
}
