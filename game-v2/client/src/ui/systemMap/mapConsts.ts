/** The map's data and small helpers: factions, lodestone colours, boss lairs, planet names, step and distance maths */

import { StarSystemData, type SystemRegionData, type HazardRules } from '@space-game/common';
import { jumpTuning, type ShipTuning } from '@space-game/common';
import factionsFile from '../../../../data/factions.json';
import shipTuning from '../../../../data/ships/tuning.json';
import systemsFile from '../../../../data/systems.json';
import bossData from '../../../../data/bosses.json';
import hazardData from '../../../../data/hazards.json';

export const HAZARD_RULES = hazardData as unknown as HazardRules;
export const JUMP = jumpTuning(shipTuning as unknown as ShipTuning);
/** Lodestones and their fields */
export const LODE_COLOR = '#a3c2cf';
/** A dead or shattered one (no field) */
export const LODE_DEAD = '#7d8590';
/** Factions (nests' colours and names) */
export const FACTIONS = (factionsFile as unknown as { factions: Record<string, { name: string; color: string }> }).factions;
/** Factions by index (a ghost's faction) */
export const FACTION_LIST = Object.values(FACTIONS);
/** Danger bands: ring colour and word */
export const REGION_STYLE: Record<SystemRegionData['danger'], { color: string; word: string }> = {
  safe: { color: '#5eead4', word: 'safe' }, contested: { color: '#fbbf24', word: 'contested' }, hostile: { color: '#f87171', word: 'hostile' },
};
/** How far round a landing point hostiles make a jump risky */
export const LANDING_HOSTILE_RADIUS = 4000;

export const BOSS_DEFS = (bossData as unknown as { bosses: Record<string, { name: string; system: string; level: number; lair: { x: number; y: number } }> }).bosses;
/** Where each boss lairs (one in a pocket is marked at its way in too, out in that system) */
export const BOSS_LAIRS = Object.entries(BOSS_DEFS).flatMap(([id, b]) => {
  const e = (systemsFile as unknown as { systems: StarSystemData[] }).systems.find((s) => s.id === b.system)?.pocket?.entrance;
  return [{ id, ...b }, ...(e ? [{ id, ...b, system: e.system, lair: { x: e.x, y: e.y } }] : [])];
});
/** Danger 1..7: green to red */
export const dangerColor = (d: number) => (d >= 6 ? '#f87171' : d >= 4 ? '#fbbf24' : d >= 2 ? '#a3e635' : '#86efac');

/** A threat against your rating: fine up to it, risky to 1.5×, past that dangerous */
export function outmatch(mine: number, theirs: number): { word: string; color: string } {
  if (!mine) return { word: '', color: '#8394ad' };
  return theirs <= mine ? { word: 'fine', color: '#86efac' } : theirs <= mine * 1.5 ? { word: 'risky', color: '#fbbf24' } : { word: 'dangerous', color: '#f87171' };
}

export const PLANET_COLORS: Record<string, string> = {
  rocky: '#a39382', desert: '#d8b075', ice: '#cfe8ff', gas: '#e0b27a', lava: '#ff6a2a', ocean: '#4f8fe0', toxic: '#b6d24a',
};
export const PLANET_KINDS: Record<string, string> = {
  rocky: 'Rocky world', desert: 'Desert world', ice: 'Ice world', gas: 'Gas giant', lava: 'Lava world', ocean: 'Ocean world', toxic: 'Toxic world',
};

export const SECTOR_COLORS = ['#5fd4c4', '#ffb547', '#9f8cff', '#f472b6', '#7dd3fc', '#86efac'];
export const HAZARD_NAMES: Record<string, string> = {
  cold: 'Cold', radiation: 'Radiation', low_visibility: 'Low visibility', darkness: 'Darkness', gravitational_anomalies: 'Gravity well',
};
export const BODY_NAMES: Record<string, string> = { sun: 'Star', black_hole: 'Black hole', pulsar: 'Pulsar', binary: 'Binary star', none: 'None' };

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hexToHue(hex: string): number {
  const v = parseInt(hex.replace('#', ''), 16);
  const r = ((v >> 16) & 255) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}

export function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

export function fmtDist(u: number): string {
  return u >= 1000 ? `${(u / 1000).toFixed(u >= 10000 ? 0 : 1)}k` : `${Math.round(u)}`;
}
