/**
 * The field guide (Escape → Field guide): a panel that fits the screen, with a
 * tab per topic and its own scroll bar. Sections carry an icon; the ships tab
 * links to the component guide (every part, its level and what it takes).
 * "Progress" shows where you stand: your level, the unlock track (what each
 * level opens: models by family, materials, room; you marked on it), the five
 * tiers (the level each needs, their systems, moons and ores) and a chart of
 * what each level takes. "Tiers & scaling" is built from the game data: how a part's grade scales what it does (a
 * chart), how weapon size scales damage (a chart), every grade's material and
 * where its ore comes from, and the systems and siege moons by tier with
 * their threat against your ship.
 */

import {
  threatLevel, xpToReach, GRADE_LEVEL, LEVEL_CAP, SKILL_POINT_CAP, jumpTuning, towTuning, unlockTrack, nextBuildUnlock, nextUnlockHint, materialUnlockName,
  secondsToFreeze, warmthStage, type FunctionDef, type ShipTuning, type TrackStep, type HazardRules,
} from '@space-game/common';
import shipTuning from '../../../data/ships/tuning.json';
import hazardData from '../../../data/hazards.json';
import materialsData from '../../../data/ships/materials.json';
import shipFunctions from '../../../data/ships/functions.json';
import shipModels from '../../../data/ships/models.json';
import recipesData from '../../../data/recipes.json';
import factionsData from '../../../data/factions.json';
import systemsData from '../../../data/systems.json';
import itemsData from '../../../data/items.json';
import { threatTag } from './threat';

export type GuideTab = 'basics' | 'combat' | 'ships' | 'industry' | 'progress' | 'tiers' | 'people';

export const GUIDE_TABS: { id: GuideTab; label: string }[] = [
  { id: 'basics', label: 'Flying' },
  { id: 'combat', label: 'Combat & danger' },
  { id: 'ships', label: 'Ships & hangar' },
  { id: 'industry', label: 'Mining & making' },
  { id: 'progress', label: 'Progress' },
  { id: 'tiers', label: 'Tiers & scaling' },
  { id: 'people', label: 'Jobs & pilots' },
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
#game-menu .fg-link { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; justify-content: space-between; padding: 12px 16px; margin: 8px 0 14px; border-radius: 10px;
  background: linear-gradient(90deg, rgba(208, 97, 63, 0.18), rgba(9, 15, 28, 0.2)); border: 1px solid rgba(208, 97, 63, 0.4); }
#game-menu .fg-link b { display: block; color: #fff; font-size: 14px; letter-spacing: 0.5px; }
#game-menu .fg-link span { color: #a9b6c9; font-size: 12px; }
#game-menu .fg-link > div { flex: 1; min-width: 220px; }
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
#game-menu .fg-chip.room { color: #a9b6c9; border-style: dashed; }`;

const JUMP = jumpTuning(shipTuning as unknown as ShipTuning);
/** The Burst Strafer and the Tow Beam (common/src/ships/strafer.ts, tow.ts): their levels and numbers */
const STRAFER = (shipModels as unknown as { models: FunctionDef[] }).models.find((m) => m.strafe);
const TOW_MODEL = (shipModels as unknown as { models: FunctionDef[] }).models.find((m) => m.tow);
const TOW = towTuning(shipTuning as unknown as ShipTuning);
/** The Repair Beam and the Point Defence Turret (common/src/ships/features/support/support.ts): their levels and numbers */
const MODEL_LEVEL = (id: string, or: number) => (shipModels as unknown as { models: FunctionDef[] }).models.find((m) => m.id === id)?.unlock?.level ?? or;
const REPAIR_LEVEL = MODEL_LEVEL('utility_repair_beam', 17), PD_LEVEL = MODEL_LEVEL('point_defence_turret', 10);
const SUPPORT_W = (shipTuning as unknown as ShipTuning).weapons ?? {};
const PD_RANGE = SUPPORT_W.point_defence?.pointDefence?.range ?? 560;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

interface Material { id: string; name: string; grade: number; output: number; toughness: number; density: number; insulation?: number }
const MATERIALS: Material[] = ((materialsData as unknown as { materials?: Material[] }).materials ?? (materialsData as unknown as Material[]));
/** One material per grade (the main line: alloy, steel, titanium, cobalt, neutronium) */
const LADDER: Material[] = [1, 2, 3, 4, 5].map((g) => MATERIALS.filter((m) => m.grade === g).sort((a, b) => b.toughness - a.toughness)[0]).filter(Boolean);
const PLATES = (recipesData as unknown as { parts: { plates: Record<string, string> } }).parts.plates;
const REFINING = (recipesData as unknown as { refining: { id: string; inputs: Record<string, number>; out: number; time?: number }[] }).refining;
const ITEM_NAMES: Record<string, string> = Object.fromEntries(((itemsData as unknown as { items: { id: string; name: string }[] }).items ?? []).map((i) => [i.id, i.name]));
const itemName = (id: string) => ITEM_NAMES[id] ?? id.replace(/_/g, ' ');
const SYSTEMS = ((systemsData as unknown as { systems: { id: string; name: string; danger?: number; siege?: unknown; grade?: number }[] }).systems);
const SYSTEM_GRADE = Object.fromEntries(Object.entries((factionsData as unknown as { spawns: Record<string, { grade?: number }> }).spawns ?? {}).map(([k, v]) => [k, v.grade ?? 1]));
const SIEGE_GRADE: Record<string, number> = { selene_siege: 1, rimeholt_siege: 2, cinderhold_siege: 3, gloam_siege: 5, lastlight_siege: 4 };
/** Where each grade's ore turns up */
const ORE_WHERE: Record<string, string> = {
  iron_ore: 'Metal asteroids everywhere; Sol and Cinder Reach have the most',
  nickel_ore: 'Metal and dense asteroids',
  titanium_ore: 'Dense asteroids (Nebula Prime, Cinder Reach, Void Sector, The Maw); richer with danger. Hard: a mining laser',
  cobalt_ore: 'Dense asteroids in danger 4+ systems, far more in the deadliest. Very hard: a titanium-grade miner',
  neutronium_ore: 'Dense asteroids in danger 4+ systems only (Nebula Prime, Cinder Reach, Void Sector, The Maw). Very hard',
  silicate: 'Ice, volatile and crystal asteroids', ice: 'Ice asteroids and comets', copper_ore: 'Metal and crystal asteroids',
};
const WEAPON_SIZE_EXP = 1.15;
const SIZES: [string, number][] = [['Small', 1], ['Medium', 2], ['Large', 4], ['Heavy', 9]];
/** Validated categorical palette (dark surface): output, thrust, pay */
const SERIES_COLORS = ['#0891d1', '#d97706', '#a855f7'];

