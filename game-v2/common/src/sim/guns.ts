/**
 * The step's gun phase (sim foundation, Stage 1B). Runs after the motion, on the moved pose, and returns what the guns
 * did as events instead of calling beamFx / scene / gunSync / the server's spawner:
 *
 *   fire  one per shell (barrel) of each volley a gun fired, named by its deterministic shot id (events.ts shotId:
 *         owner, tick, the gun's part index, the shell's place in the volley), with the aim it fired at (aimQ, in
 *         SHOT_AIM_STEPS). Every end builds the same shells from it and the firing ship (launch.ts rebuildVolley /
 *         volleyShells), so no end needs another's ids
 *   fx    a pulse laser starting a pulse ('pulse'), a charge gun's tell ('chargeStart' / 'chargeCancel'), a beam lit
 *         this tick ('beam'), a ports beam spending a piece ('beamPiece'), a ports mining laser starting a pulse ('minePulse')
 *
 * One core (`gunsTick`) for every caller: stepShipGuns (the step, on a SimShipState), the server's fireWeapons (on its
 * ShipState, server ships/bridge/weapons.ts) and the client's own-gun prediction (ShipClient.predictGuns). Each turns
 * the events into what it does after the step (the server spawns projectiles named by the shot ids; the client draws
 * them, and with CAPS.SHOT_IDS builds its own shells on its tick layer from them: sim/b-shots.ts).
 *
 * The aim is the one aim rule (input.ts simAim(q)): what the server's pilots already fire at (their Input.targetAngle
 * is fround(dequantize(q)) off the wire), so the client's prediction fires at it too.
 */

import type { ShipState } from '../ships/state.js';
import type { ShipTuning } from '../ships/tuning.js';
import type { WeaponInfo } from '../ships/rebuild.js';
import type { WeaponMods } from '../ships/types.js';
import { stepGuns, type GunOrders, type GunStep } from '../ships/guns.js';
import { gunDef, shotAimQ } from '../ships/launch.js';
import { ensurePortsCharge, payMining, type Charge } from '../ships/energy.js';
import { portsMinePhase, portsPiecePhase, type PortsState } from '../ships/power/ports.js';
import { jumpPhase, jumpTuning } from '../ships/flight.js';
import type { SimShipState } from './state.js';
import { simAim, type SimInput } from './input.js';
import type { SimEnv } from './env.js';
import { SHOT_ID_BARRELS, SHOT_ID_OWNERS, SHOT_ID_SLOTS, shotId, type SimEvent } from './events.js';

// (CTL.emp as a number: replica.ts imports step.ts, which imports this file, so nothing from it is read here)
const BIT_EMP = 512;

// (Own shells' wire names, CAPS.SHOT_IDS: exported with the gun phase, as sim/index.ts is a contract file)
export * from './b-shots.js';

/** A fire event */
export type FireEvent = Extract<SimEvent, { k: 'fire' }>;
/** (The name Stage 1B used while the contract's fire event lacked `aug`) */
export type GunFireEvent = FireEvent;

/** The fx names the gun phase emits */
export const GUN_FX = {
  pulse: 'pulse', chargeStart: 'chargeStart', chargeCancel: 'chargeCancel', beam: 'beam', beamPiece: 'beamPiece', minePulse: 'minePulse',
} as const;

/** The pose the guns fire from (the ship's after the tick's motion) */
export interface GunPose { x: number; y: number; angle: number }

/**
 * The shells a volley of this gun has (a burst's, by its tuning with its part's mods, grade, size, model and an
 * augment's mods; ammunition isn't the step's: an ammunition's burst count goes with the volley's consumer)
 */
export function volleyBarrels(tuning: ShipTuning, ship: Pick<ShipState, 'blueprint'>, w: WeaponInfo, aug?: WeaponMods): number {
  const def = gunDef(tuning, w.kind, { mods: ship.blueprint.parts[w.part]?.mods, ammo: aug, grade: w.grade, size: w.size, model: w.model });
  return Math.max(1, Math.min(SHOT_ID_BARRELS, Math.round(def.burst ?? 1)));
}

/** A gun step's outcome as events (the order: shells by volley then barrel, pulses, tells, beams) */
export function gunEvents(ship: ShipState, owner: number, pose: GunPose, step: GunStep, tick: number, tuning: ShipTuning, charge: Charge | undefined, events: SimEvent[]): void {
  for (const s of step.shots) {
    // (a gun past the id's slot field, or an owner past its owner field, fires unnamed: no ship has one yet)
    if (s.w.part >= SHOT_ID_SLOTS || owner >= SHOT_ID_OWNERS || owner < 0) continue;
    const n = volleyBarrels(tuning, ship, s.w, s.aug);
    for (let i = 0; i < n; i++) {
      const e: GunFireEvent = { k: 'fire', tick, owner, slot: s.w.part, barrel: i, shot: shotId(owner, tick, s.w.part, i), aimQ: s.aimQ };
      if (s.aug) e.aug = 1;
      events.push(e);
    }
  }
  for (const p of step.pulses) events.push({ k: 'fx', tick, owner, fx: GUN_FX.pulse, part: p.w.part, x: pose.x, y: pose.y, aq: p.aimQ });
  for (const t of step.tells) events.push({ k: 'fx', tick, owner, fx: t.start ? GUN_FX.chargeStart : GUN_FX.chargeCancel, part: t.w.part, x: pose.x, y: pose.y, aq: t.aimQ });
  const pz = ship.derived.ports, pe = pz ? (charge?.e as PortsState | undefined) : undefined;
  for (const w of step.beams) {
    events.push({ k: 'fx', tick, owner, fx: GUN_FX.beam, part: w.part, x: pose.x, y: pose.y });
    if (pz && pe && portsPiecePhase(pz, pe, w.part) === 0) events.push({ k: 'fx', tick, owner, fx: GUN_FX.beamPiece, part: w.part, x: pose.x, y: pose.y, aq: shotAimQ(ship.aim[w.part]) });
  }
}

