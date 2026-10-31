/**
 * The compiled feature plan: the registry (registry.ts, generated) checked and
 * flattened once, on first use, into frozen arrays the call sites index by
 * feature number. rebuild.ts, energy.ts and replica.ts import only this file
 * (never registry.ts or a feature folder) and call getPlan() inside their
 * functions, never at module scope, so a feature may import them back.
 *
 * Feature number = position in `plan.features` (sorted by order, then id);
 * its bit in `derived.fxMask` is 1 << number.
 */

import type { FunctionDef } from '../types.js';
import type { DeriveCtx, DescribeCtx, Fact, FlightHook, FlightPhase, InputDef, LoadShip, PartFeature, ReplicaField, ReplicaWhere, WeaponRole } from './types.js';
import type { PowerLayout } from '../circuits.js';
import type { ShipDerived } from '../rebuild.js';
import { FEATURES } from './registry.js';
import WIRE from './features.wire.json' with { type: 'json' };

/** fxMask is an int32 bitmask */
export const MAX_FEATURES = 31;

/** The controls flight has of its own (flight.ts FlightControls): a feature's input may not take one of these names */
const CORE_CONTROLS: readonly string[] = ['forward', 'backward', 'left', 'right', 'boost', 'targetAngle', 'helm', 'strafeLeft', 'strafeRight', 'jump', 'jumpDist'];

export const FLIGHT_PHASES: readonly FlightPhase[] = ['preJump', 'steer', 'thrustGate', 'impulse', 'damp'];

export interface WireManifest {
  pilotExtra: readonly { name: string; feature: string }[];
  status: readonly { name: string; feature: string; index: number }[];
  keyframe: readonly { name: string; feature: string; index: number }[];
  ctl: readonly { name: string; feature: string; bit: number }[];
}

export type DeriveHook = (c: DeriveCtx) => void;
export type LoadHook = (ship: LoadShip, L: PowerLayout, out: number[]) => void;
export interface FlightEntry { feature: number; order: number; step: FlightHook['step'] }
export interface PlanInput extends InputDef { feature: string }
export interface PlanReplica extends ReplicaField { feature: string; slot: number }
/** A weapon-kind role, with the feature that owns it */
export interface PlanWeaponRole extends WeaponRole { feature: string }
/** A held input with a replica control bit */
export interface PlanControl { name: string; bit: number }

export interface FeaturePlan {
  readonly features: readonly PartFeature[];
  readonly byId: ReadonlyMap<string, number>;
  /** Features every ship has (global) */
  readonly globalMask: number;
  /** Features that draw by the tick (rebuild.ts burst) */
  readonly burstMask: number;
  /** Of those, the ones whose draw their circuit counts as an engine's (burst: 'engine'; circuits.ts engineDraw) */
  readonly engineMask: number;
  /** Features with flight hooks (replica.ts flightSignature folds these in) */
  readonly flightMask: number;
  /** By feature number (undefined: none) */
  readonly derive: readonly (DeriveHook | undefined)[];
  readonly load: readonly (LoadHook | undefined)[];
  /** Features with describe(), in plan order */
  readonly describe: readonly PartFeature[];
  /** Every weapon-kind role of every feature, in plan order (WeaponRole) */
  readonly weapons: readonly PlanWeaponRole[];
  /** Per phase, sorted by (order, feature id) */
  readonly flight: Readonly<Record<FlightPhase, readonly FlightEntry[]>>;
  readonly inputs: readonly PlanInput[];
  /** The 'held' inputs' names (flightInputs.ts copies each from the held keys into the controls; the server's Input field of that name) */
  readonly held: readonly string[];
  /** The held inputs with a control bit (replica.ts controlBits / flightControls) */
  readonly controls: readonly PlanControl[];
  /** Features' flight keys, in plan order (replica.ts flightSignature) */
  readonly flightKeys: readonly ((d: ShipDerived) => string)[];
  readonly replicate: readonly PlanReplica[];
}

const fail = (msg: string): never => { throw new Error(`features: ${msg}`); };