export function guideHtml(tab: GuideTab, d: GuideDeps): string {
  switch (tab) {
    case 'basics': return basics(d);
    case 'combat': return combat(d);
    case 'ships': return ships(d);
    case 'industry': return industry(d);
    case 'progress': return progress(d);
    case 'tiers': return tiers(d);
    case 'people': return people(d);
  }
}

/** Cold (ships/warmth.ts): the numbers from hazards.json and the stages */
function coldGuide(): string {
  const w = (hazardData as unknown as HazardRules).warmth;
  if (!w) return 'Cold systems slowly freeze a ship that stays away from heat.';
  const numb = warmthStage(24);
  // (The coldest system, by its rating)
  const systems = ((systemsData as unknown as { systems?: unknown[] }).systems ?? []) as { name: string; hazardRatings?: Record<string, number> }[];
  const coldest = systems.filter((s) => (s.hazardRatings?.cryo ?? 0) > 0).sort((a, b) => b.hazardRatings!.cryo - a.hazardRatings!.cryo)[0];
  const insulators = MATERIALS.filter((m) => (m.insulation ?? 0) > 0).sort((a, b) => (b.insulation ?? 0) - (a.insulation ?? 0));
  return `In a cold system, cold builds up on your ship while you're away from heat, and frost creeps in from the edges of your screen as your warmth runs down (the chip under the hazard warnings gives the number). `
    + (coldest ? `In ${esc(coldest.name)} it takes about ${Math.round(secondsToFreeze(w, coldest.hazardRatings!.cryo, 0) / 60)} minutes from warm to frozen through.` : '')
    + `<br><br>Below half warmth you're chilled: a warning. Below a quarter thrust and steering drop by ${Math.round((1 - numb.control) * 100)}%. `
    + `Frozen through, your ship seizes up for ${Math.round(w.seizeTicks / 60)} seconds and comes out of it with a little warmth back.`
    + `<br><br><b>Heat</b> brings it back: near a star, close by a station (docked is quickest), beside a ship that's on fire (yours counts), or near a lava world. Away from the cold it comes back by itself. Plan your routes from one warm spot to the next.`
    + (insulators.length ? `<br><br><b>Insulation</b>: hulls of ${insulators.map((m) => `${m.name ?? m.id} (${Math.round((m.insulation ?? 0) * 100)}%)`).join(', ')} keep out that share of the cold, by how much of the hull they make. It only buys time: heat still matters.` : '')
    + `<br><br>Frost weapons, and foes that hit with cold, take warmth off the same meter.`;
}

/** Each section's icon */
const ICONS: Record<string, string> = {
  Flying: '✈', 'Jump drive': '⤳', Bracing: '⚓', 'Cargo weight': '⚖', 'Getting around': '◎', Autopilot: '▶', Stations: '⌂', 'The info panel': 'ⓘ', Hazards: '☢', 'Cold and warmth': '❄',
  Combat: '✦', Targets: '⌖', Repairs: '✚', 'Losing a ship': '↺', 'Danger & PvP': '⚠', Ratings: '◆', Sieges: '☾', 'Bosses & events': '☠', Salvage: '⚙',
  'The hangar': '⬢', 'Build orders': '☰', Energy: 'ϟ', Engines: '▲', Scrapping: '♻',
  Mining: '⛏', Refining: '♨', Fabricating: '⚒', 'Markets & quartermasters': '¤', 'Your hold': '▤',
  Jobs: '★', People: '☺', 'Leaving Sol': '⬡', Operations: '⚑', 'Flying together': '⚇', 'Ribbons, rankings and the hunt': '✪',
};
const sec = (title: string, ...paras: string[]) =>
  `<section><h3>${ICONS[title] ? `<span class="ic">${ICONS[title]}</span>` : ''}${title}</h3>${paras.map((p) => `<p>${p}</p>`).join('')}</section>`;

