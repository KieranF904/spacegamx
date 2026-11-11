/**
 * Tow Beams (common/src/ships/features/tow/tow.ts), the server half of the `tow` part feature: pilots latching onto wrecks, debris and loot pods and pulling them along.
 *
 * - `request(pilot, true, aim)` takes hold of whatever towable is nearest the aim point within the beam's reach
 *   (a derelict wreck or debris: ShipBridge.towable; a pod: LootPods.near). Never a working ship: no enemies,
 *   bosses, wards, traffic or pilots. One beam a pilot, one pilot a thing.
 * - Each tick (after the pilots' flight, before the bodies and pods move: GameServer.gameLoop) the tether pulls
 *   the towed thing (towPull), weaker short of power; it lets go when the beam's lost or out of power, the
 *   thing's gone, the pilot jumps, docks or changes system, or the tether stretches past `snap`.
 * - The pilot carries its load (towLoad): as the feature's cargoMass, ShipBridge adds `load(pilot)` to the hold's mass, so the pilot's
 *   prediction and replicas fly it. The beam draws only while it tows: the server switches it on in the ship's ports
 *   state (setPortsTow, TOW_BIT; the pilot hears it as it hears a field machine's, sim/ownStep.ts ownSync), and the pull is
 *   as strong as the share of its draw it gets (towShare).
 * - Towed into a station's reach, it's delivered: the host salvages it (GameServer: a wreck or debris into
 *   station storage, a derelict's credits too; a pod's contents into storage) and the beam lets go.
 */

import { hasComponent } from 'bitecs';
import { Position, Velocity, InSystem, Dead, Input, canTow, fullPortsCharge, setPortsTow, TOW_BIT, towLoad, towPull, towShare, towTuning, type ShipTuning, type TowKind, dcos, dhypot, dsin } from '@space-game/common';
import type { LootPods } from '../../../game/LootPods.js';
import type { FeatureInstance, FeatureMessageHandler, ShipsOf, StationCap, TellCap, WorldCap } from '../types.js';
import { SimPass } from '../../../sim/SystemClocks.js';

interface Tow { target: number; kind: TowKind }

/** What Tow Beams ask of the game: the towables and the towing ship's stores, toasts, the stations and the pods */
export type TowHost = WorldCap & ShipsOf<TowShipCalls> & Pick<TellCap, 'tell'> & StationCap;
type TowShipCalls = 'get' | 'isJumping' | 'towable' | 'towablesNear' | 'chargeOf' | 'setCharge' | 'holdTowed';

export class Towing implements FeatureInstance {
  private tows = new Map<number, Tow>();
  private readonly ships: TowHost['ships'];
  private readonly pods: LootPods;
  private readonly tuning: ShipTuning;

  constructor(private host: TowHost) {
    this.ships = host.ships;
    this.pods = host.pods;
    this.tuning = host.tuning;
  }

  /** The client's `{type:'tow', on}`: take hold of what's nearest the cursor, or let go */
  readonly messages: Readonly<Record<string, FeatureMessageHandler>> = {
    tow: (p, msg) => {
      const a = Input.targetAngle[p], dist = Input.cursorDist[p];
      this.request(p, !!msg.on, { x: Position.x[p] + dcos(a) * dist, y: Position.y[p] + dsin(a) * dist });
    },
  };

  /** The load the pilot's tow puts on the hold (ShipBridge flight sums it with the cargo) */
  cargoMass(pilot: number): number { return this.load(pilot); }

  /** The pilot-row value (features.wire.json pilotExtra "tow"): what the pilot tows, entity id + 1, 0 none */
  wire(pilot: number, out: number[]): number {
    out[0] = this.wireOf(pilot);
    return 1;
  }

  /** The status-row value other pilots get (features.wire.json status[8]) */
  status(pilot: number): number { return this.wireOf(pilot); }

  /** What a pilot tows (an entity id), if anything */
  targetOf(pilot: number): number | undefined {
    return this.tows.get(pilot)?.target;
  }

  /** Who's towing this, if anyone */
  towedBy(target: number): number | undefined {
    for (const [p, t] of this.tows) if (t.target === target) return p;
    return undefined;
  }

  /** The towed thing's mass, its radius, and whether it's still there to tow */
  private end(t: Tow): { mass: number; r: number } | null {
    const w = this.host.world;
    if (t.kind === 'pod') {
      if (!this.pods.get(t.target) || hasComponent(w, Dead, t.target)) return null;
      return { mass: towTuning(this.tuning).podMass, r: 18 };
    }
    const b = this.ships.towable(t.target);
    return b ? { mass: b.mass, r: b.radius } : null;
  }

  /** The load the pilot carries towing (as cargo mass: load.ts) */
  load(pilot: number): number {
    const t = this.tows.get(pilot);
    const ship = this.ships.get(pilot);
    if (!t || !ship) return 0;
    const e = this.end(t);
    if (!e) return 0;
    return towLoad(e.mass, Math.max(ship.derived.mass, ship.derived.fullMass ?? ship.derived.mass), towTuning(this.tuning));
  }

