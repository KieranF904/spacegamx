/**
 * describePart(): what a part says about itself. `base` is partStats (the
 * grade/size/damage/power core, unchanged); `facts` are what the part
 * features its function gives add (features/types.ts Fact, run through
 * features/plan.ts featureFacts). The client renders the facts into tooltip
 * rows, card chips, summary fields and guide numbers (client/src/ships/describe/).
 * UI only: may allocate.
 */

import type { Catalog } from './catalog.js';
import type { ShipTuning } from './tuning.js';
import { partStats, type PartStats } from './partStats.js';
import { partMaterial } from './grades.js';
import { featureFacts } from './features/plan.js';
import type { Fact } from './features/types.js';
import type { FunctionDef } from './types.js';

export interface PartFacts {
  base: PartStats;
  facts: Fact[];
}

export function describePart(catalog: Catalog, tuning: ShipTuning | undefined, part: { material: string; fn: string; piece: string }): PartFacts | null {
  const base = partStats(catalog, tuning, part);
  const fn = catalog.functions.get(part.fn);
  if (!base || !fn) return null;
  // (No tuning: a feature reads its defaults from an empty one, as partStats does)
  const facts = featureFacts({ catalog, tuning: tuning ?? ({} as ShipTuning), fn, mat: partMaterial(catalog, part), area: base.area });
  facts.push(...relayFacts(fn), ...modFacts(fn, tuning));
  return { base, facts };
}

/**
 * Energy routing's relays (plain FunctionDef data, no feature: docs/design/energy-routing-impl.md §3.4): a Diode
 * (`oneWay`) and a Conduit (`relayOnly`), in plain words (their Holds and Gives are any store's: partTip, modelCards).
 */
function relayFacts(fn: FunctionDef): Fact[] {
  if (!((fn.store ?? 0) > 0) || !(fn.oneWay || fn.relayOnly)) return [];
  if (fn.oneWay) {
    return [{
      feature: 'relay', key: 'oneWay', label: 'One way', value: 'out of its front', tier: 'stat',
      sentence: 'power only flows out of its front, into the part there; the other parts touching it can only feed it, and its front must touch a part',
      short: 'power only flows out of its front', chip: 'one way',
    }];
  }
  return [{
    feature: 'relay', key: 'carries', label: 'Carries', value: 'between touching parts', tier: 'stat',
    sentence: 'a power line: it passes power between the parts it touches, both ways, and holds very little itself',
    short: 'passes power between the parts it touches', chip: 'power line',
  }];
}

/**
 * Weapon modifiers (plain FunctionDef data, no feature: power/portsMods.ts): a mount's sockets, a modifier's effect and
 * what it uses up, a hopper's material, and how many effects a line part carries. The numbers are tuning.json `modifiers`.
 */
function modFacts(fn: FunctionDef, tuning: ShipTuning | undefined): Fact[] {
  const mt = tuning?.modifiers, out: Fact[] = [];
  if (!mt) return out;
  const m = fn.modMount, n = m?.sockets.length ?? 0, kind = fn.plug ? mt.kinds[fn.plug] : undefined, line = fn.lineTier ? mt.lines[fn.lineTier - 1] : undefined;
  if (m) {
    out.push({
      feature: 'modifier', key: 'sockets', label: 'Sockets', value: `${n}`, tier: 'stat',
      sentence: `${n === 1 ? 'one socket' : `${n} sockets`}: a modifier touching a socket changes the shots of the guns down its line${n > 1 ? '; it takes one kind of modifier, or the kinds of one recipe, which fuse into a new effect' : ''}`,
      short: n === 1 ? 'one socket for a modifier' : `${n} sockets for modifiers`, chip: n === 1 ? '1 socket' : `${n} sockets`,
    }, {
      feature: 'modifier', key: 'treat', label: 'Treats', value: `${m.treat * n} E/s`, tier: 'stat',
      sentence: `treats ${m.treat} E a second a filled socket; guns drawing more than it treats get a weaker effect, shared by what each draws`,
      short: `treats ${m.treat} E/s a socket`,
    }, {
      feature: 'modifier', key: 'upkeep', label: 'Upkeep', value: `${m.upkeep} E/s a socket`, tier: 'stat',
      sentence: `burns ${m.upkeep} E a second for each filled socket; out of power it still passes power, with no effect`,
      short: `${m.upkeep} E/s a filled socket`,
    });
  }
  if (kind) {
    const say = mt.say[kind.effect], needs = kind.needs;
    out.push({
      feature: 'modifier', key: 'effect', label: 'Effect', value: say?.name ?? kind.effect, tier: 'stat',
      sentence: `against a mount's socket: ${say?.say ?? kind.effect}`, short: say?.say ?? kind.effect, chip: (say?.name ?? kind.effect).toLowerCase(),
    });
    if (needs?.mat) {
      out.push({
        feature: 'modifier', key: 'uses', label: 'Uses', value: `${MOD_MATS[needs.mat] ?? needs.mat}`, tier: 'stat',
        sentence: `uses ${needs.per} ${MOD_MATS[needs.mat] ?? needs.mat} for each E of a shot, from a hopper touching it or piped to it; with none left its effect stops`,
        short: `uses ${MOD_MATS[needs.mat] ?? needs.mat} from a hopper`,
      });
    } else if (needs?.power) {
      out.push({
        feature: 'modifier', key: 'uses', label: 'Uses', value: `${needs.power} E/s`, tier: 'stat',
        sentence: `uses ${needs.per} E more for each E of a shot, from a power line of its own into its back (up to ${needs.power} E a second)`,
        short: 'uses extra power from its own line',
      });
    }
  }
  if (fn.hopper) {
    const name = MOD_MATS[fn.hopper.mat] ?? fn.hopper.mat;
    out.push({
      feature: 'modifier', key: 'hopper', label: 'Holds', value: `${fn.hopper.holds} ${name}`, tier: 'stat',
      sentence: `holds ${fn.hopper.holds} ${name} for the special modifier that uses it, touching it or joined by pipes; refilled at a station`,
      short: `holds ${fn.hopper.holds} ${name}`, chip: 'hopper',
    });
  }
  // (Tier I, the line parts there always were, says nothing new)
  if (line && (fn.lineTier ?? 0) > 1) {
    out.push({
      feature: 'modifier', key: 'lineTier', label: 'Effects', value: `${line.fx}`, tier: 'stat',
      sentence: `carries ${line.fx} weapon effects and ${line.cap} treated E a second; over that the weakest effects are dropped and the rest weakened to fit`,
      short: `carries ${line.fx} weapon effects`, chip: `${line.fx} effects`,
    });
  }
  return out;
}
export const MOD_MATS: Record<string, string> = { arcsalt: 'Arc Salt', cryo: 'Cryo Fluid', pyre: 'Pyre Gel' };

/** Facts of a function on its own (a palette card, no material placed): the first material it names */
export function describeFn(catalog: Catalog, tuning: ShipTuning | undefined, fnId: string, piece?: string, material?: string): Fact[] {
  const fn = catalog.functions.get(fnId);
  if (!fn) return [];
  const pc = piece ?? (fn.pieces === '*' ? 'sq' : fn.pieces[0]);
  return describePart(catalog, tuning, { fn: fnId, material: fn.model ? fn.material ?? 'alloy' : material ?? fn.material ?? 'alloy', piece: pc })?.facts ?? [];
}
