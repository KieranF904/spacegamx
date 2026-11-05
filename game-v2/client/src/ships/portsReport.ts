/**
 * The hangar's power report for a ports design (common/src/ships/power/ports.ts): what the generators make, what the
 * stores hold, and which parts the routing leaves out (a gun, engine, shield or tool with nothing feeding its in ports, or
 * with one of them open; a generator with a line going nowhere). Pure, so it can be tested; HangarUI shows it.
 */
import type { ShipDerived } from '@space-game/common';

type PortsLayout = NonNullable<ShipDerived['ports']>;

export interface PortsReport {
  /** E/s the generators make, E the stores and the core hold, links in the ship */
  supply: number;
  store: number;
  links: number;
  /** Consumers with no line in at all (they get no power) */
  unfed: number[];
  /** Consumers fed on some in ports, with others open (they get less than they could take) */
  partly: number[];
  /** Generators with an out port facing nothing (that line's power is lost) */
  wasting: number[];
}

export function portsReport(L: PortsLayout): PortsReport {
  const unfed: number[] = [], partly: number[] = [], wasting: number[] = [];
  const consumers = [...L.weapons, ...L.thrusters, ...L.tools].sort((a, b) => a - b);
  for (const p of consumers) {
    const linked = L.inStart[p + 1] - L.inStart[p] > 0;
    if (!linked) unfed.push(p);
    else if (L.openIn[p]) partly.push(p);
  }
  for (const g of L.gens) if (L.openOut[g]) wasting.push(g);
  return { supply: L.supply, store: L.gaugeMax / 256, links: L.links, unfed, partly, wasting };
}

/** The report's warnings, in plain words (name: a part's display name by index) */
export function portsWarnings(r: PortsReport, name: (i: number) => string): string[] {
  return [
    ...r.unfed.map((i) => `${name(i)} has no power: nothing feeds its in port`),
    ...r.partly.map((i) => `${name(i)} has an open in port: it gets less than it could take`),
    ...r.wasting.map((i) => `${name(i)} gives into nothing on one side: that line is wasted`),
  ];
}
