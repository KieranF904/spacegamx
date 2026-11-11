/**
 * The field guide (Escape → Field guide): a panel that fits the screen, with a
 * tab per topic and its own scroll bar. Sections carry an icon.
 * "Progress" shows where you stand: your level, the unlock track (what each
 * level opens: models by family, materials, room; you marked on it), the five
 * tiers (the level each needs, their systems, moons and ores) and a chart of
 * what each level takes. "Tiers & scaling" is built from the game data: how a Mk grade scales what a part does (a
 * chart), how weapon size scales damage (a chart), every grade's material and
 * where its ore comes from, and the systems and siege moons by tier with
 * their threat against your ship.
 */

import {
  unlocks, xpToReach, GRADE_LEVEL, LEVEL_CAP, SKILL_POINT_CAP, unlockTrack, nextBuildUnlock, nextUnlockHint, materialUnlockName,
  BOUNTY_WINDOW_MS, type FunctionDef, type TrackStep, 
} from '@space-game/common';
import materialsData from '../../../data/ships/materials.json';
import shipModels from '../../../data/ships/models.json';
import recipesData from '../../../data/recipes.json';
import factionsData from '../../../data/factions.json';
import systemsData from '../../../data/systems.json';
import itemsData from '../../../data/items.json';
import { threatTag } from './threat';
import { esc } from './escape';
import { resourcesHtml, wireResources, RESOURCE_CSS } from './resources/resourceDictionary';

export type GuideTab = 'progress' | 'tiers' | 'people' | 'resources';

export const GUIDE_TABS: { id: GuideTab; label: string }[] = [
  { id: 'progress', label: 'Progress' },
  { id: 'tiers', label: 'Tiers & scaling' },
  { id: 'people', label: 'Jobs & pilots' },
  { id: 'resources', label: 'Resources' },
];

export interface GuideDeps {
  /** A key's label for an action, as <kbd> */
  k(action: string): string;
  /** Threat ratings by system and siege moon (from the server) */
  threats(): Record<string, number>;
  /** Your ship's rating (0: unknown) */
  myRating(): number;
  /** Your level and total XP */
  level(): number;
  xp(): number;
  /** An item's icon (a data URL; '' if there's none) */
  icon(id: string): string;
  /** A ship design's silhouette (the Resources tab's enemy pictures) */
  shipIcon?(parts: { piece: string; rot: number; flip: boolean; x: number; y: number }[], size?: number): string;
}

