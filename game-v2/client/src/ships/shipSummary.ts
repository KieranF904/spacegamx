/**
 * A ship design in plain numbers, for the hangar: how fast it goes and turns,
 * how hard it hits, how much it can take and carry, how far it jumps, and what
 * it costs to rebuild. Two summaries can be compared (the design you're editing
 * against the one you saved).
 */

import { Blueprint, Catalog, ShipTuning, Economy, createShipState, FRICTION, jumpTuning, buyPrice, rateShip, salvageOf, SALVAGE, energyTuning, baseWeaponDps, partWeaponDef } from '@space-game/common';

export interface ShipSummary {
  /** Firepower and toughness together (ships/rating.ts) */
  rating: number;
  parts: number;
  mass: number;
  /** World units (metres) per second */
  topSpeed: number;
  accel: number;
  /** Seconds to turn half way round */
  turn180: number;
  dps: number;
  hull: number;
  shield: number;
  cargo: number;
  /** Kilometres */
  jump: number;
  jumpCooldown: number;
  /** The coils' capacity over what the hull needs (1: just right) */
  jumpRatio: number;
  power: { supply: number; demand: number };
  /** Battery and draws (energy.ts), for the hangar's energy readout */
  energy: { max: number; driveMax: number; weaponMax: number; spare: number; engineDraw: number; weaponDraw: number; boostDraw: number };
  guns: number;
  turrets: number;
  miners: number;
  /** Stabiliser Anchor: its best one's power (0: none; ships/anchor.ts) */
  anchor: number;
  /** Credits it costs to lose it: the minerals salvage doesn't bring back, at station prices */
  rebuild: number;
}

/** Is a bigger number better for this stat (mass, turn time and rebuild cost are better small) */
export const BIGGER_IS_BETTER: Record<keyof Omit<ShipSummary, 'power' | 'energy'>, boolean> = {
  rating: true, parts: true, mass: false, topSpeed: true, accel: true, turn180: false, dps: true, hull: true, shield: true, cargo: true,
  jump: true, jumpCooldown: false, jumpRatio: true, guns: true, turrets: true, miners: true, anchor: true, rebuild: false,
};

export function shipSummary(catalog: Catalog, tuning: ShipTuning, econ: Economy, bp: Blueprint): ShipSummary | null {
  let ship;
  try {
    ship = createShipState(catalog, tuning, 0, bp, 0);
  } catch {
    return null;
  }
  const d = ship.derived;
  if (d.mass <= 0 || d.root < 0) return null;
  const a = Math.max(d.maxThrust.forward, d.maneuverForce) / d.mass;
  // Turning: accelerate up to the spin limit, then hold it
  const alpha = d.inertia > 0 ? Math.min(d.maxTorque.cw, d.maxTorque.ccw) / d.inertia : 0;
  const wMax = tuning.flight.maxAngularSpeed;
  let turn = Infinity;
  if (alpha > 0) {
    const tUp = wMax / alpha, angUp = alpha * tUp * tUp; // accelerate and brake
    turn = angUp >= Math.PI ? 2 * Math.sqrt(Math.PI / alpha) : 2 * tUp + (Math.PI - angUp) / wMax;
  }
  let dps = 0;
  for (const w of d.weapons) {
    if (!tuning.weapons?.[w.kind]) continue;
    // Its own tuning (grade, size, gems), as the rating counts it: a pulse laser's pulses, a beam's heat-limited burn, a gun's shells
    dps += baseWeaponDps(tuning, w.kind, w.interval, partWeaponDef(tuning, w.kind, bp.parts[w.part], w)) * Math.max(w.satisfaction, tuning.flow.minWeaponSatisfaction) * w.strength;
  }
  // Losing it costs the minerals salvage doesn't bring back
  const raw = salvageOf(econ, econ.designParts(bp), 1);
  const rebuild = Object.entries(raw).filter(([id]) => econ.items.get(id)?.category === 'mineral')
    .reduce((t, [id, n]) => t + buyPrice(econ.items, id) * n * (1 - SALVAGE), 0);
  const jt = jumpTuning(tuning);
  return {
    rating: rateShip(catalog, tuning, ship).rating,
    parts: bp.parts.length,
    mass: d.mass,
    topSpeed: ((a * FRICTION) / (1 - FRICTION)) * 60,
    accel: a * 3600,
    turn180: turn / 60,
    dps,
    hull: ship.maxHp.reduce((t, h) => t + h, 0),
    shield: d.shieldMax,
    cargo: d.cargoCapacity,
    jump: (d.jumpRange || jt.baseRange) / 1000,
    jumpCooldown: (d.jumpCooldown || jt.cooldownTicks) / 60,
    jumpRatio: d.jumpRatio ?? 1,
    power: { supply: d.networks.reduce((t, n) => t + n.supply, 0), demand: d.networks.reduce((t, n) => t + n.demand, 0) },
    energy: {
      max: d.energy?.max ?? 0, driveMax: d.energy?.driveMax ?? 0, weaponMax: d.energy?.weaponMax ?? 0, spare: d.energy?.spare ?? 0, engineDraw: d.energy?.engineDraw ?? 0, weaponDraw: d.energy?.weaponDraw ?? 0,
      boostDraw: (d.energy?.engineDraw ?? 0) * (1 + energyTuning(tuning).boostDraw * (d.boostDrain ?? 1)),
    },
    guns: d.weapons.length,
    turrets: d.weapons.filter((w) => w.mount === 'turret').length,
    miners: d.miners.length,
    anchor: d.anchor ?? 0,
    rebuild,
  };
}

/** What the coils against the hull mean (flight.ts jumpDriveStats): a word, its colour and a hint */
export function jumpRatioNote(ratio: number): { word: string; color: string; hint: string } {
  if (ratio < 0.9) return { word: 'under-coiled', color: '#fbbf24', hint: 'Too much hull for its coils: less range and a slower recharge. Add jump coils (powered) to fix it' };
  if (ratio <= 1.5) return { word: 'just right', color: '#86efac', hint: "The coils suit the hull: the drive's sweet spot" };
  return { word: 'over-coiled', color: '#7dd3fc', hint: 'More coil than the hull needs: each extra one adds less and less, and the recharge has a floor' };
}
