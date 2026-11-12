/**
 * @contract client.ships.mod-tip
 * owns:       weapon modifiers in words, for a design on the bench: the rows a part's tooltip gains (a gun's effects as
 *             chips, what a mount took and reaches, why a block does nothing, what a hopper feeds, what a line part
 *             carries and drops), the POWER panel's MODIFIERS block with its warnings, and the short how-it-works text
 * needs:      build/modExplain (the explanation, a gun's chips), ui/escape; npm: @space-game/common
 * invariants: every reason a block is idle and every reason an effect is off has its words; a design with no modifier
 *             parts adds nothing to a tooltip or the panel — client/src/ships/modTip.test.ts
 * extend:     a new ModIdle or FxOff value: its words in IDLE or OFF here
 *
 * - No lore, no jargon: "E" is energy, an effect is named as tuning.json modifiers.say names it.
 */

import {
  FX_MAX, MOD_MATS, partItemId,
  type Catalog, type Economy, type ModBlockInfo, type ModifierTuning, type ModsExplain, type PlacedPart, type PortsLayout, type PortsState, type ShipDerived, type ShipTuning,
} from '@space-game/common';
import { esc } from '../ui/escape';
import { fxLook, gunChips, modsOf, type FxChip, type FxOff } from './build/modExplain';

/** What the rows need of the tooltip's context (partTip.ts PartTipCtx has it all once `parts` is given) */
export interface ModTipCtx {
  catalog: Catalog;
  tuning: ShipTuning;
  econ: Economy;
  derived?: ShipDerived | null;
  /** The design's parts, by the index the tooltip is asked for */
  parts?: readonly PlacedPart[];
  /** The ship's power state, when it is the one being flown (what is off right now); a design on the bench has none */
  power?: PortsState;
}

/** Why an effect is on a gun but off its shots */
export const OFF: Record<FxOff, string> = { mount: 'its mount has no power', hopper: 'its hopper is empty', power: 'its modifier has no power stored' };

/** Why a block does nothing */
export function idleWords(b: ModBlockInfo, mt: ModifierTuning): string {
  const mat = mt.kinds[b.kind]?.needs?.mat;
  switch (b.idle) {
    case 'noSocket': return 'no mount socket faces it';
    case 'wrongKind': return 'its mount took another kind first, and the two are no recipe';
    case 'noHopper': return `no ${MOD_MATS[mat ?? ''] ?? mat ?? 'material'} hopper touches it or is piped to it`;
    case 'noPower': return 'no power line feeds its back';
    case 'noGuns': return "its mount's line reaches no gun";
    default: return '';
  }
}

const n0 = (v: number) => (Math.round(v * 10) / 10).toLocaleString('en-GB');
const pct = (k: number) => `${Math.round(k * 100)}%`;
const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] ?? '');
/** "Pip Cannon ×2, Rattler" */
const tally = (xs: string[]) => [...new Set(xs)].map((x) => { const n = xs.filter((y) => y === x).length; return n > 1 ? `${x} ×${n}` : x; });

function row(k: string, v: string): string {
  return `<div style="display:flex; justify-content:space-between; gap:12px; padding:2px 0; border-bottom:1px solid #18223a"><span style="color:#8ea0bd">${k}</span><b style="color:#e5ecf7; font-weight:600; text-align:right">${v}</b></div>`;
}
const note = (color: string, text: string) => `<div style="color:${color}; font-size:11px; margin-top:3px">${text}</div>`;
const RED = '#f87171', AMBER = '#fbbf24', DIM = '#8ea0bd';
const fxName = (mt: ModifierTuning, fx: number) => { const l = fxLook(mt, fx); return `<b style="color:${l.color}">${esc(l.name)}</b>`; };