export const GUIDE_CSS = `
#game-menu .gm-panel.fg { display: flex; flex-direction: column; max-width: 980px; height: calc(100vh - 96px); padding: 22px 0 0; }
#game-menu .fg-head { padding: 0 28px; }
#game-menu .fg-tabs { display: flex; flex-wrap: wrap; gap: 6px; padding: 14px 28px 12px; border-bottom: 1px solid rgba(140, 170, 220, 0.14); }
#game-menu .fg-tab { all: unset; cursor: pointer; padding: 6px 13px; border-radius: 999px; border: 1px solid rgba(140, 170, 220, 0.22); color: #9fb3cc; font-size: 13px; }
#game-menu .fg-tab:hover { color: #fff; border-color: rgba(125, 211, 252, 0.4); }
#game-menu .fg-tab.on { background: rgba(125, 211, 252, 0.15); border-color: rgba(125, 211, 252, 0.55); color: #fff; }
#game-menu .fg-body { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 28px 28px; scrollbar-width: thin; scrollbar-color: #33496d transparent; }
#game-menu .fg-body::-webkit-scrollbar { width: 10px; }
#game-menu .fg-body::-webkit-scrollbar-thumb { background: #33496d; border-radius: 5px; border: 2px solid rgba(9, 15, 28, 0.9); }
#game-menu .fg-body::-webkit-scrollbar-track { background: transparent; }
#game-menu .fg-cols { columns: 2 340px; column-gap: 28px; }
#game-menu .fg-cols section { break-inside: avoid; margin-bottom: 14px; }
#game-menu .fg-cols h3 { margin-top: 10px; }
#game-menu .fg-chart { position: relative; margin: 8px 0 4px; }
#game-menu .fg-chart svg { display: block; width: 100%; height: auto; overflow: visible; }
#game-menu .fg-legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; color: #a9b6c9; margin: 2px 0 4px; }
#game-menu .fg-legend i { display: inline-block; width: 14px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 6px; }
#game-menu .fg-tip { position: absolute; pointer-events: none; display: none; padding: 7px 10px; border-radius: 8px; font-size: 12px; line-height: 1.5;
  background: rgba(6, 10, 20, 0.95); border: 1px solid rgba(140, 170, 220, 0.3); color: #d6deeb; white-space: nowrap; transform: translate(-50%, -100%); }
#game-menu .fg-tip b { color: #fff; }
#game-menu table.fg-t { width: 100%; border-collapse: collapse; font-size: 13px; margin: 6px 0 4px; }
#game-menu table.fg-t th { text-align: left; font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 1.5px; text-transform: uppercase; color: #6f8099; padding: 6px 8px; border-bottom: 1px solid rgba(140, 170, 220, 0.18); }
#game-menu table.fg-t td { padding: 7px 8px; border-bottom: 1px solid rgba(140, 170, 220, 0.08); color: #c4cfde; vertical-align: top; }
#game-menu table.fg-t td.n { text-align: right; font-variant-numeric: tabular-nums; }
#game-menu table.fg-t th.n { text-align: right; }
#game-menu .fg-mk { display: inline-block; white-space: nowrap; min-width: 34px; padding: 1px 6px; border-radius: 5px; background: #1a2740; border: 1px solid #33496d; color: #e8f0fb; font: 700 11px 'Segoe UI', sans-serif; text-align: center; }
#game-menu .fg-wide { overflow-x: auto; }
#game-menu .fg-cols h3 .ic { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; margin-right: 8px; border-radius: 7px;
  background: rgba(125, 211, 252, 0.12); border: 1px solid rgba(125, 211, 252, 0.3); font-size: 12px; letter-spacing: 0; vertical-align: middle; }
#game-menu .fg-me { display: flex; flex-wrap: wrap; gap: 18px; align-items: center; padding: 14px 16px; border-radius: 12px; margin: 12px 0 6px;
  background: linear-gradient(90deg, rgba(29, 94, 122, 0.35), rgba(9, 15, 28, 0.2)); border: 1px solid rgba(125, 211, 252, 0.25); }
#game-menu .fg-me .lv { font: 700 34px 'Segoe UI', sans-serif; color: #fff; line-height: 1; }
#game-menu .fg-me .lv small { display: block; font-size: 10px; letter-spacing: 2px; color: #7dd3fc; margin-bottom: 3px; }
#game-menu .fg-me .fg-xp { flex: 1; min-width: 200px; }
#game-menu .fg-me .fg-xp i { display: block; height: 8px; border-radius: 4px; background: linear-gradient(90deg, #2c87ad, #7dd3fc); }
#game-menu .fg-me .fg-xp div { height: 8px; border-radius: 4px; background: rgba(255,255,255,0.08); overflow: hidden; margin: 6px 0 4px; }
#game-menu .fg-tiers { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin: 8px 0 6px; }
#game-menu .fg-tier { position: relative; padding: 12px 12px 10px; border-radius: 12px; background: rgba(4, 8, 16, 0.5); border: 1px solid rgba(140, 170, 220, 0.16); border-top: 3px solid var(--tc); }
#game-menu .fg-tier.locked { opacity: 0.55; }
#game-menu .fg-tier.here { box-shadow: 0 0 0 1px var(--tc), 0 0 22px rgba(125, 211, 252, 0.15); }
#game-menu .fg-tier .mk { font: 700 22px 'Segoe UI', sans-serif; color: #fff; }
#game-menu .fg-tier .mat { color: var(--tc); font-size: 12px; font-weight: 600; margin-bottom: 6px; }
#game-menu .fg-tier .tag { position: absolute; top: 10px; right: 10px; font-size: 10px; letter-spacing: 1px; padding: 2px 7px; border-radius: 999px; background: rgba(255,255,255,0.08); color: #c4cfde; }
#game-menu .fg-tier .tag.on { background: rgba(74, 222, 128, 0.18); color: #86efac; }
#game-menu .fg-tier ul { margin: 6px 0 0; padding: 0; list-style: none; font-size: 12px; color: #a9b6c9; }
#game-menu .fg-tier li { padding: 2px 0; }
#game-menu .fg-tier li em { font-style: normal; color: #6f8099; font-size: 11px; margin-right: 4px; }
#game-menu .fg-cat { margin: 10px 0 0; font: 700 11px 'Segoe UI', sans-serif; letter-spacing: 1.5px; text-transform: uppercase; color: #6f8099; }
#game-menu .fg-track { margin: 8px 0 14px; border-left: 2px solid rgba(125, 211, 252, 0.25); padding-left: 0; }
#game-menu .fg-step { display: flex; gap: 12px; align-items: flex-start; padding: 5px 0 5px 0; position: relative; }
#game-menu .fg-step .fg-lvl { flex-shrink: 0; width: 34px; margin-left: -18px; padding: 2px 0; border-radius: 999px; text-align: center; font: 700 12px 'Segoe UI', sans-serif;
  background: #13203a; border: 1px solid #33496d; color: #e8f0fb; }
#game-menu .fg-step > div { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-height: 22px; }
#game-menu .fg-step.done { opacity: 0.5; }
#game-menu .fg-step.you .fg-lvl { background: #d97706; border-color: #fbbf24; color: #fff; }
#game-menu .fg-step.you b { color: #fbbf24; }
#game-menu .fg-chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px 2px 7px; border-radius: 8px; font-size: 12px; color: #dbe5f3;
  background: rgba(4, 8, 16, 0.5); border: 1px solid rgba(140, 170, 220, 0.18); }
#game-menu .fg-chip em { font-style: normal; color: #7dd3fc; font-size: 10px; letter-spacing: 0.5px; text-transform: uppercase; margin-right: 2px; }
#game-menu .fg-chip img { width: 18px; height: 18px; }
#game-menu .fg-chip.mat em { color: #fbbf24; }
#game-menu .fg-chip.room { color: #a9b6c9; border-style: dashed; }` + RESOURCE_CSS;