  /** Take hold (on) of what's nearest `aim` within reach, or let go (off) */
  request(pilot: number, on: boolean, aim: { x: number; y: number }): void {
    if (!on) { this.release(pilot, 'Tow Beam: let go', '#cbd5e1'); return; }
    if (this.tows.has(pilot)) { this.release(pilot, 'Tow Beam: let go', '#cbd5e1'); return; }
    const ship = this.ships.get(pilot);
    if (!ship || ship.kind !== 'ship') return;
    if (!ship.derived.fx?.tow) { this.host.tell(pilot, 'No Tow Beam fitted: build one in the hangar to tow', '#f2d24b'); return; }
    if (!canTow(ship.derived)) { this.host.tell(pilot, 'The Tow Beam has no power', '#f2d24b'); return; }
    if (this.host.isDocked(pilot) || this.ships.isJumping(ship)) return;
    const t = towTuning(this.tuning);
    const sys = InSystem.systemId[pilot];
    const x = Position.x[pilot], y = Position.y[pilot], r = ship.derived.radius;
    const reach = t.range + r;
    let best = -1, bestKind: TowKind = 'pod', bestD = Infinity;
    const consider = (eid: number, kind: TowKind, er: number) => {
      if (eid === pilot || this.towedBy(eid) !== undefined) return;
      const ex = Position.x[eid], ey = Position.y[eid];
      if (dhypot(ex - x, ey - y) - er > reach) return;
      const d = dhypot(ex - aim.x, ey - aim.y) - er;
      if (d < bestD) { bestD = d; best = eid; bestKind = kind; }
    };
    for (const eid of this.ships.towablesNear(sys, x, y, reach)) { const b = this.ships.towable(eid)!; consider(eid, b.kind, b.radius); }
    for (const eid of this.pods.near(sys, x, y, reach + 18)) consider(eid, 'pod', 18);
    if (best < 0) { this.host.tell(pilot, `Nothing to tow in range (${Math.round(t.range)} m). The Tow Beam takes wrecks, debris and pods.`, '#f2d24b'); return; }
    this.tows.set(pilot, { target: best, kind: bestKind });
    ship.tow = best;
    this.power(pilot, true);
    const what = bestKind === 'pod' ? 'a pod' : bestKind === 'wreck' ? 'a wreck' : 'debris';
    this.host.tell(pilot, `Tow Beam: towing ${what}. Bring it into a station's reach to salvage it`, '#facc15');
  }

  /** Let go (a message for the pilot, if any) */
  release(pilot: number, text?: string, color = '#f2d24b'): void {
    if (!this.tows.delete(pilot)) return;
    const ship = this.ships.get(pilot);
    if (ship) ship.tow = undefined;
    this.power(pilot, false);
    if (text) this.host.tell(pilot, text, color);
  }

  /** A pilot's gone (left, died, changed ship): forget its tow quietly */
  forget(pilot: number): void {
    this.release(pilot);
  }

  tick(): void {
    if (!this.tows.size) return;
    const w = this.host.world;
    const t = towTuning(this.tuning);
    for (const [pilot, tow] of [...this.tows]) {
      // (Its system's pass: crowd dilation, sim/SystemClocks.ts)
      if (!SimPass.on(InSystem.systemId[pilot])) continue;
      const ship = this.ships.get(pilot);
      if (!ship || ship.kind !== 'ship' || hasComponent(w, Dead, pilot)) { this.release(pilot); continue; }
      if (!canTow(ship.derived)) { this.release(pilot, 'Tow Beam lost: the tether let go'); continue; }
      const e = this.end(tow);
      if (!e || InSystem.systemId[tow.target] !== InSystem.systemId[pilot]) { this.release(pilot); continue; }
      if (this.ships.isJumping(ship)) { this.release(pilot, 'Tow Beam: let go for the jump'); continue; }
      // (A refit gives the pilot a new ship state: it still tows, and draws for it)
      ship.tow = tow.target;
      this.power(pilot, true);
      // Into a station's reach: delivered (salvaged), then the beam's free
      if (this.host.isDocked(pilot) || this.host.stationInRange(pilot) >= 0) {
        this.host.deliver(pilot, tow.target, tow.kind);
        this.release(pilot);
        continue;
      }
      // Its power this tick: what the beams got of their draw (this tick's flight ran the ports core with them on)
      const share = towShare(ship.derived, this.ships.chargeOf(pilot));
      if (share < t.minShare) { this.release(pilot, 'Tow Beam out of power: the tether let go'); continue; }
      const pull = towPull(
        { x: Position.x[pilot], y: Position.y[pilot], vx: Velocity.x[pilot], vy: Velocity.y[pilot], r: ship.derived.radius },
        { x: Position.x[tow.target], y: Position.y[tow.target], vx: Velocity.x[tow.target], vy: Velocity.y[tow.target], r: e.r },
        e.mass, share, t);
      if (pull.snapped) { this.release(pilot, 'The tow tether snapped: too far, too heavy'); continue; }
      Velocity.x[tow.target] += pull.dvx;
      Velocity.y[tow.target] += pull.dvy;
      if (tow.kind === 'debris') this.ships.holdTowed(tow.target);
    }
  }

  /** Switch the pilot's Tow Beams' draw on or off in its ports state (made, full, if it has none yet) */
  private power(pilot: number, on: boolean): void {
    const ship = this.ships.get(pilot);
    if (!ship) return;
    let c = this.ships.chargeOf(pilot);
    if (!c.e || c.e.held.length !== ship.derived.ports.n) {
      if (!on) return;
      c = fullPortsCharge(ship.derived);
      this.ships.setCharge(pilot, c);
    }
    if (((c.e!.mach & TOW_BIT) !== 0) !== on) setPortsTow(c.e!, on);
  }

  /** For the snapshot: what each pilot tows (entity id + 1; 0 none) */
  wireOf(pilot: number): number {
    const t = this.tows.get(pilot);
    return t ? t.target + 1 : 0;
  }
}