function basics({ k }: GuideDeps): string {
  return `<div class="fg-cols">
    ${sec('Flying', `Your ship turns to face the cursor and ${k('forward')}${k('left')}${k('backward')}${k('right')} push it around the screen. ${k('boost')} boosts: the engines push harder and draw on the battery (the ENERGY gauge) far faster. Afterburners boost hardest, plasma drives barely.`,
      `<b>Helm</b> mode, if you want it (${k('helm')} switches, or pick it in Settings): ${k('left')}/${k('right')} turn, ${k('forward')}/${k('backward')} thrust along the nose, ${k('strafeLeft')}/${k('strafeRight')} strafe, and the view turns with your ship so its nose points up the screen.`,
      `<b>The view</b> is its own choice too (${k('camera')} switches, or pick it in Settings): north up, or following your heading, with either controls. Mouse-steer with the view following your heading: the cursor stays on its spot in space while the view turns (move the mouse to turn), ${k('forward')}${k('left')}${k('backward')}${k('right')} push along your ship, and a click captures the mouse (Esc lets it go).`)}
    ${sec('Jump drive', `The fastest way across a system: anything past about 15k is quicker by jump than by flying. ${k('jump')} spools the drive for ${(JUMP.chargeTicks / 60).toFixed(1)} seconds, however far you aim (the engines go quiet and you slow down, so it's a poor way out of a fight already on top of you), then flings you along your nose in a second or two; you come out still moving and coast to a stop where you aimed, or thrust on. Then it recharges, so on a long trip fly the stretch between jumps.`,
      `<b>Range and recharge</b> come from the drive's coils against the size of the hull. The core has a coil of its own, about right for a small ship: some ${Math.round(JUMP.baseRange / 1000)}k and ${Math.round(JUMP.cooldownTicks / 60)} seconds. A bigger hull needs jump coils (a powered part) to match, or the drive reaches less and recharges slower, though it still works. More coil than the hull needs adds a little, less with each one, and the recharge never drops much below ${Math.round(Math.max(JUMP.minCooldownTicks, JUMP.cooldownTicks * JUMP.cooldownFloor) / 60)} seconds; better grades of coil do a little more. The hangar shows how your coils stand against your hull.`,
      `You jump as far as your cursor, up to your drive's range. While you line it up, a ring round your ship shows how far it reaches and a reticle shows where you'll land: brackets close round it when it locks on to a station, gate or marker (on screen or its edge pointer), dropping you just short of it, and it turns red if you'd land in a star's heat or among hostiles. Press it again while spooling to abort; a soft chime says it's charged again.`,
      `Near a star, inside its charging ring (☀ on the system map), the drive recharges ${1 + JUMP.solarCharge} times as fast and reaches ${Math.round((JUMP.solarRangeBoost - 1) * 100)}% further.`,
      `<b>${JUMP.lodestoneName}s</b> (◈ on the map and edge markers) are huge bodies of grey stone, from about fifty kilometres to a few hundred across, and rarely more than a handful to a system. From a way off they look like lone rocks. Closer, pilots say, the faces are a touch too flat, the edges meet at the same angles, and the veins branch in the same pattern at every scale, glowing faintly on the side away from the star; they turn slowly and never slow down. Geologists call them a mineral formation; settlers say someone put them there. Nobody knows why a jump drive works better near one, but it does, so routes are built round them. Inside one's field the drive recharges ${1 + JUMP.lodestoneCharge} times as fast, and it stays primed: your next jump within ${Math.round(JUMP.lodestonePrimeTicks / 60)} seconds of leaving reaches ${Math.round((JUMP.lodestoneRangeBoost - 1) * 100)}% further. If you're also inside a star's charging ring, you get whichever boost is better, not both. A jump locked on to one drops you inside its field.`,
      `Now and then a stretch of one goes dark, its veins dead and its faces fractured: a <b>scarred</b> ${JUMP.lodestoneShort.toLowerCase()} gives a drive about ${Math.round(JUMP.lodestoneScarredCharge * 100)}% of the usual help. Very rarely a whole one is lost, dead or shattered into a field of fragments, and gives nothing at all. People build on them anyway, and some have raiders camped by them.`)}
    ${sec('Mending and point defence', `A <b>Repair Beam</b> (a utility turret, from level ${REPAIR_LEVEL}) mends other ships. Put your cursor on a damaged party member or ally and fire: a soft teal beam passes through anything it can't mend and stops on the first friendly hull, mending about ${Math.round(SUPPORT_W.repair?.heal ?? 42)} HP a second into the damaged parts nearest where it lands (sweep it over the hull to mend where it's worst). It can't mend your own ship, a destroyed part (that's a station's or a repair kit's job) or a shield, and it does nothing to an enemy. It draws a lot of power while it's on. Mending a pilot counts as helping them: for a while after, you share their kills as their party does, and a boss they fight counts you among its winners.`,
      `A <b>Point Defence Turret</b> (a weapon, from level ${PD_LEVEL}) fires on its own, whatever you're doing: it turns to the nearest missile, torpedo, mortar shell or seeker coming at you or near you (within about ${PD_RANGE}) and shoots it down, a little power a shot. A missile takes one hit, a torpedo three, a boss's seekers two. It never fires at ships, and it can't touch shells, beams or a boss's rings of shots: those are still yours to dodge. Several turrets cover each other; one alone lets the second missile of a salvo through.`)}
    ${sec('Dodging and towing', `A <b>Burst Strafer</b> (an engine, from level ${STRAFER?.unlock?.level ?? 10}) gives no push for cruising at all: it dodges. Press ${k('dodge')} and the ship bursts the way you're steering (${k('forward')}/${k('left')}/${k('backward')}/${k('right')}, diagonals too; at the helm, forward, back and ${k('strafeLeft')}/${k('strafeRight')}) for ${((STRAFER?.strafe?.ticks ?? 12) / 60).toFixed(2)} seconds, with every strafer that can push that way. Hold nothing and it goes back the other way from your last dodge. A strafer pushes away from its nozzle, and a dodge gets each strafer's push along it: strafers facing all four ways dodge anywhere, a pair on the flanks mostly sideways. You can dodge again ${(((STRAFER?.strafe?.cooldown ?? 24)) / 60).toFixed(2)} seconds after the last one started (a press a little early waits for it): the chip over the jump gauge shows when it's ready.`,
      `There are no charges: energy is the limit. Every burst draws a great deal for a moment (about ${Math.round(((STRAFER?.demand ?? 700) * (STRAFER?.strafe?.ticks ?? 12)) / 60)} a strafer firing straight out), from a Drive Cell bank touching the strafer first, then the ship. Dodge as often as it lets you and the ship browns out (the chip says LOW POWER) unless Drive Cells, batteries and generators back it: short of power a burst pushes that much less, and with almost none it doesn't fire. It's a push, so the heavier your ship (and the fuller your hold) the less a burst moves you: it's a light ship's part.`,
      `A <b>Tow Beam</b> (a utility part, from level ${TOW_MODEL?.unlock?.level ?? 12}) takes hold of a wreck, debris or a loot pod: press ${k('tow')} with your cursor near it, within ${Math.round(TOW.range)} of your hull, and an amber tether pulls it along behind you. What you tow weighs on you like cargo: a big wreck slows you a lot. It never takes hold of a working ship. Fly it into a station's reach and it's salvaged: a wreck or debris is cut up for plate into your station storage (a derelict pays its salvage credits too), a pod's contents go into storage. The beam draws power only while it tows, and lets go if it runs short, if you jump, or if the tether's stretched too far. Press ${k('tow')} again to let go.`)}
    ${sec('Cargo weight', `What's in your hold has mass, and you carry it: a full hold accelerates, turns and stops slower. The cargo panel shows the load and what it costs you (−18% thrust, say), and the hangar shows what a full hold of ore would. It's weighed against your ship, so a big hauler with strong engines minds the same load far less than a light fighter. Ore and metal are heavy, gems light, ammunition between. What's in station storage weighs nothing.`)}
    ${sec('Getting around', `<b>Jump gates</b> link systems: fly in and press ${k('interact')}. Close to one, a card says where it goes, what it's like there against your ship and what it needs; the first time a gate leads somewhere deadly for your ship, it asks you to press again. <b>Rifts</b> pull you through the moment you touch them. Some systems need a licence (Jobs & pilots, Leaving Sol). ${k('map')} opens the galaxy and system maps; ${k('nav')} toggles the markers on the screen edge.`)}
    ${sec('Autopilot', `${k('autopilot')} flies you to the job you're following, gate by gate if it's in another system, using the jump drive on long legs. Or open the map (${k('map')}) and click a station, gate, wreck or system; right-click anywhere in a system to fly to that point. Any flight key or a click takes back control.`,
      `In flight, hold ${k('contextMenu')} and right-click anything (or open space) for what you can do with it: dock, travel through, land, hail, target, inspect, trade, fly there or jump there. A plain right-click is the right-hand guns and the mining laser, firing at once.`)}
    ${sec('Stations', `Fly into a station's docking ring and press ${k('dock')}. While docked you're safe: your ship is inside. Stations have storage (shared between every station), a market, a refinery and a fabricator, and post contracts. ${k('inventory')} shows your cargo; storage opens while you're docked.`)}
    ${sec('The info panel', `Rest the cursor on anything (another pilot, a ship, an asteroid) and the panel at the bottom right reads it out: who they are and their ship, a hostile's faction and rating against yours, or roughly what ore a rock holds. It stays a moment after you move off.`)}
    ${sec('Hazards', `Radiation, cold, darkness and low visibility make some systems harder to read. Black holes pull on everything; past the event horizon nothing survives. Watch for the red warning.`)}
    ${sec('Cold and warmth', coldGuide())}
  </div>`;
}

function combat({ k }: GuideDeps): string {
  return `<div class="fg-cols">
    ${sec('Combat', `Hold the mouse buttons to fire. Fixed guns swivel only 2° either way, so they fire once your nose is on target; turrets track the cursor on their own and only fire through gaps in your own hull. Collisions hurt both ships. Lasers, the Lance and the freeze beam are <b>held beams</b>: they burn only while you hold fire and the power lasts, and when your own ship runs short of power its beams sputter. The Glint is a pulse laser, a bolt of light on a beat.`,
      `<b>Every gun fires one of five ways</b>, shown as a chip on its card and an arc around your crosshair. <b>Cycle</b>: fires on a fixed beat while held, and each shot's energy is drawn as it reloads. <b>Clip</b>: fires a few rounds fast, then reloads from energy when empty, or a second after you let go. <b>Charge</b>: hold to charge; it fires itself at full charge, then cools down, and if you let go early nothing fires. <b>Ammo</b>: fires rounds from your hold on a fixed beat, costs no energy, and when the crates run out it fires weak plain rounds (40% damage, no splash or special effects). <b>Beam</b>: burns energy every second you hold it, and some beams wind up or ramp up the longer they stay on. Point Defence fires on its own at incoming missiles and torpedoes.`,
      `Parts fail in their own way. A destroyed core explodes and takes the ship with it; generators, thrusters and guns blow up a moment later and can set off their neighbours; armour and hull just break. Whatever is left without a core drifts off and slowly crumbles away.`)}
    ${sec('Armour & damage', `Damage isn't absolute. Every gun has a <b>penetration</b> (its grade, plus a bit for railguns, lances and torpedoes, less for flak and pulse lasers) and every block an <b>armour</b> (its grade, plus one for armour plate). Level, and a hit does full damage; a grade short, about half; two short, a quarter; three, a tenth. So a Mk I gun barely scratches Mk III plate: find a bigger gun, or the weak points.`,
      `Guns deal kinetic, explosive, thermal, energy, cryo or exotic damage, and each material takes more or less of each: ceramic shrugs off heat but cracks under shells, insulated polymer turns energy but melts, steel shrugs off shells but conducts. Tooltips show a gun's damage type and penetration, and a block's armour and what it takes. Armour plate is heavy: it slows a ship down.`)}
    ${sec('Build points', `How big a ship you can build is a budget of build points that grows as you level. Every cell costs a point at Mk I, 1.6 at Mk II, 2.5 at Mk III, 3.8 at Mk IV and 5.5 at Mk V, so a big Mk I ship and a small Mk III one cost about the same. A better gun is power-hungry too: a Mk II gun wants the output of nearly two Mk I generators. A ship built from a plan builds as designed.`)}
    ${sec('Targets', `${k('targetNext')} cycles through hostiles nearby, nearest first; ${k('targetCursor')} targets the ship under the cursor. The target panel shows its hull, shield and core, and missiles lock on to it.`)}
    ${sec('Repairs', `Near a station, your ship repairs itself: damaged parts heal, and lost parts regrow one at a time from the core outwards, for a share of the minerals they're made from (free below level 3). Repairs pause for a few seconds after you take a hit. Repair kits on the quick bar patch you up in the field.`)}
    ${sec('Losing a ship', `Destroyed? You fly a free, fully repaired loaner from your last station while your ship waits in its hangar slot, on order, and rebuilds itself from its salvage (every component and module's parts, and its minerals as ore). What else it costs depends on where it happened:`,
      `<b style="color:#5eead4">In safe space</b> (inner Sol): nothing more. All of its minerals come back, and your hold is untouched.`,
      `<b>Anywhere else</b>: 70% of its minerals come back; the rest stays in your <b>wreck</b>, with your cargo. Your <b>secure hold</b> keeps your three most valuable stacks (up to 25 of each). The wreck is marked ⚑ on your screen and map, and only you can collect it for 15 minutes: fly back and pick it up like any pod (with room in your hold).`,
      `An <b>insurance bond</b> in storage makes one loss outside safe space whole (every new pilot gets three).`)}
    ${sec('Danger & PvP', `Each system has a danger rating from 1 to 7 (the pips under your credits and on the map). Danger brings richer rock and tougher hostiles. In Void Sector and The Maw other pilots can attack you, and in Cinder Reach away from its station. Station rings are always safe.`,
      `<b>Sol has bands of its own</b> (under the pips, and rings on the map). <b style="color:#5eead4">Inner Sol</b> is safe space: hostiles never come in after you, and a ship lost there comes back whole. <b style="color:#fbbf24">Middle Sol</b>, past Jovan, is contested: smugglers in the Lanes, the Drift, the Graveyard of the Tenth and a Redtooth picket, about right for the first ship you build yourself. <b style="color:#f87171">The Reaches</b> out on the rim are hostile: veterans in better plate, the Tallyman, the Hollow Crown fortress and warbands, and a sparse belt of big, rich rocks. Farwatch, on the edge of the Reaches, repairs and resupplies you.`,
      `Grey ships are passive: they leave you be unless someone shoots them. Red ones come for you.`,
      `Hostiles come in from past your radar, out of gates (an amber ring spools up a few seconds first) or launched from their outposts, never out of nowhere beside you. They fight with their guns' real reach, close in fast if you out-range them, turn on whoever's hurting them and spread out to flank. Elites and bosses carry plate a grade above the ships around them; hurt a pack badly enough and the rest may run.`)}
    ${sec('Ratings', `Your ship's <b>rating</b> (◆) weighs its firepower against its toughness. Systems, siege moons and enemies show theirs, coloured against yours: green is easy, then fair, hard, and red for deadly. The <b>Tiers & scaling</b> tab lists them all.`)}
    ${sec('Sieges', `Siege moons (Selene, Rimeholt, Cinderhold, Gloam, Last Light) are fortresses to hold through the night. Build turrets on the pads between waves (repair, upgrade or replace them too); each round survived adds to your haul, with a bonus every fifth. Leave during the day by claiming it. Each moon is pitched at a tier: its turrets are built a grade above. Every moon is besieged its own way: Selene's Scrapborn come down three lanes, Rimeholt's out of the north, Cinderhold's from every side, Last Light's from two sides by turns, and Gloam's wraiths close in from nowhere. Nights come in fronts with more streaming in between, grow faster as they go, and some bring a <b>boss</b> (the day panel warns you). Out on the moon, <b>objectives</b> come up at night: hold a supply drop or burn out a nest for supplies and haul.`)}
    ${sec('Bosses & events', `Bosses lair across the systems (☠ on the system map). They bring escorts, change tactics as they break, and telegraph their big attacks: when one starts glowing, get clear. Everyone who fights one gets the XP, credits and their own loot, sent to storage. A few of them, seldom, leave a rare part behind: the one part their legendary weapon cannot be made without.`,
      `Raids on stations and freighter wrecks pop up while you play (✦ markers). Defend the station and it pays you; wreck cargo is anyone's. Out in Sol's Reaches, <b>warbands</b> make camp: break one up and everyone who fought it is paid a bounty. In Borealis, when the signal (pilots call it the heartbeat) <b>peaks</b> the Frost Brood burst out of the Curtain and scatter, and the rime they shed is anyone's.`)}
    ${sec('Salvage', `Derelict hulks drift in most systems. Break a wreck's core and its salvage is yours: credits and XP. Another hulk is towed in a few minutes later.`)}
  </div>`;
}

/** The player models (data/ships/models.json) */
const MODELS: FunctionDef[] = (shipModels as unknown as { models: FunctionDef[] }).models;

/** The ships tab's way to the component guide (every part's level, gate and cost; GameMenuUI wires data-a="components") */
function componentsLink(d: GuideDeps): string {
  return `<div class="fg-link"><div><b>Component guide</b><span>Every structure material and module: the level it opens at, what still gates it for you, what making it takes, and its full numbers.</span></div><button class="btn primary" data-a="components">Open it ${d.k('components')}</button></div>`;
}

function ships(d: GuideDeps): string {
  return `<h3 style="margin-top:12px">Parts</h3><p class="muted">Structure is built from plate in its material; every module is a named model with its own size and numbers, learned at the level on it, and never earlier.</p>${componentsLink(d)}<div class="fg-cols">
    ${sec('The hangar', `You have three hangar slots: the ship you fly and two more to build in. Place any part you know how to make, even ones you don't have: they're ghosts until built. Start a ship plan from the station's Ships tab, and fly any ship whose core is built. Pick a hull paint next to the ship's name: it's saved with the design, and everyone sees it.`,
      `In the hangar, <b>Share</b> sends the design you're editing to your party; they find it under Load → Shared with you.`)}
    ${sec('Build orders', `<b>Put it on order</b> and the hangar refines your ore, fabricates the modules and fits everything as it's ready, wherever you are. The station's <b>Ships</b> tab shows what each ship still needs at a glance (what to gather) and, opened up, the full bill down to the ore: what's ready, what's being made, and what's waiting.`,
      `Orders are worked first in line first: the first takes what it needs before the others. <b>⇧ Do first</b> moves one up, <b>⏸ Hold</b> stops it starting anything new (its jobs wait), and <b>Call off</b> stops it and gives its materials back. The refinery and fabricator list what orders are waiting on, and what for, and every job can be held, moved to the front or called off.`)}
    ${sec('Energy', `Generators make power, carried along <b>wires</b> the ship lays through its own hull: there is no wiring to do. Steady loads (shields, scanners, jump coils) take theirs from the generators first; engines, guns and mining lasers run wherever their network has a generator or a battery. The core's store and every battery on a network with a generator make one <b>pool</b>: your ship can give out at most its <b>Output</b> each second (its spare generation, plus what the pool gives while it holds charge). When more is asked than that, everything drawing on it shares it by what each asks: if the engines ask 10 and the guns 20, the guns get two thirds. Short of power, thrust drops and guns reload slower.`,
      `<b>Every store gives only so much a second</b>: the core and a Battery quickly, a Heavy Bank slowly (it holds the most). A gun draws its next shot's energy while it reloads, a beam while it burns, a mining laser while it cuts: a loaded gun always fires, low power only slows the next reload. A Capacitor or Drive Cell bank that isn't full asks for its intake like any other part, and what it touches draws on it first: a bank raises the share its guns or engines get. Whatever's left of the spare power refills the pool. Boosting needs stored charge and drinks it fast. Wires run along the hull: shoot out the cell under one and everything beyond it goes dark. In flight the ENERGY gauge flashes and reads LOW POWER while something gets less than it asks. The line under your ship's schematic gives the charge, how fast it is going up or down, how long until it is empty or full, and what is short. The hangar's Energy rows say how long a design keeps full power cruising, boosting and firing, and how long it takes to refill.`)}
    ${sec('Banks', `<b>Capacitors that touch form a bank, and so do Drive Cells.</b> A bank powers the parts touching it before the ship does, as fast as it gives, and refills from spare power when one of its cells is on a powered network. A Capacitor bank feeds the guns, beams, mining lasers and Flash Screens it touches, never engines; a Drive Cell bank the engines and Burst Strafers it touches. Nothing else can drain a bank: boost your pool flat and the guns on a Capacitor bank still reload at full speed.`,
      `A <b>Pulse Dynamo</b> needs no wires: it charges every bank it touches a little each second, so a bank of Capacitors with a dynamo against it keeps a gun pod going on its own. The hangar's power view outlines each bank, labels what it holds and gives, and marks the parts it feeds with a bolt; hold a Capacitor, Drive Cell or Pulse Dynamo over the hull and the parts it would feed glow cyan (or a grey tag says it feeds nothing). A gun's tooltip says how many reloads or charges its bank covers. In flight each bank has its own thin bar under the ENERGY gauge (at most four) and its cells glow by charge: a drained bank visibly dims.`)}
    ${sec('Engines', `Ion thrusters are steady and efficient. Afterburners kick hard when you boost but drain the ship's energy fast, so give them a Drive Cell bank touching them, which feeds them first; plasma drives are big, powerful and hungry. Torch and Vernier engines cannot boost. Bigger engines give more thrust per cell.`)}
    ${sec('Ammunition', `Only some guns fire from crates in your hold: Flak Burst, Lobber, Quake, Dart, Swarm, Hammerhead, Needle, Eel, Leviathan and the Demolition Launcher; with none left they fire plain rounds at a share of the damage. Cannons, the other railguns (Coilgun, Spear, Rail Driver) and the clip, charge and cycle guns need no ammo: they run on energy, so watch your power. Guns that do take crates also have special crates (sabot, incendiary, seekers...) that change their rounds. Make crates at a fabricator. A few crates are made for one enemy: <b>Quench Slugs</b> (railgun) are poor slugs on anything else but hit the Cinder Cult's ships, though not their great ones, two and a half times as hard. Forgemaster Hale teaches the pattern, and only your own station's armoury presses them (its Quench line).`,
      `Each ship has a <b>loadout</b>, set in the hangar's AMMUNITION panel: how many of each crate to carry, and which opens first (★). Docking, launching and flying the ship top your hold up to it from storage, and say what's short (order more right there). Loadout crates stay aboard when you store, and are opened before any others.`)}
    ${sec('Scrapping', `Scrap a ship (from its slot) or a module (from storage) for 70% of its minerals as ore and its components in full. A loaner just goes back.`)}
  </div>`;
}

function industry({ k }: GuideDeps): string {
  return `<div class="fg-cols">
    ${sec('Mining', `Shoot asteroids and fly through the chunks to mine them. Guns crack soft rock; a mining laser (right mouse) cracks the hard ores and gems. Glowing seams hold gems; deadlier systems hold richer rock. Rest the cursor on a rock to see roughly what it holds; a scanner reads exact shares and finds seams.`)}
    ${sec('Refining', `Every ore is refined into plate, wire or lenses at a refinery, which takes a while and carries on while you're away (finished batches go to storage). Hull, armour and cargo holds are built straight from plate in the hangar.`)}
    ${sec('Fabricating', `The fabricator makes the modules: named models of weapons, generators, engines, shields and the like, each its own size and recipe. Small low-tier ones are made at once; bigger ones take time. Each model is learned at its level (Progress shows the track), and nothing teaches one earlier. The legendaries open at their level too, but each is made with a rare part from its boss, and bosses seldom leave one whole.`)}
    ${sec('Markets & quartermasters', `Prices move. Every few hours each station wants a few goods badly and is glutted with others (shown at the top of the market), and selling a lot of one thing drives its price down there for a while. The market shows where else pays more, so hauling to the right station pays.`,
      `Faction quartermasters sell kits, components and plate to pilots they know. Standing comes from that faction's jobs; every rank unlocks more stock and a better discount.`)}
    ${sec('Your hold', `The panel above the chat shows what's in your hold and how full it is: new items flash, hover for an item's value, right-click to jettison, and click its title to fold it down to the fill bar. Outside safe space a 🔒 marks the stacks your secure hold would keep, <b style="color:#5eead4">LOAD</b> your ammunition loadout and <b style="color:#c4b5fd">UTIL</b> utility (repair kits and other consumables, and anything on the quick bar). Drag its top edge to make it taller; past that it scrolls. ${k('inventory')} opens the full cargo window. Hangar orders only use what's in storage: store ore when you dock.`,
      `Docked, the station's Overview and the cargo window have quick storage buttons: <b>Store all but ammo & utility</b> (the safe one: it leaves ammunition, your loadout, utility and job items aboard), <b>Store ore & materials</b>, <b>Store loot</b> (components, artefacts, cut gems, modules), <b>Store everything</b> (click twice), and <b>Restock loadout</b>.`)}
  </div>`;
}

function people({ k }: GuideDeps): string {
  return `<div class="fg-cols">
    ${sec('People', `Jobs come from people. Talk to them where they are: docked at a station (Overview, <b>People here</b>), or out in space and down on planets (fly close and press ${k('interact')}). A <b style="color:#fbbf24">!</b> means they have work for you, a <b style="color:#fbbf24">▸</b> that a job of yours needs them. Some ask you questions: choose your answers (1-9) with care.`,
      `Nothing is forced on you: say <i>Not now</i> and they'll ask again later. Nobody calls you: when a job you finish opens up new work, it joins your log marked <b>new</b>, and the log shows a badge until you look.`)}
    ${sec('Jobs', `${k('log')} opens your log: jobs in progress, <b>leads</b> (jobs you've heard about, and who has them), and what you've completed. A few beginner jobs are leads from the start; the rest you hear about by talking to people, from rumours, or by running into them out there. Station boards (Contracts) post bounties that change every half hour. ${k('skills')} spends skill points (one each level): each point in a skill is worth a little less than the one before, so spreading them pays. Jobs you can't take yet show once you're within three levels of them.`,
      `Many jobs ask more of you than a kill count: a <b>run</b> through rings against the clock (miss the time and you start again), <b>holding steady</b> in a spot while something works (leave and the bar drains; sometimes something comes to stop you), or <b>recovering</b> a container from somewhere (only you can take it, and it may be guarded). The panel at the top of the screen shows how it's going. Some take you down to planets: descend with ${k('interact')} in low orbit.`,
      `<b>Follow</b> a job or a lead and the ★ marker and the <b>objective guide</b> lead you there: the line under the tracker names the next waypoint (the gate, rift or planet on the way) and chevrons point from your ship. ${k('autopilot')} flies it. Settings › Interface turns the guide and the tracker on and off.`)}
    ${sec('Leaving Sol', `Glasswater, Borealis, Nebula Prime and Cinder Reach need <b>lane clearance</b>: Harbourmaster Okafor at Sol Central gives it once you've found your feet (job: Cleared for Departure). The Maw needs a licence from Horizon Watch.`,
      `Steel (Mk II) structure opens at level 5; Dr. Osei's jobs on Terra Nova teach it too.`)}
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
    <p>What each level opens: new modules to fabricate (by family), structure materials, and room (build points, hangar bays, fabricator slots). Everything you can make opens at its level and never earlier: modules, structure materials (the special ones at the level their plate can be refined) and fabricator recipes. A boss's legendary also needs that boss's rare part to make, and a job's kit needs its job.</p>
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
  const x = LADDER.map((m) => `Mk ${['', 'I', 'II', 'III', 'IV', 'V'][m.grade]}`);
  const lines = [
    { name: 'Damage, shields, power out & draw', color: SERIES_COLORS[0], ys: LADDER.map((m) => m.output) },
    { name: 'Engine thrust', color: SERIES_COLORS[1], ys: LADDER.map((m) => Math.sqrt(m.output)) },
    { name: 'Enemy pay & loot', color: SERIES_COLORS[2], ys: LADDER.map((m) => Math.pow(m.output, 1.6)) },
  ];
  const sizes = SIZES.map(([n, a]) => ({ label: n, value: Math.pow(a, WEAPON_SIZE_EXP), cells: a }));

  const gradeRows = LADDER.map((m) => {
    const plate = PLATES[m.id];
    const r = REFINING.find((x) => x.id === plate);
    const ores = Object.keys(r?.inputs ?? {});
    return `<tr><td><span class="fg-mk">Mk ${['', 'I', 'II', 'III', 'IV', 'V'][m.grade]}</span></td><td>${esc(m.name)}</td>`
      + `<td class="n">×${m.output.toFixed(2)}</td><td class="n">${m.toughness}</td>`
      + `<td>${r ? Object.entries(r.inputs).map(([id, n]) => `${n} ${esc(itemName(id))}`).join(' + ') + ` → ${esc(itemName(plate))} <span class="muted">(${r.time ?? 2}s)</span>` : '—'}</td>`
      + `<td class="muted">${ores.map((o) => ORE_WHERE[o]).filter(Boolean).slice(0, 1).map(esc).join('')}</td></tr>`;
  }).join('');

  const ladder = SYSTEMS.filter((s) => SYSTEM_GRADE[s.id] || SIEGE_GRADE[s.id])
    .map((s) => ({ s, grade: SYSTEM_GRADE[s.id] ?? SIEGE_GRADE[s.id], moon: !!SIEGE_GRADE[s.id], threat: threats[s.id] ?? 0 }))
    .sort((a, b) => (a.threat || a.grade * 20) - (b.threat || b.grade * 20));
  const ladderRows = ladder.map(({ s, grade, moon, threat }) => {
    const verdict = mine && threat ? threatLevel(mine, threat) : '';
    return `<tr><td>${esc(s.name)}${moon ? ' <span class="muted">· siege moon</span>' : ''}</td><td><span class="fg-mk">Mk ${['', 'I', 'II', 'III', 'IV', 'V'][grade]}</span></td>`
      + `<td class="n">${s.danger ?? '—'}</td><td>${threat ? threatTag(mine, threat, '◆') : '<span class="muted">—</span>'}</td>`
      + `<td class="muted">${moon ? `Turrets built Mk ${['', 'I', 'II', 'III', 'IV', 'V'][Math.min(5, grade + 1)]}` : verdict === 'deadly' ? 'Not yet' : verdict === 'easy' ? 'Comfortable' : ''}</td></tr>`;
  }).join('');

  return `
    <h3>Grades</h3>
    <p>Everything you build comes in a grade, Mk I to Mk V, set by its material. A higher grade multiplies what a part does: a gun's damage, a shield's strength, a generator's output. It also draws that much more power, so better guns need better generators. Engines gain more gently. Each system's enemies are built at a grade too, and pay and drop more the higher it is.</p>
    ${lineChart('How grade scales a part (× Mk I)', x, lines)}
    <h3>Weapon size</h3>
    <p>Bigger weapons hit harder than their size alone: damage grows as size<sup>1.15</sup>, so one Large gun outhits four Small ones (and draws power for its cells). Engines likewise give a little more thrust per cell as they grow.</p>
    ${barChart('Weapon damage by size (× Small)', sizes)}
    <h3>Materials</h3>
    <div class="fg-wide"><table class="fg-t"><thead><tr><th>Grade</th><th>Material</th><th class="n">Output</th><th class="n">HP / cell</th><th>Refining</th><th>Where the ore is</th></tr></thead><tbody>${gradeRows}</tbody></table></div>
    <h3>Systems by tier</h3>
    <p>Each system's hostiles are built at its grade; ◆ is the threat their packs (or a siege moon's waves) pose${mine ? `, coloured against your ship's rating of <b>${Math.round(mine)}</b>` : ''}. Work up the ladder as your ship's rating grows.</p>
    <div class="fg-wide"><table class="fg-t"><thead><tr><th>System</th><th>Enemies</th><th class="n">Danger</th><th>Threat</th><th></th></tr></thead><tbody>${ladderRows}</tbody></table></div>`;
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