interface Material { id: string; name: string; grade: number; output: number; toughness: number; density: number; insulation?: number; exclusive?: string }
/** Pilots' materials only: a boss's, and the dev-only Singularity (`exclusive`), are never listed */
const MATERIALS: Material[] = ((materialsData as unknown as { materials?: Material[] }).materials ?? (materialsData as unknown as Material[])).filter((m) => !m.exclusive);
/** One material per grade (the main line: alloy, steel, titanium, cobalt, neutronium) */
const LADDER: Material[] = [1, 2, 3, 4, 5].map((g) => MATERIALS.filter((m) => m.grade === g).sort((a, b) => b.toughness - a.toughness)[0]).filter(Boolean);
const PLATES = (recipesData as unknown as { parts: { plates: Record<string, string> } }).parts.plates;
const REFINING = (recipesData as unknown as { refining: { id: string; inputs: Record<string, number>; out: number; time?: number }[] }).refining;
const ITEM_NAMES: Record<string, string> = Object.fromEntries(((itemsData as unknown as { items: { id: string; name: string }[] }).items ?? []).map((i) => [i.id, i.name]));
const itemName = (id: string) => ITEM_NAMES[id] ?? id.replace(/_/g, ' ');
/** The public map's systems: no private (a pilot's station, the gun range), training, dev-only or boss-lair (pocket, cavern) system */
const SYSTEMS = ((systemsData as unknown as { systems: { id: string; name: string; danger?: number; siege?: unknown; grade?: number; private?: boolean; tutorial?: boolean; exclusive?: string; pocket?: unknown; surface?: { kind?: string } }[] }).systems)
  .filter((s) => !s.private && !s.tutorial && !s.exclusive && !s.pocket && s.surface?.kind !== 'cavern');
const SYSTEM_GRADE = Object.fromEntries(Object.entries((factionsData as unknown as { spawns: Record<string, { grade?: number }> }).spawns ?? {}).map(([k, v]) => [k, v.grade ?? 1]));
const SIEGE_GRADE: Record<string, number> = { selene_siege: 1, rimeholt_siege: 2, cinderhold_siege: 3, gloam_siege: 5, lastlight_siege: 4 };
/** Where each grade's ore turns up */
const ORE_WHERE: Record<string, string> = {
  iron_ore: 'Metal asteroids everywhere; Sol and Cinder Reach have the most',
  nickel_ore: 'Metal and dense asteroids',
  titanium_ore: 'Dense asteroids (Nebula Prime, Cinder Reach, Void Sector, The Maw), more in dangerous systems. Hard: needs a mining laser',
  cobalt_ore: 'Dense asteroids in danger 4+ systems, far more in the deadliest. Very hard: needs mining charges, a railgun or a lance',
  neutronium_ore: 'Dense asteroids in danger 4+ systems only (Nebula Prime, Cinder Reach, Void Sector, The Maw). Very hard',
  silicate: 'Ice, volatile and crystal asteroids', ice: 'Ice asteroids and comets', copper_ore: 'Metal and crystal asteroids',
};
const WEAPON_SIZE_EXP = 1.15;
const SIZES: [string, number][] = [['Small', 1], ['Medium', 2], ['Large', 4], ['Heavy', 9]];
/** Validated categorical palette (dark surface): output, thrust, pay */
const SERIES_COLORS = ['#0891d1', '#d97706', '#a855f7'];

export function guideHtml(tab: GuideTab, d: GuideDeps): string {
  switch (tab) {
    case 'progress': return progress(d);
    case 'tiers': return tiers(d);
    case 'people': return people(d);
    case 'resources': return resourcesHtml(d);
  }
}

/** Each section's icon */
const ICONS: Record<string, string> = {
  Jobs: '★', People: '☺', 'Leaving Sol': '⬡', Operations: '⚑', 'Flying together': '⚇', 'Ribbons, rankings and the hunt': '✪',
};
const sec = (title: string, ...paras: string[]) =>
  `<section><h3>${ICONS[title] ? `<span class="ic">${ICONS[title]}</span>` : ''}${title}</h3>${paras.map((p) => (p.startsWith('<table') ? p : `<p>${p}</p>`)).join('')}</section>`;


/** The player models (data/ships/models.json) */
const MODELS: FunctionDef[] = (shipModels as unknown as { models: FunctionDef[] }).models;


