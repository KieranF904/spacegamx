/**
 * Colours by function, matching the concept sheets: white core, amber
 * generator, dark amber conduit, red weapon, blue thruster, slate hull, grey armour.
 */

import { SHIP_FUNCTIONS } from './shipFunctionData';

/** By function id: data/ships/functions.json `color` */
export const FUNCTION_COLORS: Record<string, number> = Object.fromEntries(
  SHIP_FUNCTIONS.filter((f) => f.color).map((f) => [f.id, hexToNum(f.color!)]),
);

export const FLOW_COLOR = 0xffb547;
export const CONNECTOR_COLOR = 0x5fd4c4;

export function functionColor(fn: string): number {
  return FUNCTION_COLORS[fn] ?? 0x888888;
}

export function hexToNum(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}

export function numToCss(n: number): string {
  return '#' + n.toString(16).padStart(6, '0');
}

/** Blend a → b by t in [0, 1]. */
export function mix(a: number, b: number, t: number): number {
  const k = Math.max(0, Math.min(1, t));
  const r = ((a >> 16) & 0xff) * (1 - k) + ((b >> 16) & 0xff) * k;
  const g = ((a >> 8) & 0xff) * (1 - k) + ((b >> 8) & 0xff) * k;
  const bl = (a & 0xff) * (1 - k) + (b & 0xff) * k;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

/** Green → yellow → red as HP drops. */
export function hpColor(f: number): number {
  return f > 0.5 ? mix(0xf2d24b, 0x4ade80, (f - 0.5) * 2) : mix(0xef4444, 0xf2d24b, f * 2);
}