/** Check and flatten a list of features (tests pass their own; getPlan() the registry's) */
export function compilePlan(list: readonly PartFeature[], wire: WireManifest = WIRE as WireManifest): FeaturePlan {
  if (list.length > MAX_FEATURES) fail(`${list.length} features: at most ${MAX_FEATURES} (fxMask is 32 bits)`);
  const ids = new Set<string>();
  for (const f of list) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(f.id)) fail(`bad id "${f.id}"`);
    if (ids.has(f.id)) fail(`duplicate id "${f.id}"`);
    ids.add(f.id);
    if (!Number.isFinite(f.order)) fail(`${f.id}: order must be a number`);
  }
  const features = Object.freeze([...list].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  const byId = new Map(features.map((f, i) => [f.id, i] as const));
  let globalMask = 0, burstMask = 0, engineMask = 0, flightMask = 0;
  const flight = Object.fromEntries(FLIGHT_PHASES.map((p) => [p, [] as FlightEntry[]])) as Record<FlightPhase, FlightEntry[]>;
  const inputs: PlanInput[] = [], replicate: PlanReplica[] = [], held: string[] = [], controls: PlanControl[] = [];
  const flightKeys: ((d: ShipDerived) => string)[] = [];
  const weapons: PlanWeaponRole[] = [];
  const keys = new Map<string, string>(), bits = new Map<number, string>(), slots = new Map<string, string>();
  features.forEach((f, i) => {
    const bit = 1 << i;
    if (f.global) globalMask |= bit;
    if (f.burst) burstMask |= bit;
    if (f.burst === 'engine') engineMask |= bit;
    if (f.flightKey) flightKeys.push(f.flightKey.bind(f));
    const roles = new Set<string>();
    for (const r of f.weapon ?? []) {
      if (roles.has(r.id)) fail(`${f.id}: weapon role "${r.id}" is listed twice`);
      roles.add(r.id);
      weapons.push({ ...r, feature: f.id });
    }
    for (const h of f.flight ?? []) {
      if (!FLIGHT_PHASES.includes(h.phase)) fail(`${f.id}: unknown flight phase "${h.phase}"`);
      flightMask |= bit;
      flight[h.phase].push({ feature: i, order: h.order, step: h.step });
    }
    for (const inp of f.inputs ?? []) {
      const k = keys.get(inp.defaultKey);
      if (k) fail(`${f.id}.${inp.name}: key ${inp.defaultKey} is already ${k}'s`);
      keys.set(inp.defaultKey, `${f.id}.${inp.name}`);
      if (inp.ctlBit !== undefined) {
        const b = bits.get(inp.ctlBit);
        if (b) fail(`${f.id}.${inp.name}: control bit ${inp.ctlBit} is already ${b}'s`);
        bits.set(inp.ctlBit, `${f.id}.${inp.name}`);
        const pinned = wire.ctl.find((c) => c.bit === inp.ctlBit);
        if (!pinned || pinned.feature !== f.id) {
          fail(`${f.id}.${inp.name}: control bit ${inp.ctlBit} is not pinned to it in features.wire.json. The binary input's flags are full: `
            + 'a NEW feature input needs the longer binary input form first (a protocol change), not just a bit');
        }
      }
      if (inp.kind !== 'held') fail(`${f.id}.${inp.name}: only 'held' inputs are wired (a '${inp.kind}' input needs its plumbing first)`);
      inputs.push({ ...inp, feature: f.id });
      if (held.includes(inp.name) || CORE_CONTROLS.includes(inp.name)) fail(`${f.id}.${inp.name}: a control of that name already exists`);
      held.push(inp.name);
      if (inp.ctlBit !== undefined) controls.push({ name: inp.name, bit: inp.ctlBit });
    }
    for (const r of f.replicate ?? []) {
      const slot = slotOf(wire, r.where, f.id, r.name);
      if (slot < 0) fail(`${f.id}.${r.name}: no ${r.where} slot pinned to it in features.wire.json (a new slot is a wire change)`);
      const key = `${r.where}:${slot}`;
      const s = slots.get(key);
      if (s) fail(`${f.id}.${r.name}: ${r.where} slot ${slot} is already ${s}'s`);
      slots.set(key, `${f.id}.${r.name}`);
      replicate.push({ ...r, feature: f.id, slot });
    }
  });
  for (const p of FLIGHT_PHASES) {
    flight[p].sort((a, b) => a.order - b.order || a.feature - b.feature);
    Object.freeze(flight[p]);
  }
  return Object.freeze({
    features,
    byId,
    globalMask,
    burstMask,
    engineMask,
    flightMask,
    derive: Object.freeze(features.map((f) => f.derive?.bind(f))),
    load: Object.freeze(features.map((f) => f.load?.bind(f))),
    describe: Object.freeze(features.filter((f) => f.describe)),
    weapons: Object.freeze(weapons),
    flight: Object.freeze(flight),
    inputs: Object.freeze(inputs),
    held: Object.freeze(held),
    controls: Object.freeze(controls),
    flightKeys: Object.freeze(flightKeys),
    replicate: Object.freeze(replicate),
  });
}

/** A replicated field's slot: its pinned index (pilotExtra: its place after the charge groups; ctl: its bit), -1 unpinned */
function slotOf(wire: WireManifest, where: ReplicaWhere, feature: string, name: string): number {
  if (where === 'pilotExtra') return wire.pilotExtra.findIndex((e) => e.feature === feature && e.name === name);
  if (where === 'ctl') return wire.ctl.find((e) => e.feature === feature && e.name === name)?.bit ?? -1;
  return wire[where].find((e) => e.feature === feature && e.name === name)?.index ?? -1;
}

let plan: FeaturePlan | undefined;

/** The registry's plan, compiled on first use (call inside functions, never at module scope) */
export function getPlan(): FeaturePlan {
  return plan ??= compilePlan(FEATURES);
}

/** TESTS ONLY: run with another compiled plan (null: back to the registry's) */
export function setPlanForTests(p: FeaturePlan | null): void {
  plan = p ?? undefined;
}

/** The features a part's function gives a ship (bits by feature number; global features not included) */
export function featureBits(P: FeaturePlan, fn: FunctionDef): number {
  let m = 0;
  const F = P.features;
  for (let i = 0; i < F.length; i++) if (F[i].applies(fn)) m |= 1 << i;
  return m;
}

/** The feature numbers in a mask, in plan order */
export function featureList(mask: number): Int8Array {
  let n = 0;
  for (let m = mask; m; m &= m - 1) n++;
  const out = new Int8Array(n);
  for (let i = 0, k = 0; i < MAX_FEATURES && k < n; i++) if (mask & (1 << i)) out[k++] = i;
  return out;
}

/** What the features a function gives say about it, in plan order (describePart builds on this: CUT 3) */
export function featureFacts(c: DescribeCtx): Fact[] {
  const P = getPlan();
  if (!P.describe.length) return [];
  const out: Fact[] = [];
  for (const f of P.describe) if (f.applies(c.fn)) for (const fact of f.describe!(c)) out.push(fact);
  return out;
}

/** A feature's weapon role (the server's hooks hang on it): throws if there is none, a typo is a bug */
export function weaponRole(P: FeaturePlan, feature: string, id: string): PlanWeaponRole {
  const r = P.weapons.find((w) => w.feature === feature && w.id === id);
  if (!r) throw new Error(`features: no weapon role ${feature}.${id}`);
  return r;
}