function people({ k }: GuideDeps): string {
  return `<div class="fg-cols">
    ${sec('People', `Jobs come from people. Find them docked at a station (Overview, <b>People here</b>), or out in space and on planets (fly close and press ${k('interact')}). A <b style="color:#fbbf24">!</b> means they have work for you; a <b style="color:#fbbf24">▸</b> means a job of yours needs them. Some ask you questions: pick your answer (1-9).`,
      `Say <i>Not now</i> and they'll ask again later. When a job you finish opens new work, it appears in your log marked <b>new</b>, and the log shows a badge until you look.`)}
    ${sec('Jobs', `${k('log')} opens your log: jobs in progress, <b>leads</b> (jobs you've heard about, and who has them), and finished jobs. A few beginner jobs start as leads; you hear about the rest by talking to people, from rumours, or by finding them out there. Station boards (Contracts) post bounties that change every ${Math.round(BOUNTY_WINDOW_MS / 60000)} minutes. ${k('skills')} spends skill points (one per level). Each point in a skill is worth a little less than the one before, so spreading them pays. Jobs you can't take yet show once you're within three levels of them.`,
      `Some jobs ask for more than kills: a <b>run</b> through rings against the clock (miss the time and you start again), <b>staying</b> in a spot while something works (leave and the bar drains; something may come to stop you), or <b>recovering</b> a container (only you can take it, and it may be guarded). The panel at the top of the screen shows progress. Some take you down to planets: press ${k('interact')} in low orbit.`,
      `<b>Follow</b> a job or a lead and the ★ marker and the <b>objective guide</b> show the way: the line under the tracker names the next waypoint (a gate, rift or planet) and arrows point from your ship. ${k('autopilot')} flies you there. Turn the guide and the tracker on or off in Settings › Interface.`)}
    ${sec('Leaving Sol', `Glasswater, Borealis, Nebula Prime and Cinder Reach need <b>lane clearance</b>: do the job Cleared for Departure for Harbourmaster Okafor at Sol Central. The Maw needs a licence from Horizon Watch.`,
      `Steel (Mk II) structure unlocks at level 5. Dr. Osei's jobs on Terra Nova teach it too.`)}
    ${sec('Operations', `Some jobs happen out in space: courier runs against the clock, scans of derelict wrecks (fly close and hold still), escorts (meet the freighter and keep it alive until it docks), and outpost defences against waves of raiders. The panel at the top of the screen shows how it's going.`)}
    ${sec('Flying together', `Rest the cursor on another pilot to see who they are; ${k('party')} invites them (or opens the party window). A party of up to four shares kills (for jobs too), gets a <b>wing bonus</b> of 8% damage and mining yield per wingmate within 3 km, can rally beside each other after being destroyed, and takes on <b>fleet operations</b>: uplinks, convoys and sieges that need more than one pilot. Start a chat line with <b>/p</b> for party chat. ${k('ping')} pings what's under your cursor for the party (with Shift: danger); on the map, Shift + right-click.`,
      `Trade with a pilot within 2.5 km from the party window: both put up items and credits, both accept, and the swap happens at once.`)}
    ${sec('Ribbons, rankings and the hunt', `Milestones earn ribbons: your first kill, a boss, thousands of tons of ore, fleet ops, every system visited. Each pays out on the spot; rare ones are announced to the whole galaxy. ${k('log')} → Ribbons shows your progress, and Rankings shows this week's and all-time leaders (registered pilots).`,
      `Each week one boss is <b>hunted</b>: everyone in on the kill gets double XP and credits. The map marks it.`)}
  </div>`;
}

// ---------------------------------------------------------------------------
// Progress: your level, the tiers, and what each level takes
// ---------------------------------------------------------------------------

const MARK = ['', 'I', 'II', 'III', 'IV', 'V'];
/** A colour per tier (the material's feel) */
const TIER_COLOR = ['', '#94a3b8', '#cbd5e1', '#38bdf8', '#3b82f6', '#a855f7'];
const TIER_ORES: Record<number, string> = {
  1: 'Iron, nickel, copper', 2: 'More iron and nickel per plate', 3: 'Titanium (hard rock)', 4: 'Cobalt (very hard)', 5: 'Neutronium and cobalt (very hard, rare)',
};

function progress(d: GuideDeps): string {
  const level = d.level(), xp = d.xp();
  const lo = xpToReach(level), hi = xpToReach(level + 1);
  const frac = Math.max(0, Math.min(1, (xp - lo) / Math.max(1, hi - lo)));
  const tier = [5, 4, 3, 2, 1].find((g) => level >= GRADE_LEVEL[g]) ?? 1;
  const next = nextBuildUnlock(MODELS, level);
  const me = `<div class="fg-me"><div class="lv"><small>LEVEL</small>${level}</div>
    <div class="fg-xp"><span class="muted">${level >= LEVEL_CAP ? 'The top level' : `${Math.round(xp - lo).toLocaleString()} / ${Math.round(hi - lo).toLocaleString()} XP to level ${level + 1}`}</span><div><i style="width:${(frac * 100).toFixed(1)}%"></i></div>
    <span class="muted">${next ? `Next: ${esc(nextUnlockHint(MODELS, level)!)} (${Math.max(0, xpToReach(next.level) - xp).toLocaleString()} XP to go)` : 'Every model and material is open to you'}</span></div>
    <div><span class="fg-mk" style="font-size:14px; padding:4px 10px; border-color:${TIER_COLOR[tier]}">Mk ${MARK[tier]}</span><div class="muted" style="margin-top:4px">your tier</div></div></div>`;

  const tiers = [1, 2, 3, 4, 5].map((g) => {
    const mat = LADDER.find((m) => m.grade === g);
    const systems = SYSTEMS.filter((s) => SYSTEM_GRADE[s.id] === g).map((s) => s.name.replace(/ System$/, ''));
    const moons = SYSTEMS.filter((s) => SIEGE_GRADE[s.id] === g).map((s) => s.name);
    const open = level >= GRADE_LEVEL[g];
    return `<div class="fg-tier${open ? '' : ' locked'}${g === tier ? ' here' : ''}" style="--tc:${TIER_COLOR[g]}">
      <span class="tag${open ? ' on' : ''}">${open ? (g === tier ? 'YOU' : 'OPEN') : `🔒 LVL ${GRADE_LEVEL[g]}`}</span>
      <div class="mk">Mk ${MARK[g]}</div><div class="mat">${esc(mat?.name ?? '')}</div>
      <ul><li><em>Level</em>${GRADE_LEVEL[g]}</li><li><em>Fly in</em>${systems.map(esc).join(', ') || '—'}</li>
      <li><em>Siege</em>${moons.map(esc).join(', ') || '—'}</li><li><em>Ore</em>${TIER_ORES[g]}</li></ul></div>`;
  }).join('');

  // XP each level takes (not the running total: that's what you feel), the grade unlocks marked: forty levels from just behind you
  const from = Math.max(2, Math.min(LEVEL_CAP - 39, level - 8));
  const levels = Array.from({ length: Math.min(40, LEVEL_CAP - from + 1) }, (_, i) => i + from);
  const bars = levels.map((l) => ({ level: l, need: xpToReach(l) - xpToReach(l - 1), total: xpToReach(l) }));
  return `${me}
    <h3>Unlock track</h3>
    <p>What each level opens: new modules to fabricate (by family), structure materials, and room (build points, hangar bays). Everything you can make opens at its level and never earlier: modules, structure materials (the special ones at the level their plate can be refined) and fabricator recipes. A boss's legendary also needs that boss's rare part to make, and a job's kit needs its job.</p>
    ${unlockTrackHtml(d, level)}
    <h3>The tiers</h3>
    <p>Each tier is a grade of material and gear, Mk I to Mk V. Its structure material opens at its level, and not before. Higher tiers take far more ore per plate, longer to refine and fabricate, and mining lasers of the tier below barely scratch their rock.</p>
    <div class="fg-tiers">${tiers}</div>
    <h3>Levels</h3>
    <p>Levels run from 1 to ${LEVEL_CAP}, each a little longer than the last, though deadlier systems pay more XP for each kill. Each level brings a skill point (K) until you hold ${SKILL_POINT_CAP} (every skill full). XP comes from kills (more for higher-grade ships), mining, jobs (the story pays most), ribbons and bosses. Credits are deliberately scarce: what you need you mostly mine and make; tougher ships pay more a kill, and bosses the most.</p>
    ${levelChart(bars, level)}`;
}

/** Family names for the track and gallery ("drive_cell": "Drive cell") */
const FAMILY_NAME: Record<string, string> = { emp: 'EMP', ion: 'Ion drive', plasma: 'Plasma drive', jumpcoil: 'Jump coil', mining: 'Mining laser', reactor: 'Reactor' };
// (Own keys only: the constructor family isn't Object's constructor)
const familyName = (f: string | undefined) => (f ? (Object.hasOwn(FAMILY_NAME, f) ? FAMILY_NAME[f] : f.charAt(0).toUpperCase() + f.slice(1).replace(/_/g, ' ')) : '');
const modelIcon = (d: GuideDeps, m: FunctionDef) => d.icon(`part:${m.material}:${m.id}:${(m.pieces as string[])[0]}`);

/** Every level that opens something, the ones behind you faded, a marker where you are */
function unlockTrackHtml(d: GuideDeps, level: number): string {
  const steps = unlockTrack(MODELS);
  const row = (st: TrackStep) => {
    // Models grouped by family, then materials, then room
    const fams = new Map<string, FunctionDef[]>();
    for (const m of st.models) fams.set(m.family ?? '', [...(fams.get(m.family ?? '') ?? []), m]);
    const chips = [
      ...[...fams].map(([f, ms]) => `<span class="fg-chip"><em>${esc(familyName(f))}</em>${ms.map((m) => {
        const src = modelIcon(d, m);
        return `${src ? `<img src="${src}" alt="">` : ''}${esc(m.name ?? m.id)}`;
      }).join(', ')}</span>`),
      ...st.materials.map((id) => `<span class="fg-chip mat"><em>Material</em>${esc(materialUnlockName(id))}</span>`),
      ...st.capacity.map((c) => `<span class="fg-chip room">${esc(c)}</span>`),
    ];
    return `<div class="fg-step${st.level <= level ? ' done' : ''}"><span class="fg-lvl">${st.level}</span><div>${chips.join('')}</div></div>`;
  };
  const past = steps.filter((st) => st.level <= level), ahead = steps.filter((st) => st.level > level);
  const you = `<div class="fg-step you"><span class="fg-lvl">${level}</span><div><b>You are here</b>${ahead.length ? ` <span class="muted">· next at level ${ahead[0].level}</span>` : ''}</div></div>`;
  return `<div class="fg-track">${past.map(row).join('')}${you}${ahead.map(row).join('')}</div>`;
}

function levelChart(bars: { level: number; need: number; total: number }[], mine: number): string {
  const h = 230, x0 = 52, x1 = W - 12, y0 = 14, y1 = h - 34;
  const max = Math.max(...bars.map((b) => b.need));
  const step = (x1 - x0) / bars.length, bw = Math.max(6, step - 4);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = max * f, y = y1 - (y1 - y0) * f;
    return `<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" stroke="#1d2a40"/><text x="${x0 - 8}" y="${y + 4}" text-anchor="end" fill="#6f8099" font-size="11">${v >= 1000 ? `${Math.round(v / 1000)}k` : Math.round(v)}</text>`;
  }).join('');
  const rects = bars.map((b, i) => {
    const x = x0 + i * step + 2, bh = Math.max(2, ((y1 - y0) * b.need) / max), y = y1 - bh;
    const done = b.level <= mine, here = b.level === mine + 1;
    const unlock = GRADE_LEVEL.indexOf(b.level);
    return `<g data-bar="${i}">`
      + `<path d="M${x},${y1} v${-(bh - 4)} a4,4 0 0 1 4,-4 h${bw - 8} a4,4 0 0 1 4,4 v${bh - 4} z" fill="${here ? '#d97706' : done ? '#0b6a96' : '#0891d1'}" opacity="${done ? 0.55 : 1}"/>`
      + (unlock > 1 ? `<text x="${x + bw / 2}" y="${y - 6}" text-anchor="middle" fill="#e8f0fb" font-size="11" font-weight="700">Mk ${MARK[unlock]}</text>` : '')
      + (here || b.level % 5 === 0 || bars.length <= 20 ? `<text x="${x + bw / 2}" y="${h - 16}" text-anchor="middle" fill="${here ? '#fbbf24' : '#8394ad'}" font-size="10">${b.level}</text>` : '')
      + `<rect x="${x - 2}" y="${y0}" width="${step}" height="${y1 - y0 + 20}" fill="transparent"/></g>`;
  }).join('');
  const data = JSON.stringify({ lv: bars });
  return `<div class="fg-chart" data-levels='${data}' role="img" aria-label="XP each level takes">
    <div class="muted" style="margin-bottom:4px">XP each level takes · <span style="color:#fbbf24">■</span> your next level · faded: done</div>
    <svg viewBox="0 0 ${W} ${h}">${ticks}${rects}<text x="${(x0 + x1) / 2}" y="${h - 2}" text-anchor="middle" fill="#6f8099" font-size="10">level</text></svg><div class="fg-tip"></div></div>`;
}