/** One effect as a chip: its name, a bar as long as it is strong, the share; dimmed when off */
export function chipHtml(c: FxChip): string {
  return `<span style="display:inline-flex; align-items:center; gap:5px; border:1px solid ${c.color}; border-radius:9px; padding:0 7px; margin:2px 4px 2px 0; color:${c.color}; font-size:11px; white-space:nowrap${c.off ? '; opacity:0.45' : ''}">`
    + `${esc(c.name)}<span style="display:inline-block; width:26px; height:4px; border-radius:2px; background:#1c2942"><span style="display:block; width:${Math.round(c.k * 100)}%; height:4px; border-radius:2px; background:${c.color}"></span></span>${pct(c.k)}</span>`;
}

/**
 * The rows the tooltip of part `i` gains for weapon modifiers on this design ('' for a part they don't touch): a gun's
 * effects, a mount, a modifier block, a hopper, a line part carrying effects.
 */
export function modTipHtml(i: number, c: ModTipCtx): string {
  const mt = c.tuning.modifiers, d = c.derived, L = d?.ports, parts = c.parts;
  if (!mt || !d || !L || !parts || i < 0 || i >= parts.length) return '';
  const ex = modsOf(c.catalog, c.tuning, parts, d);
  if (!ex) return '';
  const name = (j: number) => esc(c.econ.items.name(partItemId(parts[j])));
  let html = '';

  const gun = ex.guns.get(i);
  if (gun) {
    const chips = gunChips(L, ex, mt, i, c.power);
    if (chips.length) {
      html += `<div style="margin-top:5px"><span style="color:${DIM}">Its shots carry</span><div style="display:flex; flex-wrap:wrap; margin-top:2px">${chips.map(chipHtml).join('')}</div></div>`;
      for (const ch of chips) html += `<div style="font-size:11px; margin-top:2px${ch.off ? '; opacity:0.55' : ''}"><b style="color:${ch.color}">${esc(ch.name)}</b> <span style="color:#cfd8e6">${esc(ch.say)}</span>${ch.off ? ` <span style="color:${AMBER}">(off: ${OFF[ch.off]})</span>` : ''}</div>`;
    }
    for (const l of gun.lost) html += note(AMBER, lostWords(l, ex, mt, name));
  }

  const m = ex.mounts.get(i);
  if (m) {
    const filled = m.sockets.filter((s) => s.block >= 0).length;
    html += row('Sockets filled', `${filled} of ${m.sockets.length}`);
    if (m.fx >= 0) {
      const kinds = m.kinds.map((k) => esc(kindName(c.catalog, k)));
      html += row('Gives', m.fused
        ? `${fxName(mt, m.fx)}: ${kinds.join(' + ')} fused, in place of ${list(m.kinds.map((k) => esc(fxLook(mt, mt.effects.indexOf(mt.kinds[k].effect)).name)))}`
        : `${fxName(mt, m.fx)} from its ${kinds[0]}${m.blocks.length > 1 ? ` ×${m.blocks.length}` : ''}`);
    }
    if (m.working) {
      html += row('Treats now', `${n0(m.treat)} E/s${m.guns.length && m.cover < 1 ? ` · ${pct(m.cover)} of what its guns draw` : ''}`);
      html += row('Upkeep now', `${n0(m.upkeep)} E/s`);
      html += row('Reaches', m.guns.length ? tally(m.guns.map(name)).join(', ') : `<span style="color:${RED}">no gun</span>`);
    }
    if (!filled) html += note(DIM, 'Nothing on a socket: it only passes power');
    else if (!m.working) html += note(RED, 'No effect: its modifier does nothing here');
    else if (!m.guns.length) html += note(RED, 'No effect: its line out reaches no gun');
    if (filled && L.inStart[i + 1] === L.inStart[i]) html += note(RED, 'No power line in: its effect stays off');
  }

  const b = ex.blocks.get(i);
  if (b) {
    const host = b.mount >= 0 ? ex.mounts.get(b.mount) : undefined;
    if (b.idle) html += row('On this ship', `<span style="color:${RED}">does nothing: ${esc(idleWords(b, mt))}</span>`);
    else if (host) html += row('On this ship', `${host.fused ? `fused into ${fxName(mt, host.fx)}` : `gives ${fxName(mt, host.fx)}`} to ${tally(host.guns.map(name)).join(', ')}`);
    if (b.hoppers.length) html += row('Fed by', tally(b.hoppers.map(name)).join(', '));
  }

  const h = ex.hoppers.get(i);
  if (h) {
    const mat = esc(MOD_MATS[h.mat] ?? h.mat);
    html += row('Feeds', h.blocks.length ? tally(h.blocks.map(name)).join(', ') : `<span style="color:${RED}">nothing: no modifier that uses ${mat} touches it or is piped to it</span>`);
    html += row('Refill', 'full when you leave dock · refilled when docked');
  }

  const l = ex.lines.get(i);
  if (l) {
    const sum = l.carried.reduce((s, x) => s + x.amt, 0);
    html += row('Carrying', `${l.carried.length} of ${l.max} effect${l.max === 1 ? '' : 's'} · ${n0(sum)} of ${n0(l.cap)} treated E/s`);
    if (l.carried.length) html += `<div style="display:flex; flex-wrap:wrap; justify-content:flex-end; margin-top:2px">${l.carried.map((x) => { const k = fxLook(mt, x.fx); return `<span style="color:${k.color}; font-size:11px; margin-left:8px">${esc(k.name)} ${n0(x.amt)}</span>`; }).join('')}</div>`;
    if (l.dropped.length) html += note(RED, `Drops ${list(l.dropped.map((fx) => esc(fxLook(mt, fx).name)))}: it carries ${l.max} effects${tierHint(mt, l.tier)}`);
    if (l.scale < 1) html += note(AMBER, `Over its ${n0(l.cap)} treated E/s: effects past it are at ${pct(l.scale)}${tierHint(mt, l.tier)}`);
  }
  return html;
}

