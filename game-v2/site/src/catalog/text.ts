/**
 * The site's own chart text, written from the catalog's numbers: what it is, what it does, what it costs, where.
 * Plain sentences, no story. A `blurb` the game supplies later replaces the first sentence's job, nothing more.
 */

import type { Catalog } from './book.js';
import type { CatalogBoss, CatalogItem, CatalogPart, CatalogShip, CatalogStation, RecipeInfo } from './types.js';

export const CATEGORY_LABEL: Record<string, string> = {
  weapons: 'Weapon', engines: 'Engine', power: 'Power', shields: 'Shield and plating', utility: 'Utility', structure: 'Structure', core: 'Core',
  mineral: 'Ore', gem: 'Gem', volatile: 'Gas', jewel: 'Socket gem', refined: 'Refined material', component: 'Component', artefact: 'Salvage',
  consumable: 'Consumable', ammo: 'Ammunition', quest: 'Job item',
};
export const label = (key: string) => CATEGORY_LABEL[key] ?? key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export const SERVICE_LABEL: Record<string, string> = {
  repair: 'Repair', storage: 'Storage', refinery: 'Refinery', fabricator: 'Fabricator', market: 'Market', shipyard: 'Shipyard',
};

const HAZARD_LABEL: Record<string, string> = {
  cold: 'Cold', radiation: 'Radiation', low_visibility: 'Low visibility', darkness: 'Darkness', gravitational_anomalies: 'Gravity anomalies',
};
export const hazardLabel = (h: string) => HAZARD_LABEL[h] ?? label(h);

export const num = (n: number, digits = 0) => n.toLocaleString('en-GB', { maximumFractionDigits: digits });

export function duration(seconds: number): string {
  if (seconds <= 0) return 'instant';
  if (seconds < 90) return `${Math.round(seconds)} s`;
  const m = Math.round(seconds / 60);
  return m < 90 ? `${m} min` : `${Math.round(m / 6) / 10} h`;
}

/** "2 Alloy Plate, 1 Copper Wire" */
export function costText(c: Catalog, inputs: Record<string, number>): string {
  return Object.entries(inputs).map(([id, n]) => `${n} ${c.item.get(id)?.name ?? id}`).join(', ');
}

export function stationName(c: Catalog, id: string): string { return c.station.get(id)?.name ?? id; }
export function systemName(c: Catalog, id: string): string { return c.system.get(id)?.name ?? id; }

/** A part, in a few sentences */
export function partText(c: Catalog, p: CatalogPart): string {
  if (p.blurb) return p.blurb;
  const out: string[] = [];
  const kind = p.family && p.category !== 'structure' ? `${label(p.category)}, ${p.family.replace(/_/g, ' ')} family` : label(p.category);
  out.push(`${p.mark} ${kind.toLowerCase()}${p.size ? `, ${p.size.toLowerCase()}` : ''}. ${p.cells === 1 ? 'One cell' : `${p.cells} cells`}, ${num(p.hp)} HP, mass ${num(p.mass, 1)}.`);
  if (p.weapon) {
    const w = p.weapon;
    out.push(`${w.mount === 'turret' ? 'Turret: it turns to your aim.' : 'Fixed: it points where the ship points.'}${w.dps > 0 ? ` About ${num(w.dps)} damage a second at full power` : ' No damage'}${w.range ? `, reaching ${num(w.range)} units` : ''}.`);
  }
  if (p.thrust) out.push(`Thrust ${num(p.thrust, 2)}${p.boost ? `, boost x${num(p.boost, 2)}` : ''}.`);
  if (p.supply) out.push(`Makes ${num(p.supply, 1)} E/s.`);
  if (p.store) out.push(`Holds ${num(p.store)} E.`);
  if (p.shield) out.push(`Shield strength ${num(p.shield)}.`);
  if (p.cargo) out.push(`Hold space ${num(p.cargo)}.`);
  if (p.draw) out.push(`Uses ${num(p.draw, 1)} E/s.`);
  out.push(p.unlock ? `Opens at level ${p.unlock}.` : 'Available from the start.');
  if (p.craft) out.push(`Fabricated from ${costText(c, p.craft.inputs)} (${duration(p.craft.seconds)}).`);
  return out.join(' ');
}

function recipeText(c: Catalog, r: RecipeInfo): string {
  const where = r.kind === 'refine' ? 'Refined' : 'Fabricated';
  return `${where} from ${costText(c, r.inputs)}${r.out > 1 ? ` (makes ${r.out})` : ''}, ${duration(r.seconds)}${r.level ? `, from level ${r.level}` : ''}.`;
}

/** An item, in a few sentences */
export function itemText(c: Catalog, i: CatalogItem): string {
  if (i.blurb) return i.blurb;
  const out: string[] = [`${label(i.category)}. Base value ${num(i.value)} cr${i.tier ? `, tier ${i.tier}` : ''}.`];
  if (i.foundIn.length) out.push(`Mined from ${i.foundIn.slice(0, 4).map((f) => f.name).join(', ')}${i.foundIn.length > 4 ? ` and ${i.foundIn.length - 4} more` : ''}.`);
  for (const r of i.madeBy) out.push(recipeText(c, r));
  if (i.soldAt.length) out.push(`Sold at ${i.soldAt.map((s) => stationName(c, s)).join(', ')}.`);
  return out.join(' ');
}

export function shipText(c: Catalog, s: CatalogShip): string {
  if (s.blurb) return s.blurb;
  const g = s.stats.guns;
  const guns = g.fixed + g.turret ? `${g.fixed + g.turret} ${g.fixed + g.turret === 1 ? 'gun' : 'guns'} (${g.fixed} fixed, ${g.turret} turret)` : 'no guns';
  const where = s.soldAt.length ? `The plan is sold at ${s.soldAt.map((x) => stationName(c, x)).join(', ')}.` : 'Not sold at a station.';
  return `${s.stats.parts} parts, mass ${num(s.stats.mass, 1)}, ${guns}. Makes ${num(s.stats.gen)} E/s and uses up to ${num(s.stats.draw)} E/s. ${where}`;
}

export function bossText(c: Catalog, b: CatalogBoss): string {
  if (b.blurb) return b.blurb;
  return `Level ${b.level}, in ${systemName(c, b.system)}. ${b.phases} ${b.phases === 1 ? 'phase' : 'phases'}. Pays ${num(b.xp)} XP and ${num(b.credits)} cr.${b.respawnSeconds ? ` Returns ${duration(b.respawnSeconds)} after it falls.` : ''}`;
}

export function stationText(c: Catalog, s: CatalogStation): string {
  if (s.blurb) return s.blurb;
  const svc = s.services.map((x) => SERVICE_LABEL[x] ?? label(x)).join(', ').toLowerCase();
  return `Station in ${systemName(c, s.system)}. Services: ${svc}.${s.repairCostPerHp ? ` Repairs cost ${s.repairCostPerHp} cr per HP.` : ''}`;
}
