/**
 * The field machines as a part feature (features/README.md; their numbers: econ/field/rules.ts, and machines.ts): the
 * fabricator (builds, repairs, attaches and recycles parts from the hold) and the refiner (refines the hold's ore).
 * Shared half: what a rebuild derives (`derived.fx.machines`: which part is each, and its tier) and the facts a card
 * shows. No flight hook, input or wire slot: a machine's draw is the ports core's (PortsState.mach), its jobs the
 * server's (server/src/game/field), its controls the client's (client/src/ships/features/machines).
 *
 * (No imported value is used at module scope here: the plan reaches this file through the registry.)
 */

import type { PartFeature } from '../types.js';
import { machineOf, machineWords } from './machines.js';

export const feature: PartFeature = {
  id: 'machines',
  applies: (fn) => !!fn.machine,
  // (After the others: feature numbers follow (order, id), so theirs do not move)
  order: 70,
  derive(c) {
    let fab = -1, fabTier = 0, ref = -1, refTier = 0;
    for (const i of c.parts) {
      const m = machineOf(c.fns[i]);
      if (!m) continue;
      // (One of each a ship: blueprint.ts machineCount; the first by index if a design has two anyway)
      if (m.kind === 'fabricator' && fab < 0) { fab = i; fabTier = m.tier; }
      if (m.kind === 'refiner' && ref < 0) { ref = i; refTier = m.tier; }
    }
    if (fab < 0 && ref < 0) return;
    c.out.machines = { fab, fabTier, ref, refTier };
  },
  describe({ fn }) {
    const m = machineOf(fn);
    if (!m) return [];
    const w = machineWords(m.kind, m.tier);
    const what = m.kind === 'fabricator' ? 'builds and repairs parts from the hold' : 'refines ore in the hold';
    return [
      {
        feature: 'machines', key: 'speed', label: 'Speed', value: w.speed, unit: 'x', tier: 'stat',
        sentence: `${what} while you fly, at ${w.speedText}; draws power only while it works`,
        short: `${what}, ${w.speedText}`,
        chip: `${w.speed}x speed`,
        drawWhen: 'working',
      },
      {
        feature: 'machines', key: 'grade', label: m.kind === 'fabricator' ? 'Builds' : 'Refines', value: w.capText, tier: 'stat',
        sentence: `${m.kind === 'fabricator' ? 'parts' : 'materials'} ${w.capText}; one per ship`,
        short: w.capText,
        chip: w.capText,
      },
    ];
  },
};