/** " (tier II carries 3, up to 300 E/s)" for a line part with a tier above it */
function tierHint(mt: ModifierTuning, tier: number): string {
  const up = mt.lines[tier];
  return up ? ` (tier ${'I'.repeat(tier + 1)} carries ${up.fx}, up to ${n0(up.cap)} E/s)` : '';
}

/** A modifier kind's part, by name ("Coil") */
function kindName(catalog: Catalog, kind: string): string {
  for (const fn of catalog.functions.values()) if (fn.plug === kind) return fn.name ?? kind;
  return kind;
}

function lostWords(l: { fx: number; by: number }, ex: ModsExplain, mt: ModifierTuning, name: (i: number) => string): string {
  const fx = esc(fxLook(mt, l.fx).name), line = l.by >= 0 ? ex.lines.get(l.by) : undefined;
  if (line) return `${fx} never arrives: ${name(l.by)} carries ${line.max} effects and dropped it`;
  return `${fx} is left off: a gun takes ${FX_MAX} effects, or its share is too small to count`;
}

/** What is wrong with a design's modifiers, a plain line each (the POWER panel's list; `name` gives a part's name) */
export function modWarnings(ex: ModsExplain, L: PortsLayout, mt: ModifierTuning, name: (i: number) => string): string[] {
  const out: string[] = [];
  for (const b of ex.blocks.values()) if (b.idle) out.push(`${name(b.part)} does nothing: ${idleWords(b, mt)}`);
  for (const m of ex.mounts.values()) {
    const filled = m.sockets.some((s) => s.block >= 0);
    if (!filled) out.push(`${name(m.part)} has nothing on a socket: it only passes power`);
    else if (L.inStart[m.part + 1] === L.inStart[m.part]) out.push(`${name(m.part)} has no power line in: its effect stays off`);
  }
  for (const l of ex.lines.values()) {
    if (l.dropped.length) out.push(`${name(l.part)} drops ${list(l.dropped.map((fx) => fxLook(mt, fx).name))}: it carries ${l.max} effects${tierHint(mt, l.tier)}`);
    if (l.scale < 1) out.push(`${name(l.part)} is over its ${n0(l.cap)} treated E/s: effects past it are at ${pct(l.scale)}${tierHint(mt, l.tier)}`);
  }
  for (const g of ex.guns.values()) for (const l of g.lost) if (l.by < 0) out.push(`${name(g.part)}: ${fxLook(mt, l.fx).name} is left off: a gun takes ${FX_MAX} effects, or its share is too small to count`);
  for (const h of ex.hoppers.values()) if (!h.blocks.length) out.push(`${name(h.part)} feeds nothing: no modifier that uses ${MOD_MATS[h.mat] ?? h.mat} touches it or is piped to it`);
  return out;
}