// ---------------------------------------------------------------------------
// Tiers & scaling
// ---------------------------------------------------------------------------

function tiers(d: GuideDeps): string {
  const mine = d.myRating();
  const threats = d.threats();
  const x = LADDER.map((m) => `Mk ${MARK[m.grade]}`);
  const lines = [
    { name: 'Damage, shields, power out & draw', color: SERIES_COLORS[0], ys: LADDER.map((m) => m.output) },
    { name: 'Engine thrust', color: SERIES_COLORS[1], ys: LADDER.map((m) => Math.sqrt(m.output)) },
  ];
  const sizes = SIZES.map(([n, a]) => ({ label: n, value: Math.pow(a, WEAPON_SIZE_EXP), cells: a }));

  const gradeRows = LADDER.map((m) => {
    const plate = PLATES[m.id];
    const r = REFINING.find((x) => x.id === plate);
    const ores = Object.keys(r?.inputs ?? {});
    return `<tr><td><span class="fg-mk">Mk ${MARK[m.grade]}</span></td><td>${esc(m.name)}</td>`
      + `<td class="n">×${m.output.toFixed(2)}</td><td class="n">${m.toughness}</td>`
      + `<td>${r ? Object.entries(r.inputs).map(([id, n]) => `${n} ${esc(itemName(id))}`).join(' + ') + ` → ${esc(itemName(plate))} <span class="muted">(${r.time ?? 2}s)</span>` : '—'}</td>`
      + `<td class="muted">${ores.map((o) => ORE_WHERE[o]).filter(Boolean).slice(0, 1).map(esc).join('')}</td></tr>`;
  }).join('');

  // (Only the public map: SYSTEMS leaves out private, training, dev-only and boss-lair systems)
  const ladder = SYSTEMS.filter((s) => SYSTEM_GRADE[s.id] || SIEGE_GRADE[s.id])
    .map((s) => ({ s, grade: SYSTEM_GRADE[s.id] ?? SIEGE_GRADE[s.id], moon: !!SIEGE_GRADE[s.id], threat: threats[s.id] ?? 0 }))
    .sort((a, b) => (a.threat || a.grade * 20) - (b.threat || b.grade * 20));
  const ladderRows = ladder.map(({ s, grade, moon, threat }) =>
    `<tr><td>${esc(s.name)}${moon ? ' <span class="muted">· siege moon</span>' : ''}</td><td><span class="fg-mk">Mk ${MARK[grade]}</span></td>`
    + `<td class="n">${s.danger ?? '—'}</td><td>${threat ? threatTag(mine, threat, '◆') : '<span class="muted">—</span>'}</td></tr>`).join('');

  return `
    <h3>Mk grades</h3>
    <p>Gear comes in grades, Mk I to Mk V, set by the material it is built from; a higher grade multiplies what a part does, and the power it draws.</p>
    ${lineChart('How a grade scales a part (× Mk I)', x, lines)}
    <h3>Materials</h3>
    <div class="fg-wide"><table class="fg-t"><thead><tr><th>Grade</th><th>Material</th><th class="n">Strength</th><th class="n">HP / cell</th><th>Made from</th><th>Where the ore is</th></tr></thead><tbody>${gradeRows}</tbody></table></div>
    <h3>Systems by Mk</h3>
    <p>Each system's enemies are built at its Mk. ◆ shows how dangerous they are${mine ? `, compared with your ship's rating of <b>${Math.round(mine)}</b>` : ''}.</p>
    <div class="fg-wide"><table class="fg-t"><thead><tr><th>System</th><th>Enemies</th><th class="n">Danger</th><th>Threat</th></tr></thead><tbody>${ladderRows}</tbody></table></div>
    <h3>Weapon size</h3>
    <p>A bigger weapon hits harder than its cells alone: one Large gun outhits four Small ones.</p>
    ${barChart('Weapon damage by size (× Small)', sizes)}`;
}

// --- Charts: inline SVG, a hover readout on each (wired by wireGuideCharts)

const W = 640, H = 240, PAD = { l: 44, r: 16, t: 14, b: 30 };

function lineChart(title: string, xs: string[], series: { name: string; color: string; ys: number[] }[]): string {
  const max = Math.ceil(Math.max(...series.flatMap((s) => s.ys)));
  const px = (i: number) => PAD.l + (i / (xs.length - 1)) * (W - PAD.l - PAD.r);
  const py = (v: number) => H - PAD.b - (v / max) * (H - PAD.t - PAD.b);
  const grid = Array.from({ length: max + 1 }, (_, v) => `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${py(v)}" y2="${py(v)}" stroke="#1d2a40" stroke-width="1"/>`
    + `<text x="${PAD.l - 8}" y="${py(v) + 4}" text-anchor="end" fill="#6f8099" font-size="11">×${v}</text>`).join('');
  const xl = xs.map((x, i) => `<text x="${px(i)}" y="${H - 8}" text-anchor="middle" fill="#8394ad" font-size="11">${x}</text>`).join('');
  const paths = series.map((s) => `<polyline points="${s.ys.map((v, i) => `${px(i)},${py(v)}`).join(' ')}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
    + s.ys.map((v, i) => `<circle cx="${px(i)}" cy="${py(v)}" r="4" fill="${s.color}" stroke="#0b1220" stroke-width="2"/>`).join('')
    // Direct label at the end of each line
    + `<text x="${px(xs.length - 1) - 8}" y="${py(s.ys[s.ys.length - 1]) - 9}" text-anchor="end" fill="#c4cfde" font-size="11">×${s.ys[s.ys.length - 1].toFixed(1)}</text>`).join('');
  const data = JSON.stringify({ xs, series: series.map((s) => ({ name: s.name, color: s.color, ys: s.ys })), px: xs.map((_, i) => px(i)) });
  return `<div class="fg-chart" data-chart='${data.replace(/'/g, '&#39;')}' role="img" aria-label="${esc(title)}">
    <div class="muted" style="margin-bottom:4px">${esc(title)}</div>
    <div class="fg-legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>
    <svg viewBox="0 0 ${W} ${H}">${grid}<line class="fg-x" x1="0" x2="0" y1="${PAD.t}" y2="${H - PAD.b}" stroke="#5b6b85" stroke-width="1" visibility="hidden"/>${paths}${xl}<rect x="${PAD.l}" y="${PAD.t}" width="${W - PAD.l - PAD.r}" height="${H - PAD.t - PAD.b}" fill="transparent"/></svg>
    <div class="fg-tip"></div></div>`;
}

function barChart(title: string, bars: { label: string; value: number; cells: number }[]): string {
  const h = 34 * bars.length + 10, max = Math.ceil(Math.max(...bars.map((b) => b.value)));
  const x0 = 70, x1 = W - 60;
  const rows = bars.map((b, i) => {
    const y = 6 + i * 34, w = Math.max(4, ((x1 - x0) * b.value) / max);
    return `<g data-bar="${i}"><text x="${x0 - 10}" y="${y + 17}" text-anchor="end" fill="#a9b6c9" font-size="12">${b.label}</text>`
      + `<path d="M${x0},${y + 4} h${w - 4} a4,4 0 0 1 4,4 v10 a4,4 0 0 1 -4,4 h${-(w - 4)} z" fill="${SERIES_COLORS[0]}"/>`
      + `<text x="${x0 + w + 8}" y="${y + 17}" fill="#c4cfde" font-size="12">×${b.value.toFixed(1)}</text>`
      + `<rect x="0" y="${y}" width="${W}" height="30" fill="transparent"/></g>`;
  }).join('');
  const data = JSON.stringify({ bars });
  return `<div class="fg-chart" data-bars='${data.replace(/'/g, '&#39;')}' role="img" aria-label="${esc(title)}">
    <div class="muted" style="margin-bottom:4px">${esc(title)}</div>
    <svg viewBox="0 0 ${W} ${h}">${rows}</svg><div class="fg-tip"></div></div>`;
}

/** Hover readouts on the guide's charts */
export function wireGuideCharts(root: HTMLElement): void {
  wireResources(root);
  for (const el of root.querySelectorAll<HTMLElement>('.fg-chart[data-levels]')) {
    const c = JSON.parse(el.dataset.levels!) as { lv: { level: number; need: number; total: number }[] };
    const tip = el.querySelector<HTMLElement>('.fg-tip')!;
    for (const g of el.querySelectorAll<SVGGElement>('[data-bar]')) {
      const b = c.lv[Number(g.dataset.bar)];
      g.addEventListener('mousemove', (e) => {
        tip.innerHTML = `<b>Level ${b.level}</b><br>${b.need.toLocaleString()} XP from level ${b.level - 1}<br>${b.total.toLocaleString()} XP in all`;
        tip.style.display = 'block';
        const r = el.getBoundingClientRect();
        tip.style.left = `${e.clientX - r.left}px`;
        tip.style.top = `${e.clientY - r.top - 12}px`;
      });
      g.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    }
  }
  for (const el of root.querySelectorAll<HTMLElement>('.fg-chart[data-chart]')) {
    const c = JSON.parse(el.dataset.chart!) as { xs: string[]; series: { name: string; color: string; ys: number[] }[]; px: number[] };
    const svg = el.querySelector('svg')!, tip = el.querySelector<HTMLElement>('.fg-tip')!, line = svg.querySelector<SVGLineElement>('.fg-x')!;
    svg.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const vx = ((e.clientX - r.left) / r.width) * W;
      let i = 0;
      for (let j = 1; j < c.px.length; j++) if (Math.abs(c.px[j] - vx) < Math.abs(c.px[i] - vx)) i = j;
      line.setAttribute('x1', String(c.px[i])); line.setAttribute('x2', String(c.px[i])); line.setAttribute('visibility', 'visible');
      tip.innerHTML = `<b>${esc(c.xs[i])}</b><br>` + c.series.map((s) => `<span style="color:${s.color}">●</span> ${esc(s.name)}: <b>×${s.ys[i].toFixed(2)}</b>`).join('<br>');
      tip.style.display = 'block';
      tip.style.left = `${(c.px[i] / W) * r.width}px`;
      tip.style.top = `${e.clientY - el.getBoundingClientRect().top - 12}px`;
    });
    svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; line.setAttribute('visibility', 'hidden'); });
  }
  for (const el of root.querySelectorAll<HTMLElement>('.fg-chart[data-bars]')) {
    const c = JSON.parse(el.dataset.bars!) as { bars: { label: string; value: number; cells: number }[] };
    const tip = el.querySelector<HTMLElement>('.fg-tip')!;
    for (const g of el.querySelectorAll<SVGGElement>('[data-bar]')) {
      const b = c.bars[Number(g.dataset.bar)];
      g.addEventListener('mousemove', (e) => {
        tip.innerHTML = `<b>${esc(b.label)}</b> · ${b.cells} cell${b.cells > 1 ? 's' : ''}<br>Damage ×${b.value.toFixed(2)} (×${(b.value / b.cells).toFixed(2)} per cell)`;
        tip.style.display = 'block';
        const r = el.getBoundingClientRect();
        tip.style.left = `${e.clientX - r.left}px`;
        tip.style.top = `${e.clientY - r.top - 12}px`;
      });
      g.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    }
  }
}