/**
 * One tick of a ship's guns: the shared firing models (ships/guns.ts stepGuns) on `ship`'s gun state, then the events.
 * Returns the step too (the server's beams, pulses and volleys read it; the step's shot specs carry the damage scale)
 */
export function gunsTick(ship: ShipState, owner: number, pose: GunPose, orders: GunOrders, tick: number, tuning: ShipTuning, events: SimEvent[]): GunStep {
  const step = stepGuns(ship, pose, orders, tick, tuning);
  gunEvents(ship, owner, pose, step, tick, tuning, orders.energy?.charge, events);
  return step;
}

/** What a ship's controls ask of its guns this tick, gated by its state (no firing mid-jump or under an EMP) */
export interface GunControls {
  firing: boolean;
  mining: boolean;
  /** Burning (mid-jump) or EMP'd: nothing fires, the mining lasers stop */
  stopped: boolean;
}

/** The trigger as the server's stepWeapons and the client's predictGuns read it (the right button fires the guns on a ship with no mining lasers) */
export function gunControls(ship: Pick<ShipState, 'derived'>, fire: boolean, fireAlt: boolean, stopped: boolean): GunControls {
  const hasMiners = ship.derived.miners.length > 0;
  return { firing: (fire || (fireAlt && !hasMiners)) && !stopped, mining: fireAlt && hasMiners && !stopped, stopped };
}

/**
 * The mining lasers' tick after the guns' (energy.ts payMining: they pay for their segment from what the shots left);
 * a ports ship's laser starting a pulse is an fx event. Returns whether they're cutting
 */
export function miningTick(ship: ShipState, owner: number, pose: GunPose, c: GunControls, tick: number, energy: { charge: Charge }, events: SimEvent[]): boolean {
  if (c.stopped) ship.mineUntil = 0;
  const on = payMining(ship, c.mining, tick, energy, c.stopped);
  const pz = ship.derived.ports, pe = energy.charge.e;
  if (on && pz && pe) for (const m of ship.derived.miners) if (portsMinePhase(pz, pe, m.part) === 0) events.push({ k: 'fx', tick, owner, fx: GUN_FX.minePulse, part: m.part, x: pose.x, y: pose.y, aq: pe.sat[m.part] });
  return on;
}

/** (stepShipGuns' view of a SimShipState as the ShipState the firing models read: its structure's record, its gun state on top) */
const NO_BLUEPRINT = Object.freeze({ parts: [] as never[] });

function gunView(state: SimShipState): ShipState {
  const base = (state.structure.ship ?? { blueprint: NO_BLUEPRINT }) as ShipState;
  const v = Object.create(base) as ShipState;
  const g = state.guns;
  v.id = state.id;
  v.derived = state.structure.derived;
  v.cooldown = g.cooldown; v.rounds = g.rounds; v.reload = g.reload; v.charge = g.charge; v.spin = g.spin; v.aim = g.aim;
  v.triggerHeld = g.triggerHeld; v.clickAt = g.clickAt;
  v.minePaid = g.minePaid; v.mineUntil = g.mineUntil; v.mineShare = g.mineShare; v.tow = g.tow; v.heldDist = g.heldDist;
  return v;
}

/**
 * The step's gun phase: stepGuns on `state.guns` + `structure` at the moved pose, the mining lasers' payment, and the
 * events. An unaccounted state (a replica's view) runs its guns free (no energy) and pays no mining. A pilot's (mode
 * Player, aimed by its input: no gunAim) holds its aim distance while the trigger is held (ships/guns.ts distDue). No calls out
 */
export function stepShipGuns(state: SimShipState, input: Readonly<SimInput>, env: Readonly<SimEnv>, events: SimEvent[]): void {
  const d = state.structure.derived;
  if (!d.weapons.length && !d.miners.length) return;
  const t = env.tick, body = state.body;
  const emp = t < state.hazard.empUntil || (input.bits & BIT_EMP) !== 0;
  const burning = jumpPhase(body.jump ?? 0, jumpTuning(env.tuning)).phase === 'burn';
  const view = gunView(state);
  const c = gunControls(view, input.fire, input.fireAlt, burning || emp);
  const pose: GunPose = { x: body.x, y: body.y, angle: body.angle };
  const energy = state.accounted ? { charge: state.charge } : undefined;
  if (energy) ensurePortsCharge(d, energy.charge);
  gunsTick(view, state.id, pose, { firing: c.firing, aimWorld: input.gunAim === undefined ? simAim(input.q) : input.gunAim ?? undefined, aimDist: input.aimDist, energy, hold: state.mode === 0 /* ReplicaMode.Player */ && input.gunAim === undefined }, t, env.tuning, events);
  if (energy) {
    miningTick(view, state.id, pose, c, t, energy, events);
    state.charge = energy.charge;
  }
  const g = state.guns;
  g.triggerHeld = view.triggerHeld;
  g.clickAt = view.clickAt;
  g.minePaid = view.minePaid;
  g.mineUntil = view.mineUntil;
  g.mineShare = view.mineShare;
  g.heldDist = view.heldDist;
}