/** How weapon modifiers work, in a few plain lines (the recipes and line tiers are tuning.json's) */
export function modGuide(catalog: Catalog, mt: ModifierTuning): string[] {
  const fx = (id: string) => mt.say[id]?.name ?? id;
  const recipes = mt.recipes.map((r) => `${r.parts.map((k) => kindName(catalog, k)).join(' + ')} = ${fx(r.effect)}`);
  const tiers = mt.lines.map((l, i) => `tier ${'I'.repeat(i + 1)} carries ${l.fx}`);
  return [
    'A Mount goes in the power line to a gun. Every gun further down that line gets its effect.',
    'A modifier block works when it touches one of the mount\'s sockets (the square marks on its edge).',
    `A mount takes one kind of block. A Double or Triple Mount holding both kinds of a recipe fuses them into a new effect that replaces the two${recipes.length ? `: ${recipes.join(', ')}` : ''}.`,
    'A mount treats so many E a second for each filled socket and burns a little upkeep. Guns that draw more than it treats get a weaker effect.',
    'Some blocks use up a material: put its hopper against the block, or pipe it there. Hoppers are refilled when docked.',
    `Line parts carry a set number of effects (${tiers.join(', ')}). Any more are dropped, weakest first.`,
  ];
}

/** The POWER panel's MODIFIERS block: what the design's mounts do in a line, what is wrong, and how it works ('' with no modifier parts) */
export function modsPanelHtml(c: Pick<ModTipCtx, 'catalog' | 'tuning' | 'derived' | 'parts'>, name: (i: number) => string): string {
  const mt = c.tuning.modifiers, L = c.derived?.ports;
  if (!mt || !L || !c.parts) return '';
  const ex = modsOf(c.catalog, c.tuning, c.parts, c.derived);
  if (!ex) return '';
  const working = [...ex.mounts.values()].filter((m) => m.working && m.guns.length), guns = [...ex.guns.values()].filter((g) => g.slots.length);
  const upkeep = working.reduce((s, m) => s + m.upkeep, 0), warn = modWarnings(ex, L, mt, name);
  let html = '<div style="display:flex; align-items:baseline; margin:8px 0 4px"><b style="color:#ffb547; letter-spacing:1px">MODIFIERS</b></div>';
  html += `<div style="font-size:11px; color:#8ea0bd; padding:2px 0">${guns.length} gun${guns.length === 1 ? '' : 's'} changed · ${working.length} of ${ex.mounts.size} mount${ex.mounts.size === 1 ? '' : 's'} working · upkeep ${n0(upkeep)} E/s</div>`;
  if (warn.length) html += `<div style="margin:5px 0 2px; font-size:11px; line-height:1.45">${warn.slice(0, 6).map((w) => `<div style="color:${/does nothing|drops|no power|feeds nothing/.test(w) ? RED : AMBER}">• ${esc(w)}</div>`).join('')}${warn.length > 6 ? `<div style="color:#8ea0bd">and ${warn.length - 6} more</div>` : ''}</div>`;
  else if (guns.length) html += '<div style="color:#4ade80; font-size:11px; margin-top:4px">Every modifier reaches a gun.</div>';
  html += `<details style="font-size:11px; color:#8ea0bd; margin-top:5px"><summary style="cursor:pointer; color:#cfd8e6">How modifiers work</summary>${modGuide(c.catalog, mt).map((t) => `<div style="margin-top:3px">${esc(t)}</div>`).join('')}</details>`;
  return html;
}
